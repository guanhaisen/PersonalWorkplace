import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import type { AppData } from './types'
import { ApiError, getSettings, loadAll, logout, me, saveCollection, saveSettings, nowLocalStr, type CollectionKey } from './api'
import LoginView from './components/LoginView'
import TodoPanel from './components/TodoPanel'
import CalendarPanel from './components/CalendarPanel'
import SchedulePanel from './components/SchedulePanel'
import HabitsPanel from './components/HabitsPanel'
import ShortcutsPanel from './components/ShortcutsPanel'
import AiPanel from './components/AiPanel'
import ReportPanel from './components/ReportPanel'
import LinksBar from './components/LinksBar'
import StartPageModal from './components/StartPageModal'
import ReminderPopup from './components/ReminderPopup'
import MikuStage, { MIKU_DRAG_END_EVENT, MIKU_DRAG_START_EVENT, MIKU_PLAY_EVENT, MIKU_QQ_EVENT, MIKU_TAP_EVENT } from './components/MikuStage'
import MikuMenu, { type MikuMenuItem } from './components/MikuMenu'
import { BrandMark, IconAi, IconCalendar, IconGitHub, IconGrip, IconHabit, IconKeys, IconOverview, IconReport, IconSchedule, IconTodo } from './components/icons'
import CommandPalette, { type Command } from './components/CommandPalette'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export type UpdateFn = <K extends CollectionKey>(
  key: K,
  updater: (items: AppData[K]) => AppData[K],
) => void

export type ViewKey = 'overview' | 'todos' | 'schedule' | 'habits' | 'ai' | 'report'

// ---------- 总览布局:两行卡槽,拖拽互换 ----------

type PanelId = 'todo' | 'schedule' | 'cal' | 'hab' | 'keys' | 'ai' | 'report'
type Rows = PanelId[][]

// 总览可放置的 5 张卡:课表卡固定占两列,其余单列;ai / report 面板常驻挂载但不进总览槽位
const SLOT_IDS: PanelId[] = ['todo', 'schedule', 'cal', 'hab', 'keys']
const PANEL_IDS: PanelId[] = [...SLOT_IDS, 'ai', 'report']
const LAYOUT_KEY = 'overview.layout.v4'

const DEFAULT_SLOTS: PanelId[] = ['todo', 'hab', 'cal', 'schedule', 'keys']

// 课表卡的合法槽位为 0/1(上行宽位)或 3/4(下行宽位);落到行边界 2 时与后一位交换
function normalizeSlots(arr: PanelId[]): PanelId[] {
  const w = arr.indexOf('schedule')
  if (w === 2) {
    const fixed = [...arr]
    ;[fixed[2], fixed[3]] = [fixed[3], fixed[2]]
    return fixed
  }
  return arr
}

function loadSlots(): PanelId[] {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const ids = parsed.filter(
          (id: PanelId, i: number) => SLOT_IDS.includes(id) && parsed.indexOf(id) === i,
        )
        // 旧存档缺槽位时补齐到末尾,避免重置用户已排好的顺序
        for (const id of SLOT_IDS) if (!ids.includes(id)) ids.push(id)
        if (ids.length === SLOT_IDS.length) return normalizeSlots(ids as PanelId[])
      }
    }
  } catch {
    // 忽略损坏的存档
  }
  return [...DEFAULT_SLOTS]
}

const NAV_META: Record<ViewKey, { label: string; icon: JSX.Element }> = {
  overview: { label: '总览', icon: <IconOverview /> },
  todos: { label: '待办', icon: <IconTodo /> },
  schedule: { label: '课表', icon: <IconSchedule /> },
  habits: { label: '习惯', icon: <IconHabit /> },
  ai: { label: 'Miku', icon: <IconAi /> },
  report: { label: '周报', icon: <IconReport /> },
}

// 手机端总览的胶囊头:卡片折叠为胶囊,点开一张、收起其余
const CAPSULE_META: Record<PanelId, { label: string; icon: JSX.Element }> = {
  todo: { label: '待办任务', icon: <IconTodo /> },
  schedule: { label: '课程表', icon: <IconSchedule /> },
  cal: { label: '日历', icon: <IconCalendar /> },
  hab: { label: '习惯打卡', icon: <IconHabit /> },
  keys: { label: '快捷键', icon: <IconKeys /> },
  ai: { label: 'Miku', icon: <IconAi /> },
  report: { label: '周报', icon: <IconReport /> },
}

// 导航顺序可自由调整(拖拽),数字快捷键跟随位置
const NAV_KEY = 'nav.order.v1'
const DEFAULT_NAV: ViewKey[] = ['overview', 'todos', 'schedule', 'habits', 'ai', 'report']

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
const GITHUB_REPO = 'https://github.com/guanhaisen/PersonalWorkplace'

export default function App() {
  // ---------- 登录会话:先确认身份,再拉当前账号的数据 ----------
  const [authUser, setAuthUser] = useState<string | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
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
  const [dropTarget, setDropTarget] = useState<{ id: PanelId; pos: 'before' | 'after' } | null>(null)
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
        // 课表卡不能落在两行边界(索引 2),否则失去宽位
        return normalizeSlots(arr)
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
  // 单击弹窗的延迟:给双击(切换 QQ 形态)的第二下留出取消窗口
  const FAB_POP_DELAY = 280

  const clampFab = (p: { right: number; bottom: number }, size?: { w: number; h: number }) => {
    // 手机端底部有图标导航栏,悬浮球拖动时最低不压到它
    const navReserve = window.matchMedia('(max-width: 640px)').matches ? 64 : 0
    // Miku 化后按钮比原 52px 大,拖动中按实际尺寸钳制;初始读档时按钮尚未挂载,退回常量
    const w = size?.w ?? FAB_SIZE
    const h = size?.h ?? FAB_SIZE
    return {
      right: Math.min(
        Math.max(Math.round(p.right), FAB_MARGIN),
        Math.max(window.innerWidth - w - FAB_MARGIN, FAB_MARGIN),
      ),
      bottom: Math.min(
        Math.max(Math.round(p.bottom), FAB_MARGIN),
        Math.max(window.innerHeight - h - FAB_MARGIN - navReserve, FAB_MARGIN),
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
  // 悬浮球点击弹出快速提问(轻量输入条 + 回复气泡);底部锚在 Miku 头顶上方,气泡变多向上生长
  const [fabChatOpen, setFabChatOpen] = useState(false)
  const [fabChatPos, setFabChatPos] = useState<{ left: number; bottom: number } | null>(null)
  // 待弹出的聊天窗定时器:双击第二下会取消它
  const fabPopTimer = useRef<number | null>(null)
  // 问候语显示名:跟登录账号绑定,存服务端按账号设置(留空 = 显示用户名)
  const [displayName, setDisplayName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [editingName, setEditingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  // 「设为浏览器开始页」指引弹窗
  const [startPageOpen, setStartPageOpen] = useState(false)
  // Miku Live2D 悬浮球:加载成功前按钮保持星星图标,失败后永久回退图标
  const [mikuReady, setMikuReady] = useState(false)
  const [mikuFailed, setMikuFailed] = useState(false)
  // QQ 人形态:按钮盒与拖动钳制范围随之缩小
  const [mikuQQ, setMikuQQ] = useState(false)
  // 右键菜单与 Miku 偏好(隐藏 / 缩放 / 眼神跟随 / 闲置彩蛋),均持久化
  const [mikuMenu, setMikuMenu] = useState<{ x: number; y: number } | null>(null)
  const [mikuHidden, setMikuHidden] = useState(() => localStorage.getItem('miku.hidden') === '1')
  const [mikuScale, setMikuScale] = useState(() => Number(localStorage.getItem('miku.scale')) || 1)
  const [mikuEye, setMikuEye] = useState(() => localStorage.getItem('miku.eye') !== '0')
  const [mikuIdle, setMikuIdle] = useState(() => localStorage.getItem('miku.idle') !== '0')

  const hideMiku = () => {
    setMikuHidden(true)
    localStorage.setItem('miku.hidden', '1')
    setFabChatOpen(false)
    if (fabPopTimer.current !== null) {
      window.clearTimeout(fabPopTimer.current)
      fabPopTimer.current = null
    }
  }
  const showMiku = () => {
    setMikuHidden(false)
    localStorage.removeItem('miku.hidden')
  }

  const startEditName = () => {
    setNameDraft(displayName)
    setEditingName(true)
    requestAnimationFrame(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    })
  }

  const saveName = () => {
    const v = nameDraft.trim()
    setDisplayName(v)
    setEditingName(false)
    // 显示名按账号存服务端,跨设备一致;失败时本次会话仍显示新值,下次登录以服务端为准
    saveSettings({ displayName: v }).catch(() => {})
  }

  const toggleFabChat = () => {
    if (fabChatOpen) {
      setFabChatOpen(false)
      return
    }
    // 右对齐 Miku 右缘,底部锚在 Miku 头顶上方 12px;气泡变长时向上生长
    const vw = window.innerWidth
    const W = Math.min(320, vw - 24)
    const gap = 12
    const r = fabRef.current?.getBoundingClientRect()
    const left = Math.min(Math.max((r ? r.right : vw - 30) - W, 8), Math.max(vw - W - 8, 8))
    const bottom = r ? Math.round(window.innerHeight - r.top + gap) : 96
    setFabChatPos({ left: Math.round(left), bottom })
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
      // 拖起 Miku 的瞬间收起快捷聊天(弹窗锚定在旧位置,不跟着球走)与待弹出的定时器
      if (fabPopTimer.current !== null) {
        window.clearTimeout(fabPopTimer.current)
        fabPopTimer.current = null
      }
      setFabChatOpen(false)
      window.dispatchEvent(new CustomEvent(MIKU_DRAG_START_EVENT))
    }
    const next = clampFab(
      { right: d.startRight - dx, bottom: d.startBottom - dy },
      { w: fabRef.current?.offsetWidth ?? FAB_SIZE, h: fabRef.current?.offsetHeight ?? FAB_SIZE },
    )
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
    if (fabMoved.current) {
      // 真拖动过才通知 Miku 落地弹跳
      window.dispatchEvent(new CustomEvent(MIKU_DRAG_END_EVENT))
      if (d.next) {
        setFabPos(d.next)
        localStorage.setItem(FAB_POS_KEY, JSON.stringify(d.next))
      }
    }
  }

  // Esc 关闭聊天窗;进入 Miku 页时收起(那边就是完整聊天界面)
  useEffect(() => {
    if (!fabChatOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFabChatOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fabChatOpen])

  // 点击气泡组件与 Miku 以外的区域时收起快速提问(点 Miku 本身由其 onClick 正常切换)
  useEffect(() => {
    if (!fabChatOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('.ai-pop') || t.closest('.ai-fab'))) return
      setFabChatOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fabChatOpen])

  useEffect(() => {
    if (view === 'ai') {
      setFabChatOpen(false)
      if (fabPopTimer.current !== null) {
        window.clearTimeout(fabPopTimer.current)
        fabPopTimer.current = null
      }
    }
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

  // 总览拖拽放置:课表卡固定占两列,拖动它 = 与目标位置的两张卡整块对调;
  // 拖普通卡到课表上同理;普通卡之间直接互换
  const applyDrop = (drag: PanelId, target: PanelId, pos: 'before' | 'after') => {
    setSlots((prev) => {
      if (drag === target) return prev
      const w = prev.indexOf('schedule')
      const di = prev.indexOf(drag)
      const ti = prev.indexOf(target)
      if (drag !== 'schedule' && target !== 'schedule') {
        const arr = [...prev]
        arr[di] = target
        arr[ti] = drag
        return arr
      }
      const dragIsWide = drag === 'schedule'
      const sameRow = w <= 1 ? dragIsWide ? ti <= 1 : di <= 1 : dragIsWide ? ti >= 3 : di >= 3
      if (sameRow) {
        // 同行(课表与它的伙伴卡)互换,宽位跟随课表
        const arr = [...prev]
        arr[w] = target
        arr[ti] = 'schedule'
        return arr
      }
      return moveSchedule(prev, dragIsWide ? ti : di, pos)
    })
  }

  // 把课表(宽卡)移到 targetIndex 所在行,覆盖包含目标卡的相邻两格;
  // 被顶出的两张卡移到课表原来的两格,课表原同行伙伴保持列位置不变
  const moveSchedule = (prev: PanelId[], targetIndex: number, pos: 'before' | 'after'): PanelId[] => {
    const w = prev.indexOf('schedule')
    const inTop = w <= 1
    const partner = inTop ? prev[1 - w] : prev[w === 3 ? 4 : 3]
    const three = inTop ? [prev[2], prev[3], prev[4]] : [prev[0], prev[1], prev[2]]
    const t = inTop ? targetIndex - 2 : targetIndex
    let pair: [PanelId, PanelId]
    let remain: PanelId
    if (t <= 0) {
      pair = [three[0], three[1]]
      remain = three[2]
    } else if (t >= 2) {
      pair = [three[1], three[2]]
      remain = three[0]
    } else if (pos === 'before') {
      pair = [three[0], three[1]]
      remain = three[2]
    } else {
      pair = [three[1], three[2]]
      remain = three[0]
    }
    // 课表覆盖 pair 原来的两格(t=0 或中卡前半 → 左两格,否则右两格)
    const scheduleLeft = t <= 0 || (t === 1 && pos === 'before')
    const top: PanelId[] = inTop
      ? w === 0
        ? [pair[0], pair[1], partner]
        : [partner, pair[0], pair[1]]
      : scheduleLeft
        ? ['schedule', remain]
        : [remain, 'schedule']
    const bottom: PanelId[] = inTop
      ? scheduleLeft
        ? ['schedule', remain]
        : [remain, 'schedule']
      : w === 3
        ? [pair[0], pair[1], partner]
        : [partner, pair[0], pair[1]]
    return [...top, ...bottom]
  }

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
    } catch (err) {
      // 401 = 会话过期/已在别处登出,回到登录页重新建立会话
      if (err instanceof ApiError && err.status === 401) {
        setAuthUser(null)
        return
      }
      setLoadError(true)
    }
  }, [])

  // 启动:先问会话,已登录才加载数据
  useEffect(() => {
    let cancelled = false
    me().then((username) => {
      if (cancelled) return
      setAuthUser(username)
      setAuthChecking(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (authUser) load()
  }, [authUser, load])

  // 显示名跟账号走:登录后从服务端取(空 = 回退用户名),换设备也一致
  useEffect(() => {
    if (!authUser) return
    let cancelled = false
    getSettings()
      .then((s) => {
        if (!cancelled) setDisplayName(typeof s?.displayName === 'string' ? s.displayName : '')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [authUser])

  const handleAuthed = useCallback((username: string) => {
    // 登录/注册成功:数据加载由 authUser 变化触发的 effect 接手
    setAuthUser(username)
  }, [])

  const handleLogout = useCallback(async () => {
    await logout()
    // 作废未落盘的防抖保存与失败重试,避免串到下一个账号
    failedKeys.current.clear()
    for (const t of Object.values(timers.current)) clearTimeout(t)
    timers.current = {}
    for (const t of Object.values(retryTimers.current)) clearTimeout(t)
    retryTimers.current = {}
    retryCount.current = {}
    setData(null)
    setSaveState('idle')
    setLoadError(false)
    setPaletteOpen(false)
    setFabChatOpen(false)
    setView('overview')
    setDisplayName('')
    setAuthUser(null)
  }, [])

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
    } catch (err) {
      // 会话失效:停止重试,清空本地数据回到登录页
      if (err instanceof ApiError && err.status === 401) {
        failedKeys.current.clear()
        for (const t of Object.values(retryTimers.current)) clearTimeout(t)
        retryTimers.current = {}
        setData(null)
        setAuthUser(null)
        return
      }
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
          setView('schedule')
          emit('workbench:new-course')
          break
        case 't':
          setView('todos')
          emit('workbench:focus-todo-input')
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
    { id: 'new-course', label: '新建课程', hint: 'N', run: () => { setView('schedule'); emit('workbench:new-course') } },
    { id: 'new-todo', label: '新建待办', hint: 'T', run: () => { setView('todos'); emit('workbench:focus-todo-input') } },
    { id: 'ask-ai', label: '询问 Miku', run: () => { setView('ai'); setTimeout(() => emit('workbench:ai-focus'), 0) } },
    { id: 'export', label: '导出全部数据', run: handleExport },
    // 头部低频工具在手机上收进面板(桌面头部按钮保留,面板里也有一份)
    { id: 'start-page', label: '设为开始页', run: () => setStartPageOpen(true) },
    { id: 'reset-layout', label: '重置布局', run: resetLayout },
    { id: 'github', label: 'GitHub 仓库', run: () => window.open(GITHUB_REPO, '_blank', 'noopener') },
    ...(mikuHidden ? [{ id: 'show-miku', label: '显示 Miku 悬浮球', run: showMiku }] : []),
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
    if (!window.confirm('导入会覆盖当前账号的全部数据,确认继续?')) return
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

  // ---------- 登录门控:未登录只渲染登录页,其余一概不挂载 ----------

  if (authChecking) return <div className="center-hint">加载中…</div>
  if (!authUser) return <LoginView onAuthed={handleAuthed} />

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

  // ---------- Miku 右键菜单:菜单树(依赖 data 与各项状态,放在数据守卫之后) ----------
  const upcomingReminders = (data.reminders ?? [])
    .filter((r) => !r.firedAt && r.dueAt >= nowLocalStr())
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
    .slice(0, 4)
  const playMiku = (expression: string) =>
    window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression } }))
  const mikuMenuItems: MikuMenuItem[] = [
    { key: 'hide', label: '隐藏她', hint: '⌘K 恢复', onClick: hideMiku },
    { key: 'sep1', label: '', divider: true },
    {
      key: 'act',
      label: '动作',
      children: [
        { key: 'heart', label: '比心', onClick: () => playMiku('比心') },
        { key: 'blush', label: '脸红', onClick: () => playMiku('脸红') },
        { key: 'circle', label: '圈圈', onClick: () => playMiku('圈圈') },
        { key: 'dance', label: '拿葱舞', onClick: () => window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { dance: true } })) },
        { key: 'qq', label: 'QQ 人形态', checked: mikuQQ, onClick: () => window.dispatchEvent(new CustomEvent(MIKU_QQ_EVENT)) },
      ],
    },
    {
      key: 'rem',
      label: '定时提醒',
      children: [
        ...upcomingReminders.map((r) => ({ key: r.id, label: r.title, hint: r.dueAt.split(' ')[1], dim: true })),
        ...(upcomingReminders.length > 0 ? [{ key: 'rem-sep', label: '', divider: true }] : []),
        {
          key: 'rem-new',
          label: '让 AI 新建提醒',
          onClick: () => {
            if (view !== 'ai') toggleFabChat()
          },
        },
      ],
    },
    {
      key: 'size',
      label: '大小',
      children: (
        [
          [0.75, '小'],
          [1, '标准'],
          [1.25, '大'],
        ] as const
      ).map(([v, label]) => ({
        key: `size-${v}`,
        label,
        checked: mikuScale === v,
        onClick: () => {
          setMikuScale(v)
          localStorage.setItem('miku.scale', String(v))
        },
      })),
    },
    {
      key: 'disp',
      label: '显示',
      children: [
        {
          key: 'eye',
          label: '眼神跟随',
          checked: mikuEye,
          onClick: () => {
            setMikuEye(!mikuEye)
            localStorage.setItem('miku.eye', !mikuEye ? '1' : '0')
          },
        },
        {
          key: 'idle',
          label: '闲置彩蛋',
          checked: mikuIdle,
          onClick: () => {
            setMikuIdle(!mikuIdle)
            localStorage.setItem('miku.idle', !mikuIdle ? '1' : '0')
          },
        },
      ],
    },
  ]

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateText = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${WEEKDAYS[now.getDay()]}`
  const dateComment = `// ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} · ${WEEKDAYS_EN[now.getDay()]}`

  // 所有面板只挂载一次,视图切换仅改 CSS 网格布局与可见性,
  // 保证各面板内部状态(筛选、草稿等)跨视图保留
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
          <div className="user-line">
            <span className="user-name" title={`当前账号:${authUser}`}>
              <i className="user-dot" />
              {authUser}
            </span>
            <button className="data-link" onClick={handleLogout} title="退出当前账号">
              退出
            </button>
          </div>
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
            <span>SQLITE</span>
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
                  placeholder="显示名(留空显示用户名)"
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
                  {greeting},{displayName || authUser}
                  <button
                    className="name-edit-btn"
                    title="设置显示名(留空显示用户名)"
                    onClick={startEditName}
                  >
                    ✎
                  </button>
                </>
              )}
            </h1>
            <p className="hello-date">
              {dateText}
              {/* 移动端命令面板入口:头部工具行收进面板后,这里是手机上唯一的 ⌘K 入口 */}
              <button className="kbd-hint hello-k" title="命令面板" onClick={() => setPaletteOpen(true)}>
                ⌘K
              </button>
            </p>
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
            <a
              className="kbd-hint gh-repo"
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              title="GitHub 仓库"
            >
              <IconGitHub />
            </a>
            <span className="cm">{dateComment}</span>
          </div>
        </header>

        {(() => {
          const panelEls: Record<PanelId, JSX.Element> = {
            todo: <TodoPanel todos={data.todos} update={update} />,
            schedule: <SchedulePanel courses={data.courses} update={update} />,
            cal: <CalendarPanel habits={data.habits} />,
            hab: <HabitsPanel habits={data.habits} update={update} />,
            keys: <ShortcutsPanel onOpenPalette={() => setPaletteOpen(true)} />,
            ai: <AiPanel data={data} update={update} onNavigate={setView} />,
            report: <ReportPanel data={data} />,
          }
          // 各视图的行结构;总览行结构随课表卡位置自适应,其余面板保持挂载(隐藏)
          const w = slots.indexOf('schedule')
          const overviewRows: Rows =
            w <= 1
              ? [[slots[0], slots[1]], [slots[2], slots[3], slots[4]]]
              : [[slots[0], slots[1], slots[2]], [slots[3], slots[4]]]
          const wideRowIdx = w <= 1 ? 0 : 1
          const wideCellIdx = w <= 1 ? w : w - 3
          const VIEW_ROWS: Record<Exclude<ViewKey, 'overview'>, Rows> = {
            todos: [['todo']],
            schedule: [['schedule']],
            habits: [['hab']],
            ai: [['ai']],
            report: [['report']],
          }
          const isOverview = view === 'overview'
          const viewRows: Rows = isOverview ? overviewRows : VIEW_ROWS[view]
          const inView = new Set(viewRows.flat())
          const hidden = PANEL_IDS.filter((id) => !inView.has(id))

          const cellOf = (id: PanelId, withCapsule: boolean, span2 = false) => {
            const isDragging = dragPanel === id
            const isTarget = !!dropTarget && dropTarget.id === id && dragPanel !== null && dragPanel !== id
            const capOpen = withCapsule && openCapsule === id
            return (
              <div
                key={id}
                className={`cell cell-${id} ${withCapsule ? 'has-cap' : ''} ${capOpen ? 'cap-open' : ''} ${
                  isDragging ? 'dragging' : ''
                } ${isTarget ? 'drop-target' : ''}`}
                style={span2 ? { gridColumn: 'span 2' } : undefined}
                onDragOver={(e) => {
                  if (!dragPanel || dragPanel === id) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pos = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                  if (dropTarget?.id !== id || dropTarget?.pos !== pos) setDropTarget({ id, pos })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragPanel && dropTarget) applyDrop(dragPanel, dropTarget.id, dropTarget.pos)
                  setDragPanel(null)
                  setDropTarget(null)
                }}
                onDragLeave={(e) => {
                  if (e.target === e.currentTarget && dropTarget?.id === id) setDropTarget(null)
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
                  style={{
                    gridTemplateColumns: isOverview
                      ? 'repeat(3, minmax(0, 1fr))'
                      : `repeat(${row.length}, minmax(0, 1fr))`,
                  }}
                >
                  {row.map((id, ci) => cellOf(id, isOverview, isOverview && ri === wideRowIdx && ci === wideCellIdx))}
                </div>
              ))}
              {hidden.length > 0 && <div style={{ display: 'none' }}>{hidden.map((id) => cellOf(id, false))}</div>}
            </div>
          )
        })()}

        {/* 右下角:Miku 快捷入口(Live2D),全页面常驻;可拖动,点击弹出就地聊天窗,
            右键打开桌宠菜单;「隐藏她」后经 ⌘K 命令面板唤回 */}
        {!mikuHidden && (
          <button
            ref={fabRef}
            className={`ai-fab ${fabDragging ? 'dragging' : ''} ${mikuReady && !mikuFailed ? 'miku-fab' : ''} ${
              mikuQQ ? 'miku-qq' : ''
            }`}
            style={{ ...(fabPos ?? {}), '--miku-scale': mikuScale } as CSSProperties}
            title="Miku · 右键更多 · 拖动可换位置"
            onPointerDown={onFabPointerDown}
            onPointerMove={onFabPointerMove}
            onPointerUp={endFabDrag}
            onPointerCancel={endFabDrag}
            onContextMenu={(e) => {
              e.preventDefault()
              setMikuMenu({ x: e.clientX, y: e.clientY })
            }}
            onClick={() => {
              if (fabMoved.current) {
                fabMoved.current = false
                return
              }
              // 无论哪个页面点她都有互动反馈;Miku 页本身是完整聊天界面,不再弹就地小窗
              window.dispatchEvent(new CustomEvent(MIKU_TAP_EVENT))
              if (view === 'ai') return
              // 弹窗延迟弹出,双击的第二下会取消(双击 = 切换 QQ 形态)
              if (fabPopTimer.current !== null) {
                window.clearTimeout(fabPopTimer.current)
                fabPopTimer.current = null
                return
              }
              fabPopTimer.current = window.setTimeout(() => {
                fabPopTimer.current = null
                toggleFabChat()
              }, FAB_POP_DELAY)
            }}
            onDoubleClick={() => window.dispatchEvent(new CustomEvent(MIKU_QQ_EVENT))}
          >
            {!mikuFailed && (
              <MikuStage
                onReady={() => setMikuReady(true)}
                onFailed={() => setMikuFailed(true)}
                onQQChange={setMikuQQ}
                eyeFollow={mikuEye}
                idleEnabled={mikuIdle}
              />
            )}
            {/* 加载中先露星星占位,Miku 就绪后由 CSS 类切换按钮尺寸并隐藏图标 */}
            {!mikuReady && <IconAi />}
          </button>
        )}

        {fabChatOpen && (
          <div className="ai-pop" style={fabChatPos ?? undefined}>
            <AiPanel
              data={data}
              update={update}
              onNavigate={setView}
              onClose={() => setFabChatOpen(false)}
              autoFocus
              variant="bubble"
            />
          </div>
        )}

        {/* 到期提醒 + AI 主动巡查弹窗:锚定 AI 悬浮球 */}
        <ReminderPopup data={data} update={update} />

        {/* Miku 右键菜单 */}
        {mikuMenu && !mikuHidden && (
          <MikuMenu x={mikuMenu.x} y={mikuMenu.y} items={mikuMenuItems} onClose={() => setMikuMenu(null)} />
        )}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      {startPageOpen && <StartPageModal onClose={() => setStartPageOpen(false)} />}
    </div>
  )
}
