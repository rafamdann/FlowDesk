/**
 * The parts of dictation that are just text and keys: the shortcut, applying
 * the shared dictionary, and learning a correction from a hand edit.
 */

export interface DictWord {
  id: string
  word: string
  /** What transcription wrote instead, lowercased. Null for plain vocabulary. */
  heard: string | null
}

// ─── Shortcut ───────────────────────────────────────────────────────────────

export interface Shortcut {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /**
   * KeyboardEvent.code, so it is the same key whatever the keyboard layout.
   * Empty for modifiers on their own — Ctrl, or Ctrl + Alt — which fire when
   * they are let go without anything else having been pressed.
   */
  code: string
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Ctrl+Space on every machine. Not Cmd+Space on a Mac: macOS gives that to
 * Spotlight before any app sees it, so it could never start a recording.
 */
export const DEFAULT_SHORTCUT: Shortcut = { ctrl: true, meta: false, alt: false, shift: false, code: 'Space' }

export function matchesShortcut(e: KeyboardEvent, s: Shortcut) {
  return (
    !!s.code && e.code === s.code && e.ctrlKey === s.ctrl && e.metaKey === s.meta && e.altKey === s.alt && e.shiftKey === s.shift
  )
}

export const sameShortcut = (a: Shortcut, b: Shortcut) =>
  a.code === b.code && a.ctrl === b.ctrl && a.meta === b.meta && a.alt === b.alt && a.shift === b.shift

const MODIFIER_CODES = /^(Control|Meta|Alt|Shift|OS|AltGraph)(Left|Right)?$/

/** Keys nobody types into a text box, so they work on their own. */
const LONE_KEYS = /^(F\d+|Insert|Pause|ScrollLock|ContextMenu|PrintScreen|Help|Media\w*|Audio\w*|Launch\w*|Browser\w*)$/

/**
 * The shortcut a key press describes, or null while only modifiers are held.
 * Anything with Ctrl, Alt or Cmd, and the keys nobody types. Not a plain
 * letter, space or Shift + letter: those would fire on ordinary typing, and
 * that letter could never be typed again.
 */
export function shortcutFromEvent(e: KeyboardEvent): Shortcut | null {
  if (MODIFIER_CODES.test(e.code)) return null
  const s = { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, code: e.code }
  if (!s.ctrl && !s.meta && !s.alt && !LONE_KEYS.test(e.code)) return null
  return s
}

/**
 * Notices modifiers pressed and let go on their own — Ctrl, or Ctrl + Alt —
 * with nothing else pressed in between. Fed every keydown and keyup (and told
 * about clicks, since Ctrl + click is not a tap of Ctrl); `up` hands back the
 * chord once the last modifier is released.
 */
export function chordTracker() {
  let peak = { ctrl: false, meta: false, alt: false, shift: false }
  let spoiled = false
  const reset = () => {
    peak = { ctrl: false, meta: false, alt: false, shift: false }
    spoiled = false
  }
  return {
    down(e: KeyboardEvent) {
      if (!MODIFIER_CODES.test(e.code)) {
        spoiled = true
        return
      }
      peak = {
        ctrl: peak.ctrl || e.ctrlKey,
        meta: peak.meta || e.metaKey,
        alt: peak.alt || e.altKey,
        shift: peak.shift || e.shiftKey,
      }
    },
    up(e: KeyboardEvent): Shortcut | null {
      if (!MODIFIER_CODES.test(e.code)) return null
      // Others still held: the chord is not finished.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
      const any = peak.ctrl || peak.meta || peak.alt || peak.shift
      const chord = any && !spoiled ? { ...peak, code: '' } : null
      reset()
      return chord
    },
    spoil() {
      spoiled = true
    },
    reset,
  }
}

function keyName(code: string) {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return { Space: 'Space', Enter: 'Enter', Backquote: '`', Period: '.', Comma: ',', Slash: '/' }[code] ?? code
}

export function formatShortcut(s: Shortcut) {
  if (isMac) {
    return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.meta ? '⌘' : ''}${s.code ? keyName(s.code) : ''}`
  }
  return [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.meta && 'Win', s.code && keyName(s.code)]
    .filter(Boolean)
    .join(' + ')
}

// ─── Applying the dictionary ────────────────────────────────────────────────

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces every learned mishearing with the word it should have been. */
export function applyCorrections(text: string, words: DictWord[]) {
  let out = text
  // Longest first, so "gyna many" is fixed before a shorter lesson inside it.
  const fixes = words.filter((w) => w.heard).sort((a, b) => b.heard!.length - a.heard!.length)
  for (const { word, heard } of fixes) {
    const pattern = heard!.trim().split(/\s+/).map(escape).join('[\\s,.-]+')
    // Letters on either side mean it is part of a longer word: leave it.
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), word)
  }
  return out
}

/** The words to tell the model about, so it can spell them. */
export function vocabulary(words: DictWord[]) {
  const unique = [...new Set(words.map((w) => w.word.trim()))]
  return unique.join(', ').slice(0, 800)
}

// ─── Learning from a hand edit ──────────────────────────────────────────────

interface Token {
  raw: string
  /** For comparing: no surrounding punctuation, lowercase, no accents. */
  key: string
}

const strip = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function tokens(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, key: fold(strip(raw)) }))
}

function levenshtein(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/**
 * Whether a hand edit looks like fixing how a name was heard, rather than
 * rewriting what was said. Getting this wrong is costly — a lesson learned
 * from "tomorrow" → "on Friday" would rewrite every later "tomorrow" — so it
 * has to pass all of these:
 *
 * - short on both sides: a name, not a sentence;
 * - the new text has a capital or a digit: names and brands, which is what
 *   the model misspells, and not their/there, which would then be "fixed"
 *   everywhere;
 * - not just a change of case or punctuation;
 * - it sounds alike: close in spelling once accents and spaces are gone,
 *   which "Gyna Many" → "Dinamene" is and "tomorrow" → "Friday" is not.
 */
function looksLikeMishearing(heard: Token[], written: Token[]) {
  if (heard.length < 1 || heard.length > 4 || written.length < 1 || written.length > 3) return false
  const writtenText = written.map((t) => strip(t.raw)).join(' ')
  if (!/[\p{Lu}\p{N}]/u.test(writtenText)) return false
  const a = heard.map((t) => t.key).join('')
  const b = written.map((t) => t.key).join('')
  if (!a || !b || a === b) return false
  return levenshtein(a, b) / Math.max(a.length, b.length) <= 0.6
}

/**
 * The corrections a person made to dictated text, found by comparing the box
 * as dictation left it with the box now. Only changes to words that were
 * dictated count: editing their own typing around it teaches nothing.
 */
export function learnCorrections(before: string, after: string, dictated: string) {
  const a = tokens(before)
  const b = tokens(after)

  // Edits are local, so peel off what is unchanged at both ends first; a long
  // note would otherwise make the comparison below needlessly slow.
  let start = 0
  while (start < a.length && start < b.length && a[start].raw === b[start].raw) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1].raw === b[endB - 1].raw) {
    endA--
    endB--
  }
  const oldMid = a.slice(start, endA)
  const newMid = b.slice(start, endB)
  if (oldMid.length === 0 || newMid.length === 0 || oldMid.length > 60 || newMid.length > 60) return []

  // Line up what is left word by word (longest common subsequence) and keep
  // each run where words were swapped for others.
  const n = oldMid.length
  const m = newMid.length
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = oldMid[i].key === newMid[j].key ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])

  const hunks: { heard: Token[]; written: Token[] }[] = []
  let cur = { heard: [] as Token[], written: [] as Token[] }
  const flush = () => {
    if (cur.heard.length || cur.written.length) hunks.push(cur)
    cur = { heard: [], written: [] }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && oldMid[i].key === newMid[j].key) {
      flush()
      i++
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.written.push(newMid[j++])
    else cur.heard.push(oldMid[i++])
  }
  flush()

  const dictatedKeys = ` ${tokens(dictated).map((t) => t.key).join(' ')} `
  return hunks
    .filter((h) => looksLikeMishearing(h.heard, h.written))
    .filter((h) => dictatedKeys.includes(` ${h.heard.map((t) => t.key).join(' ')} `))
    .map((h) => ({
      word: h.written.map((t) => strip(t.raw)).join(' '),
      heard: h.heard.map((t) => strip(t.raw).toLowerCase()).join(' '),
    }))
}
