import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppData } from './types'
import { loadAll, saveCollection, type CollectionKey } from './api'
import TodoPanel from './components/TodoPanel'
import NotesPanel from './components/NotesPanel'
import CalendarPanel from './components/CalendarPanel'
import PomodoroPanel from './components/PomodoroPanel'
import HabitsPanel from './components/HabitsPanel'
import ShortcutsPanel from './components/ShortcutsPanel'
import { BrandMark, IconGrip, IconHabit, IconNote, IconOverview, IconTimer, IconTodo } from './components/icons'
import CommandPalette, { type Command } from './components/CommandPalette'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export type UpdateFn = <K extends CollectionKey>(
  key: K,
  updater: (items: AppData[K]) => AppData[K],
) => void

type ViewKey = 'overview' | 'todos' | 'notes' | 'focus' | 'habits'

// ---------- 总览自由布局 ----------

type PanelId = 'todo' | 'notes' | 'cal' | 'pomo' | 'hab' | 'keys'

const PANEL_IDS: PanelId[] = ['todo', 'notes', 'cal', 'pomo', 'hab', 'keys']
const SPAN_STEPS = [3, 4, 5, 6, 8, 12]
const LAYOUT_KEY = 'overview.layout.v1'

interface OverviewLayout {
  order: PanelId[]
  spans: Record<PanelId, number>
}

const DEFAULT_LAYOUT: OverviewLayout = {
  order: ['todo', 'notes', 'pomo', 'cal', 'hab', 'keys'],
  spans: { todo: 5, notes: 4, cal: 4, pomo: 3, hab: 4, keys: 4 },
}

function loadLayout(): OverviewLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw)
    const order = Array.isArray(parsed?.order)
      ? (parsed.order as PanelId[]).filter((id) => PANEL_IDS.includes(id))
      : []
    for (const id of PANEL_IDS) if (!order.includes(id)) order.push(id)
    const spans = { ...DEFAULT_LAYOUT.spans }
    if (parsed?.spans) {
      for (const id of PANEL_IDS) {
        const s = Number(parsed.spans[id])
        if (SPAN_STEPS.includes(s)) spans[id] = s
      }
    }
    return { order, spans }
  } catch {
    return DEFAULT_LAYOUT
  }
}

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
  const [layout, setLayout] = useState<OverviewLayout>(loadLayout)
  const [dragPanel, setDragPanel] = useState<PanelId | null>(null)
  const [dropTarget, setDropTarget] = useState<PanelId | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)
  const dataRef = useRef<AppData | null>(null)

  // 布局持久化
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  }, [layout])

  const movePanel = (src: PanelId, dst: PanelId) => {
    if (src === dst) return
    setLayout((l) => {
      const order = l.order.filter((id) => id !== src)
      const to = order.indexOf(dst)
      if (to < 0) return l
      order.splice(to, 0, src)
      return { ...l, order }
    })
  }

  const changeSpan = (id: PanelId, dir: 1 | -1) =>
    setLayout((l) => {
      const idx = SPAN_STEPS.indexOf(l.spans[id])
      const next = SPAN_STEPS[Math.min(SPAN_STEPS.length - 1, Math.max(0, idx + dir))]
      if (next === l.spans[id]) return l
      return { ...l, spans: { ...l.spans, [id]: next } }
    })

  const resetLayout = () => setLayout(DEFAULT_LAYOUT)
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

  // 整集合更新:先改本地状态,再防抖 400ms 后整体保存到后端。
  // 保存失败进入重试队列(指数退避,窗口聚焦/联网时立即重试),
  // 关闭页面前若有未落盘的变更,用 sendBeacon 兜底发出。
  const failedKeys = useRef<Set<CollectionKey>>(new Set())
  const retryTimers = useRef<Partial<Record<CollectionKey, ReturnType<typeof setTimeout>>>>({})
  const retryCount = useRef<Partial<Record<CollectionKey, number>>>({})

  const flush = useCallback(async (key: CollectionKey) => {
    const current = dataRef.current
    if (!current) return
    try {
      await saveCollection(key, current[key])
      failedKeys.current.delete(key)
      retryCount.current[key] = 0
      setSaveState(failedKeys.current.size ? 'error' : 'saved')
    } catch {
      failedKeys.current.add(key)
      const delays = [2000, 4000, 8000, 15000, 30000]
      const n = retryCount.current[key] ?? 0
      retryCount.current[key] = n + 1
      clearTimeout(retryTimers.current[key])
      retryTimers.current[key] = setTimeout(() => flush(key), delays[Math.min(n, delays.length - 1)])
      setSaveState('error')
    }
  }, [])

  const update = useCallback<UpdateFn>(
    (key, updater) => {
      setData((prev) => (prev ? { ...prev, [key]: updater(prev[key]) } : prev))
      setSaveState('saving')
      clearTimeout(timers.current[key])
      timers.current[key] = setTimeout(() => flush(key), 400)
    },
    [flush],
  )

  // 有失败队列时:窗口重新聚焦 / 网络恢复 → 立即重试
  useEffect(() => {
    const retryNow = () => {
      for (const key of failedKeys.current) flush(key)
    }
    window.addEventListener('online', retryNow)
    window.addEventListener('focus', retryNow)
    return () => {
      window.removeEventListener('online', retryNow)
      window.removeEventListener('focus', retryNow)
    }
  }, [flush])

  // 关页兜底:把还没保存成功的集合用 sendBeacon 发出
  useEffect(() => {
    const onBeforeUnload = () => {
      const current = dataRef.current
      if (!current) return
      for (const key of failedKeys.current) {
        navigator.sendBeacon?.(
          `/api/${key}`,
          new Blob([JSON.stringify(current[key])], { type: 'application/json' }),
        )
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
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
            {saveState === 'saving'
              ? '保存中…'
              : saveState === 'error'
                ? '保存失败 · 将重试'
                : '已保存'}
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
            {view === 'overview' && (
              <button className="kbd-hint" onClick={resetLayout} title="恢复默认布局">
                重置布局
              </button>
            )}
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

        {(() => {
          const panelEls: Record<PanelId, JSX.Element> = {
            todo: <TodoPanel todos={data.todos} update={update} />,
            notes: <NotesPanel notes={data.notes} update={update} />,
            cal: <CalendarPanel pomodoros={data.pomodoros} habits={data.habits} />,
            pomo: <PomodoroPanel pomodoros={data.pomodoros} update={update} />,
            hab: <HabitsPanel habits={data.habits} update={update} />,
            keys: <ShortcutsPanel onOpenPalette={() => setPaletteOpen(true)} />,
          }
          return (
            <div className={`board v-${view}`}>
              {layout.order.map((id) => (
                <div
                  key={id}
                  className={[
                    'cell',
                    `cell-${id}`,
                    dragPanel === id ? 'dragging' : '',
                    dropTarget === id && dragPanel && dragPanel !== id ? 'drop-target' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={view === 'overview' ? { gridColumn: `span ${layout.spans[id]}` } : undefined}
                  onDragOver={(e) => {
                    if (!dragPanel || dragPanel === id) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dropTarget !== id) setDropTarget(id)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragPanel && dropTarget) movePanel(dragPanel, dropTarget)
                    setDragPanel(null)
                    setDropTarget(null)
                  }}
                  onDragLeave={(e) => {
                    if (e.target === e.currentTarget && dropTarget === id) setDropTarget(null)
                  }}
                >
                  <div className="layout-tools">
                    <button
                      className="layout-grip"
                      draggable
                      onDragStart={(e) => {
                        setDragPanel(id)
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', id)
                      }}
                      onDragEnd={() => {
                        setDragPanel(null)
                        setDropTarget(null)
                      }}
                      title="拖动调整位置"
                    >
                      <IconGrip />
                    </button>
                    <button title="缩窄" onClick={() => changeSpan(id, -1)}>
                      −
                    </button>
                    <button title="加宽" onClick={() => changeSpan(id, 1)}>
                      +
                    </button>
                  </div>
                  {panelEls[id]}
                </div>
              ))}
            </div>
          )
        })()}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  )
}
