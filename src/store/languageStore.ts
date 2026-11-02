import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Lang } from '../i18n/translations'

interface LanguageState {
  lang: Lang
  toggle: () => void
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      lang: 'en',
      toggle: () => set({ lang: get().lang === 'en' ? 'pt' : 'en' }),
    }),
    { name: 'flowdesk-lang' }
  )
)
