import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../i18n/useT'
import { DictationSettings } from './DictationSettings'
import { WidgetSettings } from './WidgetSettings'

type Tab = 'dictation' | 'widget'

/** Each person's own settings: dictation, and their home-screen widget. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT()
  const [tab, setTab] = useState<Tab>('dictation')

  // Esc closes. Recording a new dictation shortcut stops its own Esc from
  // getting this far, so that one cancels the recording instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dictation', label: t('dictate_settings') },
    { key: 'widget', label: t('widget_tab') },
  ]

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
        <div className="flex gap-1 p-1 mb-4 rounded-lg bg-surface-2" role="tablist">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex-1 h-8 rounded-md text-sm font-medium transition-colors ${
                tab === key ? 'bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col min-h-0 overflow-y-auto -mx-1 px-1">
          {tab === 'dictation' ? <DictationSettings /> : <WidgetSettings />}
        </div>
      </div>
    </div>
  )
}
