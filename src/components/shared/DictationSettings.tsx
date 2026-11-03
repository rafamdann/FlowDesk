import { useEffect, useRef, useState } from 'react'
import { Trash2, Keyboard, BookA } from 'lucide-react'
import { useDictationStore } from '../../store/dictationStore'
import { useT } from '../../i18n/useT'
import { chordTracker, DEFAULT_SHORTCUT, formatShortcut, isMac, sameShortcut, shortcutFromEvent } from '../../lib/dictation'

/**
 * Dictation's settings: the shortcut, which is this device's, and the
 * dictionary, which is the whole team's. A tab of the Settings dialog.
 */
export function DictationSettings() {
  const { t, lang } = useT()
  const { shortcut, setShortcut, words, loaded, load, add, remove } = useDictationStore()
  const [capturing, setCapturing] = useState(false)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState('')
  const captureBox = useRef<HTMLDivElement>(null)
  const [chords] = useState(chordTracker)

  // The keys go to whatever has focus, and "Change" is not the field that
  // listens for them: hand focus over as soon as recording starts.
  useEffect(() => {
    if (capturing) {
      chords.reset()
      captureBox.current?.focus()
    }
  }, [capturing, chords])

  useEffect(() => {
    load()
  }, [load])

  // Any key with Ctrl, Alt or Cmd is taken as it is pressed; modifiers on
  // their own (Ctrl, Ctrl + Alt) when they are let go. Every key is kept
  // from the page meanwhile, so nothing else reacts to the one being tried.
  const captureDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    chords.down(e.nativeEvent)
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return setCapturing(false)
    const next = shortcutFromEvent(e.nativeEvent)
    if (!next) return
    setShortcut(next)
    setCapturing(false)
  }
  const captureUp = (e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const chord = chords.up(e.nativeEvent)
    if (!chord) return
    setShortcut(chord)
    setCapturing(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    setAddError('')
    try {
      await add(draft)
      setDraft('')
    } catch (err) {
      setAddError(`${t('dictate_addFailed')} ${(err as Error).message}`)
    }
  }

  const isDefault = sameShortcut(shortcut, DEFAULT_SHORTCUT)

  return (
    <>
      <p className="text-text-muted text-xs mb-5">
        {t('dictate_language').replace('{lang}', lang === 'pt' ? 'Português' : 'English')}
      </p>

      {/* Shortcut */}
      <section className="mb-6">
        <h4 className="flex items-center gap-1.5 text-text-main text-sm font-medium mb-1">
          <Keyboard size={14} className="text-text-subtle" />
          {t('dictate_shortcut')}
        </h4>
        <p className="text-text-subtle text-xs mb-2.5">{t('dictate_shortcutHint')}</p>
        <div className="flex items-center gap-2">
          {/* Not a <button>: a focused button turns Space into a click, so
              Ctrl + Space restarted the recording instead of being taken. */}
          <div
            ref={captureBox}
            role="button"
            tabIndex={0}
            data-shortcut-capture
            onClick={() => setCapturing(true)}
            onKeyDown={capturing ? captureDown : undefined}
            onKeyUp={capturing ? captureUp : undefined}
            onBlur={() => setCapturing(false)}
            className={`min-w-[140px] h-9 px-3 rounded-lg border text-sm font-mono flex items-center justify-center cursor-pointer select-none transition-colors outline-none ${
              capturing
                ? 'border-primary text-primary bg-primary/5'
                : 'border-border-md text-text-main hover:border-primary/40'
            }`}
          >
            {capturing ? t('dictate_shortcutPress') : formatShortcut(shortcut)}
          </div>
          {!capturing && (
            <button
              type="button"
              onClick={() => setCapturing(true)}
              className="h-9 px-3 rounded-lg text-sm text-primary hover:bg-primary/10 transition-colors"
            >
              {t('dictate_shortcutChange')}
            </button>
          )}
          {!capturing && !isDefault && (
            <button
              type="button"
              onClick={() => setShortcut(DEFAULT_SHORTCUT)}
              className="h-9 px-3 rounded-lg text-sm text-text-muted hover:bg-surface-2 transition-colors"
            >
              {t('dictate_shortcutReset')}
            </button>
          )}
        </div>
        <p className="text-text-subtle text-[11px] mt-2">{t('dictate_shortcutRules')}</p>
        {isMac && <p className="text-text-subtle text-[11px] mt-1">{t('dictate_shortcutSpotlight')}</p>}
      </section>

      {/* Dictionary */}
      <section className="flex flex-col min-h-0">
        <h4 className="flex items-center gap-1.5 text-text-main text-sm font-medium mb-1">
          <BookA size={14} className="text-text-subtle" />
          {t('dictate_dictionary')}
        </h4>
        <p className="text-text-subtle text-xs mb-2.5">{t('dictate_dictionaryHint')}</p>
        <form onSubmit={submit} className="flex gap-2 mb-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('dictate_addPlaceholder')}
            // Dictating a word into the box that teaches dictation how to
            // spell it would only write it the wrong way again.
            data-no-dictation
            className="flex-1 h-9 px-3 rounded-lg border border-border-md bg-surface text-sm focus:outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-9 px-4 rounded-lg bg-primary text-white text-sm font-medium disabled:opacity-40"
          >
            {t('dictate_add')}
          </button>
        </form>
        {addError && <p className="text-danger text-xs -mt-1 mb-3">{addError}</p>}
        <ul className="overflow-y-auto min-h-0 -mx-1 px-1 divide-y divide-border">
          {loaded && words.length === 0 && <li className="text-text-subtle text-xs py-2">{t('dictate_dictionaryEmpty')}</li>}
          {words.map((w) => (
            <li key={w.id} className="flex items-center gap-2 py-2 group">
              <span className="text-sm text-text-main font-medium">{w.word}</span>
              {w.heard && (
                <span className="text-xs text-text-subtle truncate">
                  {t('dictate_heardAs').replace('{heard}', w.heard)}
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(w.id)}
                className="ml-auto p-1 rounded text-text-subtle md:opacity-0 md:group-hover:opacity-100 hover:text-danger transition-opacity"
                title={t('ui_remove')}
                aria-label={t('ui_remove')}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
