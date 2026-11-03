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
 * What it shows is each person's own choice, made in FlowDesk (Settings →
 * Widget) and stored in widget_settings: today's tasks, their to-dos, their
 * work log, their notes, in any combination. A widget's Parameter field in
 * Scriptable overrides it for that one widget ("notes", "todos worklog"), so
 * one person can keep several widgets showing different things.
 *
 * Today's tasks come from the app's own scheduler on the person's own rows,
 * signed in as them: the widget can never disagree with My Tasks about what
 * today holds, and it can only see what they could.
 *
 * Built on its own (vite.widget.config.ts) into dist/widget/.
 */

import { format, parseISO } from 'date-fns'
import { taskOccurrences, setSkippedOccurrences, type TaskOccurrence, type TaskStatusRow, type TaskMoveRow } from '../utils/taskScheduler'
import { toTask, toCompletionLog } from '../store/taskRows'
import { defaultColor, isHexColor } from '../lib/personColor'
import { cleanSections, type WidgetSection } from '../lib/widgetSections'

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
declare const args: any
declare const module: any

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL
const ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY
const SESSION_KEY = 'flowdesk.widget.session'

/** How often to ask iOS for a refresh. iOS decides in the end; this is a hint. */
const REFRESH_MIN = 15

// ─── Words ──────────────────────────────────────────────────────────────────

const STRINGS = {
  en: {
    titles: { tasks: 'Today', todos: 'To-dos', worklog: 'Work log', notes: 'Notes' } as Record<WidgetSection, string>,
    empty: { tasks: 'Nothing today', todos: 'Nothing to do', worklog: 'Nothing logged today', notes: 'No notes' } as Record<WidgetSection, string>,
    left: (n: number) => `${n} left`,
    allDone: 'All done',
    loggedToday: (m: string) => `${m} today`,
    more: (n: number) => `+${n} more`,
    untitled: 'Untitled',
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
    titles: { tasks: 'Hoje', todos: 'Tarefas', worklog: 'Registo', notes: 'Notas' } as Record<WidgetSection, string>,
    empty: { tasks: 'Nada para hoje', todos: 'Nada a fazer', worklog: 'Nada registado hoje', notes: 'Sem notas' } as Record<WidgetSection, string>,
    left: (n: number) => `faltam ${n}`,
    allDone: 'Tudo feito',
    loggedToday: (m: string) => `${m} hoje`,
    more: (n: number) => `+${n}`,
    untitled: 'Sem título',
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
    expiresAt: res.expires_at ? res.expires_at * 1000 : Date.now() + res.expires_in * 1000,
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

// ─── Reading ────────────────────────────────────────────────────────────────

/** Every matching row, a thousand at a time — Supabase stops at max_rows. */
async function rows(session: Session, table: string, query: string, optional = false, max = Infinity): Promise<any[]> {
  const out: any[] = []
  const page = Math.min(1000, max)
  for (let offset = 0; ; offset += page) {
    const req = new Request(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=${page}&offset=${offset}`)
    req.headers = { apikey: ANON_KEY, Authorization: `Bearer ${session.access}` }
    const data = await req.loadJSON()
    if (!Array.isArray(data)) {
      // A table whose migration has not run: the app treats it as empty too.
      if (optional) return []
      throw new Error(data?.message || `${table} could not be read`)
    }
    out.push(...data)
    if (data.length < page || out.length >= max) return out
  }
}

/** One line in a section. */
interface Row {
  text: string
  icon: string
  tone: 'accent' | 'muted' | 'urgent'
  /** Dimmed text: done, missed, or from another day. */
  faded?: boolean
  trailing?: string
  url?: string
}

interface Section {
  key: WidgetSection
  /** Right of the title: how much is left, or logged. */
  summary: string
  rows: Row[]
  /** For the lock screen, which only has room for a number. */
  count: number
  url: string
}

interface Person {
  id: string
  isOwner: boolean
  color: string
}

/** Where a tap on each section lands. The owner's to-dos and notes live per project. */
function pathFor(key: WidgetSection, person: Person, projectId?: string | null) {
  if (!person.isOwner) return { tasks: '/employee/tasks', todos: '/employee/todos', worklog: '/employee/work-log', notes: '/employee/notes' }[key]
  if (projectId && (key === 'todos' || key === 'notes')) return `/admin/projects/${projectId}/${key}`
  return '/'
}

/** "My board": their own rows, or for the owner the shared manager board. */
const ownerFilter = (p: Person) => (p.isOwner ? 'owner_id=is.null' : `owner_id=eq.${p.id}`)

const today = () => format(new Date(), 'yyyy-MM-dd')

async function loadTasks(session: Session, p: Person, t: Strings, app: string): Promise<Section> {
  const day = today()
  // The scheduler looks back a year for untouched work; a little more, so a
  // task from the edge of that year is not counted undone for want of its log.
  const since = format(new Date(Date.now() - 400 * 86400000), 'yyyy-MM-dd')
  const mine = `employee_id=eq.${p.id}`

  const [tasks, logs, statuses, moves, skips] = await Promise.all([
    rows(session, 'tasks', 'select=*,task_assignments(employee_id)&order=id'),
    rows(session, 'completion_logs', `select=*&${mine}&due_date=gte.${since}&order=id`),
    rows(session, 'task_statuses', `select=*&${mine}&due_date=gte.${since}&order=task_id,due_date`),
    rows(session, 'task_moves', `select=*&${mine}&order=task_id,due_date`, true),
    rows(session, 'task_skips', `select=*&${mine}&order=task_id,due_date`, true),
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
    p.id,
    logs.map(toCompletionLog),
    { from: day, to: day, today: day },
    statusRows,
    365,
    moveRows,
  ).filter((o) => o.showOn === day)

  // What still needs doing first, urgent at the top; finished work last.
  const rank = (o: TaskOccurrence) =>
    o.completed ? 4 : o.status === 'missed' ? 3 : o.task.isUrgent ? 0 : o.status === 'in_progress' ? 1 : 2
  items.sort((a, b) => rank(a) - rank(b))

  const open = items.filter((o) => !o.completed && o.status !== 'missed').length
  const url = app + pathFor('tasks', p)
  return {
    key: 'tasks',
    summary: items.length === 0 ? '' : open ? t.left(open) : t.allDone,
    count: open,
    url,
    rows: items.map((o) => ({
      text: o.task.title,
      icon: o.completed
        ? 'checkmark.circle.fill'
        : o.status === 'missed'
          ? 'xmark.circle'
          : o.status === 'in_progress'
            ? 'circle.lefthalf.filled'
            : 'circle',
      tone: o.status === 'missed' ? 'muted' : !o.completed && o.task.isUrgent ? 'urgent' : 'accent',
      faded: o.completed || o.status === 'missed',
      url,
    })),
  }
}

async function loadTodos(session: Session, p: Person, t: Strings, app: string): Promise<Section> {
  const day = today()
  const todos = (await rows(session, 'project_todos', `select=*&${ownerFilter(p)}&is_completed=eq.false&order=sort_order`))
  // Urgent, then anything due by today, then by date, then as listed.
  const rank = (r: any) => (r.is_urgent ? 0 : r.do_date && r.do_date <= day ? 1 : r.do_date ? 2 : 3)
  todos.sort((a, b) => rank(a) - rank(b) || String(a.do_date ?? '').localeCompare(String(b.do_date ?? '')))
  return {
    key: 'todos',
    summary: todos.length ? t.left(todos.length) : '',
    count: todos.length,
    url: app + pathFor('todos', p),
    rows: todos.map((r) => ({
      text: r.title || t.untitled,
      icon: 'square',
      tone: r.is_urgent ? 'urgent' : 'accent',
      trailing: r.do_date && r.do_date !== day ? format(parseISO(r.do_date), 'd MMM') : undefined,
      url: app + pathFor('todos', p, r.project_id),
    })),
  }
}

function duration(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

async function loadWorkLog(session: Session, p: Person, t: Strings, app: string): Promise<Section> {
  const day = today()
  const entries = await rows(
    session,
    'work_log_entries',
    `select=id,title,minutes,worked_on&author_id=eq.${p.id}&order=worked_on.desc,created_at.desc`,
    false,
    30,
  )
  const todays = entries.filter((e) => e.worked_on === day)
  const total = todays.reduce((sum, e) => sum + (e.minutes ?? 0), 0)
  const url = app + pathFor('worklog', p)
  // Today's entries, then the most recent before them, marked with their day.
  return {
    key: 'worklog',
    summary: total ? t.loggedToday(duration(total)) : '',
    count: todays.length,
    url,
    rows: entries.map((e) => ({
      text: e.worked_on === day ? e.title : `${format(parseISO(e.worked_on), 'EEE')} · ${e.title}`,
      icon: 'clock',
      tone: 'accent',
      faded: e.worked_on !== day,
      trailing: e.minutes ? duration(e.minutes) : undefined,
      url,
    })),
  }
}

/** A note's first words, from its title or else its text. */
function noteLine(n: any, t: Strings) {
  if (n.title?.trim()) return n.title.trim()
  const text = String(n.content || n.body || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text || t.untitled
}

async function loadNotes(session: Session, p: Person, t: Strings, app: string): Promise<Section> {
  const notes = (await rows(session, 'project_notes', `select=*&${ownerFilter(p)}&order=updated_at.desc`)).filter(
    (n) => !n.is_archived,
  )
  // Pinned first, as on the board; otherwise most recently changed.
  notes.sort((a, b) => Number(!!b.is_pinned) - Number(!!a.is_pinned))
  return {
    key: 'notes',
    summary: '',
    count: notes.length,
    url: app + pathFor('notes', p),
    rows: notes.map((n) => ({
      text: noteLine(n, t),
      icon: n.is_pinned ? 'pin.fill' : 'note.text',
      tone: 'accent',
      url: app + pathFor('notes', p, n.project_id),
    })),
  }
}

const LOADERS: Record<WidgetSection, typeof loadTasks> = {
  tasks: loadTasks,
  todos: loadTodos,
  worklog: loadWorkLog,
  notes: loadNotes,
}

// ─── Drawing ────────────────────────────────────────────────────────────────

const ink = () => Color.dynamic(new Color('#18170F'), new Color('#F5F4EF'))
const muted = () => Color.dynamic(new Color('#6B6960'), new Color('#A8A69F'))
const urgent = () => Color.dynamic(new Color('#B42318'), new Color('#F97066'))

function message(container: any, text: string, size = 13) {
  const line = container.addText(text)
  line.font = Font.systemFont(size)
  line.textColor = muted()
}

/** One section into a widget or a column: title, summary, then up to `max` rows. */
function drawSection(container: any, s: Section, t: Strings, accent: any, max: number, compact: boolean) {
  const header = container.addStack()
  header.layoutHorizontally()
  header.centerAlignContent()
  header.url = s.url
  const title = header.addText(t.titles[s.key])
  title.font = Font.boldSystemFont(compact ? 13 : 15)
  title.textColor = accent
  header.addSpacer()
  if (s.summary) {
    const summary = header.addText(s.summary)
    summary.font = Font.mediumSystemFont(compact ? 10 : 12)
    summary.textColor = muted()
    summary.lineLimit = 1
  }
  container.addSpacer(compact ? 4 : 6)

  if (s.rows.length === 0) {
    message(container, t.empty[s.key], compact ? 11 : 13)
    return
  }

  // Room for "+N more" comes out of the rows, so the widget never overflows.
  const shown = s.rows.length > max ? s.rows.slice(0, Math.max(1, max - 1)) : s.rows
  for (const r of shown) {
    const row = container.addStack()
    row.layoutHorizontally()
    row.centerAlignContent()
    row.spacing = 6
    if (r.url) row.url = r.url
    const img = row.addImage(SFSymbol.named(r.icon).image)
    img.imageSize = new Size(compact ? 11 : 13, compact ? 11 : 13)
    img.tintColor = r.tone === 'urgent' ? urgent() : r.tone === 'muted' ? muted() : accent
    const text = row.addText(r.text)
    text.font = Font.systemFont(compact ? 12 : 13)
    text.lineLimit = 1
    text.textColor = r.faded ? muted() : r.tone === 'urgent' ? urgent() : ink()
    if (r.trailing) {
      row.addSpacer()
      const tail = row.addText(r.trailing)
      tail.font = Font.systemFont(compact ? 10 : 11)
      tail.textColor = muted()
      tail.lineLimit = 1
    }
    container.addSpacer(compact ? 3 : 4)
  }
  if (shown.length < s.rows.length) message(container, t.more(s.rows.length - shown.length), compact ? 10 : 11)
}

/**
 * Small: the first section. Medium: one section, or the first two side by
 * side. Large: every section, one under the other, sharing the rows.
 */
function drawWidget(widget: any, sections: Section[], t: Strings, color: string, app: string, family: string) {
  const accent = new Color(color)
  widget.backgroundColor = Color.dynamic(new Color('#F5F4EF'), new Color('#1C1B17'))
  widget.setPadding(12, 14, 12, 14)
  widget.url = sections[0]?.url ?? app
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000)

  if (family === 'small') {
    drawSection(widget, sections[0], t, accent, 4, true)
  } else if (family === 'medium') {
    if (sections.length === 1) drawSection(widget, sections[0], t, accent, 5, false)
    else {
      const columns = widget.addStack()
      columns.layoutHorizontally()
      columns.spacing = 14
      // Fixed widths, or a column of long titles takes the whole widget. A
      // medium widget is the screen less about 26pt each side.
      const width = Math.floor((Device.screenSize().width - 52 - 28 - 14) / 2)
      sections.slice(0, 2).forEach((s) => {
        const col = columns.addStack()
        col.layoutVertically()
        col.size = new Size(width, 0)
        drawSection(col, s, t, accent, 5, true)
        col.addSpacer()
      })
    }
  } else {
    const budget = family === 'extraLarge' ? 14 : 12
    const each = Math.max(2, Math.floor(budget / sections.length))
    sections.forEach((s, i) => {
      if (i > 0) widget.addSpacer(8)
      drawSection(widget, s, t, accent, each, sections.length > 2)
    })
  }
  widget.addSpacer()
}

function drawLockScreen(widget: any, s: Section, t: Strings) {
  const family = config.widgetFamily
  widget.url = s.url
  if (family === 'accessoryCircular') {
    const n = widget.addText(String(s.count))
    n.font = Font.boldSystemFont(22)
    n.centerAlignText()
    const label = widget.addText(t.titles[s.key])
    label.font = Font.systemFont(9)
    label.centerAlignText()
    return
  }
  if (family === 'accessoryInline') {
    widget.addText(`${t.titles[s.key]}: ${s.summary || s.count}`)
    return
  }
  const head = widget.addText(`${t.titles[s.key]}${s.summary ? ` · ${s.summary}` : ''}`)
  head.font = Font.semiboldSystemFont(13)
  for (const r of s.rows.filter((r) => !r.faded).slice(0, 2)) {
    const line = widget.addText(r.text)
    line.font = Font.systemFont(12)
    line.lineLimit = 1
  }
}

// ─── Running ────────────────────────────────────────────────────────────────

async function loadPerson(session: Session): Promise<{ person: Person; sections: WidgetSection[] }> {
  const me = session.userId
  const [profile, settings] = await Promise.all([
    // '*' rather than naming columns: a column whose migration has not run
    // would fail the whole read.
    rows(session, 'users', `select=*&id=eq.${me}`, true),
    rows(session, 'widget_settings', `select=sections&user_id=eq.${me}`, true),
  ])
  const u = profile[0] ?? {}
  const color = isHexColor(u.calendar_color) ? u.calendar_color : defaultColor(me)
  // This widget's own Parameter, if it has one, wins over the saved choice.
  const param = typeof args !== 'undefined' ? args.widgetParameter : null
  const sections = cleanSections(param || settings[0]?.sections)
  return { person: { id: me, isOwner: !!u.is_owner || u.role === 'admin', color }, sections }
}

/**
 * Called by the stub with the address it loaded this from, which is also
 * where a tap on the widget should open.
 */
async function run(appUrl: string) {
  const t: Strings = String(Device.language()).startsWith('pt') ? STRINGS.pt : STRINGS.en
  const widget = new ListWidget()
  // Run by hand there is no family: the preview is large, so it shows
  // everything they picked.
  const family = String(config.widgetFamily ?? (config.runsInWidget ? 'medium' : 'large'))

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
      const { person, sections: wanted } = await loadPerson(session)
      // Only what this size can show is fetched.
      const fits = family === 'small' || family.startsWith('accessory') ? 1 : family === 'medium' ? 2 : 4
      const sections = await Promise.all(wanted.slice(0, fits).map((k) => LOADERS[k](session!, person, t, appUrl)))
      if (family.startsWith('accessory')) drawLockScreen(widget, sections[0], t)
      else drawWidget(widget, sections, t, person.color, appUrl, family)
    } catch (err) {
      message(widget, `${t.offline}: ${String((err as Error)?.message ?? err)}`)
      widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000)
    }
  }

  if (config.runsInWidget) Script.setWidget(widget)
  else await (family === 'large' ? widget.presentLarge() : widget.presentMedium())
  Script.complete()
}

// The stub loads this with Scriptable's importModule, which hands back
// module.exports.
if (typeof module !== 'undefined') module.exports = run
