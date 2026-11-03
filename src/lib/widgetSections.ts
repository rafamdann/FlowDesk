/**
 * What a home-screen widget can show. Shared by the settings in the app,
 * where each person picks theirs, and the widget, which draws them — so the
 * two can never disagree about the names. Stored in widget_settings.
 */
export const WIDGET_SECTIONS = ['tasks', 'todos', 'worklog', 'notes'] as const
export type WidgetSection = (typeof WIDGET_SECTIONS)[number]

export const DEFAULT_WIDGET_SECTIONS: WidgetSection[] = ['tasks']

/** Only known names, each once, in the order given; the default if none are left. */
export function cleanSections(value: unknown): WidgetSection[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const out: WidgetSection[] = []
  for (const v of list) {
    const name = String(v).trim().toLowerCase().replace('-', '') as WidgetSection
    if (WIDGET_SECTIONS.includes(name) && !out.includes(name)) out.push(name)
  }
  return out.length ? out : DEFAULT_WIDGET_SECTIONS
}
