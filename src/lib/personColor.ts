import type { CSSProperties } from 'react'

/**
 * What colour a person is drawn in.
 *
 * Each employee has one colour, picked when they are added. It is theirs
 * everywhere: the circle with their initials, the logo and accents of their
 * side of the app, the profile a manager opens on them, and their work on
 * every calendar — including the team calendar, where it is what tells three
 * people's blocks on one day apart.
 *
 * Anybody nobody has picked a colour for falls back to the old pair:
 * employees purple, InnoWeb grey.
 */

/** The one account that manages everything. */
const INNOWEB_ID = '1e2001c5-72b2-44a6-9605-9954db51908e'

/** An employee nobody has picked a colour for. */
const EMPLOYEE = '#6B21A8'

/**
 * InnoWeb's own. Grey, because the manager's todos sit alongside the work
 * they have handed out, and the work handed out is what should stand out.
 */
const INNOWEB = '#6B7280'

/** The colour somebody has when nobody has chosen one for them. */
export function defaultColor(id: string | null | undefined): string {
  return id === INNOWEB_ID ? INNOWEB : EMPLOYEE
}

/**
 * The colours offered. Ten, spread round the wheel so that any two read as
 * different people when they sit in one day of a week view, and every one
 * dark enough to carry white text — avatars, buttons and calendar blocks are
 * all filled with it and labelled in white. The first is the purple everyone
 * had before, so "what it was" is a choice like any other.
 */
export const PERSON_COLORS = [
  { hex: '#6B21A8', name: 'purple' },
  { hex: '#4F46E5', name: 'indigo' },
  { hex: '#1D4ED8', name: 'blue' },
  { hex: '#0F766E', name: 'teal' },
  { hex: '#15803D', name: 'green' },
  { hex: '#A16207', name: 'ochre' },
  { hex: '#C2410C', name: 'orange' },
  { hex: '#B91C1C', name: 'red' },
  { hex: '#BE185D', name: 'pink' },
  { hex: '#334155', name: 'slate' },
] as const

export type PersonColorName = typeof PERSON_COLORS[number]['name']

/**
 * Whether a string is one of our hex colours. The column is checked in the
 * database too; this stops a bad value reaching the stylesheet from a stale
 * row that predates the check.
 */
export function isHexColor(v: string | null | undefined): v is string {
  return !!v && /^#[0-9A-Fa-f]{6}$/.test(v)
}

/**
 * Somebody's colour: the one chosen for them, else the default.
 *
 * Read from the unscoped list of people. A screen narrowed to one project
 * still draws work belonging to people outside it, and a colour looked up in
 * the narrowed list would be missed for them.
 */
export function personColor(
  id: string | null | undefined,
  people: { id: string; calendarColor?: string | null }[],
): string {
  const chosen = people.find((p) => p.id === id)?.calendarColor
  return isHexColor(chosen) ? chosen : defaultColor(id)
}

// ─── Remembered between loads ───────────────────────────────────────────────
// The team arrives a moment after the page does. Without a copy from last
// time, an employee's whole side of the app would open green and turn their
// colour a beat later, on every load. This is only a first guess: the store
// overwrites it as soon as the real list is in.

const CACHE_KEY = 'flowdesk.personColors'

function readCache(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let cache: Record<string, string> = readCache()

/** Last load's colour for this person, if they had one. */
export function cachedColor(id: string | null | undefined): string | undefined {
  const hit = id ? cache[id] : undefined
  return isHexColor(hit) ? hit : undefined
}

/** Keep everybody's chosen colour for the next load's first paint. */
export function rememberColors(people: { id: string; calendarColor?: string | null }[]) {
  cache = Object.fromEntries(
    people.filter((p) => isHexColor(p.calendarColor)).map((p) => [p.id, p.calendarColor as string]),
  )
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Private window or storage full: the next load just opens on the default.
  }
}

// ─── A side of the app in somebody's colour ─────────────────────────────────

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The style that redraws everything inside an element in this colour: every
 * bg-primary, text-primary, ring-primary/30 and so on, read from the three
 * variables Tailwind's primary is built on. The light shade is the colour
 * washed nearly to white, for selected rows and soft fills; the dark one is
 * for hover on a filled button.
 */
export function themeVars(hex: string): CSSProperties {
  if (!isHexColor(hex)) return {}
  const [r, g, b] = channels(hex)
  const toward = (c: number, target: number, by: number) => Math.round(c + (target - c) * by)
  const light = [r, g, b].map((c) => toward(c, 255, 0.88)).join(' ')
  const dark = [r, g, b].map((c) => toward(c, 0, 0.22)).join(' ')
  return {
    '--primary': `${r} ${g} ${b}`,
    '--primary-light': light,
    '--primary-dark': dark,
  } as CSSProperties
}

/** Initials from a name: the first letters of its first two words. */
/**
 * A faint fill of a colour: `amount` of it over white, or over whatever is
 * behind when `over` is 'transparent'. Worked out here rather than with CSS
 * color-mix(), which phones on an older Chrome or Samsung Internet do not
 * have — there the fill silently came out as nothing.
 */
export function wash(hex: string, amount: number, over: 'white' | 'transparent' = 'white'): string | undefined {
  if (!isHexColor(hex)) return undefined
  const [r, g, b] = channels(hex)
  if (over === 'transparent') return `rgba(${r}, ${g}, ${b}, ${amount})`
  const mix = (c: number) => Math.round(255 + (c - 255) * amount)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

/** Is this InnoWeb's own work rather than an employee's? */
export function isInnoweb(id: string | null | undefined): boolean {
  return id === INNOWEB_ID
}

/**
 * Whose todo this is: explicitly assigned, else whose list it sits on, else
 * whoever added it.
 *
 * A todo on the shared board has no owner, and one nobody has been assigned
 * has no assignee, so the pair alone left todos belonging to nobody. Every
 * todo is created by somebody, so the creator is the answer whenever the
 * other two are silent: if you added it to your own list it is yours, and it
 * stops being yours only when it is assigned to someone else.
 */
export function todoOwner(todo: {
  assigneeId?: string | null
  ownerId?: string | null
  createdBy?: string | null
}): string | null {
  return todo.assigneeId ?? todo.ownerId ?? todo.createdBy ?? null
}
