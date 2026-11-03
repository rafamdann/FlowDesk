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
 * Each widget shows one thing, each person's own choice made in FlowDesk
 * (Settings → Widget) and stored in widget_settings: today's tasks, their
 * to-dos, their work log or their notes. A widget's Parameter field in
 * Scriptable overrides it for that one widget ("notes"), so one person can
 * keep several widgets showing different things.
 *
 * iOS widgets cannot be ticked or typed into — Apple allows neither outside
 * a native app, and typing not even there. What can act without opening
 * anything is a Shortcuts button on the home screen, so this also answers
 * Scriptable's "Run Script" action from Shortcuts: `todos` lists the open
 * to-dos for a Choose from List, `tick: <title>` ticks one off, and
 * `log: <what> <minutes>` adds to the work log. See install.html.
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
    nothingToDo: 'Nothing to do',
    ticked: (x: string) => `Done: ${x}`,
    tickNotFound: (x: string) => `“${x}” is not on your to-do list any more.`,
    logged: (x: string, m: string) => `Logged: ${x} (${m})`,
    needTitle: 'Say what you did.',
    needMinutes: 'Add how long it took at the end, e.g. “Client call 45” or “Editing 1h30”.',
    noProject: 'There is no project to log this in.',
    notSignedIn: 'Not signed in. Open Scriptable and run FlowDesk once.',
    unknown: 'FlowDesk did not understand that. Use todos, tick: … or log: …',
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
    nothingToDo: 'Nada a fazer',
    ticked: (x: string) => `Feito: ${x}`,
    tickNotFound: (x: string) => `“${x}” já não está na sua lista.`,
    logged: (x: string, m: string) => `Registado: ${x} (${m})`,
    needTitle: 'Diga o que fez.',
    needMinutes: 'Diga no fim quanto tempo demorou, por exemplo “Chamada com cliente 45” ou “Edição 1h30”.',
    noProject: 'Não há nenhum projeto onde registar isto.',
    notSignedIn: 'Sem sessão. Abra o Scriptable e corra o FlowDesk uma vez.',
    unknown: 'O FlowDesk não percebeu. Use todos, tick: … ou log: …',
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

/** Their open to-dos, urgent and due first: what the widget lists and a shortcut picks from. */
async function openTodos(session: Session, p: Person): Promise<any[]> {
  const day = today()
  const todos = await rows(session, 'project_todos', `select=*&${ownerFilter(p)}&is_completed=eq.false&order=sort_order`)
  // Urgent, then anything due by today, then by date, then as listed.
  const rank = (r: any) => (r.is_urgent ? 0 : r.do_date && r.do_date <= day ? 1 : r.do_date ? 2 : 3)
  todos.sort((a, b) => rank(a) - rank(b) || String(a.do_date ?? '').localeCompare(String(b.do_date ?? '')))
  return todos
}

async function loadTodos(session: Session, p: Person, t: Strings, app: string): Promise<Section> {
  const day = today()
  const todos = await openTodos(session, p)
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

/** One section filling the widget, as many rows as its size has room for. */
function drawWidget(widget: any, section: Section, t: Strings, color: string, family: string) {
  widget.backgroundColor = Color.dynamic(new Color('#F5F4EF'), new Color('#1C1B17'))
  widget.setPadding(12, 14, 12, 14)
  widget.url = section.url
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000)
  const rowsFor: Record<string, number> = { small: 4, medium: 5, large: 12, extraLarge: 14 }
  drawSection(widget, section, t, new Color(color), rowsFor[family] ?? 5, family === 'small')
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

// ─── Acting from Shortcuts ──────────────────────────────────────────────────

/** Sends a write and hands back the rows it touched; RLS refusing shows as none. */
async function write(session: Session, method: 'POST' | 'PATCH', path: string, body: object): Promise<any[]> {
  const req = new Request(`${SUPABASE_URL}/rest/v1/${path}`)
  req.method = method
  req.headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${session.access}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
  req.body = JSON.stringify(body)
  const data = await req.loadJSON()
  if (!Array.isArray(data)) throw new Error(data?.message || 'not saved')
  return data
}

/** Done, as the app does it: completed now, and no longer waiting on anyone. */
async function tick(session: Session, p: Person, t: Strings, title: string): Promise<string> {
  const todo = (await openTodos(session, p)).find((r) => String(r.title ?? '').trim() === title.trim())
  if (!todo) return t.tickNotFound(title)
  const done = { is_completed: true, completed_at: new Date().toISOString() }
  let changed: any[]
  try {
    changed = await write(session, 'PATCH', `project_todos?id=eq.${todo.id}`, { ...done, waiting_since: null })
  } catch {
    // waiting_since arrives with its own migration; completing must not wait for it.
    changed = await write(session, 'PATCH', `project_todos?id=eq.${todo.id}`, done)
  }
  if (changed.length === 0) throw new Error('not allowed')
  return t.ticked(todo.title)
}

/**
 * "Client call 45", "Editing 1h30", "Reels 2h": what was done, then how long.
 * Minutes are required, as in the app — a log without time cannot answer
 * the one question it exists for.
 */
function parseLog(text: string): { title: string; minutes: number | null } {
  const unit = '(?:m|min|mins|minutes|minutos)?'
  const hours = new RegExp(`^(.*?)[\\s,·-]*(\\d+)\\s*h(?:rs?|ours?|oras?)?\\s*(?:(\\d+)\\s*${unit})?\\s*$`, 'i').exec(text)
  if (hours && hours[1].trim()) return { title: hours[1].trim(), minutes: Number(hours[2]) * 60 + Number(hours[3] ?? 0) }
  const mins = new RegExp(`^(.*?)[\\s,·-]+(\\d+)\\s*${unit}\\s*$`, 'i').exec(text)
  if (mins) return { title: mins[1].trim(), minutes: Number(mins[2]) }
  return { title: text.trim(), minutes: null }
}

async function logWork(session: Session, p: Person, t: Strings, text: string): Promise<string> {
  const { title, minutes } = parseLog(text)
  if (!title) return t.needTitle
  if (!minutes || minutes <= 0) return t.needMinutes
  // An employee's work goes on the project they are on, as in the app; the
  // owner's, on the project they last logged work for.
  const [me] = await rows(session, 'users', `select=*&id=eq.${p.id}`, true)
  let projectId: string | null = me?.project_id ?? null
  if (!projectId) {
    const [last] = await rows(session, 'work_log_entries', `select=project_id&author_id=eq.${p.id}&order=created_at.desc`, true, 1)
    projectId = last?.project_id ?? null
  }
  if (!projectId) return t.noProject
  await write(session, 'POST', 'work_log_entries', {
    project_id: projectId,
    author_id: p.id,
    worked_on: today(),
    title,
    description: '',
    minutes,
  })
  return t.logged(title, duration(minutes))
}

/** What a shortcut asked for: the Run Script action's Parameter, or else its Texts. */
function shortcutRequest(): string | null {
  if (typeof args === 'undefined') return null
  const value = args.shortcutParameter ?? (Array.isArray(args.plainTexts) ? args.plainTexts[0] : null)
  return value == null || String(value).trim() === '' ? null : String(value).trim()
}

async function answerShortcut(request: string, session: Session | null, t: Strings): Promise<unknown> {
  if (!session) return t.notSignedIn
  const { person } = await loadPerson(session)
  const [, verb, rest = ''] = /^(\w+)\s*:?\s*([\s\S]*)$/.exec(request) ?? []
  switch ((verb ?? '').toLowerCase()) {
    case 'todos': {
      const titles = (await openTodos(session, person)).map((r) => String(r.title ?? '').trim()).filter(Boolean)
      return titles.length ? titles : [t.nothingToDo]
    }
    case 'tick':
      return rest.trim() === t.nothingToDo ? t.nothingToDo : tick(session, person, t, rest)
    case 'log':
      return logWork(session, person, t, rest)
    default:
      return t.unknown
  }
}

// ─── Running ────────────────────────────────────────────────────────────────

async function loadPerson(session: Session): Promise<{ person: Person; section: WidgetSection }> {
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
  // One per widget: a widget is too small to be a dashboard.
  const section = cleanSections(param || settings[0]?.sections)[0]
  return { person: { id: me, isOwner: !!u.is_owner || u.role === 'admin', color }, section }
}

/**
 * Called by the stub with the address it loaded this from, which is also
 * where a tap on the widget should open.
 */
async function run(appUrl: string) {
  const t: Strings = String(Device.language()).startsWith('pt') ? STRINGS.pt : STRINGS.en
  const widget = new ListWidget()
  const family = String(config.widgetFamily ?? 'medium')

  let session = await currentSession()

  // Asked by a Shortcuts button: act, answer, and show nothing of our own.
  const request = config.runsInWidget ? null : shortcutRequest()
  if (request) {
    let answer: unknown
    try {
      answer = await answerShortcut(request, session, t)
    } catch (err) {
      answer = `${t.offline}: ${String((err as Error)?.message ?? err)}`
    }
    Script.setShortcutOutput(answer)
    return Script.complete()
  }

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
      const { person, section: key } = await loadPerson(session)
      const section = await LOADERS[key](session, person, t, appUrl)
      if (family.startsWith('accessory')) drawLockScreen(widget, section, t)
      else drawWidget(widget, section, t, person.color, family)
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
