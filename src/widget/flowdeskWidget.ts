/**
 * FlowDesk on the iPhone home screen, through Scriptable.
 *
 * Apple only lets real widgets come from an installed app, and FlowDesk is a
 * web app. Scriptable is an app whose widgets run a script, so this is that
 * script. What sits in Scriptable on the phone is a ten-line stub (see
 * public/widget/install.html) that downloads this file from FlowDesk every
 * time the widget refreshes — so a change here reaches every phone on the
 * next deploy, with nobody pasting anything again.
 *
 * It shows today's tasks worked out by the app's own scheduler, on the
 * person's own rows, signed in as them: the widget can never disagree with
 * My Tasks about what today holds, and it can only see what they could.
 *
 * Built on its own (vite.widget.config.ts) into dist/widget/.
 */

import { format } from 'date-fns'
import { taskOccurrences, setSkippedOccurrences, type TaskOccurrence, type TaskStatusRow, type TaskMoveRow } from '../utils/taskScheduler'
import { toTask, toCompletionLog } from '../store/taskRows'
import { defaultColor, isHexColor } from '../lib/personColor'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Scriptable's globals, as far as this uses them ─────────────────────────
declare const Request: any
declare const Keychain: any
declare const Alert: any
declare const ListWidget: any
declare const Color: any
declare const Font: any
declare const SFSymbol: any
declare const Size: any
declare const Script: any
declare const Device: any
declare const Safari: any
declare const config: any
declare const module: any

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL
const ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY
const SESSION_KEY = 'flowdesk.widget.session'

/** How often to ask iOS for a refresh. iOS decides in the end; this is a hint. */
const REFRESH_MIN = 15

// ─── Words ──────────────────────────────────────────────────────────────────

const STRINGS = {
  en: {
    today: 'Today',
    left: (n: number) => `${n} left`,
    allDone: 'All done',
    nothing: 'Nothing today',
    more: (n: number) => `+${n} more`,
    tasks: 'tasks',
    signInTitle: 'Sign in to FlowDesk',
    signInMessage: 'The same email and password as the app. Your password is not kept: only a sign-in token, in the iPhone’s keychain.',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    cancel: 'Cancel',
    signedOut: 'Open Scriptable and run FlowDesk to sign in.',
    signInFailed: 'Could not sign in',
    offline: 'Could not reach FlowDesk',
    menuTitle: 'FlowDesk widget',
    preview: 'Preview the widget',
    openApp: 'Open FlowDesk',
    signOut: 'Sign out',
  },
  pt: {
    today: 'Hoje',
    left: (n: number) => `faltam ${n}`,
    allDone: 'Tudo feito',
    nothing: 'Nada para hoje',
    more: (n: number) => `+${n}`,
    tasks: 'tarefas',
    signInTitle: 'Entrar no FlowDesk',
    signInMessage: 'O mesmo email e palavra-passe da aplicação. A palavra-passe não fica guardada: só um token de sessão, no porta-chaves do iPhone.',
    email: 'Email',
    password: 'Palavra-passe',
    signIn: 'Entrar',
    cancel: 'Cancelar',
    signedOut: 'Abra o Scriptable e corra o FlowDesk para entrar.',
    signInFailed: 'Não foi possível entrar',
    offline: 'Não foi possível contactar o FlowDesk',
    menuTitle: 'Widget do FlowDesk',
    preview: 'Pré-visualizar o widget',
    openApp: 'Abrir o FlowDesk',
    signOut: 'Terminar sessão',
  },
}
type Strings = (typeof STRINGS)['en']

// ─── Signing in ─────────────────────────────────────────────────────────────

interface Session {
  access: string
  refresh: string
  /** Milliseconds. */
  expiresAt: number
  userId: string
}

function readSession(): Session | null {
  if (!Keychain.contains(SESSION_KEY)) return null
  try {
    return JSON.parse(Keychain.get(SESSION_KEY))
  } catch {
    return null
  }
}

async function auth(grant: 'password' | 'refresh_token', body: object): Promise<Session> {
  const req = new Request(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`)
  req.method = 'POST'
  req.headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' }
  req.body = JSON.stringify(body)
  const res = await req.loadJSON()
  if (!res?.access_token) throw new Error(res?.error_description || res?.msg || res?.error || 'sign-in refused')
  const session: Session = {
    access: res.access_token,
    refresh: res.refresh_token,
    expiresAt: (res.expires_at ? res.expires_at * 1000 : Date.now() + res.expires_in * 1000),
    userId: res.user.id,
  }
  Keychain.set(SESSION_KEY, JSON.stringify(session))
  return session
}

/**
 * A usable session, refreshed only when the current one is about to run out.
 * Refresh tokens are single-use, so refreshing on every run would have two
 * widgets on one screen racing to spend the same one.
 */
async function currentSession(): Promise<Session | null> {
  const s = readSession()
  if (!s) return null
  if (Date.now() < s.expiresAt - 5 * 60 * 1000) return s
  try {
    return await auth('refresh_token', { refresh_token: s.refresh })
  } catch {
    return null
  }
}

async function askToSignIn(t: Strings): Promise<Session | null> {
  const alert = new Alert()
  alert.title = t.signInTitle
  alert.message = t.signInMessage
  alert.addTextField(t.email, '')
  alert.addSecureTextField(t.password, '')
  alert.addAction(t.signIn)
  alert.addCancelAction(t.cancel)
  if ((await alert.presentAlert()) === -1) return null
  try {
    return await auth('password', { email: alert.textFieldValue(0).trim(), password: alert.textFieldValue(1) })
  } catch (err) {
    const fail = new Alert()
    fail.title = t.signInFailed
    fail.message = String((err as Error)?.message ?? err)
    fail.addAction('OK')
    await fail.presentAlert()
    return null
  }
}

// ─── Reading their day ──────────────────────────────────────────────────────

/** Every matching row, a thousand at a time — Supabase stops at max_rows. */
async function rows(session: Session, table: string, query: string, optional = false): Promise<any[]> {
  const out: any[] = []
  for (let offset = 0; ; offset += 1000) {
    const req = new Request(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1000&offset=${offset}`)
    req.headers = { apikey: ANON_KEY, Authorization: `Bearer ${session.access}` }
    const data = await req.loadJSON()
    if (!Array.isArray(data)) {
      // A table whose migration has not run: the app treats it as empty too.
      if (optional) return []
      throw new Error(data?.message || `${table} could not be read`)
    }
    out.push(...data)
    if (data.length < 1000) return out
  }
}

interface Day {
  items: TaskOccurrence[]
  color: string
}

async function loadToday(session: Session): Promise<Day> {
  const me = session.userId
  const today = format(new Date(), 'yyyy-MM-dd')
  // The scheduler looks back a year for untouched work; a little more, so a
  // task from the edge of that year is not counted undone for want of its log.
  const since = format(new Date(Date.now() - 400 * 86400000), 'yyyy-MM-dd')
  const mine = `employee_id=eq.${me}`

  const [tasks, logs, statuses, moves, skips, profile] = await Promise.all([
    rows(session, 'tasks', 'select=*,task_assignments(employee_id)&order=id'),
    rows(session, 'completion_logs', `select=*&${mine}&due_date=gte.${since}&order=id`),
    rows(session, 'task_statuses', `select=*&${mine}&due_date=gte.${since}&order=task_id,due_date`),
    rows(session, 'task_moves', `select=*&${mine}&order=task_id,due_date`, true),
    rows(session, 'task_skips', `select=*&${mine}&order=task_id,due_date`, true),
    rows(session, 'users', `select=calendar_color&id=eq.${me}`, true),
  ])

  setSkippedOccurrences(skips.map((r) => ({ taskId: r.task_id, employeeId: r.employee_id, date: r.due_date })))
  const statusRows: TaskStatusRow[] = statuses.map((r) => ({
    taskId: r.task_id,
    employeeId: r.employee_id,
    date: r.due_date,
    status: r.status === 'missed' ? 'missed' : 'in_progress',
    at: r.started_at ?? null,
  }))
  const moveRows: TaskMoveRow[] = moves.map((r) => ({
    taskId: r.task_id,
    employeeId: r.employee_id,
    date: r.due_date,
    movedTo: r.moved_to,
  }))

  const items = taskOccurrences(
    tasks.map(toTask),
    me,
    logs.map(toCompletionLog),
    { from: today, to: today, today },
    statusRows,
    365,
    moveRows,
  ).filter((o) => o.showOn === today)

  // What still needs doing first, urgent at the top; finished work last.
  const rank = (o: TaskOccurrence) =>
    o.completed ? 4 : o.status === 'missed' ? 3 : o.task.isUrgent ? 0 : o.status === 'in_progress' ? 1 : 2
  items.sort((a, b) => rank(a) - rank(b))

  const chosen = profile[0]?.calendar_color
  return { items, color: isHexColor(chosen) ? chosen : defaultColor(me) }
}

// ─── Drawing it ─────────────────────────────────────────────────────────────

const ink = () => Color.dynamic(new Color('#18170F'), new Color('#F5F4EF'))
const muted = () => Color.dynamic(new Color('#6B6960'), new Color('#A8A69F'))
const urgent = () => Color.dynamic(new Color('#B42318'), new Color('#F97066'))

function symbol(name: string, size: number, tint: any) {
  const image = SFSymbol.named(name).image
  return { image, size: new Size(size, size), tint }
}

function message(widget: any, text: string) {
  const line = widget.addText(text)
  line.font = Font.systemFont(13)
  line.textColor = muted()
}

function drawLockScreen(widget: any, day: Day, t: Strings) {
  const open = day.items.filter((o) => !o.completed && o.status !== 'missed')
  const family = config.widgetFamily
  if (family === 'accessoryCircular') {
    const n = widget.addText(String(open.length))
    n.font = Font.boldSystemFont(22)
    n.centerAlignText()
    const label = widget.addText(t.tasks)
    label.font = Font.systemFont(9)
    label.centerAlignText()
    return
  }
  if (family === 'accessoryInline') {
    widget.addText(open.length ? `${t.today}: ${t.left(open.length)}` : t.allDone)
    return
  }
  const head = widget.addText(`FlowDesk · ${open.length ? t.left(open.length) : t.allDone}`)
  head.font = Font.semiboldSystemFont(13)
  for (const o of open.slice(0, 2)) {
    const line = widget.addText(o.task.title)
    line.font = Font.systemFont(12)
    line.lineLimit = 1
  }
}

function drawToday(widget: any, day: Day, t: Strings, appUrl: string) {
  const family = config.widgetFamily ?? 'medium'
  const accent = new Color(day.color)
  const small = family === 'small'
  const max = small ? 4 : family === 'medium' ? 5 : 12
  const open = day.items.filter((o) => !o.completed && o.status !== 'missed')

  widget.backgroundColor = Color.dynamic(new Color('#F5F4EF'), new Color('#1C1B17'))
  widget.setPadding(small ? 12 : 14, 14, 12, 14)
  widget.url = appUrl
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000)

  const header = widget.addStack()
  header.layoutHorizontally()
  header.centerAlignContent()
  const title = header.addText(t.today)
  title.font = Font.boldSystemFont(small ? 14 : 15)
  title.textColor = accent
  header.addSpacer()
  const count = header.addText(day.items.length === 0 ? '' : open.length ? t.left(open.length) : t.allDone)
  count.font = Font.mediumSystemFont(small ? 11 : 12)
  count.textColor = muted()
  widget.addSpacer(small ? 6 : 8)

  if (day.items.length === 0) {
    message(widget, t.nothing)
    widget.addSpacer()
    return
  }

  for (const o of day.items.slice(0, max)) {
    const row = widget.addStack()
    row.layoutHorizontally()
    row.centerAlignContent()
    row.spacing = 6
    const done = o.completed
    const icon = done
      ? symbol('checkmark.circle.fill', 13, accent)
      : o.status === 'missed'
        ? symbol('xmark.circle', 13, muted())
        : o.status === 'in_progress'
          ? symbol('circle.lefthalf.filled', 13, accent)
          : symbol('circle', 13, o.task.isUrgent ? urgent() : accent)
    const img = row.addImage(icon.image)
    img.imageSize = icon.size
    img.tintColor = icon.tint
    const text = row.addText(o.task.title)
    text.font = Font.systemFont(small ? 12 : 13)
    text.lineLimit = 1
    text.textColor = done || o.status === 'missed' ? muted() : o.task.isUrgent ? urgent() : ink()
    widget.addSpacer(small ? 3 : 4)
  }
  if (day.items.length > max) {
    const more = widget.addText(t.more(day.items.length - max))
    more.font = Font.systemFont(11)
    more.textColor = muted()
  }
  widget.addSpacer()
}

// ─── Running ────────────────────────────────────────────────────────────────

/**
 * Called by the stub with the address it loaded this from, which is also
 * where a tap on the widget should open.
 */
async function run(appUrl: string) {
  const t: Strings = String(Device.language()).startsWith('pt') ? STRINGS.pt : STRINGS.en
  const widget = new ListWidget()
  const lockScreen = String(config.widgetFamily ?? '').startsWith('accessory')

  let session = await currentSession()

  // Run by hand inside Scriptable: sign in, or offer the little menu.
  if (!config.runsInWidget) {
    if (!session) {
      session = await askToSignIn(t)
      if (!session) return Script.complete()
    } else {
      const menu = new Alert()
      menu.title = t.menuTitle
      menu.addAction(t.preview)
      menu.addAction(t.openApp)
      menu.addDestructiveAction(t.signOut)
      menu.addCancelAction(t.cancel)
      const choice = await menu.presentSheet()
      if (choice === 1) {
        Safari.open(appUrl)
        return Script.complete()
      }
      if (choice === 2) {
        Keychain.remove(SESSION_KEY)
        return Script.complete()
      }
      if (choice !== 0) return Script.complete()
    }
  }

  if (!session) {
    widget.url = appUrl
    message(widget, t.signedOut)
  } else {
    try {
      const day = await loadToday(session)
      if (lockScreen) drawLockScreen(widget, day, t)
      else drawToday(widget, day, t, appUrl)
    } catch (err) {
      message(widget, `${t.offline}: ${String((err as Error)?.message ?? err)}`)
      widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000)
    }
  }

  if (config.runsInWidget) Script.setWidget(widget)
  else await widget.presentMedium()
  Script.complete()
}

// The stub loads this with Scriptable's importModule, which hands back
// module.exports.
if (typeof module !== 'undefined') module.exports = run
