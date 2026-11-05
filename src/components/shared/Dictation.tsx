import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useLanguageStore } from '../../store/languageStore'
import { useDictationStore } from '../../store/dictationStore'
import { useT } from '../../i18n/useT'
import { applyCorrections, chordTracker, formatShortcut, learnCorrections, matchesShortcut, sameShortcut, vocabulary } from '../../lib/dictation'
import type { Lang } from '../../i18n/translations'

/**
 * Speak instead of typing, in any text box.
 *
 * Mounted once beside the app rather than wired into each field: there are
 * well over a hundred of them — notes, tasks, the work log, comments, chat,
 * every dialog — and per field, the ones nobody remembered would be the ones
 * without it. Instead a mic follows focus: whichever box has the caret gets
 * one in its corner, including boxes added after this was written. The
 * shortcut (Ctrl+Space unless changed) starts and stops it from the keyboard.
 *
 * The browser records and the `transcribe` edge function turns it into text,
 * in the app's language, with the team's dictionary as a hint. Not the
 * browser's own speech recognition: the desktop app is Electron, where that
 * fails with a network error.
 *
 * A field that should never take dictation opts out with data-no-dictation.
 */

type Phase = 'idle' | 'recording' | 'transcribing'

/** Long enough for a proper brain-dump, well short of the upload limit. */
const MAX_MS = 10 * 60 * 1000
const SIZE = 28
const INSET = 4
const BARS = 10
/** Tallest in the middle, so the bars swell like a voice rather than jitter. */
const BAR_SHAPE = Array.from({ length: BARS }, (_, k) => 0.45 + 0.55 * Math.sin((Math.PI * (k + 0.5)) / BARS))
/** Where speech lives; hum below and hiss above it are left out of the bars. */
const VOICE_LOW_HZ = 300
const VOICE_HIGH_HZ = 3400
/** How often the level is read for the silence clock. */
const TICK_MS = 50
/** Below this a recording is room noise, not a voice. */
const VOICE_RMS = 0.02
/**
 * Less voice than this and nothing is sent. Silence is not just wasted money:
 * given nothing to hear, the model makes something up.
 */
const MIN_VOICE_MS = 300

/** Text inputs only: dictating into a date, a number or a password is nonsense. */
const TEXT_INPUTS = new Set(['text', 'search'])

interface TiptapHost extends HTMLElement {
  editor?: {
    isDestroyed: boolean
    getText: () => string
    state: { selection: { from: number }; doc: { textBetween: (a: number, b: number) => string } }
    chain: () => { focus: () => { insertContent: (s: string) => { run: () => boolean } } }
  }
}

interface Notice {
  text: string
  undo?: () => void
}

function dictationTarget(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof HTMLElement) || el.closest('[data-no-dictation]')) return null
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled ? el : null
  if (el.isContentEditable) {
    // The editing host, not the paragraph inside it that took focus.
    let host = el
    while (host.parentElement?.isContentEditable) host = host.parentElement
    return host
  }
  return null
}

/** Everything in the box as plain text, for spotting what they changed. */
function fieldText(el: HTMLElement) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  const editor = (el as TiptapHost).editor
  if (editor && !editor.isDestroyed) return editor.getText()
  return el.innerText
}

/** Joins dictated text onto what is around the caret without gluing words together. */
function spaced(text: string, before: string, after: string) {
  return (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '')
}

function insertInto(el: HTMLElement, raw: string, savedRange: Range | null) {
  // Tiptap keeps its own selection while blurred, and inserting through it
  // goes onto its undo stack and into its onUpdate like typing does.
  const editor = (el as TiptapHost).editor
  if (editor && !editor.isDestroyed) {
    const { from } = editor.state.selection
    const before = editor.state.doc.textBetween(Math.max(0, from - 1), from)
    editor.chain().focus().insertContent(spaced(raw, before, '')).run()
    return
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const text = el instanceof HTMLInputElement ? raw.replace(/\s*\n+\s*/g, ' ') : raw
    // An input remembers its caret after losing focus, so this is wherever
    // they left it — even if they typed more while speaking.
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const piece = spaced(text, el.value.slice(0, start), el.value.slice(end))
    el.focus()
    el.setSelectionRange(start, end)
    // execCommand rather than assigning value: it fires the input event React
    // listens for, so controlled fields update, and Ctrl+Z takes it back.
    if (!document.execCommand('insertText', false, piece)) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
      setter?.call(el, el.value.slice(0, start) + piece + el.value.slice(end))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.setSelectionRange(start + piece.length, start + piece.length)
    }
    return
  }

  // Any other contenteditable.
  el.focus()
  const sel = window.getSelection()
  if (savedRange && sel && !el.contains(sel.anchorNode)) {
    sel.removeAllRanges()
    sel.addRange(savedRange)
  }
  document.execCommand('insertText', false, spaced(raw, ' ', ''))
}

async function transcribe(audio: Blob, lang: Lang, vocab: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error()

  const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'
  const form = new FormData()
  form.append('audio', audio, `dictation.${ext}`)
  form.append('language', lang)
  if (vocab) form.append('vocabulary', vocab)

  const { data, error } = await supabase.functions.invoke('transcribe', {
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  })
  if (error) {
    // supabase-js keeps the function's own reason on the response.
    const res = (error as { context?: Response }).context
    const body = res && typeof res.json === 'function' ? await res.json().catch(() => null) : null
    console.error('[dictation]', body?.error ?? error)
    throw new Error(body?.error ?? error.message)
  }
  return String(data?.text ?? '')
}

export function Dictation() {
  const { t } = useT()
  const shortcut = useDictationStore((s) => s.shortcut)
  const shortcutLabel = formatShortcut(shortcut)

  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [lastPos, setPos] = useState<{ right: number; top: number } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Read from listeners registered once, so kept in step by hand.
  const phaseRef = useRef<Phase>('idle')
  const setPhase = (next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }
  const recorder = useRef<MediaRecorder | null>(null)
  const discard = useRef(false)
  const savedRange = useRef<Range | null>(null)
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  /** The last dictation, watched so a hand correction can be learned. */
  const watch = useRef<{ el: HTMLElement; before: string; dictated: string } | null>(null)

  const say = useCallback((text: string, undo?: () => void) => setNotice({ text, undo }), [setNotice])

  /**
   * Compares the box with how dictation left it, and adds any name they
   * fixed by hand to the team's dictionary. Runs when they leave the box, so
   * a half-typed correction is never mistaken for the finished one.
   */
  const learn = useCallback(() => {
    const w = watch.current
    if (!w) return
    if (!w.el.isConnected) {
      watch.current = null
      return
    }
    const { add, remove } = useDictationStore.getState()
    for (const fix of learnCorrections(w.before, fieldText(w.el), w.dictated)) {
      add(fix.word, fix.heard)
        .then((entry) => {
          if (entry) say(t('dictate_learned').replace('{word}', entry.word), () => remove(entry.id))
        })
        // Learning is a bonus: a failure here is in the console, not in their way.
        .catch(() => {})
    }
  }, [say, t])

  // Follow focus. While recording the mic stays with the box it started in,
  // even if they click elsewhere to read something.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (phaseRef.current !== 'idle') return
      setTarget(dictationTarget(e.target))
    }
    const onFocusOut = (e: FocusEvent) => {
      if (watch.current && e.target instanceof Node && watch.current.el.contains(e.target)) {
        // Only when focus has really left the box, not moved inside it.
        setTimeout(() => {
          if (watch.current && !watch.current.el.contains(document.activeElement)) learn()
        }, 0)
      }
      // Focus moves out and then in; only clear if it went nowhere useful.
      setTimeout(() => {
        if (phaseRef.current !== 'idle') return
        setTarget(dictationTarget(document.activeElement))
      }, 0)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [learn])

  const stop = useCallback((keep: boolean) => {
    discard.current = !keep
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  // Track the box every frame: it can scroll inside any container, sit in a
  // dialog that animates in, or grow as they type. Cheap — one rect a frame,
  // and a render only when it actually moved.
  useEffect(() => {
    if (!target) return
    let frame = 0
    const tick = () => {
      if (!target.isConnected) {
        // The box went away (a dialog closed) mid-recording: nowhere to put it.
        stop(false)
        setTarget(null)
        return
      }
      const r = target.getBoundingClientRect()
      const tooSmall = r.width < 100 || r.height < 20
      const offscreen = r.bottom < 0 || r.top > window.innerHeight
      let next: { right: number; top: number } | null = null
      if (!tooSmall && !offscreen) {
        const singleLine = target instanceof HTMLInputElement
        // A one-line box gets it centred on the right; a tall one in the
        // bottom corner, kept on screen when the box runs past the fold.
        const top = singleLine
          ? r.top + (r.height - SIZE) / 2
          : Math.min(r.bottom, window.innerHeight) - SIZE - INSET
        next = { right: window.innerWidth - r.right + INSET, top: Math.max(INSET, top) }
      }
      setPos((p) =>
        p === next || (p && next && Math.abs(p.right - next.right) < 0.5 && Math.abs(p.top - next.top) < 0.5) ? p : next,
      )
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [target, stop])

  useEffect(() => {
    if (!notice) return
    // Longer for anything with more to read, or a button to reach.
    const id = setTimeout(() => setNotice(null), notice.undo || notice.text.length > 60 ? 8000 : 3500)
    return () => clearTimeout(id)
  }, [notice])

  // Esc throws the recording away. Captured first, so the dialog the box sits
  // in does not close along with it.
  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      stop(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, stop])

  const start = async (el: HTMLElement) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      say(t('dictate_unsupported'))
      return
    }
    // Whatever they corrected in the last one is settled now.
    learn()
    const dict = useDictationStore.getState()
    if (!dict.loaded) dict.load()

    const sel = window.getSelection()
    savedRange.current = sel && sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = (err as DOMException)?.name
      say(t(name === 'NotFoundError' ? 'dictate_noMic' : 'dictate_micBlocked'))
      return
    }

    // The bars, and the measure of whether anyone actually spoke.
    const audio = new AudioContext()
    const analyser = audio.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.6
    audio.createMediaStreamSource(stream).connect(analyser)
    const wave = new Float32Array(analyser.fftSize)
    const freq = new Uint8Array(analyser.frequencyBinCount)
    const started = Date.now()
    let voiceMs = 0
    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(wave)
      let sum = 0
      for (const v of wave) sum += v * v
      if (Math.sqrt(sum / wave.length) > VOICE_RMS) voiceMs += TICK_MS
      if (Date.now() - started >= MAX_MS) stop(true)
    }, TICK_MS)

    // The speech band, split into one slice per bar.
    const hz = audio.sampleRate / analyser.fftSize
    const low = Math.round(VOICE_LOW_HZ / hz)
    const band = Math.max(1, Math.floor((VOICE_HIGH_HZ / hz - low) / BARS))
    const heights = new Array<number>(BARS).fill(0)
    let floor = 1
    let frame = 0
    const draw = () => {
      analyser.getByteFrequencyData(freq)
      const slices = heights.map((_, k) => {
        let total = 0
        for (let b = low + k * band; b < low + (k + 1) * band; b++) total += freq[b]
        return total / band / 255
      })
      const level = slices.reduce((a, b) => a + b, 0) / BARS
      // The room sets the floor: it drops at once to anything quieter and
      // creeps up only slowly, so a fan or a hum sits under it and only a
      // voice rises above. Pauses between words keep pulling it back down.
      floor = level < floor ? level : floor + (level - floor) * 0.004
      const voice = Math.min(1, Math.max(0, (level - floor - 0.05) / 0.22))
      bars.current.forEach((bar, k) => {
        if (!bar) return
        // A little of each slice's own loudness, so the bars are not in lockstep.
        const texture = Math.min(1.3, Math.max(0.7, level ? slices[k] / level : 1))
        const target = Math.min(1, voice * BAR_SHAPE[k] * texture)
        // Rise quickly, settle gently.
        heights[k] += (target - heights[k]) * (target > heights[k] ? 0.35 : 0.12)
        bar.style.transform = `scaleY(${0.14 + 0.86 * heights[k]})`
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    )
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      clearInterval(meter)
      cancelAnimationFrame(frame)
      audio.close()
      stream.getTracks().forEach((track) => track.stop())
      recorder.current = null
      const done = () => {
        setPhase('idle')
        setTarget(dictationTarget(document.activeElement) ?? (el.isConnected ? el : null))
      }
      if (discard.current || chunks.length === 0) return done()
      if (voiceMs < MIN_VOICE_MS) {
        say(t('dictate_nothingHeard'))
        return done()
      }
      setPhase('transcribing')
      try {
        const { words } = useDictationStore.getState()
        const lang = useLanguageStore.getState().lang
        const heard = (await transcribe(new Blob(chunks, { type: rec.mimeType }), lang, vocabulary(words))).trim()
        const text = applyCorrections(heard, words)
        if (!text) say(t('dictate_nothingHeard'))
        else if (el.isConnected) {
          insertInto(el, text, savedRange.current)
          watch.current = { el, before: fieldText(el), dictated: text }
        }
      } catch (err) {
        // With the reason, when there is one: "could not" alone gives nobody
        // anything to fix.
        const reason = (err as Error)?.message
        say(reason ? `${t('dictate_failed')} ${reason}` : t('dictate_failed'))
      }
      done()
    }

    discard.current = false
    recorder.current = rec
    rec.start()
    setPhase('recording')
  }

  // The shortcut: starts in the focused box, stops (and keeps) wherever focus
  // has wandered since. Captured, so it wins over whatever the box itself
  // would do with the keys.
  const startRef = useRef(start)
  useEffect(() => {
    startRef.current = start
  })
  useEffect(() => {
    /** Start or stop; false when there was nothing to act on. */
    const fire = () => {
      if (phaseRef.current === 'recording') {
        stop(true)
        return true
      }
      if (phaseRef.current !== 'idle') return false
      const el = dictationTarget(document.activeElement)
      if (!el) return false
      setTarget(el)
      startRef.current(el)
      return true
    }
    // The settings field that is recording a new shortcut gets the keys.
    const capturing = () => !!document.activeElement?.closest('[data-shortcut-capture]')

    // A shortcut of modifiers alone (Ctrl, Ctrl + Alt) fires on release.
    const chords = chordTracker()
    const onDown = (e: KeyboardEvent) => {
      chords.down(e)
      if (!matchesShortcut(e, useDictationStore.getState().shortcut) || capturing()) return
      if (fire()) e.preventDefault()
    }
    const onUp = (e: KeyboardEvent) => {
      const chord = chords.up(e)
      const shortcut = useDictationStore.getState().shortcut
      if (!chord || shortcut.code || !sameShortcut(chord, shortcut) || capturing()) return
      fire()
    }
    // Ctrl + click is not a tap of Ctrl; leaving the window ends any chord.
    const onPointer = () => chords.spoil()
    const onBlur = () => chords.reset()
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [stop])

  // Released if the app itself goes away mid-recording, so the mic light goes out.
  useEffect(() => () => stop(false), [stop])

  // The last position lingers for a frame after the box loses focus.
  const pos = target ? lastPos : null
  if (!pos && !notice) return null

  const pill = 'flex items-center justify-center rounded-full bg-surface border shadow-sm transition-colors'

  return (
    <div
      className="fixed z-[120] !m-0"
      style={pos ? { right: pos.right, top: pos.top } : { right: 16, bottom: 16 }}
      // Never take focus from the box, and never count as a click outside it:
      // dialogs and popovers that close on one would close under the mic.
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {pos && phase === 'idle' && (
        <button
          type="button"
          onClick={() => target && start(target)}
          title={t('dictate_start').replace('{shortcut}', shortcutLabel)}
          aria-label={t('dictate_start').replace('{shortcut}', shortcutLabel)}
          className={`${pill} bg-surface/90 border-border text-text-subtle hover:text-primary hover:border-primary/40`}
          style={{ width: SIZE, height: SIZE }}
        >
          <Mic size={14} />
        </button>
      )}

      {/* Recording: nothing but bars that move with the voice, so it is plain
          the mic is hearing them. A click on them stops it. */}
      {pos && phase === 'recording' && (
        <button
          type="button"
          onClick={() => stop(true)}
          title={t('dictate_stop').replace('{shortcut}', shortcutLabel)}
          aria-label={t('dictate_stop').replace('{shortcut}', shortcutLabel)}
          className={`${pill} gap-[2px] border-primary/40 hover:border-primary`}
          style={{ width: SIZE + 24, height: SIZE }}
        >
          {Array.from({ length: BARS }, (_, k) => (
            <span
              key={k}
              ref={(node) => {
                bars.current[k] = node
              }}
              className="w-[2px] h-[18px] rounded-full bg-primary"
              style={{ transform: 'scaleY(0.14)' }}
            />
          ))}
        </button>
      )}

      {pos && phase === 'transcribing' && (
        <div
          className={`${pill} border-primary/40 text-primary`}
          style={{ width: SIZE + 16, height: SIZE }}
          aria-label={t('dictate_transcribing')}
          title={t('dictate_transcribing')}
        >
          <Loader2 size={14} className="animate-spin" />
        </div>
      )}

      {notice && (
        <div className="absolute bottom-full right-0 mb-1.5 w-max max-w-[280px] flex items-center gap-3 px-3 py-2 rounded-lg bg-text-main text-white text-xs shadow-lg animate-fade-in">
          <span>{notice.text}</span>
          {notice.undo && (
            <button
              type="button"
              onClick={() => {
                notice.undo?.()
                setNotice(null)
              }}
              className="font-semibold text-white/80 hover:text-white underline-offset-2 hover:underline"
            >
              {t('dictate_undo')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
