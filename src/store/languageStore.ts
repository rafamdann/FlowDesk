import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Lang } from '../i18n/translations'

interface LanguageState {
  lang: Lang
  toggle: () => void
  /**
   * The language dictation listens for. Separate from the app's own: someone
   * reading FlowDesk in English may well be writing a client's caption in
   * Portuguese. Null until they pick one, and until then it follows the app.
   */
  dictationLang: Lang | null
  setDictationLang: (lang: Lang) => void
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      lang: 'en',
      toggle: () => set({ lang: get().lang === 'en' ? 'pt' : 'en' }),
      dictationLang: null,
      setDictationLang: (dictationLang) => set({ dictationLang }),
    }),
    { name: 'flowdesk-lang' }
  )
)
