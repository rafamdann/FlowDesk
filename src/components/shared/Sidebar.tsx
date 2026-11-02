import React, { useState, useEffect } from 'react'
import { NavLink, useNavigate, useMatch, Link, useLocation } from 'react-router-dom'
import {
  NotebookPen, Clapperboard,
  ListTodo, Users, Info, FolderOpen, CalendarDays,
  CheckSquare, Wrench, BookOpen, Building2, MessageCircle, MessageSquare, StickyNote, Sparkles,
  LogOut, Menu, X, ChevronLeft, PanelLeftClose, PanelLeftOpen, ExternalLink, Mic
} from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useProjectStore } from '../../store/projectStore'
import { useLanguageStore } from '../../store/languageStore'
import { useChatStore } from '../../store/chatStore'
import { useT } from '../../i18n/useT'
import { useContentT } from '../../i18n/content'
import { Avatar } from './Avatar'
import { NotificationBell } from './NotificationBell'
import { DictationSettings } from './DictationSettings'
import { useDictationStore } from '../../store/dictationStore'
import { formatShortcut } from '../../lib/dictation'
import {
  canDockWhatsapp, setWhatsappTab, onWhatsappState, openWhatsapp,
  canDockClaude, setClaudeTab, onClaudeState, openClaude, setSidebarWidth,
} from '../../lib/nativeShare'

export function Sidebar() {
  const { currentUser, logout } = useAuthStore()
  const { toggle, lang } = useLanguageStore()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [dictationOpen, setDictationOpen] = useState(false)
  const dictationShortcut = formatShortcut(useDictationStore((s) => s.shortcut))
  const { t } = useT()
  // The content calendar is Portuguese whatever the switch says, name and all.
  const contentLabel = useContentT().c.title

  // Inside a project the sidebar mirrors its tabs; outside it just offers the
  // way back to the picker, since everything else now lives within a project.
  const projectMatch = useMatch('/admin/projects/:projectId/*')
  const activeProjectId = projectMatch?.params.projectId
  const activeProject = useProjectStore((s) =>
    activeProjectId ? s.projects.find((p) => p.id === activeProjectId) : undefined
  )

  // The project's own tabs live in its header; the sidebar carries the tabs
  // themselves so they're reachable from anywhere inside the project.
  const adminNav = activeProjectId
    ? [
        { to: `/admin/projects/${activeProjectId}/todos`, label: t('nav_todos'), icon: <ListTodo size={18} /> },
        { to: `/admin/projects/${activeProjectId}/resources`, label: t('nav_resources'), icon: <FolderOpen size={18} /> },
        { to: `/admin/projects/${activeProjectId}/calendar`, label: t('nav_calendar'), icon: <CalendarDays size={18} /> },
        // Only in a project that has one — InnoWeb's.
        ...(activeProject?.hasContentCalendar
          ? [{ to: `/admin/projects/${activeProjectId}/content`, label: contentLabel, icon: <Clapperboard size={18} /> }]
          : []),
        { to: `/admin/projects/${activeProjectId}/employees`, label: t('nav_employees'), icon: <Users size={18} /> },
        { to: `/admin/projects/${activeProjectId}/notes`, label: t('nav_notes'), icon: <StickyNote size={18} /> },
        // Inside the project, so opening chat does not leave it.
        { to: `/admin/projects/${activeProjectId}/chat`, label: t('nav_chat'), icon: <MessageSquare size={18} /> },
      ]
    : [
        { to: '/admin/projects', label: t('nav_projects'), icon: <Building2 size={18} /> },
        { to: '/admin/chat', label: t('nav_chat'), icon: <MessageSquare size={18} /> },
      ]

  // An employee's sidebar is their project's, so it has the content calendar
  // when their project does.
  const myProject = useProjectStore((s) =>
    currentUser?.projectId ? s.projects.find((p) => p.id === currentUser.projectId) : undefined
  )

  // The same tabs the managers get inside a project, plus the employee's own
  // assigned work. Todos, resources and notes are their side of the project:
  // their own lists and board, and the project's files.
  const employeeNav = [
    { to: '/employee/tasks', label: t('nav_myTasks'), icon: <CheckSquare size={18} /> },
    { to: '/employee/work-log', label: t('nav_workLog'), icon: <NotebookPen size={18} /> },
    { to: '/employee/todos', label: t('nav_todos'), icon: <ListTodo size={18} /> },
    { to: '/employee/resources', label: t('nav_resources'), icon: <FolderOpen size={18} /> },
    { to: '/employee/calendar', label: t('nav_calendar'), icon: <CalendarDays size={18} /> },
    ...(myProject?.hasContentCalendar
      ? [{ to: '/employee/content', label: contentLabel, icon: <Clapperboard size={18} /> }]
      : []),
    { to: '/employee/notes', label: t('nav_notes'), icon: <StickyNote size={18} /> },
    { to: '/employee/chat', label: t('nav_chat'), icon: <MessageSquare size={18} /> },
    { to: '/employee/toolbox', label: t('nav_toolbox'), icon: <Wrench size={18} /> },
    { to: '/employee/guidelines', label: t('nav_guidelines'), icon: <BookOpen size={18} /> },
  ]

  // Live, so a message arriving while you are on another tab shows up on the
  // Chat tab without a reload.
  const unreadChats = useChatStore((s) => s.totalUnread())

  const navItems = (currentUser?.role === 'admin' ? adminNav : employeeNav).map((item) =>
    item.to.endsWith('/chat') ? { ...item, badge: unreadChats } : item
  )

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  // ─── WhatsApp tab ─────────────────────────────────────────────────────────
  // WhatsApp is a native view the desktop shell lays over this page, not a
  // route: a web page cannot embed web.whatsapp.com. So the tab asks the shell
  // to show it, and follows the shell's state rather than owning it.
  const whatsappAvailable = canDockWhatsapp()
  const claudeAvailable = canDockClaude()
  const [whatsappDocked, setWhatsappDocked] = useState(false)
  const [claudeDocked, setClaudeDocked] = useState(false)
  const location = useLocation()

  // Either docked view covers the page, so both suppress the route's highlight.
  const nativeTabOpen = whatsappDocked || claudeDocked

  useEffect(
    () => onWhatsappState(({ open, mode }) => setWhatsappDocked(open && mode === 'dock')),
    []
  )

  useEffect(() => onClaudeState(({ docked }) => setClaudeDocked(docked)), [])

  // Opening WhatsApp does not change the route, so picking the tab you were
  // already on — the common case, since WhatsApp covered it — would leave the
  // route identical and close nothing. Every nav link closes it on click
  // instead, which makes the tabs behave as one selection rather than a toggle
  // layered over the page.
  // Read through a ref, not the state values directly. The route-change effect
  // below runs with the deps it declares, so closing over the flags would use
  // whatever they were on the last route change — stale by the time a tab is
  // clicked, which left the Claude tab open when switching tabs.
  // Remembered between visits: leaving it open and finding it shut on every
  // reload is a setting the app keeps forgetting. Collapsed is still the
  // default for anyone who has never touched it, so a first run opens with
  // the room.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('flowdesk:sidebarCollapsed')
      return saved === null ? true : saved === '1'
    } catch {
      // Private mode or blocked storage: the preference just is not kept.
      return true
    }
  })

  useEffect(() => {
    // The docked native views start where the sidebar ends, so the shell has
    // to be told when that width changes or they would overlap or leave a gap.
    setSidebarWidth(collapsed ? 64 : 240)
    try {
      localStorage.setItem('flowdesk:sidebarCollapsed', collapsed ? '1' : '0')
    } catch {
      // As above — not being able to save it is not worth failing over.
    }
  }, [collapsed])

  // Unconditional on purpose. Guarding these on a docked flag meant a flag
  // that had not arrived yet — or that the shell reported differently — left
  // the view mounted, and it showed as a panel down the edge of the window.
  // Closing something already closed costs nothing, so nothing is asked.
  const leaveNativeTabs = () => {
    setWhatsappTab(false)
    setClaudeTab(false)
  }

  // Still needed for the ways out that are not a sidebar click: the project
  // name, "All projects", or anything else that navigates.
  useEffect(() => {
    leaveNativeTabs()
    // Only on a route change — depending on the docked flags would close them
    // immediately after they opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  // A plain function, not a component: it closes over local state, and
  // remounting it on every render would drop focus and animation state.
  // `mini` is the desktop collapsed rail; the mobile drawer always shows text,
  // since it slides over the page and is not competing for room.
  const sidebarContent = (mini = false) => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div
        // h-16 to match the top bar exactly: both carry a bottom border, and
        // padding alone left them at different heights, so the two lines did
        // not meet where the sidebar ends.
        className={`h-16 flex items-center border-b border-border flex-shrink-0 ${
          mini ? 'justify-center px-2' : 'gap-2.5 px-5'
        }`}
      >
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-sm">F</span>
        </div>
        {!mini && <span className="font-semibold text-text-main text-base">Flow Desk</span>}
      </div>

      {/* Which project you're inside, with the way back out. Collapsed, the
          project is just its colour dot, the name has nowhere to go. */}
      {activeProject && mini && (
        <div className="px-2 pt-3 pb-1 flex justify-center">
          <NavLink
            to={`/admin/projects/${activeProjectId}/about`}
            onClick={() => {
              setMobileOpen(false)
              leaveNativeTabs()
            }}
            title={`${activeProject.name}, project details`}
            className={({ isActive }) =>
              `w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                isActive && !nativeTabOpen ? 'bg-primary-light ring-1 ring-primary/30' : 'hover:bg-surface-2'
              }`
            }
          >
            <span
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: activeProject.color }}
            />
          </NavLink>
        </div>
      )}
      {activeProject && !mini && (
        <div className="px-3 pt-3 pb-1">
          <Link
            to="/admin/projects"
            onClick={() => {
              setMobileOpen(false)
              leaveNativeTabs()
            }}
            className="flex items-center gap-1 text-[11px] text-text-subtle hover:text-text-main mb-2 px-2 transition-colors"
          >
            <ChevronLeft size={12} />{t('ui_allProjects')}</Link>
          {/* The project name is the way into its details, so About needs no
              tab of its own. */}
          <NavLink
            to={`/admin/projects/${activeProjectId}/about`}
            onClick={() => {
              setMobileOpen(false)
              leaveNativeTabs()
            }}
            title={`${activeProject.name}, project details`}
            className={({ isActive }) =>
              `flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                isActive && !nativeTabOpen
                  ? 'bg-primary-light ring-1 ring-primary/30'
                  : 'bg-surface-2 hover:bg-border'
              }`
            }
          >
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: activeProject.color }}
            />
            <span className="text-sm font-medium text-text-main truncate flex-1">{activeProject.name}</span>
            <Info size={13} className="text-text-subtle flex-shrink-0" />
          </NavLink>
        </div>
      )}

      {/* Nav */}
      <nav className={`flex-1 py-4 space-y-0.5 overflow-y-auto ${mini ? 'px-2' : 'px-3'}`}>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => {
              setMobileOpen(false)
              leaveNativeTabs()
            }}
            // Collapsed, the label only exists as a tooltip.
            title={mini ? item.label : undefined}
            className={({ isActive }) =>
              // While a docked view is covering the page it is the selected
              // tab, so the route's own tab must not stay lit as well —
              // otherwise two tabs look active at once.
              `flex items-center rounded-lg text-sm font-medium transition-all duration-150 ${
                mini ? 'justify-center h-10' : 'gap-3 px-3 py-2.5'
              } ${
                isActive && !nativeTabOpen
                  ? 'bg-primary text-white'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text-main'
              }`
            }
          >
            {/* Collapsed, the badge rides the icon; expanded, it sits at the
                end of the row where a count belongs. */}
            {mini && 'badge' in item && (item.badge ?? 0) > 0 ? (
              <span className="relative">
                {item.icon}
                <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] bg-danger text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                  {(item.badge ?? 0) > 9 ? '9+' : item.badge}
                </span>
              </span>
            ) : (
              item.icon
            )}
            {!mini && item.label}
            {!mini && 'badge' in item && (item.badge ?? 0) > 0 && (
              <span className="ml-auto min-w-[18px] h-[18px] bg-danger text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                {(item.badge ?? 0) > 99 ? '99+' : item.badge}
              </span>
            )}
          </NavLink>
        ))}

        {/* Below the other tabs, since it is a tool rather than part of the
            project's data. Desktop app only, a browser cannot embed it. */}
        {/* Both tabs, for everybody. They used to render only when the shell
            could dock them, which is desktop-only — so anyone on the web app,
            which is most of the employees, had no WhatsApp or Claude at all.
            The tabs are there for them now and open in a browser tab instead:
            neither site can be framed, so docking is genuinely impossible on
            the web, but "opens in a tab" beats "is not there". */}
        <button
          onClick={() => {
            setMobileOpen(false)
            if (!whatsappAvailable) {
              // No number: this opens WhatsApp itself, not a conversation.
              openWhatsapp()
              return
            }
            // One native view at a time: leaving the other open docked both
            // and the one behind became a side panel.
            setClaudeTab(false)
            // Always open, never toggle: a tab does not deselect itself when
            // you click it again. You leave by picking another tab.
            setWhatsappTab(true)
          }}
          title={mini ? 'WhatsApp' : undefined}
          className={`w-full flex items-center rounded-lg text-sm font-medium transition-all duration-150 ${
            mini ? 'justify-center h-10' : 'gap-3 px-3 py-2.5'
          } ${
            whatsappDocked
              ? 'bg-[#25d366] text-white'
              : 'text-text-muted hover:bg-surface-2 hover:text-text-main'
          }`}
        >
          <MessageCircle size={18} />
          {!mini && 'WhatsApp'}
          {/* Says it is leaving the app, so a new tab is not a surprise. */}
          {!mini && !whatsappAvailable && (
            <ExternalLink size={12} className="ml-auto opacity-50" />
          )}
        </button>

        <button
          onClick={() => {
            setMobileOpen(false)
            if (!claudeAvailable) {
              openClaude()
              return
            }
            setWhatsappTab(false)
            setClaudeTab(true)
          }}
          title={mini ? 'Claude' : undefined}
          className={`w-full flex items-center rounded-lg text-sm font-medium transition-all duration-150 ${
            mini ? 'justify-center h-10' : 'gap-3 px-3 py-2.5'
          } ${
            claudeDocked
              ? 'bg-[#d97757] text-white'
              : 'text-text-muted hover:bg-surface-2 hover:text-text-main'
          }`}
        >
          <Sparkles size={18} />
          {!mini && 'Claude'}
          {!mini && !claudeAvailable && (
            <ExternalLink size={12} className="ml-auto opacity-50" />
          )}
        </button>
      </nav>

      {/* Notifications + language + user */}
      <div className={`border-t border-border py-3 space-y-2 ${mini ? 'px-2' : 'px-3'}`}>
        {/* The bell lived in the top bar, which is gone. Here it opens
            upwards and to the right, or it would fall off the bottom of the
            window from this far down the sidebar. */}
        <div className={`flex ${mini ? 'justify-center' : 'px-1'}`}>
          <NotificationBell panelClass="left-0 bottom-full mb-2" />
        </div>

        {/* Language toggle: collapsed, the flag alone carries it. */}
        <button
          onClick={toggle}
          className={`w-full flex items-center rounded-lg hover:bg-surface-2 transition-colors ${
            mini ? 'justify-center h-9' : 'justify-between px-3 py-2'
          }`}
          title={lang === 'en' ? 'Mudar para Português' : 'Switch to English'}
        >
          {mini ? (
            <span className="text-base leading-none">{lang === 'en' ? '🇧🇷' : '🇬🇧'}</span>
          ) : (
            <>
              <span className="text-text-muted text-xs font-medium">{lang === 'en' ? '🇧🇷 Português' : '🇬🇧 English'}</span>
              <span className="text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded">
                {t('lang_switchLabel')}
              </span>
            </>
          )}
        </button>

        {/* Dictation: its shortcut, and the team's dictionary. */}
        <button
          onClick={() => setDictationOpen(true)}
          className={`w-full flex items-center rounded-lg hover:bg-surface-2 transition-colors ${
            mini ? 'justify-center h-9' : 'justify-between px-3 py-2'
          }`}
          title={t('dictate_settings')}
        >
          {mini ? (
            <Mic size={15} className="text-text-muted" />
          ) : (
            <>
              <span className="flex items-center gap-2 text-text-muted text-xs font-medium">
                <Mic size={13} />
                {t('dictate_settings')}
              </span>
              <span className="text-[10px] font-mono text-text-subtle">{dictationShortcut}</span>
            </>
          )}
        </button>

        {/* User: collapsed, the avatar is the logout button's own tooltip. */}
        {mini ? (
          <button
            onClick={handleLogout}
            title={`${currentUser?.name}, log out`}
            className="w-full flex justify-center py-1 rounded-lg hover:bg-surface-2 transition-colors group"
          >
            <div className="relative w-8 h-8">
              <Avatar
                id={currentUser?.id}
                initials={currentUser?.avatarInitials}
                name={currentUser?.name}
                size={32}
                className="group-hover:opacity-0 transition-opacity"
              />
              {/* The avatar's colour is an inline style, which no class can
                  override, so the sign-out state is a layer over it. */}
              <div className="absolute inset-0 rounded-full bg-danger flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <LogOut size={14} className="text-white" />
              </div>
            </div>
          </button>
        ) : (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg">
          <Avatar
            id={currentUser?.id}
            initials={currentUser?.avatarInitials}
            name={currentUser?.name}
            size={32}
          />
          <div className="flex-1 min-w-0">
            <p className="text-text-main text-sm font-medium truncate">{currentUser?.name}</p>
            <p className="text-text-subtle text-xs capitalize">{currentUser?.role}</p>
          </div>
          <button
            onClick={handleLogout}
            className="text-text-subtle hover:text-danger transition-colors p-1 rounded"
            title={t('ui_logout')}
          >
            <LogOut size={15} />
          </button>
        </div>
        )}

        {/* Collapse to icons, for more room in the main area. Desktop only -
            the mobile drawer slides away entirely and needs no rail. */}
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`hidden md:flex w-full items-center rounded-lg text-text-subtle hover:bg-surface-2 hover:text-text-main transition-colors ${
            mini ? 'justify-center h-9' : 'gap-2 px-3 py-2'
          }`}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          {!mini && <span className="text-xs font-medium">{t('ui_collapse')}</span>}
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile toggle button */}
      <button
        className="md:hidden fixed top-4 left-4 z-50 w-9 h-9 bg-surface border border-border rounded-lg flex items-center justify-center shadow-sm"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Desktop sidebar. Lifted above the page: sticky makes it a layer of
          its own, and without a z-index anything positioned in the page (the
          calendar's blocks) painted over the notification panel that opens
          out of it. Page dialogs sit at z-40 and above and come later in the
          document, so they still cover it. */}
      <aside
        className={`hidden md:flex flex-col bg-surface border-r border-border flex-shrink-0 h-screen sticky top-0 z-40 transition-[width] duration-200 ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        {sidebarContent(collapsed)}
      </aside>

      {/* Mobile sidebar */}
      <aside
        className={`md:hidden fixed top-0 left-0 h-full w-60 bg-surface border-r border-border z-50 flex flex-col transition-transform duration-300 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebarContent()}
      </aside>

      {/* Out here, not in sidebarContent: that is drawn twice, and the
          mobile drawer's transform would pin a fixed dialog inside it. */}
      {dictationOpen && <DictationSettings onClose={() => setDictationOpen(false)} />}
    </>
  )
}
