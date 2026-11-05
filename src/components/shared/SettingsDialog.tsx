import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../i18n/useT'
import { DictationSettings } from './DictationSettings'

/** Each person's own settings: dictation. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT()

  // Esc closes. Recording a new dictation shortcut stops its own Esc from
  // getting this far, so that one cancels the recording instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-xl border border-border w-full max-w-md p-5 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-text-main font-semibold text-base">{t('settings_title')}</h3>
          <button onClick={onClose} className="text-text-subtle hover:text-text-main p-1 rounded" title={t('ui_close')}>
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col min-h-0 overflow-y-auto -mx-1 px-1">
          <DictationSettings />
        </div>
      </div>
    </div>
  )
}
