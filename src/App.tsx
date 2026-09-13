import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppData } from './types'
import { loadAll, saveCollection, type CollectionKey } from './api'
import TodoPanel from './components/TodoPanel'
import NotesPanel from './components/NotesPanel'
import CalendarPanel from './components/CalendarPanel'
import PomodoroPanel from './components/PomodoroPanel'
import HabitsPanel from './components/HabitsPanel'
import { BrandMark, IconHabit, IconNote, IconOverview, IconTimer, IconTodo } from './components/icons'
import CommandPalette, { type Command } from './components/CommandPalette'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export type UpdateFn = <K extends CollectionKey>(
  key: K,
  updater: (items: AppData[K]) => AppData[K],
) => void

type ViewKey = 'overview' | 'todos' | 'notes' | 'focus' | 'habits'

const NAV_ITEMS: { key: ViewKey; label: string; icon: JSX.Element }[] = [
  { key: 'overview', label: '总览', icon: <IconOverview /> },
  { key: 'todos', label: '待办', icon: <IconTodo /> },
  { key: 'notes', label: '笔记', icon: <IconNote /> },
  { key: 'focus', label: '专注', icon: <IconTimer /> },
  { key: 'habits', label: '习惯', icon: <IconHabit /> },
]

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAYS_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

export default function App() {
  const [data, setData] = useState<AppData | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [view, setView] = useState<ViewKey>('overview')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const importFileRef = useRef<HTMLInputElement>(null)
  const dataRef = useRef<AppData | null>(null)
  dataRef.current = data
  const timers = useRef<Partial<Record<CollectionKey, ReturnType<typeof setTimeout>>>>({})

  const load = useCallback(async () => {
    try {
      setData(await loadAll())
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 整集合更新:先改本地状态,再防抖 400ms 后整体保存到后端
  const update = useCallback<UpdateFn>((key, updater) => {
    setData((prev) => (prev ? { ...prev, [key]: updater(prev[key]) } : prev))
    setSaveState('saving')
    clearTimeout(timers.current[key])
    timers.current[key] = setTimeout(async () => {
      const current = dataRef.current
      if (!current) return
      try {
        await saveCollection(key, current[key])
        setSaveState('saved')
      } catch {
        setSaveState('error')
      }
    }, 400)
  }, [])

  const handleExport = () => {
    // 触发浏览器下载(GET /api/export 返回 attachment)
    window.location.href = '/api/export'
  }

  // 跨组件动作:面板各自监听这些自定义事件
  const emit = (name: string) => window.dispatchEvent(new CustomEvent(name))

  // 全局快捷键(输入框打字时失效;Ctrl/⌘+K 任何时刻可用)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (typing || paletteOpen || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case '1':
          setView('overview')
          break
        case '2':
          setView('todos')
          break
        case '3':
          setView('notes')
          break
        case '4':
          setView('focus')
          break
        case '5':
          setView('habits')
          break
        case 'n':
          setView('notes')
          emit('workbench:new-note')
          break
        case 't':
          setView('todos')
          emit('workbench:focus-todo-input')
          break
        case '/':
          e.preventDefault()
          setView('notes')
          emit('workbench:focus-search')
          break
        case 'p':
          emit('workbench:timer-toggle')
          break
        case '?':
          setPaletteOpen(true)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen])

  const commands: Command[] = [
    ...NAV_ITEMS.map(({ key, label }, i) => ({
      id: `view-${key}`,
      label: `前往「${label}」`,
      hint: String(i + 1),
      run: () => setView(key),
    })),
    { id: 'new-note', label: '新建笔记', hint: 'N', run: () => { setView('notes'); emit('workbench:new-note') } },
    { id: 'new-todo', label: '新建待办', hint: 'T', run: () => { setView('todos'); emit('workbench:focus-todo-input') } },
    { id: 'search-notes', label: '搜索笔记', hint: '/', run: () => { setView('notes'); emit('workbench:focus-search') } },
    { id: 'timer-toggle', label: '开始 / 暂停番茄钟', hint: 'P', run: () => emit('workbench:timer-toggle') },
    { id: 'timer-reset', label: '重置番茄钟', run: () => emit('workbench:timer-reset') },
    { id: 'export', label: '导出全部数据', run: handleExport },
  ]

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    let payload: unknown
    try {
      payload = JSON.parse(await file.text())
    } catch {
      window.alert('文件不是有效的 JSON。')
      return
    }
    if (!window.confirm('导入会覆盖当前全部数据(服务端会先备份),确认继续?')) return
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await res.text())
      await load()
      setSaveState('saved')
    } catch {
      setSaveState('error')
      window.alert('导入失败,请检查文件格式。')
    }
  }

  if (loadError) {
    return (
      <div className="center-hint">
        <p>数据加载失败,请确认后端服务已启动。</p>
        <button className="btn solid" onClick={load}>
          重试
        </button>
      </div>
    )
  }
  if (!data) return <div className="center-hint">加载中…</div>

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateText = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${WEEKDAYS[now.getDay()]}`
  const dateComment = `// ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} · ${WEEKDAYS_EN[now.getDay()]}`

  // 所有面板只挂载一次,视图切换仅改 CSS 网格布局与可见性,
  // 保证番茄钟计时等组件内部状态跨视图保留
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">个人工作台</div>
            <div className="brand-sub">WORKBENCH</div>
          </div>
        </div>

        <nav className="nav">
          {NAV_ITEMS.map(({ key, label, icon }, i) => (
            <button
              key={key}
              className={`nav-item ${view === key ? 'active' : ''}`}
              onClick={() => setView(key)}
            >
              {icon}
              <span className="no">{String(i + 1).padStart(2, '0')}</span>
              <span className="lab">{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="save-line">
            <span className={`pulse ${saveState === 'error' ? 'err' : ''}`} />
            {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}
          </div>
          <div className="sf">
            <span>LOCAL</span>
            <em>·</em>
            <span>JSON</span>
          </div>
          <div className="data-links">
            <button className="data-link" onClick={handleExport} title="下载全部数据为 JSON">
              导出
            </button>
            <em>·</em>
            <button className="data-link" onClick={() => importFileRef.current?.click()} title="从 JSON 备份导入(覆盖当前数据)">
              导入
            </button>
          </div>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={handleImportFile}
          />
        </div>
      </aside>

      <main className="content">
        <header className={`app-header ${view === 'overview' ? '' : 'hidden'}`}>
          <div className="hello">
            <h1>
              <span className="tilde">~/</span>
              {greeting}
            </h1>
            <p>{dateText}</p>
          </div>
          <div className="top-right">
            <button
              className="kbd-hint"
              onClick={() => setPaletteOpen(true)}
              title="命令面板(Ctrl/⌘+K)"
            >
              ⌘K
            </button>
            <span className="cm">{dateComment}</span>
          </div>
        </header>

        <div className={`board v-${view}`}>
          <div className="cell cell-todo">
            <TodoPanel todos={data.todos} update={update} />
          </div>
          <div className="cell cell-notes">
            <NotesPanel notes={data.notes} update={update} />
          </div>
          <div className="cell cell-cal">
            <CalendarPanel pomodoros={data.pomodoros} habits={data.habits} />
          </div>
          <div className="cell cell-pomo">
            <PomodoroPanel pomodoros={data.pomodoros} update={update} />
          </div>
          <div className="cell cell-habits">
            <HabitsPanel habits={data.habits} update={update} />
          </div>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  )
}
