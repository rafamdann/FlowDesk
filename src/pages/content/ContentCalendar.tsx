import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, AlertTriangle, Check, FileText, ArrowRight, Archive, GripVertical, X } from 'lucide-react'
import { ContentClient, ContentOneOff } from '../../types'
import { addDays, mondayOf, monthBounds, shiftMonth, todayKey } from '../../utils/contentPipeline'
import { ContentStrings, useContentT } from '../../i18n/content'
import {
  ClientDialog, codesOf, ContentTask, ContentTaskKind, groupBatches, KIND_COLOR, moveTask, OneOffDialog,
  PlanViewer, toggleTask,
  inProject, useContentBase, useContentData, useContentProject, useContentTasks, usePersonName,
} from '../../components/content/contentShared'
import { wash } from '../../lib/personColor'

/** The stages drawn as blocks in a day, in the order a day runs. */
const WORK_KINDS: ContentTaskKind[] = ['schedule', 'plan', 'record', 'edit', 'deliver']

/**
 * Each client once, in the order they first appear.
 *
 * A one-off task that is about nobody carries a stand-in client with an empty
 * id, which is skipped here: it has no name to put in a week's title and no
 * profile to link to, and letting it through produced stray separators in
 * "SHZ + TAS" and a link to nowhere.
 */
function clientsOf(tasks: ContentTask[]) {
  const seen = new Map<string, ContentClient>()
  for (const t of tasks) {
    for (const m of t.members ?? [t]) if (m.client.id && !seen.has(m.client.id)) seen.set(m.client.id, m.client)
  }
  return [...seen.values()]
}

/**
 * What a week is, named after what gets shot in it: "Shazia Saima + Sra
 * Tasca", "ESP, OKU, DER, OLU". A week with no shooting or editing is light.
 */
function weekType(tasks: ContentTask[], light: string, c: ContentStrings) {
  const shot = clientsOf(tasks.filter((t) => t.kind === 'record'))
  if (shot.length) return shot.length <= 2 ? shot.map((cl) => cl.name).join(' + ') : codesOf(shot)
  if (tasks.some((t) => t.kind === 'edit')) return c.typeEditing(codesOf(clientsOf(tasks.filter((t) => t.kind === 'edit'))))
  if (tasks.some((t) => t.kind === 'schedule' || t.kind === 'deliver')) return light
  if (tasks.some((t) => t.kind === 'plan')) return c.typePlanning
  return ''
}

/**
 * One day of work in a few words, as the rhythm table writes it: "Schedule
 * SHZ + TAS, record DIA", "Edit + deliver DIA".
 */
function dayLabel(tasks: ContentTask[], c: ContentStrings) {
  const parts: { verbs: string[]; who: string }[] = []
  for (const kind of WORK_KINDS) {
    const of = tasks.filter((t) => t.kind === kind)
    if (!of.length) continue
    const who = codesOf(clientsOf(of))
    const prev = parts[parts.length - 1]
    // The same clients twice in a row read as one job: "Edit + deliver DIA".
    if (prev && prev.who === who) prev.verbs.push(c.verb[kind].toLowerCase())
    else parts.push({ verbs: [c.verb[kind]], who })
  }
  return parts
    .map((p, i) => {
      const verbs = p.verbs.join(' + ')
      return `${i === 0 ? verbs : verbs.charAt(0).toLowerCase() + verbs.slice(1)} ${p.who}`
    })
    .join(', ')
}

/**
 * A project's content calendar: its clients' plans, shoots, edits,
 * deliveries, scheduling and posts on one month. Shaped after the agency's
 * October plan — a month you can read at a glance, filtered to one client
 * with a click, with the same work as a week-by-week checklist underneath.
 */
export function ContentCalendar() {
  const data = useContentData()
  const project = useContentProject()
  const base = useContentBase()
  const nameOf = usePersonName()
  const { c, fmt } = useContentT()
  const [params, setParams] = useSearchParams()

  const today = todayKey()
  const month = params.get('m') ? `${params.get('m')}-01` : monthBounds(today).first
  /**
   * Which clients are on screen. A comma-separated list in the address, empty
   * meaning all of them.
   *
   * It used to be one id or the word "all", so the calendar could show one
   * client or the whole agency and nothing in between — and three clients at
   * once is exactly the question a month is read to answer.
   */
  const selected = useMemo(() => {
    const raw = params.get('c')
    return new Set((raw && raw !== 'all' ? raw.split(',') : []).filter(Boolean))
  }, [params])
  const { first, last } = monthBounds(month)
  const gridStart = mondayOf(first)
  const gridEnd = addDays(mondayOf(last), 6)

  const [adding, setAdding] = useState(false)
  const [viewing, setViewing] = useState<ContentTask | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  /** A one-off being added on a day, or an existing one being changed. */
  const [oneOff, setOneOff] = useState<{ day: string; task: ContentOneOff | null } | null>(null)
  const [moveError, setMoveError] = useState('')

  // Well past the month, so a batch shot this month can be followed to its
  // last post, and the rhythm table has the weeks after it.
  const { flows, tasks } = useContentTasks(addDays(gridEnd, 120), project)

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v === null) next.delete(k)
    else next.set(k, v)
    setParams(next, { replace: true })
  }

  /** Add or remove one client from the view, leaving the others as they are. */
  const toggleClient = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setParam('c', next.size ? [...next].join(',') : null)
  }

  const own = data.clients.filter((cl) => inProject(cl, project))
  const active = own.filter((cl) => !cl.isArchived)
  const archived = own.filter((cl) => cl.isArchived)
  // The "showing only X, open their profile" line still makes sense with one
  // client picked, and stops making sense with three.
  const current = selected.size === 1 ? active.find((cl) => selected.has(cl.id)) ?? null : null

  const shown = useMemo(
    () =>
      tasks.filter((t) => {
        if (selected.size === 0) return true
        // A one-off about nobody belongs to the calendar rather than to any
        // client, so it stays visible while the view is narrowed: hiding it
        // would be hiding work that no filter could ever bring back.
        if (t.kind === 'oneoff' && !t.client.id) return true
        return selected.has(t.client.id)
      }),
    [tasks, selected],
  )
  const byDay = useMemo(() => {
    const m = new Map<string, ContentTask[]>()
    for (const t of shown) (m.get(t.day) ?? m.set(t.day, []).get(t.day)!).push(t)
    return m
  }, [shown])

  // ─── Dragging one day of work to another ─────────────────────────────────
  // Pointer events rather than HTML5 drag-and-drop, matching the task
  // calendar: the same gesture works with a finger, and a drag that has not
  // passed the threshold yet is still a click on the block.
  const [drag, setDrag] = useState<{ task: ContentTask; label: string } | null>(null)
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null)
  const [hoverDay, setHoverDay] = useState<string | null>(null)
  // Set when a drag ends, so the click that follows the pointerup does not
  // also fire "add a one-off here" on the day it was dropped on.
  const justDragged = useRef(false)

  /** The day under a point, from the cells' own data-day. */
  const dayUnder = (x: number, y: number) =>
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-day]')?.dataset.day ?? null

  /**
   * Begin a drag, but only once the pointer has actually travelled: a block is
   * a thing to tick off and open as well as a thing to move, and a drag that
   * started on pointerdown would eat every one of those clicks.
   */
  const startDrag = (task: ContentTask, label: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const { clientX: sx, clientY: sy } = e
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 4) return
      window.removeEventListener('pointermove', onMove)
      setDrag({ task, label })
      setDragPoint({ x: ev.clientX, y: ev.clientY })
      setHoverDay(dayUnder(ev.clientX, ev.clientY))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onMove), { once: true })
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      setDragPoint({ x: e.clientX, y: e.clientY })
      setHoverDay(dayUnder(e.clientX, e.clientY))
    }
    const up = (e: PointerEvent) => {
      const day = dayUnder(e.clientX, e.clientY)
      const task = drag.task
      setDrag(null)
      setDragPoint(null)
      setHoverDay(null)
      justDragged.current = true
      // Cleared on the next frame, once the click that follows this pointerup
      // has been and gone.
      requestAnimationFrame(() => { justDragged.current = false })
      if (!day || day === task.day) return
      setBusy(task.key)
      setMoveError('')
      moveTask(task, day)
        .catch(() => setMoveError(c.couldNotMove))
        .finally(() => setBusy(null))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, c])

  const tick = async (t: ContentTask, done: boolean) => {
    setBusy(t.key)
    try {
      await toggleTask(t, done)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Only a project that has the content calendar shows it; the rest go back
  // to the project's own start.
  if (!project) return null
  if (!project.hasContentCalendar) {
    return <Navigate to={base.startsWith('/admin') ? `/admin/projects/${project.id}` : '/employee/tasks'} replace />
  }
  if (!data.loaded) return <p className="text-text-muted text-sm py-8">{c.loading}</p>
  if (data.error) {
    return (
      <div className="max-w-xl py-10">
        <h1 className="text-2xl font-bold text-text-main">{c.title}</h1>
        <p className="text-sm text-text-muted mt-2">
          {c.notSetUpBefore}{' '}
          <code className="text-xs bg-surface-2 px-1 py-0.5 rounded">20261016000000_content_calendar.sql</code>{' '}
          {c.notSetUpAfter}
        </p>
        <p className="text-xs text-text-subtle mt-3">{data.error}</p>
      </div>
    )
  }

  const dayMonth = (d: string) => fmt(d, { day: 'numeric', month: 'short' })
  // Lower case inside a sentence in Portuguese ("em outubro"), so the title
  // capitalises its own copy.
  const monthName = fmt(first, { month: 'long' })
  const monthTitle = monthName.charAt(0).toUpperCase() + monthName.slice(1)
  const year = first.slice(0, 4)
  const weeks: { from: string; to: string }[] = []
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 7)) weeks.push({ from: d, to: addDays(d, 6) })
  const days: string[] = []
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d)
  const rhythm = Array.from({ length: 8 }, (_, i) => addDays(gridEnd, 1 + i * 7))

  const visibleClients = selected.size === 0 ? active : active.filter((cl) => selected.has(cl.id))

  return (
    <div className="text-text-main">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <header>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <h1 className="text-6xl md:text-8xl font-extrabold tracking-tighter leading-[0.9]">
            {monthTitle}
            <span className="text-text-subtle text-3xl md:text-4xl font-bold tracking-tight ml-3">{year}</span>
          </h1>
          <div className="flex items-center gap-1 pb-2">
            <button
              onClick={() => setParam('m', shiftMonth(first, -1).slice(0, 7))}
              className="p-2 rounded-lg border border-border-md bg-surface hover:bg-surface-2"
              title={c.prevMonth}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setParam('m', null)}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-border-md bg-surface hover:bg-surface-2"
            >
              {c.today}
            </button>
            <button
              onClick={() => setParam('m', shiftMonth(first, 1).slice(0, 7))}
              className="p-2 rounded-lg border border-border-md bg-surface hover:bg-surface-2"
              title={c.nextMonth}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <p className="max-w-[62ch] text-text-muted mt-4 text-[1.05rem]">{c.lede(active.length)}</p>

        {/* Each client is its own switch, so any set of them can be on at once.
            "All clients" is not one of the switches — it is the way back to
            none of them being on. */}
        <ul className="flex flex-wrap gap-2 mt-6">
          <li>
            <ChipButton pressed={selected.size === 0} onClick={() => setParam('c', null)}>
              {c.allClients}
            </ChipButton>
          </li>
          {active.map((cl) => (
            <li key={cl.id}>
              <ChipButton pressed={selected.has(cl.id)} color={cl.color} onClick={() => toggleClient(cl.id)}>
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: cl.color }} />
                {cl.name}
                <small className="font-normal text-text-muted">{c.perMonth(cl.postsPerMonth)}</small>
                {selected.has(cl.id) && <Check size={13} style={{ color: cl.color }} />}
              </ChipButton>
            </li>
          ))}
          <li>
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-md border border-dashed border-border-md text-text-muted hover:text-text-main hover:border-text-muted"
            >
              <Plus size={14} /> {c.newClient}
            </button>
          </li>
        </ul>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 min-h-[1.5rem]">
          <p className="text-sm text-text-muted" aria-live="polite">
            {current ? (
              <>
                {c.showingOnly(current.name)}{' '}
                <Link to={`${base}/${current.id}`} className="font-semibold text-primary hover:underline">
                  {c.openProfile}
                </Link>
              </>
            ) : selected.size > 0 ? (
              <>
                {c.showingClients(selected.size, active.length)}{' '}
                <button onClick={() => setParam('c', null)} className="font-semibold text-primary hover:underline">
                  {c.clearFilter}
                </button>
              </>
            ) : (
              c.showingAll
            )}
          </p>
          <p className="text-xs text-text-subtle">{c.dragHint}</p>
        </div>
      </header>

      {active.length === 0 && (
        <div className="mt-10 border border-dashed border-border-md rounded-lg p-8 text-center bg-surface">
          <p className="font-semibold">{c.noClients}</p>
          <p className="text-sm text-text-muted mt-1 max-w-md mx-auto">{c.noClientsBody}</p>
          <button
            onClick={() => setAdding(true)}
            className="mt-4 inline-flex items-center gap-1.5 bg-primary text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-primary-dark"
          >
            <Plus size={15} /> {c.addFirstClient}
          </button>
        </div>
      )}

      {/* ─── Calendar ───────────────────────────────────────────────────── */}
      <h2 className="text-2xl font-extrabold tracking-tight mt-12 mb-3">{c.calendar}</h2>
      <div className="overflow-x-auto border border-border-md rounded-md bg-surface">
        <div className="grid grid-cols-7 min-w-[900px]">
          {c.dow.map((d) => (
            <div key={d} className="px-2.5 py-2 text-xs font-semibold text-text-muted border-b border-border-md bg-surface-2/60">
              {d}
            </div>
          ))}
          {days.map((d, i) => {
            const out = d < first || d > last
            const list = byDay.get(d) ?? []
            const work = groupBatches(list.filter((t) => t.kind !== 'post'), c)
            const posts = list.filter((t) => t.kind === 'post')
            return (
              <div
                key={d}
                // What a drop lands on, and what a click adds a one-off to.
                data-day={d}
                onClick={() => { if (!justDragged.current) setOneOff({ day: d, task: null }) }}
                title={c.addOneOffHere}
                className={`group/day relative min-h-[130px] p-2 pb-2.5 flex flex-col gap-1.5 border-b border-border-md cursor-pointer ${
                  (i + 1) % 7 ? 'border-r' : ''
                } ${out ? 'bg-surface-2/50' : ''} ${
                  // The day a drop would land on. Ringed inside, so the grid's
                  // own lines do not move while something is being dragged.
                  hoverDay === d && drag ? 'ring-2 ring-inset ring-primary bg-primary-light/40' : ''
                }`}
              >
                <div className="flex justify-between items-baseline">
                  <span
                    className={`font-extrabold text-[1.05rem] ${out ? 'text-text-subtle' : ''} ${
                      d === today ? 'bg-primary text-white rounded px-1.5 -ml-0.5' : ''
                    }`}
                  >
                    {Number(d.slice(8))}
                  </span>
                  {out && <span className="text-[10px] font-medium text-text-subtle">{fmt(d, { month: 'short' })}</span>}
                </div>
                {work.map((t) => (
                  <TaskBlock
                    key={t.key}
                    task={t}
                    busy={busy === t.key}
                    onTick={tick}
                    onView={setViewing}
                    onEditOneOff={(o) => setOneOff({ day: o.day, task: o })}
                    onDragStart={startDrag(t, t.title)}
                    dragging={drag?.task.key === t.key}
                    base={base}
                    nameOf={nameOf}
                  />
                ))}
                {posts.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-auto">
                    {posts.map((t) => (
                      <PostTag
                        key={t.key}
                        task={t}
                        busy={busy === t.key}
                        onTick={tick}
                        onDragStart={startDrag(t, t.tag ?? t.title)}
                        dragging={drag?.task.key === t.key}
                        nameOf={nameOf}
                      />
                    ))}
                  </div>
                )}

                {/* The way in is the whole cell; this is what says so. It only
                    appears on hover, so an empty month is not a grid of
                    plus signs. */}
                <span className="absolute top-1.5 right-1.5 opacity-0 group-hover/day:opacity-100 text-text-subtle transition-opacity">
                  <Plus size={13} />
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[0.82rem] text-text-muted mt-2.5">
        {(['plan', 'record', 'edit', 'deliver', 'schedule'] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <i className="inline-block w-[3px] h-3.5" style={{ backgroundColor: KIND_COLOR[k] }} />
            {c.stage[k]}
          </span>
        ))}
        <span>{c.legendPosts}</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-[10px] font-semibold px-1.5 rounded-sm border border-dashed border-text-muted">ESP —</span>
          {c.legendEmpty}
        </span>
      </div>

      {/* ─── Week by week ───────────────────────────────────────────────── */}
      <h2 className="text-2xl font-extrabold tracking-tight mt-12 mb-3">{c.weekByWeek}</h2>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(270px,1fr))]">
        {weeks.map((w, i) => {
          const inWeek = shown.filter((t) => t.day >= w.from && t.day <= w.to)
          const work = groupBatches(inWeek.filter((t) => t.kind !== 'post'), c)
          const posts = inWeek.filter((t) => t.kind === 'post')
          const postDays = [...new Set(posts.map((t) => t.day))]
          const light = !inWeek.some((t) => t.kind === 'record' || t.kind === 'edit')
          const type = weekType(work, c.typeScheduleAndPost, c) || (posts.length ? c.typePosting : '')
          const left = [...work, ...posts].filter((t) => !t.done).length
          return (
            <section
              key={w.from}
              className={`rounded-md p-4 ${light ? 'border border-dashed border-border-md' : 'bg-surface border border-border-md'}`}
            >
              <h3 className="font-semibold">
                {c.week(i + 1)}
                {type && ` · ${type}`}
              </h3>
              <div className="text-sm text-text-muted mb-2.5">
                {dayMonth(w.from)} – {dayMonth(w.to)}
                {work.length + posts.length > 0 && ` · ${c.toDo(left, work.length + posts.length)}`}
              </div>
              {work.length === 0 && posts.length === 0 && <p className="text-sm text-text-muted">{c.nothingThisWeek}</p>}
              {work.length > 0 && (
                <ul>
                  {work.map((t) => (
                    <li key={t.key} className="grid grid-cols-[auto_1fr] gap-2.5 items-start py-1.5 border-t border-border first:border-t-0 text-sm">
                      <input
                        id={`wk-${t.key}`}
                        type="checkbox"
                        checked={t.done}
                        disabled={busy === t.key}
                        onChange={(e) => tick(t, e.target.checked)}
                        className="mt-1 w-4 h-4 accent-primary cursor-pointer"
                      />
                      <label htmlFor={`wk-${t.key}`} className={`cursor-pointer ${t.done ? 'line-through text-text-muted' : ''}`}>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-flex gap-0.5">
                            {clientsOf([t]).map((cl) => (
                              <span key={cl.id} className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: cl.color }} />
                            ))}
                          </span>
                          {t.title}
                        </span>
                        <em className="not-italic text-text-muted text-xs block">
                          {fmt(t.day)} · {t.detail}
                          {nameOf(t.assigneeId) ? ` · ${nameOf(t.assigneeId)}` : ''}
                        </em>
                        {t.warning && !t.done && (
                          <em className="not-italic text-warning text-xs flex items-center gap-1">
                            <AlertTriangle size={11} /> {t.warning}
                          </em>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {postDays.length > 0 && (
                <div className={work.length ? 'mt-2 pt-2 border-t border-border' : ''}>
                  <p className="text-xs font-medium text-text-muted mb-1">{c.postsGoingLive}</p>
                  {postDays.map((day) => (
                    <div key={day} className="flex items-start gap-2 py-0.5">
                      <span className="text-xs text-text-muted w-14 flex-shrink-0 pt-px">
                        {fmt(day, { weekday: 'short', day: 'numeric' })}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {posts
                          .filter((t) => t.day === day)
                          .map((t) => (
                            <PostTag key={t.key} task={t} busy={busy === t.key} onTick={tick} nameOf={nameOf} />
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {/* ─── Posting schedule ───────────────────────────────────────────── */}
      {visibleClients.length > 0 && (
        <>
          <h2 className="text-2xl font-extrabold tracking-tight mt-12 mb-3">{c.postingSchedule}</h2>
          <p className="text-sm text-text-muted max-w-[70ch] mb-4">{c.postingNote}</p>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
            {visibleClients.map((cl) => {
              const slots = (flows[cl.id]?.slots ?? []).filter((s) => s.day >= first && s.day <= last)
              return (
                <div key={cl.id}>
                  <h3 className="font-semibold mb-1.5 flex items-center gap-2">
                    <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: cl.color }} />
                    <Link to={`${base}/${cl.id}`} className="hover:underline">
                      {cl.name}
                    </Link>
                  </h3>
                  <div className="overflow-x-auto bg-surface border border-border-md rounded-md">
                    {slots.length === 0 ? (
                      <p className="text-sm text-text-muted p-3">{c.noPostingDaysIn(monthName)}</p>
                    ) : (
                      <table className="w-full text-[0.85rem] border-collapse">
                        <thead>
                          <tr className="bg-surface-2/60 text-text-muted">
                            <th className="text-left font-semibold px-3 py-2">{c.colPiece}</th>
                            <th className="text-left font-semibold px-3 py-2">{c.colGoesLive}</th>
                            <th className="text-left font-semibold px-3 py-2">{c.colBatch}</th>
                            <th className="px-2 py-2" aria-label={c.colPosted} />
                          </tr>
                        </thead>
                        <tbody>
                          {slots.map((s) => (
                            <tr key={s.day} className="border-t border-border">
                              <td className="px-3 py-1.5 font-semibold whitespace-nowrap" style={{ color: s.piece ? cl.color : undefined }}>
                                {s.piece ? `${cl.code} ${String(s.piece.n).padStart(2, '0')}` : <span className="text-warning">{c.nothingReady}</span>}
                              </td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{fmt(s.day)}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
                                {s.piece ? c.shotOn(dayMonth(s.piece.recordedOn)) : '—'}
                              </td>
                              <td className="px-2 py-1.5">{s.done && <Check size={14} className="text-success" />}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ─── The rhythm after this month ────────────────────────────────── */}
      {active.length > 0 && (
        <>
          <h2 className="text-2xl font-extrabold tracking-tight mt-12 mb-3">{c.rhythmAfter(monthName)}</h2>
          <p className="text-sm text-text-muted max-w-[70ch] mb-4">{c.rhythmNote}</p>
          <div className="overflow-x-auto bg-surface border border-border-md rounded-md">
            <table className="w-full text-[0.85rem] border-collapse">
              <thead>
                <tr className="bg-surface-2/60 text-text-muted">
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">{c.colWeekOf}</th>
                  <th className="text-left font-semibold px-3 py-2">{c.colType}</th>
                  {c.dow.map((d) => (
                    <th key={d} className="text-left font-semibold px-3 py-2">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rhythm.map((from) => {
                  const to = addDays(from, 6)
                  const inWeek = shown.filter((t) => t.kind !== 'post' && t.day >= from && t.day <= to)
                  return (
                    <tr key={from} className="border-t border-border align-top">
                      <td className="px-3 py-2 font-semibold whitespace-nowrap">{dayMonth(from)}</td>
                      <td className="px-3 py-2 min-w-[140px]">
                        {weekType(inWeek, c.typeLight, c) || <span className="text-text-subtle">{c.nothingBooked}</span>}
                      </td>
                      {c.dow.map((_, i) => {
                        const label = dayLabel(inWeek.filter((t) => t.day === addDays(from, i)), c)
                        return (
                          <td key={i} className="px-3 py-2 min-w-[110px]">
                            {label || <span className="text-text-subtle">{c.free}</span>}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ─── Clients ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mt-12 mb-3">
        <h2 className="text-2xl font-extrabold tracking-tight">{c.clients}</h2>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 bg-primary text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-primary-dark"
        >
          <Plus size={15} /> {c.newClient}
        </button>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
        {(showArchived ? [...active, ...archived] : active).map((cl) => {
          const next = data.recordings
            .filter((r) => r.clientId === cl.id && r.recordedOn >= today)
            .sort((a, b) => a.recordedOn.localeCompare(b.recordedOn))[0]
          return (
            <Link
              key={cl.id}
              to={`${base}/${cl.id}`}
              className={`group bg-surface border border-border-md rounded-md p-4 border-t-4 hover:shadow-sm transition-shadow ${cl.isArchived ? 'opacity-60' : ''}`}
              style={{ borderTopColor: cl.color }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{cl.name}</p>
                  <p className="text-xs text-text-muted truncate">
                    {cl.code}
                    {cl.handle ? ` · ${cl.handle}` : ''}
                    {cl.isArchived ? ` · ${c.archivedTag}` : ''}
                  </p>
                </div>
                <ArrowRight size={16} className="text-text-subtle group-hover:text-text-main flex-shrink-0 mt-0.5" />
              </div>
              <p className="text-2xl font-extrabold mt-2 leading-none">
                {cl.postsPerMonth}
                <span className="text-sm font-medium text-text-muted">{c.postsAMonthSuffix(cl.postsPerMonth)}</span>
              </p>
              <p className="text-xs text-text-muted mt-2">{next ? c.nextShootOn(fmt(next.recordedOn)) : c.noShootBooked}</p>
            </Link>
          )
        })}
      </div>
      {archived.length > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="mt-3 text-sm text-text-muted hover:text-text-main inline-flex items-center gap-1.5"
        >
          <Archive size={14} /> {c.toggleArchived(showArchived, archived.length)}
        </button>
      )}

      {adding && <ClientDialog client={null} projectId={project.id} onClose={() => setAdding(false)} />}
      {viewing?.recording && <PlanViewer recording={viewing.recording} client={viewing.client} onClose={() => setViewing(null)} />}
      {oneOff && (
        <OneOffDialog
          task={oneOff.task}
          day={oneOff.day}
          projectId={project.id}
          onClose={() => setOneOff(null)}
        />
      )}

      {/* What is being dragged, following the pointer. Nothing is listening on
          it — it is there so the hand has something to carry. */}
      {drag && dragPoint && (
        <div
          className="fixed z-[60] pointer-events-none px-2 py-1 rounded-md bg-surface border border-primary shadow-lg text-xs font-semibold text-text-main max-w-[220px] truncate"
          style={{ left: dragPoint.x + 10, top: dragPoint.y + 10 }}
        >
          {drag.label}
        </div>
      )}

      {moveError && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-3 py-2 rounded-lg bg-danger-bg border border-danger/30 text-danger text-xs shadow-lg">
          {moveError}
          <button onClick={() => setMoveError('')} className="hover:opacity-70">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

function ChipButton({
  pressed,
  color,
  onClick,
  children,
}: {
  pressed: boolean
  color?: string
  onClick: () => void
  children: React.ReactNode
}) {
  const col = color ?? '#18170F'
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="flex items-center gap-2 text-sm font-semibold px-3 py-2 rounded-md border bg-surface text-left transition-colors"
      style={{
        borderColor: pressed ? col : 'rgba(0,0,0,0.15)',
        boxShadow: pressed ? `inset 0 0 0 1px ${col}` : undefined,
        backgroundColor: pressed ? wash(col, 0.08) : undefined,
      }}
    >
      {children}
    </button>
  )
}

function TaskBlock({
  task: t,
  busy,
  onTick,
  onView,
  onEditOneOff,
  onDragStart,
  dragging,
  base,
  nameOf,
}: {
  task: ContentTask
  busy: boolean
  onTick: (t: ContentTask, done: boolean) => void
  onView: (t: ContentTask) => void
  /** A one-off opens its own dialog; a pipeline task has a client page instead. */
  onEditOneOff?: (o: ContentOneOff) => void
  /** Absent where the block cannot be moved, e.g. in the week-by-week list. */
  onDragStart?: (e: React.PointerEvent) => void
  dragging?: boolean
  base: string
  nameOf: (id: string | null) => string | null
}) {
  const { c } = useContentT()
  const k = KIND_COLOR[t.kind]
  const who = nameOf(t.assigneeId)
  const clients = clientsOf([t])
  const body = (
    <>
      <b className={`block font-semibold ${t.done ? 'line-through' : ''}`}>
        {clients.map((cl) => (
          <span key={cl.id} className="inline-block w-1.5 h-1.5 rounded-full mr-0.5 align-middle" style={{ backgroundColor: cl.color }} />
        ))}
        <span className="ml-0.5">{t.title}</span>
      </b>
      <span className="text-text-muted">{t.detail}</span>
      {who && <span className="block text-text-subtle">{who}</span>}
    </>
  )
  return (
    <div
      // The block is its own thing: a click on it ticks, opens or edits, and
      // must not also count as a click on the day behind it.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onDragStart}
      className={`group relative text-[0.78rem] leading-tight px-1.5 py-1 rounded-[3px] border-l-[3px] ${
        t.done ? 'opacity-55' : ''
      } ${onDragStart ? 'cursor-grab active:cursor-grabbing select-none' : ''} ${dragging ? 'opacity-40' : ''}`}
      style={{ borderLeftColor: k, backgroundColor: wash(k, 0.09, 'transparent') }}
      title={[t.title, t.detail, who, t.warning].filter(Boolean).join(' · ')}
    >
      <div className="flex items-start gap-1">
        <button
          // A tick is not a drag, and must not become one on the way down.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onTick(t, !t.done)}
          disabled={busy}
          className={`mt-[1px] w-3.5 h-3.5 rounded-[3px] border flex-shrink-0 flex items-center justify-center ${
            t.done ? 'bg-success border-success text-white' : 'border-border-md bg-surface hover:border-text-muted'
          }`}
          aria-label={t.done ? c.markNotDone : c.markDone}
        >
          {t.done && <Check size={10} strokeWidth={3} />}
        </button>
        {/* A one-off has no pipeline to open, so it opens itself. A batch
            spans clients, so it has no one profile to open. */}
        {t.oneOff && onEditOneOff ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onEditOneOff(t.oneOff!)}
            className="min-w-0 flex-1 text-left"
          >
            {body}
          </button>
        ) : clients.length === 1 ? (
          <Link to={`${base}/${clients[0].id}`} className="min-w-0 flex-1" onPointerDown={(e) => e.stopPropagation()}>
            {body}
          </Link>
        ) : (
          <div className="min-w-0 flex-1">{body}</div>
        )}
        {onDragStart && (
          <GripVertical
            size={11}
            className="flex-shrink-0 mt-[2px] text-text-subtle opacity-0 group-hover:opacity-100 transition-opacity"
          />
        )}
      </div>
      {(t.kind === 'plan' || t.kind === 'record') && t.recording && (t.recording.planPath || t.recording.planNotes) && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onView(t)}
          className="mt-1 ml-[18px] inline-flex items-center gap-1 text-[0.7rem] font-semibold text-blue-accent hover:underline"
        >
          <FileText size={11} /> {c.viewPlan}
        </button>
      )}
      {t.warning && !t.done && (
        <span className="mt-0.5 ml-[18px] flex items-center gap-1 text-[0.7rem] text-warning">
          <AlertTriangle size={10} /> {t.warning}
        </span>
      )}
    </div>
  )
}

function PostTag({
  task: t,
  busy,
  onTick,
  onDragStart,
  dragging,
  nameOf,
}: {
  task: ContentTask
  busy: boolean
  onTick: (t: ContentTask, done: boolean) => void
  /** Absent where the tag cannot be moved, e.g. in the week-by-week list. */
  onDragStart?: (e: React.PointerEvent) => void
  dragging?: boolean
  nameOf: (id: string | null) => string | null
}) {
  const { c, fmt } = useContentT()
  const empty = !!t.warning
  const who = nameOf(t.assigneeId)
  // A slot dragged off the day its rule puts it on. Worth saying on the tag
  // itself: otherwise a Tuesday post sitting on a Thursday looks like the
  // rule says Thursday.
  const moved = t.ruleDay && t.ruleDay !== t.day
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!empty) onTick(t, !t.done) }}
      onPointerDown={onDragStart}
      // An empty slot still moves: it is the day that is being planned, and
      // the piece that fills it is worked out from the day afterwards. Only
      // ticking it off is meaningless.
      disabled={busy}
      title={[
        empty
          ? c.postEmpty(t.client.name)
          : `${t.client.name} · ${t.tag}${who ? ` · ${who}` : ''} — ${t.done ? c.postPosted : c.postWhenPosted}`,
        moved ? c.movedFromRule(fmt(t.ruleDay!, { day: 'numeric', month: 'short' })) : '',
      ].filter(Boolean).join('\n')}
      className={`text-[0.7rem] font-semibold px-1.5 py-[1px] rounded-sm inline-flex items-center gap-0.5 ${
        empty ? 'border border-dashed bg-transparent' : 'text-white'
      } ${t.done ? 'opacity-60' : ''} ${dragging ? 'opacity-40' : ''} ${
        onDragStart ? 'cursor-grab active:cursor-grabbing select-none' : ''
      } ${moved ? 'ring-1 ring-offset-1 ring-text-subtle/50' : ''}`}
      style={empty ? { borderColor: t.client.color, color: t.client.color } : { backgroundColor: t.client.color }}
    >
      {t.done && <Check size={10} strokeWidth={3} />}
      {t.tag}
    </button>
  )
}
