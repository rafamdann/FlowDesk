import { useEffect, useState } from 'react'
import { Check, ListChecks, ListTodo, NotebookPen, StickyNote, Smartphone, Copy } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuthStore } from '../../store/authStore'
import { useT } from '../../i18n/useT'
import { DEFAULT_WIDGET_SECTIONS, WIDGET_SECTIONS, cleanSections, type WidgetSection } from '../../lib/widgetSections'
import type { TranslationKey } from '../../i18n/translations'

const ICONS: Record<WidgetSection, typeof ListChecks> = {
  tasks: ListChecks,
  todos: ListTodo,
  worklog: NotebookPen,
  notes: StickyNote,
}

/**
 * What this person's home-screen widget shows. Saved to widget_settings,
 * where the widget on their phone reads it at its next refresh — the phone
 * cannot see anything kept in this browser. A tab of the Settings dialog.
 */
export function WidgetSettings() {
  const { t } = useT()
  const me = useAuthStore((s) => s.currentUser?.id)
  const [sections, setSections] = useState<WidgetSection[]>(DEFAULT_WIDGET_SECTIONS)
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle')
  const [copied, setCopied] = useState(false)
  const setupUrl = `${window.location.origin}/widget/install.html`

  useEffect(() => {
    if (!me) return
    supabase
      .from('widget_settings')
      .select('sections')
      .eq('user_id', me)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setSections(cleanSections(data.sections))
      })
  }, [me])

  const toggle = async (key: WidgetSection) => {
    if (!me) return
    const on = sections.includes(key)
    // Never none: an empty widget is not a choice anyone means to make.
    if (on && sections.length === 1) return
    // Kept in the fixed order, so the widget's layout does not depend on the
    // order things were ticked in.
    const next = WIDGET_SECTIONS.filter((s) => (s === key ? !on : sections.includes(s)))
    setSections(next)
    const { error } = await supabase
      .from('widget_settings')
      .upsert({ user_id: me, sections: next, updated_at: new Date().toISOString() })
    if (error) console.warn('[widget] could not save:', error.message)
    setStatus(error ? 'failed' : 'saved')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the address is on screen to copy by hand */
    }
  }

  return (
    <>
      <p className="text-text-muted text-xs mb-4">{t('widget_intro')}</p>

      <ul className="space-y-2 mb-3">
        {WIDGET_SECTIONS.map((key) => {
          const on = sections.includes(key)
          const Icon = ICONS[key]
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => toggle(key)}
                aria-pressed={on}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                  on ? 'border-primary/50 bg-primary/5' : 'border-border-md hover:border-primary/30'
                }`}
              >
                <Icon size={16} className={on ? 'text-primary' : 'text-text-subtle'} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-text-main">{t(`widget_${key}` as TranslationKey)}</span>
                  <span className="block text-xs text-text-subtle">{t(`widget_${key}Hint` as TranslationKey)}</span>
                </span>
                <span
                  className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 ${
                    on ? 'bg-primary border-primary text-white' : 'border-border-md'
                  }`}
                >
                  {on && <Check size={13} strokeWidth={3} />}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="text-text-subtle text-[11px] mb-1">{t('widget_sizes')}</p>
      <p className={`text-[11px] h-4 ${status === 'failed' ? 'text-danger' : 'text-success'}`}>
        {status === 'saved' ? t('widget_saved') : status === 'failed' ? t('widget_saveFailed') : ''}
      </p>

      <section className="mt-4 pt-4 border-t border-border">
        <h4 className="flex items-center gap-1.5 text-text-main text-sm font-medium mb-1">
          <Smartphone size={14} className="text-text-subtle" />
          {t('widget_setup')}
        </h4>
        <p className="text-text-subtle text-xs mb-2.5">{t('widget_setupHint')}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate h-9 leading-9 px-3 rounded-lg bg-surface-2 text-xs text-text-muted">
            {setupUrl}
          </code>
          <button
            type="button"
            onClick={copy}
            className="h-9 px-3 rounded-lg text-sm text-primary hover:bg-primary/10 transition-colors flex items-center gap-1.5"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('widget_copied') : t('widget_copy')}
          </button>
        </div>
      </section>
    </>
  )
}
