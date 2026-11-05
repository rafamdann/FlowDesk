import { create } from 'zustand'
import { supabase } from '../lib/supabaseClient'
import { Task, CompletionLog, Category, TaskComment, TaskAttachment, TaskFile, ActivityLog } from '../types'
import {
  getTasksDueOnDate, getTasksDueThisWeek, getTasksDueThisMonth, getTimeOfDay, TaskMoveRow,
  TaskSkipRow, setSkippedOccurrences,
} from '../utils/taskScheduler'
import { useAuthStore } from './authStore'
import { recordUndo } from './undoStore'
import { format } from 'date-fns'

interface TaskState {
  /** Tasks of the project being viewed, or all when unscoped. */
  tasks: Task[]
  /** Every task, regardless of scope. */
  allTasks: Task[]
  scopedProjectId: string | null
  setProjectScope: (projectId: string | null) => void
  completionLogs: CompletionLog[]
  categories: Category[]
  loading: boolean
  /** Keyed `task:employee:day`. Started and missed share the one row, so they exclude each other. */
  taskStatuses: Record<string, 'in_progress' | 'missed'>
  /** Same keys as taskStatuses, holding the moment work began. */
  taskStartedAt: Record<string, string>
  /** Days of recurring tasks the owner has dragged to another day. */
  taskMoves: TaskMoveRow[]
  /** Single days of repeating tasks that were deleted on their own. */
  taskSkips: TaskSkipRow[]
  taskComments: TaskComment[]
  activityLogs: ActivityLog[]

  initialize: () => Promise<void>
  /** Re-read everything. Used by the live subscription below. */
  refresh: () => Promise<void>
  /** Stop listening for live task changes. */
  teardown: () => void

  addTask: (task: Omit<Task, 'id' | 'createdAt'>) => Promise<void>
  updateTask: (id: string, updates: Partial<Task>) => Promise<void>
  deleteTask: (id: string) => Promise<void>

  completeTask: (taskId: string, employeeId: string, dueDate: string) => Promise<void>
  uncompleteTask: (taskId: string, employeeId: string, dueDate: string) => Promise<void>
  isTaskCompleted: (taskId: string, employeeId: string, date: string) => boolean

  setInProgress: (taskId: string, empId: string, date: string) => Promise<void>
  clearInProgress: (taskId: string, empId: string, date: string) => Promise<void>
  isInProgress: (taskId: string, empId: string, date: string) => boolean
  /** When they pressed start, so "how long has this been going" is answerable. */
  inProgressSince: (taskId: string, empId: string, date: string) => string | null
  /**
   * Mark one occurrence as missed. It stops on the day it was marked and never
   * moves on. Shares the status row with "in progress", so it replaces it.
   */
  markMissed: (taskId: string, empId: string, date: string) => Promise<void>
  /**
   * Put one day of somebody's task on another day. A one-off simply gets the
   * new date; a day of a recurring task is moved on its own, leaving the
   * rest of the schedule where it was. Dropping it back on its own day
   * undoes the move.
   */
  moveTaskOccurrence: (taskId: string, empId: string, date: string, to: string) => Promise<void>
  /**
   * Delete one day of somebody's repeating task, leaving every other day of
   * it where it is.
   */
  deleteTaskOccurrence: (taskId: string, empId: string, date: string) => Promise<void>
  /** Put back a day that was deleted on its own. What Cmd+Z does to a skip. */
  restoreTaskOccurrence: (taskId: string, empId: string, date: string) => Promise<void>
  /** Take a missed mark back, which lets the task start moving forward again. */
  clearMissed: (taskId: string, empId: string, date: string) => Promise<void>
  isMissed: (taskId: string, empId: string, date: string) => boolean

  addComment: (comment: Omit<TaskComment, 'id' | 'createdAt'> & { attachments: TaskAttachment[] }) => Promise<TaskComment>
  deleteComment: (commentId: string) => Promise<void>
  getTaskComments: (taskId: string) => TaskComment[]

  addActivityLog: (log: Omit<ActivityLog, 'id' | 'timestamp'>) => Promise<void>

  /** Files showing the work done, per task and per day it was done. */
  taskFiles: TaskFile[]
  loadTaskFiles: (taskId: string) => Promise<void>
  uploadTaskFile: (taskId: string, dueDate: string | null, file: File) => Promise<void>
  deleteTaskFile: (id: string) => Promise<void>
  getTaskFileUrl: (storagePath: string) => Promise<string | null>
  getActivityLogs: (taskId: string) => ActivityLog[]

  addCategory: (category: Omit<Category, 'id'>) => Promise<Category>
  updateCategory: (id: string, updates: Partial<Category>) => Promise<void>
  deleteCategory: (id: string) => Promise<void>

  getProjectTasks: (projectId: string) => Task[]
  getTasksDueToday: (employeeId: string, date: Date) => Task[]
  getTasksDueThisWeek: (employeeId: string, weekStart: Date) => Record<string, Task[]>
  getTasksDueThisMonth: (employeeId: string, month: number, year: number) => Record<number, Task[]>
}

function toTask(row: any): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    assignedTo: (row.task_assignments ?? []).map((a: any) => a.employee_id),
    frequency: row.frequency,
    categoryId: row.category_id,
    isUrgent: !!row.is_urgent,
    associatedTool: row.associated_tool ?? undefined,
    estimatedMinutes: row.estimated_minutes,
    createdAt: row.created_at,
    createdBy: row.created_by,
    isActive: row.is_active,
    // Read from '*', so it is simply absent until its migration has run.
    content: row.content_kind
      ? { kind: row.content_kind, id: row.content_id, clientId: row.content_client_id ?? null }
      : undefined,
  }
}

function toTaskFile(row: any): TaskFile {
  return {
    id: row.id,
    taskId: row.task_id,
    dueDate: row.due_date ?? null,
    name: row.name,
    type: row.type ?? '',
    size: row.size ?? 0,
    storagePath: row.storage_path,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
  }
}

function toCompletionLog(row: any): CompletionLog {
  return {
    id: row.id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    completedAt: row.completed_at,
    dueDate: row.due_date,
    wasLate: row.was_late,
    timeOfDay: row.time_of_day,
  }
}

function toComment(row: any): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    authorId: row.author_id,
    content: row.content,
    createdAt: row.created_at,
    attachments: (row.task_attachments ?? []).map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      size: a.size,
      storagePath: a.storage_path,
      uploadedAt: a.uploaded_at,
      uploadedBy: a.uploaded_by,
    })),
  }
}

function toActivityLog(row: any): ActivityLog {
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    action: row.action,
    detail: row.detail ?? undefined,
    timestamp: row.timestamp,
  }
}

/** Keep `allTasks` authoritative and re-derive the scoped `tasks` from it. */
function applyTasks(scopedProjectId: string | null, all: Task[]) {
  return {
    allTasks: all,
    tasks: scopedProjectId ? all.filter((t) => t.projectId === scopedProjectId) : all,
  }
}

/**
 * A one-off happens once, so whatever this person recorded for it counts,
 * whichever day it was recorded under: the day it was ticked, in older
 * versions, or its date before somebody dragged it to another one.
 * taskOccurrences places it by that rule, and so must everything that reads
 * or clears its status here — or the task shows one state and acts on another.
 */
function isOneOff(tasks: Task[], taskId: string) {
  return tasks.find((t) => t.id === taskId)?.frequency.type === 'one-off'
}

/**
 * The status an occurrence shows, and the key it is kept under. A recurring
 * task's is its own day's. A one-off's is its own day's when it has one, and
 * otherwise the latest recorded under any day — exactly what taskOccurrences
 * draws. Reading only the one day while the calendar drew another is what made
 * a long-started task take two presses to finish and a third to come back as
 * started.
 */
function statusOf(
  s: Pick<TaskState, 'allTasks' | 'taskStatuses' | 'taskStartedAt'>,
  taskId: string,
  empId: string,
  date: string,
): { key: string; status: 'in_progress' | 'missed' } | null {
  const own = `${taskId}:${empId}:${date}`
  if (s.taskStatuses[own]) return { key: own, status: s.taskStatuses[own] }
  if (!isOneOff(s.allTasks, taskId)) return null

  let found: { key: string; status: 'in_progress' | 'missed' } | null = null
  let foundAt = ''
  const prefix = `${taskId}:${empId}:`
  for (const [key, status] of Object.entries(s.taskStatuses)) {
    if (!key.startsWith(prefix)) continue
    const at = s.taskStartedAt[key] ?? ''
    if (!found || at > foundAt) {
      found = { key, status }
      foundAt = at
    }
  }
  return found
}

/** Every status key this person has for a one-off, of one kind. */
function oneOffKeys(statuses: Record<string, 'in_progress' | 'missed'>, taskId: string, empId: string, status: 'in_progress' | 'missed') {
  const prefix = `${taskId}:${empId}:`
  return Object.keys(statuses).filter((key) => key.startsWith(prefix) && statuses[key] === status)
}

/** A copy of a status map without the given keys. */
function without<T>(map: Record<string, T>, keys: string[]) {
  const next = { ...map }
  for (const key of keys) delete next[key]
  return next
}

/**
 * Every row of a table, not the first thousand. Supabase stops a select at
 * max_rows without saying so, and ticks and statuses pass a thousand in a few
 * months of daily work. Past that, which rows came back was whichever the
 * table happened to hold first: a task could be started or done in the
 * database and blank here, and pressing it ran into the row this screen
 * could not see. Ordered by the key, so no page repeats or skips a row.
 */
async function selectAll(table: string, columns: string, orderBy: string[]) {
  const page = 1000
  const rows: any[] = []
  for (let from = 0; ; from += page) {
    let query = supabase.from(table).select(columns)
    for (const col of orderBy) query = query.order(col)
    const { data, error } = await query.range(from, from + page - 1)
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
    if (!data || data.length < page) return { data: rows, error: null }
  }
}

/**
 * Give one occurrence a status, replacing whatever it had. task_statuses has
 * no update policy, so an upsert that lands on a row already there is
 * refused — and a row this screen had not loaded made the press do nothing
 * at all. Replacing it is a delete and an insert, both of which are allowed.
 */
async function writeStatus(row: {
  task_id: string; employee_id: string; due_date: string; status: 'in_progress' | 'missed'; started_at: string
}) {
  const { error } = await supabase.from('task_statuses').upsert(row)
  if (!error) return
  await supabase
    .from('task_statuses')
    .delete()
    .eq('task_id', row.task_id)
    .eq('employee_id', row.employee_id)
    .eq('due_date', row.due_date)
  const { error: again } = await supabase.from('task_statuses').insert(row)
  if (again) {
    console.error('[task_statuses] write failed:', again)
    throw new Error(again.message)
  }
}

/**
 * Live subscription. Kept outside the store because it is a connection, not
 * state, and must survive re-renders.
 */
let channel: ReturnType<typeof supabase.channel> | null = null

export const useTaskStore = create<TaskState>()((set, get) => ({
  tasks: [],
  allTasks: [],
  scopedProjectId: null,

  setProjectScope: (projectId) =>
    set((s) => ({
      scopedProjectId: projectId,
      tasks: projectId ? s.allTasks.filter((t) => t.projectId === projectId) : s.allTasks,
    })),

  completionLogs: [],
  categories: [],
  loading: false,
  taskStatuses: {},
  taskStartedAt: {},
  taskMoves: [],
  taskSkips: [],
  taskComments: [],
  activityLogs: [],

  initialize: async () => {
    await get().refresh()

    // Without this, an employee had to reload to see a task an admin had just
    // assigned them: every one of these tables is written by someone else's
    // client, so a fetch on mount was never going to show it.
    if (channel) return
    const refetch = () => { get().refresh() }
    channel = supabase
      .channel('tasks-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignments' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'completion_logs' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_statuses' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_moves' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_skips' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_comments' }, refetch)
      .subscribe()
  },

  teardown: () => {
    if (!channel) return
    supabase.removeChannel(channel)
    channel = null
  },

  refresh: async () => {
    set({ loading: true })

    // Only who a task is assigned to. The day it happens comes from the task's
    // own frequency, so the assignment carries no date any more.
    const fetchTasks = () => selectAll('tasks', '*, task_assignments(employee_id)', ['id'])
    const occurrenceKey = ['task_id', 'employee_id', 'due_date']

    const [tasksRes, categoriesRes, logsRes, statusesRes, commentsRes, activityRes, movesRes, skipsRes] = await Promise.all([
      fetchTasks(),
      supabase.from('categories').select('*'),
      selectAll('completion_logs', '*', ['id']),
      selectAll('task_statuses', '*', occurrenceKey),
      selectAll('task_comments', '*, task_attachments(*)', ['id']),
      selectAll('activity_logs', '*', ['id']),
      // Absent until the task_moves migration has run: nothing is moved, and
      // the rest still loads.
      selectAll('task_moves', '*', occurrenceKey),
      // Likewise absent until task_skips has run.
      selectAll('task_skips', '*', occurrenceKey),
    ])

    const taskSkips: TaskSkipRow[] = (skipsRes.data ?? []).map((row: any) => ({
      taskId: row.task_id,
      employeeId: row.employee_id,
      date: row.due_date,
    }))
    // Before the tasks are set, so the first render already leaves them out.
    setSkippedOccurrences(taskSkips)

    const taskMoves: TaskMoveRow[] = (movesRes.data ?? []).map((row: any) => ({
      taskId: row.task_id,
      employeeId: row.employee_id,
      date: row.due_date,
      movedTo: row.moved_to,
    }))

    const taskStatuses: Record<string, 'in_progress' | 'missed'> = {}
    const taskStartedAt: Record<string, string> = {}
    for (const row of statusesRes.data ?? []) {
      const key = `${row.task_id}:${row.employee_id}:${row.due_date}`
      taskStatuses[key] = row.status === 'missed' ? 'missed' : 'in_progress'
      // Absent until the started_at migration has run, in which case the
      // duration simply is not shown rather than the whole row being lost.
      if (row.started_at) taskStartedAt[key] = row.started_at
    }

    // A failed fetch must not be mistaken for "there are no tasks": blanking
    // the list on error is what made a missing column look like data loss.
    if (tasksRes.error) {
      console.error('[tasks] load failed:', tasksRes.error)
      set({ loading: false })
      return
    }

    set({
      ...applyTasks(get().scopedProjectId, (tasksRes.data ?? []).map(toTask)),
      categories: categoriesRes.data ?? [],
      completionLogs: (logsRes.data ?? []).map(toCompletionLog),
      taskStatuses,
      taskStartedAt,
      taskMoves,
      taskSkips,
      taskComments: (commentsRes.data ?? []).map(toComment),
      activityLogs: (activityRes.data ?? []).map(toActivityLog),
      loading: false,
    })
  },

  addTask: async (task) => {
    const base = {
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      frequency: task.frequency,
      // A task made from a todo has no category yet, and an empty string is not a uuid.
      category_id: task.categoryId || null,
      is_urgent: !!task.isUrgent,
      associated_tool: task.associatedTool ?? null,
      estimated_minutes: task.estimatedMinutes,
      created_by: task.createdBy,
      is_active: task.isActive,
    }

    const { data, error } = await supabase.from('tasks').insert(base).select().single()

    // Swallowing this made a failed save look like a successful one: the form
    // closed, nothing appeared, and there was nothing to go on. Throw so the
    // caller can say what went wrong.
    if (error || !data) {
      console.error('[addTask] failed:', error)
      throw new Error(error?.message ?? 'The task could not be saved.')
    }

    if (task.assignedTo.length > 0) {
      const { error: assignError } = await supabase
        .from('task_assignments')
        .insert(task.assignedTo.map((employeeId) => ({ task_id: data.id, employee_id: employeeId })))

      // The task exists but reaches nobody, which looks identical to a task
      // that was never created. Say so rather than leaving it orphaned.
      if (assignError) {
        console.error('[addTask] assignments failed:', assignError)
        throw new Error(`The task was created but could not be assigned: ${assignError.message}`)
      }
    }

    set((s) => applyTasks(s.scopedProjectId, [
      ...s.allTasks,
      toTask({
        ...data,
        task_assignments: task.assignedTo.map((id) => ({ employee_id: id })),
      }),
    ]))

    // Undoing a task that was only just made is deleting it; redoing it puts
    // it back under the same id, so anything recorded after it on the undo
    // stack still points at a task that exists.
    recordUndo({
      label: 'added a task',
      undo: () => get().deleteTask(data.id),
      redo: async () => {
        const { error: err } = await supabase.from('tasks').insert({ ...base, id: data.id })
        if (err) throw new Error(err.message)
        if (task.assignedTo.length > 0) {
          await supabase
            .from('task_assignments')
            .insert(task.assignedTo.map((employeeId) => ({ task_id: data.id, employee_id: employeeId })))
        }
        set((s) => applyTasks(s.scopedProjectId, [
          ...s.allTasks.filter((t) => t.id !== data.id),
          toTask({ ...data, task_assignments: task.assignedTo.map((id) => ({ employee_id: id })) }),
        ]))
      },
    })
  },

  updateTask: async (id, updates) => {
    // What it was, before it is not any more. Only the fields actually being
    // changed, so undoing an edit does not quietly rewrite the rest of the
    // task with whatever this client last happened to have loaded.
    const before = get().allTasks.find((t) => t.id === id)
    const previous: Partial<Task> | null = before
      ? (Object.fromEntries(
          Object.keys(updates)
            .filter((k) => k in before)
            .map((k) => [k, (before as unknown as Record<string, unknown>)[k]]),
        ) as Partial<Task>)
      : null

    const patch: Record<string, unknown> = {}
    if (updates.title !== undefined) patch.title = updates.title
    if (updates.description !== undefined) patch.description = updates.description
    if (updates.frequency !== undefined) patch.frequency = updates.frequency
    if (updates.categoryId !== undefined) patch.category_id = updates.categoryId
    if (updates.isUrgent !== undefined) patch.is_urgent = updates.isUrgent
    if (updates.associatedTool !== undefined) patch.associated_tool = updates.associatedTool
    if (updates.estimatedMinutes !== undefined) patch.estimated_minutes = updates.estimatedMinutes
    if (updates.isActive !== undefined) patch.is_active = updates.isActive

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('tasks').update(patch).eq('id', id)
      if (error) {
        console.error('[updateTask] failed:', error)
        throw new Error(error.message)
      }
    }

    if (updates.assignedTo !== undefined) {
      await supabase.from('task_assignments').delete().eq('task_id', id)
      if (updates.assignedTo.length > 0) {
        const { error } = await supabase.from('task_assignments').insert(
          updates.assignedTo.map((employeeId) => ({ task_id: id, employee_id: employeeId })),
        )
        if (error) {
          console.error('[updateTask] assignments failed:', error)
          throw new Error(error.message)
        }
      }
    }

    set((s) => applyTasks(s.scopedProjectId, s.allTasks.map((t) => (t.id === id ? { ...t, ...updates } : t))))

    if (previous && Object.keys(previous).length > 0) {
      recordUndo({
        label: 'edited a task',
        undo: () => get().updateTask(id, previous),
        redo: () => get().updateTask(id, updates),
      })
    }
  },

  deleteTask: async (id) => {
    // Everything that hangs off the task, read before it is gone. The row
    // itself is only half of a task: the rest is who it is for, which days
    // were ticked, which were started, which were moved and which were
    // skipped, and all of it cascades away with the delete. Undo without this
    // would bring back a task stripped of its history, which is worse than
    // not bringing it back at all.
    const [taskRow, assignments, statuses, logs, moves, skips] = await Promise.all([
      supabase.from('tasks').select('*').eq('id', id).maybeSingle(),
      supabase.from('task_assignments').select('*').eq('task_id', id),
      supabase.from('task_statuses').select('*').eq('task_id', id),
      supabase.from('completion_logs').select('*').eq('task_id', id),
      supabase.from('task_moves').select('*').eq('task_id', id),
      supabase.from('task_skips').select('*').eq('task_id', id),
    ])

    // The result was thrown away and the row dropped from local state either
    // way, so a refused delete looked exactly like a successful one until the
    // task reappeared on the next reload. Say so instead.
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) {
      console.error('[deleteTask] failed:', error)
      throw new Error(error.message)
    }
    set((s) => applyTasks(s.scopedProjectId, s.allTasks.filter((t) => t.id !== id)))

    if (!taskRow.data) return

    recordUndo({
      label: 'deleted a task',
      undo: async () => {
        const { error: err } = await supabase.from('tasks').insert(taskRow.data)
        if (err) throw new Error(err.message)

        // Each of these is only worth attempting if there was anything there.
        // Failures are logged rather than thrown: the task is back, and
        // losing it again because one completion log would not re-insert
        // would be the wrong trade.
        for (const [table, rows] of [
          ['task_assignments', assignments.data],
          ['task_statuses', statuses.data],
          ['completion_logs', logs.data],
          ['task_moves', moves.data],
          ['task_skips', skips.data],
        ] as const) {
          if (!rows?.length) continue
          const { error: rowErr } = await supabase.from(table).insert(rows)
          if (rowErr) console.error(`[deleteTask/undo] ${table} did not come back:`, rowErr)
        }

        // Re-read rather than patch state back together by hand: the task is
        // back along with its assignments, ticks, moves and skips, and every
        // one of those feeds a different derived list.
        await get().refresh()
      },
      redo: async () => {
        const { error: err } = await supabase.from('tasks').delete().eq('id', id)
        if (err) throw new Error(err.message)
        set((s) => applyTasks(s.scopedProjectId, s.allTasks.filter((t) => t.id !== id)))
      },
    })
  },

  completeTask: async (taskId, employeeId, dueDate) => {
    const now = new Date()
    const isoNow = now.toISOString()
    // Late means finished after the day it was due, not simply late in the
    // afternoon: this used to read `getHours() >= 16`, so anything done after
    // four was marked late even when it was not due until tomorrow.
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const wasLate = !!dueDate && todayKey > dueDate
    const timeOfDay = getTimeOfDay(isoNow)

    const { data, error } = await supabase
      .from('completion_logs')
      .insert({
        task_id: taskId,
        employee_id: employeeId,
        completed_at: isoNow,
        due_date: dueDate,
        was_late: wasLate,
        time_of_day: timeOfDay,
      })
      .select()
      .single()

    // Already ticked under this day — on another screen, or before this one
    // loaded it. It is done, so read that tick back rather than failing to add
    // a second one, which left the task looking untouched however often it
    // was pressed.
    if (error?.code === '23505') {
      const { data: existing } = await supabase
        .from('completion_logs')
        .select()
        .eq('task_id', taskId)
        .eq('employee_id', employeeId)
        .eq('due_date', dueDate)
        .maybeSingle()
      if (existing) {
        set((s) => ({
          completionLogs: s.completionLogs.some((l) => l.id === existing.id)
            ? s.completionLogs
            : [...s.completionLogs, toCompletionLog(existing)],
        }))
      }
      return
    }
    if (error || !data) {
      console.error('[completeTask] failed:', error)
      throw new Error(error?.message ?? 'The task could not be ticked off.')
    }

    set((s) => ({ completionLogs: [...s.completionLogs, toCompletionLog(data)] }))
    await get().addActivityLog({ taskId, actorId: employeeId, action: 'completed' })
    recordUndo({
      label: 'ticked a task off',
      undo: () => get().uncompleteTask(taskId, employeeId, dueDate),
      redo: () => get().completeTask(taskId, employeeId, dueDate),
    })
  },

  uncompleteTask: async (taskId, employeeId, dueDate) => {
    // A one-off's tick counts under any day, so taking it back takes back all
    // of them — one left under an older day would still hold it done.
    const anyDay = isOneOff(get().allTasks, taskId)
    let query = supabase
      .from('completion_logs')
      .delete()
      .eq('task_id', taskId)
      .eq('employee_id', employeeId)
    if (!anyDay) query = query.eq('due_date', dueDate)
    await query

    set((s) => ({
      completionLogs: s.completionLogs.filter(
        (log) =>
          !(log.taskId === taskId && log.employeeId === employeeId && (anyDay || log.dueDate === dueDate))
      ),
    }))

    await get().addActivityLog({ taskId, actorId: employeeId, action: 'uncompleted' })

    recordUndo({
      label: 'un-ticked a task',
      undo: () => get().completeTask(taskId, employeeId, dueDate),
      redo: () => get().uncompleteTask(taskId, employeeId, dueDate),
    })
  },

  isTaskCompleted: (taskId, employeeId, date) => {
    const dateStr = date.length === 10 ? date : format(new Date(date), 'yyyy-MM-dd')
    // A one-off is done if it was ticked under any day, as taskOccurrences shows it.
    const anyDay = isOneOff(get().allTasks, taskId)
    return get().completionLogs.some(
      (log) => log.taskId === taskId && log.employeeId === employeeId && (anyDay || log.dueDate === dateStr)
    )
  },

  setInProgress: async (taskId, empId, date) => {
    const key = `${taskId}:${empId}:${date}`
    // Stamped here rather than left to the column default, so re-starting
    // something restarts the clock instead of keeping the first attempt's.
    const startedAt = new Date().toISOString()
    // Throws when refused, so the screen that was pressed can say why rather
    // than leave the task looking untouched.
    await writeStatus({
      task_id: taskId, employee_id: empId, due_date: date, status: 'in_progress',
      started_at: startedAt,
    })
    set((s) => ({
      taskStatuses: { ...s.taskStatuses, [key]: 'in_progress' },
      taskStartedAt: { ...s.taskStartedAt, [key]: startedAt },
    }))
    await get().addActivityLog({ taskId, actorId: empId, action: 'in_progress' })
  },

  clearInProgress: async (taskId, empId, date) => {
    if (isOneOff(get().allTasks, taskId)) {
      // Started under any day shows it as started, so stopping it has to clear
      // every one — otherwise an older start brings it straight back.
      await supabase
        .from('task_statuses')
        .delete()
        .eq('task_id', taskId)
        .eq('employee_id', empId)
        .eq('status', 'in_progress')
      set((s) => {
        const keys = oneOffKeys(s.taskStatuses, taskId, empId, 'in_progress')
        return { taskStatuses: without(s.taskStatuses, keys), taskStartedAt: without(s.taskStartedAt, keys) }
      })
      return
    }
    const key = `${taskId}:${empId}:${date}`
    await supabase.from('task_statuses').delete().eq('task_id', taskId).eq('employee_id', empId).eq('due_date', date)
    set((s) => ({ taskStatuses: without(s.taskStatuses, [key]), taskStartedAt: without(s.taskStartedAt, [key]) }))
  },

  isInProgress: (taskId, empId, date) => statusOf(get(), taskId, empId, date)?.status === 'in_progress',

  inProgressSince: (taskId, empId, date) => {
    const found = statusOf(get(), taskId, empId, date)
    return found?.status === 'in_progress' ? get().taskStartedAt[found.key] ?? null : null
  },

  moveTaskOccurrence: async (taskId, empId, date, to) => {
    const hasMove = get().taskMoves.some((m) => m.taskId === taskId && m.employeeId === empId && m.date === date)
    if (to === date && !hasMove) return
    const task = get().allTasks.find((t) => t.id === taskId)
    if (!task) return

    // Where this day sat before the move. Undo puts it back there, which is
    // not always the day it belongs to: a day moved twice goes back one step,
    // the same as every other undo.
    const wasAt =
      get().taskMoves.find((m) => m.taskId === taskId && m.employeeId === empId && m.date === date)?.movedTo ?? date

    // A one-off is its own only day, so moving it is changing its date.
    // updateTask records its own undo, so nothing more is needed here.
    if (task.frequency.type === 'one-off') {
      await get().updateTask(taskId, { frequency: { ...task.frequency, date: to } })
      return
    }

    // Back on its own day: the move is simply gone.
    if (to === date) {
      const { error } = await supabase
        .from('task_moves')
        .delete()
        .eq('task_id', taskId).eq('employee_id', empId).eq('due_date', date)
      if (error) {
        console.error('[moveTaskOccurrence] failed:', error)
        throw new Error(error.message)
      }
      set((s) => ({
        taskMoves: s.taskMoves.filter((m) => !(m.taskId === taskId && m.employeeId === empId && m.date === date)),
      }))
      recordUndo({
        label: 'moved a task back',
        undo: () => get().moveTaskOccurrence(taskId, empId, date, wasAt),
        redo: () => get().moveTaskOccurrence(taskId, empId, date, to),
      })
      return
    }

    const { error } = await supabase.from('task_moves').upsert({
      task_id: taskId,
      employee_id: empId,
      due_date: date,
      moved_to: to,
      moved_by: useAuthStore.getState().realUser?.id ?? null,
      moved_at: new Date().toISOString(),
    })
    if (error) {
      console.error('[moveTaskOccurrence] failed:', error)
      throw new Error(error.message)
    }
    set((s) => ({
      taskMoves: [
        ...s.taskMoves.filter((m) => !(m.taskId === taskId && m.employeeId === empId && m.date === date)),
        { taskId, employeeId: empId, date, movedTo: to },
      ],
    }))

    recordUndo({
      label: 'rescheduled a task',
      undo: () => get().moveTaskOccurrence(taskId, empId, date, wasAt),
      redo: () => get().moveTaskOccurrence(taskId, empId, date, to),
    })
  },

  deleteTaskOccurrence: async (taskId, empId, date) => {
    const { error } = await supabase.from('task_skips').upsert({
      task_id: taskId,
      employee_id: empId,
      due_date: date,
      skipped_by: useAuthStore.getState().realUser?.id ?? null,
      skipped_at: new Date().toISOString(),
    })
    if (error) {
      console.error('[deleteTaskOccurrence] failed:', error)
      throw new Error(error.message)
    }
    const taskSkips = [
      ...get().taskSkips.filter((r) => !(r.taskId === taskId && r.employeeId === empId && r.date === date)),
      { taskId, employeeId: empId, date },
    ]
    setSkippedOccurrences(taskSkips)
    // Fresh task arrays as well: every screen that works out a task's days
    // memoises on them, and the registry changing underneath is invisible
    // to a memo.
    set((s) => ({ taskSkips, ...applyTasks(s.scopedProjectId, [...s.allTasks]) }))

    recordUndo({
      label: 'deleted a day of a task',
      undo: () => get().restoreTaskOccurrence(taskId, empId, date),
      redo: () => get().deleteTaskOccurrence(taskId, empId, date),
    })
  },

  restoreTaskOccurrence: async (taskId, empId, date) => {
    const { error } = await supabase
      .from('task_skips')
      .delete()
      .eq('task_id', taskId).eq('employee_id', empId).eq('due_date', date)
    if (error) {
      console.error('[restoreTaskOccurrence] failed:', error)
      throw new Error(error.message)
    }
    const taskSkips = get().taskSkips.filter(
      (r) => !(r.taskId === taskId && r.employeeId === empId && r.date === date),
    )
    setSkippedOccurrences(taskSkips)
    set((s) => ({ taskSkips, ...applyTasks(s.scopedProjectId, [...s.allTasks]) }))
  },

  markMissed: async (taskId, empId, date) => {
    const key = `${taskId}:${empId}:${date}`
    // When it was marked, which is the day it stops on.
    const at = new Date().toISOString()
    // Usually over a started row, which is exactly the case the upsert alone
    // was refused on.
    await writeStatus({
      task_id: taskId, employee_id: empId, due_date: date, status: 'missed', started_at: at,
    })
    set((s) => ({
      taskStatuses: { ...s.taskStatuses, [key]: 'missed' as const },
      taskStartedAt: { ...s.taskStartedAt, [key]: at },
    }))
    await get().addActivityLog({ taskId, actorId: empId, action: 'missed' })
  },

  clearMissed: async (taskId, empId, date) => {
    // As with starting: a one-off marked missed under any day shows as missed,
    // so reopening it clears every such mark.
    const anyDay = isOneOff(get().allTasks, taskId)
    let query = supabase
      .from('task_statuses')
      .delete()
      .eq('task_id', taskId)
      .eq('employee_id', empId)
    query = anyDay ? query.eq('status', 'missed') : query.eq('due_date', date)
    const { error } = await query
    if (error) {
      console.error('[clearMissed] failed:', error)
      return
    }
    set((s) => {
      const keys = anyDay ? oneOffKeys(s.taskStatuses, taskId, empId, 'missed') : [`${taskId}:${empId}:${date}`]
      return { taskStatuses: without(s.taskStatuses, keys), taskStartedAt: without(s.taskStartedAt, keys) }
    })
  },

  isMissed: (taskId, empId, date) => statusOf(get(), taskId, empId, date)?.status === 'missed',

  addComment: async (comment) => {
    const { data, error } = await supabase
      .from('task_comments')
      .insert({ task_id: comment.taskId, author_id: comment.authorId, content: comment.content })
      .select()
      .single()

    if (error || !data) throw error ?? new Error('Failed to add comment')

    if (comment.attachments.length > 0) {
      await supabase.from('task_attachments').insert(
        comment.attachments.map((a) => ({
          comment_id: data.id,
          name: a.name,
          type: a.type,
          size: a.size,
          storage_path: a.storagePath,
          uploaded_by: a.uploadedBy,
        }))
      )
    }

    const newComment: TaskComment = {
      id: data.id,
      taskId: data.task_id,
      authorId: data.author_id,
      content: data.content,
      createdAt: data.created_at,
      attachments: comment.attachments,
    }

    set((s) => ({ taskComments: [...s.taskComments, newComment] }))
    await get().addActivityLog({ taskId: comment.taskId, actorId: comment.authorId, action: 'commented' })
    if (comment.attachments.length > 0) {
      await get().addActivityLog({
        taskId: comment.taskId,
        actorId: comment.authorId,
        action: 'file_uploaded',
        detail: comment.attachments.map((a) => a.name).join(', '),
      })
    }
    return newComment
  },

  deleteComment: async (commentId) => {
    await supabase.from('task_comments').delete().eq('id', commentId)
    set((s) => ({ taskComments: s.taskComments.filter((c) => c.id !== commentId) }))
  },

  getTaskComments: (taskId) => get().taskComments.filter((c) => c.taskId === taskId),

  taskFiles: [],

  loadTaskFiles: async (taskId) => {
    const { data, error } = await supabase
      .from('task_files')
      .select('*')
      .eq('task_id', taskId)
      .order('uploaded_at', { ascending: false })

    if (error) {
      console.warn('[loadTaskFiles] failed:', error.message)
      return
    }
    set((s) => ({
      // Replace this task's files rather than appending, or opening the same
      // task twice would show everything twice.
      taskFiles: [
        ...s.taskFiles.filter((f) => f.taskId !== taskId),
        ...(data ?? []).map(toTaskFile),
      ],
    }))
  },

  uploadTaskFile: async (taskId, dueDate, file) => {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) throw new Error('You are not signed in.')

    // Named by time so two files of the same name on the same task do not
    // overwrite each other.
    const path = `tasks/${taskId}/${Date.now()}-${file.name}`
    const { error: upErr } = await supabase.storage
      .from('attachments')
      .upload(path, file, { upsert: false })
    if (upErr) {
      console.error('[uploadTaskFile] storage failed:', upErr)
      throw new Error(upErr.message)
    }

    const { data, error } = await supabase
      .from('task_files')
      .insert({
        task_id: taskId,
        due_date: dueDate,
        name: file.name,
        type: file.type || '',
        size: file.size,
        storage_path: path,
        uploaded_by: uid,
      })
      .select()
      .single()

    if (error || !data) {
      // The bytes are up but the row is not, which would leave a file nobody
      // can find. Take it back out rather than leaving litter.
      await supabase.storage.from('attachments').remove([path])
      console.error('[uploadTaskFile] failed:', error)
      throw new Error(error?.message ?? 'The file could not be attached.')
    }

    set((s) => ({ taskFiles: [toTaskFile(data), ...s.taskFiles] }))
  },

  deleteTaskFile: async (id) => {
    const file = get().taskFiles.find((f) => f.id === id)
    const { error } = await supabase.from('task_files').delete().eq('id', id)
    if (error) {
      console.error('[deleteTaskFile] failed:', error)
      throw new Error(error.message)
    }
    if (file) await supabase.storage.from('attachments').remove([file.storagePath])
    set((s) => ({ taskFiles: s.taskFiles.filter((f) => f.id !== id) }))
  },

  getTaskFileUrl: async (storagePath) => {
    const { data, error } = await supabase.storage
      .from('attachments')
      .createSignedUrl(storagePath, 60 * 60)
    if (error) {
      console.warn('[getTaskFileUrl] failed:', error.message)
      return null
    }
    return data?.signedUrl ?? null
  },

  addActivityLog: async (log) => {
    const { data, error } = await supabase
      .from('activity_logs')
      .insert({ task_id: log.taskId, actor_id: log.actorId, action: log.action, detail: log.detail ?? null })
      .select()
      .single()

    if (!error && data) {
      set((s) => ({ activityLogs: [...s.activityLogs, toActivityLog(data)] }))
    }
  },

  getActivityLogs: (taskId) => get().activityLogs.filter((l) => l.taskId === taskId),

  addCategory: async (category) => {
    const { data, error } = await supabase.from('categories').insert(category).select().single()
    if (error || !data) throw error ?? new Error('Failed to add category')
    set((s) => ({ categories: [...s.categories, data] }))
    return data
  },

  updateCategory: async (id, updates) => {
    await supabase.from('categories').update(updates).eq('id', id)
    set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, ...updates } : c)) }))
  },

  deleteCategory: async (id) => {
    await supabase.from('categories').delete().eq('id', id)
    set((s) => ({ categories: s.categories.filter((c) => c.id !== id) }))
  },

  getProjectTasks: (projectId) => get().allTasks.filter((t) => t.projectId === projectId),
  getTasksDueToday: (employeeId, date) => getTasksDueOnDate(get().tasks, employeeId, date),
  getTasksDueThisWeek: (employeeId, weekStart) => getTasksDueThisWeek(get().tasks, employeeId, weekStart),
  getTasksDueThisMonth: (employeeId, month, year) => getTasksDueThisMonth(get().tasks, employeeId, month, year),
}))
