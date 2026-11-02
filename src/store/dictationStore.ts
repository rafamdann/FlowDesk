import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '../lib/supabaseClient'
import { DEFAULT_SHORTCUT, type DictWord, type Shortcut } from '../lib/dictation'

interface DictationState {
  /**
   * Per device, not per account: Ctrl on Windows is Cmd on a Mac, so the
   * same person may well want a different one on each.
   */
  shortcut: Shortcut
  setShortcut: (s: Shortcut) => void

  /** The team's shared dictionary. See the dictation_words migration. */
  words: DictWord[]
  loaded: boolean
  load: () => Promise<void>
  /** Resolves to the new entry, or null if it was already there or failed. */
  add: (word: string, heard?: string | null) => Promise<DictWord | null>
  remove: (id: string) => Promise<void>
}

export const useDictationStore = create<DictationState>()(
  persist(
    (set, get) => ({
      shortcut: DEFAULT_SHORTCUT,
      setShortcut: (shortcut) => set({ shortcut }),

      words: [],
      loaded: false,
      load: async () => {
        const { data, error } = await supabase
          .from('dictation_words')
          .select('id, word, heard')
          .order('word')
        // Before the migration has run the table does not exist: dictation
        // still works, just without a dictionary.
        if (error) console.warn('[dictation] dictionary unavailable:', error.message)
        set({ words: (data as DictWord[] | null) ?? [], loaded: true })
      },

      add: async (word, heard = null) => {
        word = word.trim()
        heard = heard?.trim().toLowerCase() || null
        if (!word) return null
        const exists = get().words.some(
          (w) => w.word.toLowerCase() === word.toLowerCase() && (w.heard ?? null) === heard,
        )
        if (exists) return null
        const { data, error } = await supabase
          .from('dictation_words')
          .insert({ word, heard })
          .select('id, word, heard')
          .single()
        if (error || !data) {
          console.warn('[dictation] could not add to the dictionary:', error?.message)
          return null
        }
        set((s) => ({ words: [...s.words, data as DictWord].sort((a, b) => a.word.localeCompare(b.word)) }))
        return data as DictWord
      },

      remove: async (id) => {
        const prev = get().words
        set({ words: prev.filter((w) => w.id !== id) })
        const { error } = await supabase.from('dictation_words').delete().eq('id', id)
        if (error) set({ words: prev })
      },
    }),
    {
      name: 'flowdesk-dictation',
      // Only the shortcut is this device's; the words live in the database.
      partialize: (s) => ({ shortcut: s.shortcut }),
    },
  ),
)
