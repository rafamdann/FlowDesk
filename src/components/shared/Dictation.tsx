import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, X, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useLanguageStore } from '../../store/languageStore'
import { useT } from '../../i18n/useT'
import type { Lang } from '../../i18n/translations'

/**
 * Speak instead of typing, in any text box.
 *
 * Mounted once beside the app rather than wired into each field: there are
 * well over a hundred of them — notes, tasks, the work log, comments, chat,
 * every dialog — and per field, the ones nobody remembered would be the ones
 * without it. Instead a mic follows focus: whichever box has the caret gets
 * one in its corner, including boxes added after this was written.
 *
 * The browser records and the `transcribe` edge function turns it into text,
 * in whichever language is picked. Not the browser's own speech recognition:
 * the desktop app is Electron, where that fails with a network error.
 *
 * A field that should never take dictation opts out with data-no-dictation.
 */

type Phase = 'idle' | 'recording' | 'transcribing'

/** Long enough for a proper brain-dump, well short of the upload limit. */
const MAX_MS = 10 * 60 * 1000
const SIZE = 28
const INSET = 4

/** Text inputs only: dictating into a date, a number or a password is nonsense. */
const TEXT_INPUTS = new Set(['text', 'search'])

interface TiptapHost extends HTMLElement {
  editor?: {
    isDestroyed: boolean
    state: { selection: { from: number }; doc: { textBetween: (a: number, b: number) => string } }
    chain: () => { focus: () => { insertContent: (s: string) => { run: () => boolean } } }
  }
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

async function transcribe(audio: Blob, lang: Lang): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error()

  const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'
  const form = new FormData()
  form.append('audio', audio, `dictation.${ext}`)
  form.append('language', lang)

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
  const { t, lang: appLang } = useT()
  const dictationLang = useLanguageStore((s) => s.dictationLang) ?? appLang
  const setDictationLang = useLanguageStore((s) => s.setDictationLang)

  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [lastPos, setPos] = useState<{ right: number; top: number } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState('')

  // Read from focus listeners registered once, so kept in step by hand.
  const phaseRef = useRef<Phase>('idle')
  const setPhase = (next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }
  const recorder = useRef<MediaRecorder | null>(null)
  const discard = useRef(false)
  const savedRange = useRef<Range | null>(null)

  // Follow focus. While recording the mic stays with the box it started in,
  // even if they click elsewhere to read something.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (phaseRef.current !== 'idle') return
      setTarget(dictationTarget(e.target))
    }
    const onFocusOut = () => {
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
  }, [])

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
    // Longer for an error with a reason attached: there is more to read.
    const id = setTimeout(() => setNotice(''), notice.length > 60 ? 10000 : 3500)
    return () => clearTimeout(id)
  }, [notice])

  // The timer, and the ceiling on how long one recording can run.
  useEffect(() => {
    if (phase !== 'recording') return
    const started = Date.now()
    const id = setInterval(() => {
      const ms = Date.now() - started
      setElapsed(ms)
      if (ms >= MAX_MS) stop(true)
    }, 250)
    return () => clearInterval(id)
  }, [phase, stop])

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

  const start = async () => {
    const el = target
    if (!el) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice(t('dictate_unsupported'))
      return
    }

    const sel = window.getSelection()
    savedRange.current = sel && sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = (err as DOMException)?.name
      setNotice(t(name === 'NotFoundError' ? 'dictate_noMic' : 'dictate_micBlocked'))
      return
    }

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    )
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop())
      recorder.current = null
      if (discard.current || chunks.length === 0) {
        setPhase('idle')
        setTarget(dictationTarget(document.activeElement))
        return
      }
      setPhase('transcribing')
      try {
        // Whatever is picked now, not when recording began.
        const { dictationLang: picked, lang } = useLanguageStore.getState()
        const text = (await transcribe(new Blob(chunks, { type: rec.mimeType }), picked ?? lang)).trim()
        if (!text) setNotice(t('dictate_nothingHeard'))
        else if (el.isConnected) insertInto(el, text, savedRange.current)
      } catch (err) {
        // With the reason, when there is one: "could not" alone gives nobody
        // anything to fix.
        const reason = (err as Error)?.message
        setNotice(reason ? `${t('dictate_failed')} ${reason}` : t('dictate_failed'))
      }
      setPhase('idle')
      setTarget(dictationTarget(document.activeElement) ?? (el.isConnected ? el : null))
    }

    discard.current = false
    recorder.current = rec
    rec.start()
    setElapsed(0)
    setPhase('recording')
  }

  // Released if the app itself goes away mid-recording, so the mic light goes out.
  useEffect(() => () => stop(false), [stop])

  // The last position lingers for a frame after the box loses focus.
  const pos = target ? lastPos : null
  if (!pos && !notice) return null

  const seconds = Math.floor(elapsed / 1000)
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const otherLang: Lang = dictationLang === 'en' ? 'pt' : 'en'
  const btn = 'flex items-center justify-center rounded-full transition-colors'

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
          onClick={start}
          title={t('dictate_start').replace('{lang}', dictationLang.toUpperCase())}
          aria-label={t('dictate_start').replace('{lang}', dictationLang.toUpperCase())}
          className={`${btn} bg-surface/90 border border-border text-text-subtle shadow-sm hover:text-primary hover:border-primary/40`}
          style={{ width: SIZE, height: SIZE }}
        >
          <Mic size={14} />
        </button>
      )}

      {pos && phase === 'recording' && (
        <div className="flex items-center gap-1 h-7 pl-2.5 pr-0.5 rounded-full bg-danger text-white shadow-lg">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-xs font-medium tabular-nums w-9">{clock}</span>
          {/* Read only when it is sent, so it can be switched mid-sentence. */}
          <button
            type="button"
            onClick={() => setDictationLang(otherLang)}
            title={t('dictate_language')}
            className="h-5 px-1.5 rounded-full bg-white/20 hover:bg-white/30 text-[10px] font-semibold tracking-wide"
          >
            {dictationLang.toUpperCase()}
          </button>
          <button
            type="button"
            onClick={() => stop(false)}
            title={t('dictate_cancel')}
            aria-label={t('dictate_cancel')}
            className={`${btn} w-6 h-6 hover:bg-white/20`}
          >
            <X size={13} />
          </button>
          <button
            type="button"
            onClick={() => stop(true)}
            title={t('dictate_stop')}
            aria-label={t('dictate_stop')}
            className={`${btn} w-6 h-6 bg-white text-danger hover:bg-white/90`}
          >
            <Square size={10} fill="currentColor" />
          </button>
        </div>
      )}

      {pos && phase === 'transcribing' && (
        <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-text-main text-white text-xs shadow-lg">
          <Loader2 size={12} className="animate-spin" />
          {t('dictate_transcribing')}
        </div>
      )}

      {notice && (
        <div className="absolute bottom-full right-0 mb-1.5 w-max max-w-[260px] px-3 py-2 rounded-lg bg-text-main text-white text-xs shadow-lg animate-fade-in">
          {notice}
        </div>
      )}
    </div>
  )
}
