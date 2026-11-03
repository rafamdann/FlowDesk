import React, { useEffect, useMemo, useState } from 'react'
import {
  Pin, PinOff, Trash2, Archive, ArchiveRestore, Palette, Plus, Search, X, FileText, ChevronLeft,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Project, ProjectNote } from '../../types'
import { useProjectStore } from '../../store/projectStore'
import { NoteEditor } from './NoteEditor'
import { useHighlight } from '../../hooks/useHighlight'
import { HIGHLIGHT_CLASS } from '../../lib/highlight'
import { useT } from '../../i18n/useT'

interface NoteBoardProps {
  project: Project
  /**
   * Whose board this is. Null is the project's shared manager board; a user id
   * is that person's private one.
   */
  ownerId: string | null
  /** Read-only opens notes without an editor — how a manager looks in. */
  readOnly?: boolean
}

/** Paper colours, muted to sit inside FlowDesk's own surfaces. */
const COLORS = [
  { name: 'Yellow', value: '#fef3c7' },
  { name: 'Green', value: '#d1fae5' },
  { name: 'Blue', value: '#dbeafe' },
  { name: 'Purple', value: '#ede9fe' },
  { name: 'Pink', value: '#fce7f3' },
  { name: 'Orange', value: '#ffedd5' },
  { name: 'Grey', value: '#e5e7eb' },
  { name: 'White', value: '#ffffff' },
]

/** Strip the HTML down to a line of text for the list preview and search. */
function plainText(html: string): string {
  if (!html) return ''
  const el = document.createElement('div')
  el.innerHTML = html
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The notes board: a list of notes down the side, the one you picked open
 * beside it.
 *
 * This replaced a Keep-style grid of sticky cards. A sticky note is fine for a
 * line of text but not for something you come back to and keep working on,
 * which is what was actually wanted — so a note is now a document with real
 * formatting, tables, checklists and drawings, and the board is a way to move
 * between them.
 */
export function NoteBoard({ project, ownerId, readOnly = false }: NoteBoardProps) {
  const { t } = useT()
  const {
    notes, notesLoadedFor, loadNotes, createNote, updateNote, deleteNote,
    setEditingNote,
  } = useProjectStore()

  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const highlight = useHighlight()

  /**
   * A ringed note has to be findable: a search box that excludes it, or the
   * archive it was filed into, would both leave the reader looking at a list
   * the note is not in.
   */
  useEffect(() => {
    const id = highlight.activeId
    if (!id) return
    const target = notes.find((n) => n.id === id)
    if (!target) return
    setQuery('')
    if (target.isArchived) setShowArchived(true)
  }, [highlight.activeId, notes])

  const boardKey = `${project.id}:${ownerId ?? 'shared'}`

  useEffect(() => {
    if (notesLoadedFor !== boardKey) loadNotes(project.id, ownerId)
  }, [project.id, ownerId, boardKey, notesLoadedFor, loadNotes])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter((n) => n.projectId === project.id && (n.ownerId ?? null) === ownerId)
      .filter((n) => n.isArchived === showArchived)
      .filter((n) => {
        if (!q) return true
        return (
          n.title.toLowerCase().includes(q) ||
          plainText(n.content || n.body).toLowerCase().includes(q)
        )
      })
      .sort((a, b) =>
        a.isPinned === b.isPinned
          ? (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
          : a.isPinned
            ? -1
            : 1
      )
  }, [notes, project.id, ownerId, query, showArchived])

  // Keep a valid selection: the note you were reading may be deleted, archived
  // or filtered out from under you.
  const open = visible.find((n) => n.id === openId) ?? null

  // Tell the store which note is being edited, so its own autosave echoing
  // back over realtime does not reload the note under the caret.
  useEffect(() => {
    setEditingNote(readOnly ? null : open?.id ?? null)
    return () => setEditingNote(null)
  }, [open?.id, readOnly, setEditingNote])

  const handleNew = async () => {
    const created = await createNote(project.id, { title: '', content: '' }, ownerId)
    if (created) {
      setOpenId(created.id)
      setShowArchived(false)
    }
  }

  const handleDelete = async (note: ProjectNote) => {
    if (openId === note.id) setOpenId(null)
    await deleteNote(note.id)
  }

  // On a phone there is no room for both panes: a fixed-width list left a
  // 360px screen a sliver for the note. Below md it is one or the other — the
  // list, or the open note with a way back to it.
  return (
    <div className="flex gap-4 h-[calc(100vh-14rem)] min-h-[28rem]">
      {/* ── The list ──────────────────────────────────────────────────────── */}
      <aside
        className={`${open ? 'hidden md:flex' : 'flex'} w-full md:w-64 flex-shrink-0 flex-col bg-surface border border-border rounded-xl overflow-hidden`}
      >
        <div className="p-2.5 border-b border-border space-y-2">
          {!readOnly && (
            <button
              onClick={handleNew}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-dark transition-colors"
            >
              <Plus size={15} />{t('note_newNote')}</button>
          )}
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('note_search')}
              className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-surface-2 border border-border text-xs text-text-main focus:outline-none focus:border-primary"
            />
          </div>
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
              showArchived
                ? 'bg-primary text-white border-primary'
                : 'bg-surface-2 border-border text-text-muted hover:text-text-main'
            }`}
          >
            <Archive size={13} />
            {showArchived ? 'Showing archive' : 'Archive'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="text-text-subtle text-xs text-center px-3 py-8">
              {showArchived
                ? 'Nothing archived.'
                : query
                  ? 'No notes match.'
                  : readOnly
                    ? 'No notes yet.'
                    : 'No notes yet. Create the first one.'}
            </p>
          ) : (
            visible.map((note) => {
              const preview = plainText(note.content || note.body)
              return (
                <button
                  key={note.id}
                  ref={highlight.isHighlighted(note.id) ? highlight.ref : undefined}
                  onClick={() => setOpenId(note.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border transition-colors ${
                    open?.id === note.id ? 'bg-primary-light' : 'hover:bg-surface-2'
                  } ${highlight.isHighlighted(note.id) ? HIGHLIGHT_CLASS : ''}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0 border border-black/10"
                      style={{ backgroundColor: note.color }}
                    />
                    <span className="text-xs font-medium text-text-main truncate flex-1">
                      {note.title || 'Untitled'}
                    </span>
                    {note.isPinned && <Pin size={11} className="text-primary flex-shrink-0" />}
                  </div>
                  <p className="text-[11px] text-text-subtle truncate mt-0.5">
                    {preview || 'Empty note'}
                  </p>
                  <p className="text-[10px] text-text-subtle mt-0.5">
                    {note.updatedAt ? format(parseISO(note.updatedAt), 'd MMM HH:mm') : ''}
                  </p>
                </button>
              )
            })
          )}
        </div>
      </aside>

      {/* ── The note ──────────────────────────────────────────────────────── */}
      <section
        className={`${open ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col bg-surface border border-border rounded-xl overflow-hidden`}
      >
        {!open ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
            <FileText size={30} className="text-text-subtle" />
            <p className="text-text-muted text-sm font-medium">{t('note_noNoteOpen')}</p>
            <p className="text-text-subtle text-xs">
              {readOnly
                ? 'Pick a note from the list to read it.'
                : 'Pick one from the list, or create a new note.'}
            </p>
          </div>
        ) : (
          <NoteView
            key={open.id}
            note={open}
            readOnly={readOnly}
            onChange={(patch) => updateNote(open.id, patch)}
            onDelete={() => handleDelete(open)}
            onClose={() => setOpenId(null)}
          />
        )}
      </section>
    </div>
  )
}

function NoteView({
  note,
  readOnly,
  onChange,
  onDelete,
  onClose,
}: {
  note: ProjectNote
  readOnly: boolean
  onChange: (patch: Partial<ProjectNote>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t } = useT()
  const [title, setTitle] = useState(note.title)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => setTitle(note.title), [note.id, note.title])

  return (
    <div className="flex flex-col h-full min-h-0" style={{ backgroundColor: note.color }}>
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-black/10">
        {/* Phones show one pane at a time; this is the way back to the list. */}
        <button
          onClick={onClose}
          title={t('ui_close')}
          aria-label={t('ui_close')}
          className="md:hidden -ml-2 p-1.5 rounded text-zinc-600 hover:bg-black/10"
        >
          <ChevronLeft size={18} />
        </button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== note.title && onChange({ title })}
          readOnly={readOnly}
          placeholder={t('ui_title')}
          className="flex-1 min-w-0 bg-transparent text-base font-semibold text-zinc-900 placeholder-zinc-500 focus:outline-none"
        />

        <button
          onClick={() => onChange({ isPinned: !note.isPinned })}
          title={note.isPinned ? 'Unpin' : 'Pin'}
          disabled={readOnly}
          className="p-1.5 rounded text-zinc-600 hover:bg-black/10 disabled:opacity-40 transition-colors"
        >
          {note.isPinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button>

        <div className="relative">
          <button
            onClick={() => setPaletteOpen((v) => !v)}
            title={t('ui_colour')}
            disabled={readOnly}
            className="p-1.5 rounded text-zinc-600 hover:bg-black/10 disabled:opacity-40 transition-colors"
          >
            <Palette size={15} />
          </button>
          {paletteOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 flex gap-1 p-1.5 rounded-lg bg-surface border border-border shadow-lg">
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  title={c.name}
                  onClick={() => {
                    onChange({ color: c.value })
                    setPaletteOpen(false)
                  }}
                  className={`w-5 h-5 rounded-full border transition-transform hover:scale-110 ${
                    note.color === c.value ? 'border-zinc-900' : 'border-black/15'
                  }`}
                  style={{ backgroundColor: c.value }}
                />
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => onChange({ isArchived: !note.isArchived })}
          title={note.isArchived ? 'Restore from archive' : 'Archive'}
          disabled={readOnly}
          className="p-1.5 rounded text-zinc-600 hover:bg-black/10 disabled:opacity-40 transition-colors"
        >
          {note.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
        </button>

        <button
          onClick={onDelete}
          title={t('ui_delete')}
          disabled={readOnly}
          className="p-1.5 rounded text-zinc-600 hover:bg-red-500/20 hover:text-red-700 disabled:opacity-40 transition-colors"
        >
          <Trash2 size={15} />
        </button>

        <button onClick={onClose} title={t('ui_close')} className="hidden md:block p-1.5 rounded text-zinc-600 hover:bg-black/10">
          <X size={15} />
        </button>
      </header>

      <div className="flex-1 min-h-0 bg-white/60">
        <NoteEditor
          content={note.content || (note.body ? `<p>${note.body}</p>` : '')}
          readOnly={readOnly}
          onChange={(html) => onChange({ content: html })}
        />
      </div>
    </div>
  )
}
