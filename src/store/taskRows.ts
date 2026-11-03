import { Task, CompletionLog } from '../types'

/**
 * Database rows into the shapes the scheduler reads. Their own module, apart
 * from the task store, because the home-screen widget runs the same scheduler
 * on the same rows and must not drag the store, Supabase and React along.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function toTask(row: any): Task {
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

export function toCompletionLog(row: any): CompletionLog {
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
