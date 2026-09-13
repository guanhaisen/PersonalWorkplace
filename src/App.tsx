import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppData } from './types'
import { loadAll, saveCollection, type CollectionKey } from './api'
import TodoPanel from './components/TodoPanel'
import NotesPanel from './components/NotesPanel'
import CalendarPanel from './components/CalendarPanel'
import PomodoroPanel from './components/PomodoroPanel'
import HabitsPanel from './components/HabitsPanel'
import ShortcutsPanel from './components/ShortcutsPanel'
import AiPanel from './components/AiPanel'
import ReportPanel from './components/ReportPanel'
import LinksBar from './components/LinksBar'
import StartPageModal from './components/StartPageModal'
import { BrandMark, IconAi, IconCalendar, IconGrip, IconHabit, IconKeys, IconNote, IconOverview, IconReport, IconTimer, IconTodo } from './components/icons'
import CommandPalette, { type Command } from './components/CommandPalette'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export type UpdateFn = <K extends CollectionKey>(
  key: K,
  updater: (items: AppData[K]) => AppData[K],
) => void

export type ViewKey = 'overview' | 'todos' | 'notes' | 'focus' | 'habits' | 'ai' | 'report'

// ---------- 总览布局:严格两行三列,拖拽互换 ----------

type PanelId = 'todo' | 'notes' | 'cal' | 'pomo' | 'hab' | 'keys' | 'ai' | 'report'
type Rows = PanelId[][]

// 总览可放置的 6 张卡;ai / report 面板常驻挂载但不进总览槽位
const SLOT_IDS: PanelId[] = ['todo', 'notes', 'cal', 'pomo', 'hab', 'keys']
const PANEL_IDS: PanelId[] = [...SLOT_IDS, 'ai', 'report']
const LAYOUT_KEY = 'overview.layout.v3'

const DEFAULT_SLOTS: PanelId[] = ['todo', 'notes', 'pomo', 'cal', 'hab', 'keys']

function loadSlots(): PanelId[] {
  try {
    for (const key of [LAYOUT_KEY, 'overview.layout.v2']) {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      // v3 是六元素槽位数组;v2 是行数组,拍平兼容
      const flat = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed.flat() : parsed
      if (!Array.isArray(flat)) continue
      const ids = flat.filter(
        (id: PanelId, i: number) => SLOT_IDS.includes(id) && flat.indexOf(id) === i,
      )
      if (ids.length === SLOT_IDS.length) return ids as PanelId[]
    }
  } catch {
    // 忽略损坏的存档
  }
  return [...DEFAULT_SLOTS]
}

const NAV_META: Record<ViewKey, { label: string; icon: JSX.Element }> = {
  overview: { label: '总览', icon: <IconOverview /> },
  todos: { label: '待办', icon: <IconTodo /> },
  notes: { label: '笔记', icon: <IconNote /> },
  focus: { label: '专注', icon: <IconTimer /> },
  habits: { label: '习惯', icon: <IconHabit /> },
  ai: { label: 'AI 助手', icon: <IconAi /> },
  report: { label: '周报', icon: <IconReport /> },
}

// 手机端总览的胶囊头:卡片折叠为胶囊,点开一张、收起其余
const CAPSULE_META: Record<PanelId, { label: string; icon: JSX.Element }> = {
  todo: { label: '待办任务', icon: <IconTodo /> },
  notes: { label: '笔记', icon: <IconNote /> },
  cal: { label: '日历', icon: <IconCalendar /> },
  pomo: { label: '番茄钟', icon: <IconTimer /> },
  hab: { label: '习惯打卡', icon: <IconHabit /> },
  keys: { label: '快捷键', icon: <IconKeys /> },
  ai: { label: 'AI 助手', icon: <IconAi /> },
  report: { label: '周报', icon: <IconReport /> },
}

// 导航顺序可自由调整(拖拽),数字快捷键跟随位置
const NAV_KEY = 'nav.order.v1'
const DEFAULT_NAV: ViewKey[] = ['overview', 'todos', 'notes', 'focus', 'habits', 'ai', 'report']

function loadNavOrder(): ViewKey[] {
  try {
    const raw = localStorage.getItem(NAV_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const ids = parsed.filter(
          (id: ViewKey, i: number) => DEFAULT_NAV.includes(id) && parsed.indexOf(id) === i,
        )
        // 旧存档缺新增视图时追加到末尾,避免重置用户已排好的顺序
        for (const id of DEFAULT_NAV) if (!ids.includes(id)) ids.push(id)
        return ids as ViewKey[]
      }
    }
  } catch {
    // 忽略损坏的存档
  }
  return [...DEFAULT_NAV]
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAYS_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

export default function App() {
  const [data, setData] = useState<AppData | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [view, setView] = useState<ViewKey>('overview')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [slots, setSlots] = useState<PanelId[]>(loadSlots)
  const [navOrder, setNavOrder] = useState<ViewKey[]>(loadNavOrder)
  const [navDrag, setNavDrag] = useState<ViewKey | null>(null)
  const [navDropTarget, setNavDropTarget] = useState<{ key: ViewKey; pos: 'before' | 'after' } | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar.collapsed') === '1',
  )
  const [dragPanel, setDragPanel] = useState<PanelId | null>(null)
  const [dropTarget, setDropTarget] = useState<PanelId | null>(null)
  // 手机端总览:当前展开的胶囊对应卡片;null = 全部收起
  const [openCapsule, setOpenCapsule] = useState<PanelId | null>(null)

  // 手机端胶囊长按拖动排序:长按约 400ms 进入拖动,松手提交新顺序;
  // 未满阈值松手是普通点击(展开/收起)。拖动全程只改 transform,落点一次提交。
  const capDrag = useRef<{
    id: PanelId
    fromIndex: number
    targetIndex: number
    startX: number
    startY: number
    active: boolean
    press: HTMLButtonElement
    pointerId: number
    cells: HTMLElement[] | null
    rects: DOMRect[] | null
    step: number
  } | null>(null)
  const capPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const capSuppressClick = useRef(false)

  // 拖动激活后拦截触摸滚动(长按前不拦,保证列表可正常滑动)
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (capDrag.current?.active) e.preventDefault()
    }
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [])

  const measureCapsules = (d: NonNullable<typeof capDrag.current>) => {
    const cells = Array.from(document.querySelectorAll<HTMLElement>('.board .cell.has-cap'))
    const rects = cells.map((c) => c.getBoundingClientRect())
    d.cells = cells
    d.rects = rects
    d.step = rects.length > 1 ? rects[1].top - rects[0].top : 0
    d.fromIndex = cells.findIndex((c) => c.classList.contains(`cell-${d.id}`))
    d.targetIndex = d.fromIndex
  }

  const onCapsulePress = (id: PanelId, e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const press = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    capSuppressClick.current = false
    capDrag.current = {
      id,
      fromIndex: 0,
      targetIndex: 0,
      startX,
      startY,
      active: false,
      press,
      pointerId,
      cells: null,
      rects: null,
      step: 0,
    }
    clearTimeout(capPressTimer.current!)
    capPressTimer.current = setTimeout(() => {
      const d = capDrag.current
      if (!d || d.press !== press) return
      d.active = true
      try {
        press.setPointerCapture(d.pointerId)
      } catch {
        // 指针可能已释放,交给 pointercancel 清理
      }
      press.closest<HTMLElement>('.cell')?.classList.add('cap-dragging')
      navigator.vibrate?.(15)
      setOpenCapsule(null) // 收起展开中的卡片,保证各行等高便于计算
    }, 380)
  }

  const onCapsulePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = capDrag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (!d.active) {
      // 长按生效前的大幅移动是滚动手势,取消长按
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 10) {
        clearTimeout(capPressTimer.current!)
        capDrag.current = null
      }
      return
    }
    if (!d.rects) measureCapsules(d) // 首次移动时测量,确保收起重渲染已完成
    if (!d.rects || !d.cells || !d.cells.length || d.step <= 0) return
    const from = Math.max(d.fromIndex, 0)
    const h = d.rects[0].height
    const minDy = d.rects[0].top - d.rects[from].top
    const maxDy = d.rects[d.rects.length - 1].top - d.rects[from].top
    const dy = Math.min(Math.max(e.clientY - d.startY, minDy), maxDy)
    d.cells[from]?.style.setProperty('transform', `translateY(${dy}px)`)
    const center = d.rects[from].top + h / 2 + dy
    const target = Math.min(
      Math.max(Math.round((center - d.rects[0].top - h / 2) / d.step), 0),
      d.cells.length - 1,
    )
    if (target !== d.targetIndex) {
      d.targetIndex = target
      d.cells.forEach((c, i) => {
        if (i === from) return
        let shift = 0
        if (from < target && i > from && i <= target) shift = -d.step
        if (from > target && i >= target && i < from) shift = d.step
        c.style.setProperty('transform', shift ? `translateY(${shift}px)` : '')
      })
    }
  }

  const endCapsuleDrag = () => {
    clearTimeout(capPressTimer.current!)
    const d = capDrag.current
    capDrag.current = null
    if (!d) return
    if (!d.active) return // 未进入拖动:交给 onClick 展开卡片
    capSuppressClick.current = true
    if (d.targetIndex !== d.fromIndex) {
      const { fromIndex, targetIndex } = d
      setSlots((prev) => {
        const arr = [...prev]
        const [moved] = arr.splice(fromIndex, 1)
        arr.splice(targetIndex, 0, moved)
        return arr
      })
    }
    const cells = d.cells ?? Array.from(document.querySelectorAll<HTMLElement>('.board .cell.has-cap'))
    cells.forEach((c) => {
      c.style.removeProperty('transform')
      c.classList.remove('cap-dragging')
    })
  }
  const importFileRef = useRef<HTMLInputElement>(null)
  const dataRef = useRef<AppData | null>(null)

  // ---------- 总览右下角 AI 悬浮球:可拖动,位置记在 localStorage ----------

  const FAB_POS_KEY = 'ai.fab.pos.v1'
  const FAB_SIZE = 52
  const FAB_MARGIN = 8

  const clampFab = (p: { right: number; bottom: number }) => {
    // 手机端底部有图标导航栏,悬浮球拖动时最低不压到它
    const navReserve = window.matchMedia('(max-width: 640px)').matches ? 64 : 0
    return {
      right: Math.min(
        Math.max(Math.round(p.right), FAB_MARGIN),
        Math.max(window.innerWidth - FAB_SIZE - FAB_MARGIN, FAB_MARGIN),
      ),
      bottom: Math.min(
        Math.max(Math.round(p.bottom), FAB_MARGIN),
        Math.max(window.innerHeight - FAB_SIZE - FAB_MARGIN - navReserve, FAB_MARGIN),
      ),
    }
  }

  const [fabPos, setFabPos] = useState<{ right: number; bottom: number } | null>(() => {
    try {
      const raw = localStorage.getItem(FAB_POS_KEY)
      if (!raw) return null
      const p = JSON.parse(raw)
      if (typeof p?.right === 'number' && typeof p?.bottom === 'number') return clampFab(p)
    } catch {
      // 忽略损坏存档
    }
    return null
  })
  const fabRef = useRef<HTMLButtonElement>(null)
  const fabDrag = useRef<{
    startX: number
    startY: number
    startRight: number
    startBottom: number
    next?: { right: number; bottom: number }
  } | null>(null)
  const [fabDragging, setFabDragging] = useState(false)
  // 区分拖动与点击:pointerup 后由 onClick 读取并复位
  const fabMoved = useRef(false)
  // 悬浮球点击弹出就地聊天窗(不跳转页面);位置锚定按钮当前所在处
  const [fabChatOpen, setFabChatOpen] = useState(false)
  const [fabChatPos, setFabChatPos] = useState<{ left: number; top: number } | null>(null)
  // 问候语名字:个人偏好,存 localStorage
  const [name, setName] = useState(() => localStorage.getItem('profile.name') || '')
  const [nameDraft, setNameDraft] = useState('')
  const [editingName, setEditingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  // 「设为浏览器开始页」指引弹窗
  const [startPageOpen, setStartPageOpen] = useState(false)

  const startEditName = () => {
    setNameDraft(name)
    setEditingName(true)
    requestAnimationFrame(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    })
  }

  const saveName = () => {
    const v = nameDraft.trim()
    setName(v)
    localStorage.setItem('profile.name', v)
    setEditingName(false)
  }

  const toggleFabChat = () => {
    if (fabChatOpen) {
      setFabChatOpen(false)
      return
    }
    // 优先在按钮上方右对齐;上方放不下翻到按钮下方;始终钳制在视口内
    const vw = window.innerWidth
    const vh = window.innerHeight
    const W = Math.min(380, vw - 24)
    const H = Math.min(520, vh - 140)
    const gap = 12
    const r = fabRef.current?.getBoundingClientRect()
    let left = r ? r.right - W : vw - 30 - W
    let top = r ? r.top - gap - H : vh - 96 - H
    if (r && top < gap) top = r.bottom + gap
    left = Math.min(Math.max(left, gap), Math.max(vw - W - gap, gap))
    top = Math.min(Math.max(top, gap), Math.max(vh - H - gap, gap))
    setFabChatPos({ left: Math.round(left), top: Math.round(top) })
    setFabChatOpen(true)
  }

  const onFabPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    fabDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startRight: window.innerWidth - rect.right,
      startBottom: window.innerHeight - rect.bottom,
    }
    fabMoved.current = false
  }

  const onFabPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = fabDrag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!fabMoved.current && Math.hypot(dx, dy) < 5) return
    if (!fabMoved.current) {
      fabMoved.current = true
      setFabDragging(true)
    }
    const next = clampFab({ right: d.startRight - dx, bottom: d.startBottom - dy })
    d.next = next
    // 拖动过程直接改样式,避免每个 mousemove 都重渲染整棵 App 树
    const el = fabRef.current
    if (el) {
      el.style.right = `${next.right}px`
      el.style.bottom = `${next.bottom}px`
    }
  }

  const endFabDrag = () => {
    const d = fabDrag.current
    fabDrag.current = null
    setFabDragging(false)
    if (!d) return
    if (fabMoved.current && d.next) {
      setFabPos(d.next)
      localStorage.setItem(FAB_POS_KEY, JSON.stringify(d.next))
    }
  }

  // Esc 关闭聊天窗;进入 AI 助手页时收起(那边就是完整聊天界面)
  useEffect(() => {
    if (!fabChatOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFabChatOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fabChatOpen])

  useEffect(() => {
    if (view === 'ai') setFabChatOpen(false)
  }, [view])

  // 窗口缩小后把悬浮球拉回视口内(仅视觉钳制,不覆盖记住的位置,放大窗口后原位仍在)
  useEffect(() => {
    const onResize = () => setFabPos((p) => (p ? clampFab(p) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // clampFab 每次渲染重建,但行为只依赖常量与当时的窗口尺寸,无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 布局持久化
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(slots))
  }, [slots])

  useEffect(() => {
    localStorage.setItem(NAV_KEY, JSON.stringify(navOrder))
  }, [navOrder])

  useEffect(() => {
    localStorage.setItem('sidebar.collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // 严格 2×3:拖拽即互换两张卡片
  const swapPanels = (a: PanelId, b: PanelId) =>
    setSlots((prev) => prev.map((id) => (id === a ? b : id === b ? a : id)))

  // 导航排序:src 插到 dst 前/后
  const moveNavItem = (src: ViewKey, dst: ViewKey, pos: 'before' | 'after') => {
    if (src === dst) return
    setNavOrder((prev) => {
      const next = prev.filter((id) => id !== src)
      const i = next.indexOf(dst)
      next.splice(pos === 'before' ? i : i + 1, 0, src)
      return next
    })
  }

  const resetLayout = () => {
    setSlots([...DEFAULT_SLOTS])
    setNavOrder([...DEFAULT_NAV])
  }
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
      // 数字键按导航顺序切换视图
      const digit = Number(e.key)
      if (digit >= 1 && digit <= navOrder.length) {
        setView(navOrder[digit - 1])
        return
      }
      switch (e.key) {
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
          setView('focus')
          emit('workbench:timer-toggle')
          break
        case '?':
          setPaletteOpen(true)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, navOrder])

  const commands: Command[] = [
    ...navOrder.map((key, i) => ({
      id: `view-${key}`,
      label: `前往「${NAV_META[key].label}」`,
      hint: String(i + 1),
      run: () => setView(key),
    })),
    { id: 'new-note', label: '新建笔记', hint: 'N', run: () => { setView('notes'); emit('workbench:new-note') } },
    { id: 'new-todo', label: '新建待办', hint: 'T', run: () => { setView('todos'); emit('workbench:focus-todo-input') } },
    { id: 'search-notes', label: '搜索笔记', hint: '/', run: () => { setView('notes'); emit('workbench:focus-search') } },
    { id: 'timer-toggle', label: '开始 / 暂停番茄钟', hint: 'P', run: () => { setView('focus'); emit('workbench:timer-toggle') } },
    { id: 'timer-reset', label: '重置番茄钟', run: () => emit('workbench:timer-reset') },
    { id: 'ask-ai', label: '询问 AI 助手', run: () => { setView('ai'); setTimeout(() => emit('workbench:ai-focus'), 0) } },
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
      // 服务端已被导入数据覆盖:作废未落盘的防抖保存与失败重试,
      // 避免竞态下旧数据被写回、保存状态灯闪错
      failedKeys.current.clear()
      for (const t of Object.values(timers.current)) clearTimeout(t)
      timers.current = {}
      for (const t of Object.values(retryTimers.current)) clearTimeout(t)
      retryTimers.current = {}
      retryCount.current = {}
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
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button
          className="collapse-btn"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={sidebarCollapsed ? '展开导航' : '收起导航'}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">个人工作台</div>
            <div className="brand-sub">WORKBENCH</div>
          </div>
        </div>

        <nav className="nav">
          {navOrder.map((key, i) => {
            const meta = NAV_META[key]
            const isDragging = navDrag === key
            const isTarget = !!navDropTarget && navDropTarget.key === key && navDrag !== null && navDrag !== key
            return (
              <button
                key={key}
                className={`nav-item ${view === key ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${
                  isTarget ? `drop-${navDropTarget!.pos}` : ''
                }`}
                draggable
                onClick={() => setView(key)}
                title={`${meta.label} · 点击切换,拖动排序`}
                onDragStart={(e) => {
                  setNavDrag(key)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', key)
                }}
                onDragEnd={() => {
                  setNavDrag(null)
                  setNavDropTarget(null)
                }}
                onDragOver={(e) => {
                  if (!navDrag || navDrag === key) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  if (navDropTarget?.key !== key || navDropTarget.pos !== pos)
                    setNavDropTarget({ key, pos })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (navDrag && navDropTarget) moveNavItem(navDrag, navDropTarget.key, navDropTarget.pos)
                  setNavDrag(null)
                  setNavDropTarget(null)
                }}
                onDragLeave={(e) => {
                  if (e.target === e.currentTarget && navDropTarget?.key === key) setNavDropTarget(null)
                }}
              >
                {meta.icon}
                <span className="no">{String(i + 1).padStart(2, '0')}</span>
                <span className="lab">{meta.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="save-line">
            <span className={`pulse ${saveState === 'error' ? 'err' : ''}`} />
            <span className="save-text">
              {saveState === 'saving'
                ? '保存中…'
                : saveState === 'error'
                  ? '保存失败 · 将重试'
                  : '已保存'}
            </span>
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
              {editingName ? (
                <input
                  ref={nameInputRef}
                  className="name-edit"
                  value={nameDraft}
                  placeholder="名字(留空则不显示)"
                  maxLength={20}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName()
                    if (e.key === 'Escape') setEditingName(false)
                  }}
                  onBlur={saveName}
                />
              ) : (
                <>
                  {greeting}
                  {name && `,${name}`}
                  <button className="name-edit-btn" title="设置名字" onClick={startEditName}>
                    ✎
                  </button>
                </>
              )}
            </h1>
            <p>{dateText}</p>
          </div>

          <LinksBar links={data.links} update={update} />

          <div className="top-right">
            <button
              className="kbd-hint"
              onClick={() => setStartPageOpen(true)}
              title="把个人工作台设为浏览器开始页"
            >
              设为开始页
            </button>
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
            ai: <AiPanel data={data} update={update} onNavigate={setView} />,
            report: <ReportPanel data={data} />,
          }
          // 各视图的行结构;总览固定两行三列(槽位由用户互换),其余面板保持挂载(隐藏)
          const overviewRows: Rows = [slots.slice(0, 3), slots.slice(3, 6)]
          const VIEW_ROWS: Record<ViewKey, Rows> = {
            overview: overviewRows,
            todos: [['todo']],
            notes: [['notes']],
            focus: [['pomo', 'cal']],
            habits: [['hab']],
            ai: [['ai']],
            report: [['report']],
          }
          const viewRows = VIEW_ROWS[view]
          const inView = new Set(viewRows.flat())
          const hidden = PANEL_IDS.filter((id) => !inView.has(id))

          const cellOf = (id: PanelId, withCapsule: boolean) => {
            const isDragging = dragPanel === id
            const isTarget = !!dropTarget && dropTarget === id && dragPanel !== null && dragPanel !== id
            const capOpen = withCapsule && openCapsule === id
            return (
              <div
                key={id}
                className={`cell cell-${id} ${withCapsule ? 'has-cap' : ''} ${capOpen ? 'cap-open' : ''} ${
                  isDragging ? 'dragging' : ''
                } ${isTarget ? 'drop-target' : ''}`}
                onDragOver={(e) => {
                  if (!dragPanel || dragPanel === id) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dropTarget !== id) setDropTarget(id)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragPanel && dropTarget) swapPanels(dragPanel, dropTarget)
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
                    title="拖到其他卡片上互换位置"
                  >
                    <IconGrip />
                  </button>
                </div>
                {withCapsule && (
                  <button
                    type="button"
                    className="capsule-head"
                    aria-expanded={capOpen}
                    onPointerDown={(e) => onCapsulePress(id, e)}
                    onPointerMove={onCapsulePointerMove}
                    onPointerUp={endCapsuleDrag}
                    onPointerCancel={endCapsuleDrag}
                    onClick={() => {
                      if (capSuppressClick.current) {
                        capSuppressClick.current = false
                        return
                      }
                      setOpenCapsule(capOpen ? null : id)
                    }}
                  >
                    {CAPSULE_META[id].icon}
                    <span>{CAPSULE_META[id].label}</span>
                    <i className="cap-chev" aria-hidden="true">
                      ▾
                    </i>
                  </button>
                )}
                {panelEls[id]}
              </div>
            )
          }

          return (
            <div className={`board v-${view}`}>
              {viewRows.map((row, ri) => (
                <div
                  key={ri}
                  className="board-row"
                  style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                >
                  {row.map((id) => cellOf(id, view === 'overview'))}
                </div>
              ))}
              {hidden.length > 0 && <div style={{ display: 'none' }}>{hidden.map((id) => cellOf(id, false))}</div>}
            </div>
          )
        })()}

        {/* 右下角:AI 助手快捷入口,除 AI 助手页外常驻;可拖动,点击弹出就地聊天窗 */}
        {view !== 'ai' && (
          <button
            ref={fabRef}
            className={`ai-fab ${fabDragging ? 'dragging' : ''}`}
            style={fabPos ?? undefined}
            title="AI 助手 · 拖动可换位置"
            onPointerDown={onFabPointerDown}
            onPointerMove={onFabPointerMove}
            onPointerUp={endFabDrag}
            onPointerCancel={endFabDrag}
            onClick={() => {
              if (fabMoved.current) {
                fabMoved.current = false
                return
              }
              toggleFabChat()
            }}
          >
            <IconAi />
          </button>
        )}

        {view !== 'ai' && fabChatOpen && (
          <div className="ai-pop" style={fabChatPos ?? undefined}>
            <AiPanel
              data={data}
              update={update}
              onNavigate={setView}
              onClose={() => setFabChatOpen(false)}
              autoFocus
            />
          </div>
        )}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      {startPageOpen && <StartPageModal onClose={() => setStartPageOpen(false)} />}
    </div>
  )
}
