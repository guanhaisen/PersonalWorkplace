// Miku 养成页:大舞台 + 亲密度/心情/饱食度 + 互动按钮,只展示 Miku 本人(聊天走
// 「Miku」页或悬浮球快捷弹窗)。与悬浮球共用同一个 MikuStage 组件(传大尺寸、page
// 变体);两处舞台不同时渲染——进入本页时 App 会卸载悬浮球,离开本页时本舞台也随之
// 卸载(单存活模型:双模型并存会毒害先建那只的形变管线,代价是每次进入重载 1-2 秒)。
// 数值模型在 ../mikuPet;存档经 App 的 onPet 防抖写 /api/settings。
// 互动增强:投喂飞食动画+咀嚼口型、舞台拖拽摇摆、连击浮标、长按摸头(眯眼+点头)、
// 时段×状态问候与主动撒娇、连续来访签到、升级撒花、等级解锁互动、成就任务券
// (侧栏摘要+浮层,方向B定稿见 miku-badges/direction-approved.md)、接大葱小游戏。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppData } from '../types'
import { todayStr } from '../api'
import {
  achievementView,
  applyPet,
  checkAchievements,
  hasUnlock,
  makeGreetLine,
  makeMurmurLine,
  petLevel,
  petNow,
  petTitle,
  registerVisit,
  UNLOCKS,
  type MikuPet,
  type MikuPetCounters,
} from '../mikuPet'
import LeekGame from './LeekGame'
import AchievementModal, { AchChip } from './AchievementModal'
import { IconTicket } from './icons'
import MikuStage, {
  MIKU_CELEBRATE_EVENT,
  MIKU_COMBO_EVENT,
  MIKU_CHEER_EVENT,
  MIKU_DRAG_END_EVENT,
  MIKU_DRAG_START_EVENT,
  MIKU_MURMUR_EVENT,
  MIKU_NOD_EVENT,
  MIKU_PLAY_EVENT,
  MIKU_QQ_EVENT,
  MIKU_SLIDE_EVENT,
  MIKU_SQUINT_EVENT,
  MIKU_SPEAK_EVENT,
  MIKU_TAP_EVENT,
  type MikuStageApi,
} from './MikuStage'

interface Props {
  /** 闲置碎碎念按当前数据生成台词 */
  data: AppData
  pet: MikuPet
  /** App 提供的统一入口:更新宠物状态并防抖持久化 */
  onPet: (next: MikuPet) => void
  /** 当前保留动作(与右键菜单同源):null = 默认待机;手部三选一组 */
  mikuAction: string | null
  /** QQ 人形态是否开启(与右键菜单同源) */
  mikuQQ: boolean
  /** 本页大舞台切换 QQ 形态后回写全局状态(悬浮球/右键菜单跟随) */
  onQQChange?: (on: boolean) => void
  /** 选择/取消保留动作(App 统一派发,菜单与本栏共享) */
  playMiku: (expression: string | null, talkMs?: number) => void
  /** 可叠加表情(脸红/圈圈/前倾,参数独立可同时生效) */
  emoteOn: Record<string, boolean>
  toggleEmote: (name: string) => void
  /** 恢复默认:清空可叠加组 + 解除手部三选一 */
  clearEmotes: () => void
  /** 本页是否可见(切页即 display:none):透传给大舞台做渲染循环的确定性启停 */
  visible?: boolean
}

// 舞台尺寸按视口在挂载时定一次(中途旋转/缩放窗口见下方 resize 监听)
// 手势指南的「已看过」标记:首次进养成页自动弹出,之后靠标题栏「?」重开
const GUIDE_KEY = 'miku.raise.guide.v1'
function pickStageSize(): { w: number; h: number } {
  const mobile = window.innerWidth < 900
  const ratio = 1.3 // 与悬浮球舞台 170:230 的瘦高比例接近
  const hMax = mobile
    ? Math.max(290, Math.min(372, window.innerHeight * 0.44))
    : Math.max(360, Math.min(600, window.innerHeight - 320))
  let w = Math.round(hMax / ratio)
  // 桌面右侧留出互动侧栏(176px + 间距/内边距)
  const wMax = mobile ? window.innerWidth - 40 : Math.max(300, Math.min(500, window.innerWidth - 400))
  if (w > wMax) w = Math.max(220, wMax)
  return { w, h: Math.round(w * ratio) }
}

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

const moodLabel = (v: number) =>
  v >= 70 ? '元气满满' : v >= 40 ? '心情不错' : v >= 15 ? '有点无聊' : '无精打采'
const fullnessLabel = (v: number) =>
  v >= 70 ? '吃得很饱' : v >= 40 ? '还不错' : v >= 15 ? '有点饿' : '饿扁了'

const HUNGER_LINES = ['肚子咕咕叫了…喂我点东西嘛', '好饿…这个点,该有大葱了吧?', '闻到葱香了…是错觉吗?']
const BORED_LINES = ['无聊…陪我玩一会儿嘛', '摸摸头也行,人家想你了', '发呆好累,来点乐子吧~']
const GAME_LINES = (score: number) =>
  score >= 20
    ? '太强了!葱都接不过你!'
    : score >= 10
      ? '好厉害!再来一局嘛~'
      : score >= 5
        ? '呼…接得好累,不过很开心!'
        : '呜,葱掉了一地…再来一次?'
const SONGS = ['《甩葱歌》', '《World is Mine》', '《千本樱》', '《Melt》', '《Tell Your World》']

// 台词气泡的优先级:升级/成就等「必达消息」不再被后续台词截断(旧行为是 say
// 直接互相覆盖,延迟播报 setTimeout 也常撞车丢消息)
type BubblePrio = 1 | 2 | 3

interface FlyingFood {
  id: number
  emoji: string
  left: number
  top: number
  dx: number
  dy: number
}

export default function MikuRaisePanel({ data, pet, onPet, mikuAction, mikuQQ, onQQChange, playMiku, emoteOn, toggleEmote, clearEmotes, visible = true }: Props) {
  // 画布尺寸:高度按视口推算,宽度在挂载后量整个舞台容器(此前画布只有 ~462px
  // 的盒子宽,和 Miku 展开的头发差不多宽,左右拖动几步就会被画布边缘腰斩)。
  // 首帧先渲染召唤提示,量完宽再挂载舞台,不会出现「先按盒子宽建画布再重载」
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const stageSizeRef = useRef<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const base = pickStageSize()
    const wrapW = stageWrapRef.current?.clientWidth ?? base.w
    const next = { w: Math.min(Math.max(wrapW, 320), 1200), h: base.h }
    stageSizeRef.current = next
    setSize(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  // 台词气泡条目:ach = 句首要带的成就章
  interface BubbleItem {
    id: number
    text: string
    ach?: { key: keyof MikuPetCounters; tier: number }
    prio: BubblePrio
  }
  // 数值变化飘字(舞台中下部冒出后上浮消散)
  interface FloatText {
    id: number
    text: string
    neg: boolean
    x: number
  }
  const [bubble, setBubble] = useState<BubbleItem | null>(null)
  const bubbleTimer = useRef<number | null>(null)
  const bubbleRef = useRef<BubbleItem | null>(null)
  const bubbleQueueRef = useRef<BubbleItem[]>([])
  const [floats, setFloats] = useState<FloatText[]>([])
  // 连点连击浮标(x2…x5)/ 飞行中的食物 / 升级撒花 / 小游戏开关 / 成就浮层
  const [combo, setCombo] = useState<{ id: number; count: number; done: boolean } | null>(null)
  const [foods, setFoods] = useState<FlyingFood[]>([])
  const [confettiAt, setConfettiAt] = useState(0)
  const [gameOpen, setGameOpen] = useState(false)
  const [achOpen, setAchOpen] = useState(false)
  // 手势指南浮层:首次进入自动弹出(localStorage 记忆),「?」按钮可随时重开
  const [guideOpen, setGuideOpen] = useState(() => !localStorage.getItem(GUIDE_KEY))
  // 移动端侧栏的分组 Tab(桌面两栏并排展示,Tab 条由 CSS 隐藏)
  const [mobileTab, setMobileTab] = useState<'actions' | 'emotes'>('actions')
  // 模型网格失能自愈(同页双模型毒害先建那只,见 MikuStage.onModelDead 注释)
  const [stageEpoch, setStageEpoch] = useState(0)

  // 离开本页时大舞台随之卸载(单存活模型策略),重进需重载模型:复位 ready,
  // 让「正在召唤 Miku…」提示重新出现
  useEffect(() => {
    if (!visible) setReady(false)
  }, [visible])
  const comboTimer = useRef<number | null>(null)
  const confettiTimer = useRef<number | null>(null)
  const lastMurmur = useRef('')
  const petRef = useRef(pet)
  petRef.current = pet
  const dataRef = useRef(data)
  dataRef.current = data
  // 面板根节点:隐藏(display:none 子树)时所有气泡/撒娇/碎碎念静默
  const bodyRef = useRef<HTMLDivElement>(null)
  const panelVisible = () => !!bodyRef.current && bodyRef.current.offsetParent !== null
  // 舞台几何(飞食落点/长按/拖拽)
  const stageWrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  // MikuStage 的嘴部锚点接口:喂食落点按当前形态(QQ/普通)实时定位
  const stageApiRef = useRef<MikuStageApi | null>(null)
  // 摸摸收益冷却 / 互动按钮冷却 / 长按与拖拽手势
  const tapGainAt = useRef(0)
  const cdRef = useRef<Record<string, number>>({})
  const holdTimerRef = useRef<number | null>(null)
  const holdFiredRef = useRef(false)
  const stageDragRef = useRef<{ x0: number; y0: number; lastX: number; dragging: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  // 小游戏冷却(会话内 3 分钟)
  const gameCdRef = useRef(0)

  // 立即显示一条气泡并计时,播完自动从队列取下一条(留 260ms 间隙,避免无缝顶替
  // 看起来像闪烁)。useCallback([]) 内部自引用稳定:递归调用到的始终是首个渲染的
  // 同一函数实例,而它只读写 ref 与 setState,行为与最新渲染无关
  const showBubbleNow = useCallback((item: BubbleItem) => {
    bubbleRef.current = item
    setBubble(item)
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => {
      bubbleRef.current = null
      setBubble(null)
      const next = bubbleQueueRef.current.shift()
      if (next) window.setTimeout(() => showBubbleNow(next), 260)
    }, 5000)
  }, [])

  // 优先级:3 = 升级/成就/解锁(必达:当前有气泡时入队,容量 2 且挤掉 1 级)
  //        2 = 动作台词/系统提示(顶替当前的 1/2 级气泡,保留旧 say 的直感)
  //        1 = 撒娇/碎碎念/庆祝播报(忙时直接丢弃,防刷屏)
  const say = useCallback((text: string, opts?: { prio?: BubblePrio; ach?: BubbleItem['ach'] }) => {
    const item: BubbleItem = {
      id: Date.now() + Math.random(),
      text,
      ach: opts?.ach,
      prio: opts?.prio ?? 2,
    }
    const cur = bubbleRef.current
    if (!cur) {
      showBubbleNow(item)
      return
    }
    if (item.prio === 3) {
      bubbleQueueRef.current = [...bubbleQueueRef.current.filter((x) => x.prio > 1), item].slice(-2)
      return
    }
    if (item.prio === 2 && cur.prio <= 2 && bubbleQueueRef.current.every((x) => x.prio < 3)) {
      showBubbleNow(item)
      return
    }
    // 1 级消息或会打断必达播报的情况:静默丢弃
  }, [])

  // 数值变化飘字:聚合一条冒在舞台中下部,负增量红色。喂食链路里 settle 在食物
  // 到嘴时才调用,飘字与咀嚼口型同帧出现,「按钮 → 食物 → 数值」因果感闭环
  const pushFloat = (delta: { mood?: number; fullness?: number; bond?: number }) => {
    const fmt = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`
    const parts: string[] = []
    if (delta.mood) parts.push(`心情 ${fmt(delta.mood)}`)
    if (delta.fullness) parts.push(`饱食 ${fmt(delta.fullness)}`)
    if (delta.bond) parts.push(`亲密 ${fmt(delta.bond)}`)
    if (parts.length === 0) return
    const id = Date.now() + Math.random()
    const total = (delta.mood ?? 0) + (delta.fullness ?? 0) + (delta.bond ?? 0)
    const item: FloatText = { id, text: parts.join(' · '), neg: total < 0, x: 26 + Math.random() * 48 }
    setFloats((f) => [...f.slice(-3), item])
    window.setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1150)
  }

  // 心跳:按钮冷却倒计时展示(数值衰减在渲染时按 ts 回推,不需要心跳)
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1000)
    return () => window.clearInterval(t)
  }, [])

  const fireConfetti = () => {
    setConfettiAt(Date.now())
    if (confettiTimer.current !== null) window.clearTimeout(confettiTimer.current)
    confettiTimer.current = window.setTimeout(() => setConfettiAt(0), 2600)
  }

  // 数值结算:叠加增量(可选累计一个互动计数)→ 飘字 → 升级检测(撒花+播报+解锁提示)
  const settle = (
    delta: { mood?: number; fullness?: number; bond?: number },
    counter?: keyof MikuPetCounters,
  ): { up: number; next: MikuPet } => {
    const before = petLevel(petRef.current.bond).level
    let next = applyPet(petRef.current, delta)
    if (counter) {
      next = {
        ...next,
        counters: { pat: 0, feed: 0, play: 0, sing: 0, game: 0, ...next.counters, [counter]: (next.counters?.[counter] ?? 0) + 1 },
      }
    }
    onPet(next)
    pushFloat(delta)
    const after = petLevel(next.bond).level
    if (after > before) {
      fireConfetti()
      window.dispatchEvent(new CustomEvent(MIKU_CHEER_EVENT))
      say(`亲密度升级啦!现在我们是「${petTitle(after)}」了`, { prio: 3 })
      const unlock = UNLOCKS.find((u) => u.lv === after)
      // 解锁提示直接进队列:升级台词播完自动接上,不再靠延迟 setTimeout 猜时机
      if (unlock) say(`解锁新互动「${unlock.label}」!快试试吧~`, { prio: 3 })
      return { up: after, next }
    }
    // 未升级 up 为 0,调用方据此决定是否播报动作台词
    return { up: 0, next }
  }

  // 成就检查:基于「本次结算后的存档」判断(同步链路里 petRef 要等重渲染才更新,
  // 读 ref 会拿到旧值),新达成 → 亲密度 +5 + 播报(必达消息进队列,排在升级台词
  // 之后,不再丢失)。奖励 +5 也可能跨级:升级链路(撒花/称号播报/解锁提示)
  // 与 settle 共用一套,不能静默
  const checkAch = (base: MikuPet) => {
    const fresh = checkAchievements(base)
    if (fresh.length === 0) return
    const levelBefore = petLevel(base.bond).level
    let next = applyPet(base, { bond: 5 })
    pushFloat({ bond: 5 })
    next = { ...next, achievements: { ...next.achievements } }
    for (const a of fresh) next.achievements![a.key] = a.tier
    onPet(next)
    const levelAfter = petLevel(next.bond).level
    const first = fresh[0]
    const achLine = `成就达成「${first.name}」,亲密度 +5!`
    if (levelAfter > levelBefore) {
      fireConfetti()
      window.dispatchEvent(new CustomEvent(MIKU_CHEER_EVENT))
      say(`${achLine}亲密度升级啦,现在是「${petTitle(levelAfter)}」了`, {
        prio: 3,
        ach: { key: first.key, tier: first.tier },
      })
      const unlock = UNLOCKS.find((u) => u.lv === levelAfter)
      if (unlock) say(`解锁新互动「${unlock.label}」!快试试吧~`, { prio: 3 })
      return
    }
    say(achLine, { prio: 3, ach: { key: first.key, tier: first.tier } })
  }

  // 进页:签到(连续来访加成)+ 每日见面礼 + 时段×状态问候;跨级时撒花播报
  useEffect(() => {
    const today = todayStr()
    const levelBefore = petLevel(petRef.current.bond).level
    const visit = registerVisit(petRef.current, today)
    let next = visit.pet
    const bonusToday = next.lastBonus === today
    if (!bonusToday) next = { ...applyPet(next, { mood: 10, bond: 5 }), lastBonus: today }
    if (next !== petRef.current) onPet(next)
    const levelAfter = petLevel(next.bond).level
    const parts: string[] = []
    if (levelAfter > levelBefore) {
      fireConfetti()
      window.dispatchEvent(new CustomEvent(MIKU_CHEER_EVENT))
      parts.push(`亲密度升级啦!现在我们是「${petTitle(levelAfter)}」了`)
    }
    parts.push(makeGreetLine(next))
    if (visit.bonus > 0) {
      parts.push(`连续来访 ${visit.streak} 天,亲密度 +${visit.bonus}!`)
      pushFloat({ bond: visit.bonus })
    }
    if (!bonusToday) {
      parts.push('每日见面礼:心情 +10~')
      pushFloat({ mood: 10, bond: 5 })
    }
    say(parts.join(' '))
    // onPet 引用稳定;只按挂载执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 闲置碎碎念:舞台彩蛋请求 → 按数据与状态生成台词(状态差时她会撒娇)
  useEffect(() => {
    const onMurmur = () => {
      if (document.hidden || !panelVisible()) return
      let text = makeMurmurLine(dataRef.current, petNow(petRef.current))
      for (let i = 0; i < 3 && text === lastMurmur.current; i++) {
        text = makeMurmurLine(dataRef.current, petNow(petRef.current))
      }
      if (text === lastMurmur.current) return
      lastMurmur.current = text
      say(text, { prio: 1 })
    }
    window.addEventListener(MIKU_MURMUR_EVENT, onMurmur)
    return () => window.removeEventListener(MIKU_MURMUR_EVENT, onMurmur)
  }, [say])

  // 完成待办/打卡的庆祝 → 播报具体事项(无 label 时用通用庆祝语);隐藏时静默
  useEffect(() => {
    const onCelebrate = (e: Event) => {
      if (!panelVisible()) return
      const label = (e as CustomEvent).detail?.label as string | undefined
      say(label ? `${label}完成!好厉害!` : pick(['又完成一件事,为你鼓掌!', '干得漂亮,给你比个心~']), { prio: 1 })
    }
    window.addEventListener(MIKU_CELEBRATE_EVENT, onCelebrate)
    return () => window.removeEventListener(MIKU_CELEBRATE_EVENT, onCelebrate)
  }, [say])

  // 连击浮标:x2…x4 弹跳浮现,第 5 下比心样式
  useEffect(() => {
    const onCombo = (e: Event) => {
      if (!panelVisible()) return
      const d = (e as CustomEvent).detail as { count: number; done: boolean } | undefined
      if (!d) return
      setCombo({ id: Date.now() + Math.random(), count: d.count, done: !!d.done })
      if (comboTimer.current !== null) window.clearTimeout(comboTimer.current)
      comboTimer.current = window.setTimeout(() => setCombo(null), 900)
    }
    window.addEventListener(MIKU_COMBO_EVENT, onCombo)
    return () => window.removeEventListener(MIKU_COMBO_EVENT, onCombo)
  }, [])

  // 主动撒娇:状态差时偶尔开口(饿了求投喂 / 无聊求陪玩)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden || !panelVisible() || bubbleRef.current) return
      const cur = petNow(petRef.current)
      if (cur.fullness < 25) {
        say(pick(HUNGER_LINES), { prio: 1 })
        window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '葱' } }))
      } else if (cur.mood < 25) {
        say(pick(BORED_LINES), { prio: 1 })
        window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '圈圈' } }))
      }
    }, 45_000)
    return () => window.clearInterval(t)
  }, [say])

  // 「回来啦」:离开养成页超过 30 分钟再回来时打个招呼。纯陪伴台词不给奖励
  // (签到/见面礼仍只在挂载时结算一次),优先级 1:忙时不出,不抢正式播报
  const raiseHiddenAtRef = useRef(0)
  useEffect(() => {
    if (visible) {
      const away = raiseHiddenAtRef.current ? Date.now() - raiseHiddenAtRef.current : 0
      raiseHiddenAtRef.current = 0
      if (away > 30 * 60_000) {
        say(pick(['回来啦~我一直在这里等你哦', '欢迎回来!今天也一起加油吧', '咦,你回来啦!想你了']), { prio: 1 })
      }
    } else {
      raiseHiddenAtRef.current = Date.now()
    }
  }, [visible, say])

  // 旋转屏幕/缩放窗口后重算舞台尺寸:变化显著(>32px)时更新并换 epoch 重挂舞台
  // ——MikuStage 内部几何量全是初始化闭包,热改尺寸极易复现沉底类 bug;重挂的
  // 1-2s 召唤提示在旋转屏幕这种低频操作上可接受。小差异忽略,避免拖拽窗口边缘
  // 时频繁重载
  useEffect(() => {
    let timer: number | null = null
    const onResize = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        if (!panelVisible()) return // 隐藏期间不折腾,回屏后的 resize 会补上
        const base = pickStageSize()
        const wrapW = stageWrapRef.current?.clientWidth ?? base.w
        const next = { w: Math.min(Math.max(wrapW, 320), 1200), h: base.h }
        const prev = stageSizeRef.current
        if (!prev) return
        if (Math.abs(next.w - prev.w) <= 32 && Math.abs(next.h - prev.h) <= 32) return
        stageSizeRef.current = next
        setSize(next)
        setStageEpoch((x) => x + 1)
      }, 250)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer !== null) window.clearTimeout(timer)
    }
    // panelVisible 只读 ref,行为与渲染无关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 舞台手势:点按=分区摸摸,长按=害羞点头,拖拽=身体摇摆 ----------

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    stageDragRef.current = { x0: e.clientX, y0: e.clientY, lastX: e.clientX, dragging: false }
    holdFiredRef.current = false
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null
      holdFiredRef.current = true
      // 长按摸头:眯眼害羞 + 点头回应(新驱动参数,见 MikuStage)
      window.dispatchEvent(new CustomEvent(MIKU_SQUINT_EVENT, { detail: { ms: 2600 } }))
      window.dispatchEvent(new CustomEvent(MIKU_NOD_EVENT))
      const { up, next } = settle({ mood: 2, bond: 1 }, 'pat')
      if (!up) say(pick(['嘿嘿…人家会害羞的啦', '点头点头,最喜欢你啦', '再摸下去要晕了…']))
      checkAch(next)
    }, 600)
  }

  const onStagePointerMove = (e: React.PointerEvent) => {
    const d = stageDragRef.current
    if (!d) return
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return
      d.dragging = true
      d.lastX = e.clientX
      // 拖拽激活:作废未触发的长按;摆动由 MikuStage 的 DRAG_START 处理
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      window.dispatchEvent(new CustomEvent(MIKU_DRAG_START_EVENT))
      return
    }
    // 拖动中:水平增量派发给 MikuStage 平移支点(左右拖动她换个位置站)
    const dx = e.clientX - d.lastX
    d.lastX = e.clientX
    if (dx !== 0) window.dispatchEvent(new CustomEvent(MIKU_SLIDE_EVENT, { detail: { dx } }))
  }

  const onStagePointerEnd = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    const d = stageDragRef.current
    stageDragRef.current = null
    if (d?.dragging) {
      suppressClickRef.current = true
      window.dispatchEvent(new CustomEvent(MIKU_DRAG_END_EVENT))
    }
  }

  // 点舞台 = 摸摸(纵坐标分区反应,与悬浮球一致);亲密度收益 1.5s 冷却防狂点
  const onStageTap = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (holdFiredRef.current) {
      holdFiredRef.current = false
      return
    }
    window.dispatchEvent(new CustomEvent(MIKU_TAP_EVENT, { detail: { clientY: e.clientY } }))
    const now = Date.now()
    if (now - tapGainAt.current < 1500) return
    tapGainAt.current = now
    const { next } = settle({ bond: 1, mood: 0.5 }, 'pat')
    checkAch(next)
  }

  // ---------- 投喂:食物飞进嘴里再结算(咀嚼口型 + 表情 + 数值) ----------

  const flyFood = (emoji: string, btnRect: DOMRect | undefined, onArrive: () => void) => {
    const wrap = stageWrapRef.current
    const cr = stageRef.current?.querySelector('.miku-stage.page canvas')?.getBoundingClientRect()
    const wr = wrap?.getBoundingClientRect()
    if (!wrap || !wr) {
      onArrive()
      return
    }
    // 缺按钮矩形(理论兜底)时从左下角起飞
    const fromX = btnRect ? btnRect.left + btnRect.width / 2 - wr.left : wr.width * 0.18
    const fromY = btnRect ? btnRect.top - wr.top : wr.height * 0.85
    // 嘴部落点:MikuStage 实时回读当前形态(QQ/普通)的轮廓定位嘴部;
    // 拿不到锚点(Live2D 未就绪等)再退回普通站姿的固定比例
    const anchor = stageApiRef.current?.getMouthAnchor?.() ?? null
    const mx = anchor && cr ? cr.left - wr.left + anchor.x : wr.width / 2
    const my = anchor && cr ? cr.top - wr.top + anchor.y : wr.height * 0.3
    const id = Date.now() + Math.random()
    setFoods((f) => [...f, { id, emoji, left: fromX, top: fromY, dx: mx - fromX, dy: my - fromY }])
    window.setTimeout(() => {
      setFoods((f) => f.filter((x) => x.id !== id))
      onArrive()
    }, 620)
  }

  const feedConf = {
    leek: {
      emoji: '🥬',
      expression: '葱',
      delta: { mood: 4, fullness: 18, bond: 2 },
      lines: ['是葱!!我最喜欢葱了!!', '葱葱葱——(眼睛亮了)', '咔嚓咔嚓…好好吃!'],
    },
    snack: {
      emoji: '🍞',
      expression: '圈圈',
      delta: { mood: 6, fullness: 12, bond: 2 },
      lines: ['唔姆,甜甜的真好吃~', '嚼嚼…谢谢款待!', '偷偷藏一块到明天…才不行,现在吃掉!'],
    },
    pudding: {
      emoji: '🍮',
      expression: '比心',
      delta: { mood: 8, fullness: 10, bond: 3 },
      lines: ['布丁!!你的 favorite!', '晃晃悠悠的,舍不得吃掉啦', '咕噜咕噜~幸福指数爆棚!'],
    },
  } as const

  const feed = (kind: keyof typeof feedConf) => (e?: React.MouseEvent<HTMLButtonElement>) => {
    const key = `feed-${kind}`
    const now = Date.now()
    if (now < (cdRef.current[key] ?? 0)) return
    const conf = feedConf[kind]
    const full = petNow(petRef.current).fullness
    if (full >= 98) {
      cdRef.current[key] = now + 2000
      say('吃饱啦,一口都吃不下了~')
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '圈圈' } }))
      return
    }
    cdRef.current[key] = now + (kind === 'pudding' ? 15_000 : 10_000)
    flyFood(conf.emoji, e?.currentTarget.getBoundingClientRect(), () => {
      // 到嘴了:咀嚼口型(带小弹跳)→ 表情 → 数值
      window.dispatchEvent(new CustomEvent(MIKU_SPEAK_EVENT, { detail: { ms: 1200 } }))
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: conf.expression } }))
      const { up, next } = settle(conf.delta, 'feed')
      if (!up) say(pick([...conf.lines]))
      checkAch(next)
    })
  }

  // ---------- 其他互动 ----------

  const act = (key: string, cdMs: number, run: () => void) => {
    const now = Date.now()
    if (now < (cdRef.current[key] ?? 0)) return
    cdRef.current[key] = now + cdMs
    run()
  }

  const doPat = () =>
    act('pat', 4000, () => {
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '脸红' } }))
      const { up, next } = settle({ mood: 3, bond: 1 }, 'pat')
      if (!up) say(pick(['嘿嘿…好舒服~', '再、再摸头发会乱的啦', '哼,就知道你会这样', '今天的摸摸也收到啦']))
      checkAch(next)
    })

  const doPlay = () =>
    act('play', 20_000, () => {
      const full = petNow(petRef.current).fullness
      if (full < 15) {
        say('肚子空空的,玩不动了…先喂点东西吧')
        return
      }
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { dance: true } }))
      const { up, next } = settle({ mood: 10, fullness: -6, bond: 3 }, 'play')
      if (!up) say(pick(['耶!一起玩吧~', '再来再来!', '看我的拿葱舞!', '累、累坏了…但是好开心']))
      checkAch(next)
    })

  const doSing = () =>
    act('sing', 30_000, () => {
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '唱歌', talkMs: 3200 } }))
      const { up, next } = settle({ mood: 8, bond: 2 }, 'sing')
      if (!up) say(pick(['1、2、3、哒——!', '听完要给我打分哦~', '这首是新练的,好听吗?']))
      checkAch(next)
    })

  const doHighfive = () =>
    act('highfive', 10_000, () => {
      window.dispatchEvent(new CustomEvent(MIKU_CHEER_EVENT))
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '比心' } }))
      const { up, next } = settle({ mood: 2, bond: 2 })
      if (!up) say(pick(['啪!击掌!', '耶~默契满分!', '手好疼…骗你的,超开心!']))
      checkAch(next)
    })

  const doRequest = () =>
    act('request', 30_000, () => {
      const song = pick(SONGS)
      window.dispatchEvent(new CustomEvent(MIKU_PLAY_EVENT, { detail: { expression: '唱歌', talkMs: 3200 } }))
      const { up, next } = settle({ mood: 5, bond: 3 }, 'sing')
      if (!up) say(`好!这首${song},送给你~`)
      checkAch(next)
    })

  const openGame = () => {
    // 冷却由按钮禁用态表达(接大葱 3 分钟);能点进来就是可直接开局
    setGameOpen(true)
  }

  const onGameEnd = (score: number) => {
    setGameOpen(false)
    gameCdRef.current = Date.now() + 3 * 60_000
    const { up, next } = settle({ mood: Math.min(score, 15), fullness: -8, bond: Math.min(score, 12) }, 'game')
    if (!up) say(GAME_LINES(score))
    checkAch(next)
  }

  // ---------- 展示 ----------

  const now = Date.now()
  const lvInfo = petLevel(pet.bond)
  const cur = petNow(pet)
  const cooling = (key: string) => Math.max(0, Math.ceil(((cdRef.current[key] ?? 0) - now) / 1000))
  const gameCooling = Math.max(0, Math.ceil((gameCdRef.current - now) / 1000))

  // 舞台天色时段:夜晚(21-06,与 MikuStage 困困模式同边界)/黄昏(17-21)/白天,
  // 心跳每秒重渲染顺带驱动,跨时段时 CSS transition 渐变过渡
  const hourNow = new Date().getHours()
  const timeBand = hourNow >= 21 || hourNow < 6 ? 'night' : hourNow >= 17 ? 'dusk' : 'day'

  // 冷却/锁定按钮的点击反馈:按钮不再用 disabled(收不到事件,触屏上完全无回应),
  // 改 aria-disabled 保持置灰样式,点了必须有声响——锁定说解锁条件,冷却抖一抖+
  // 节流台词(2s 内连点不刷屏)
  const actHintAt = useRef(0)
  const onActClick = (a: ActionDef, e: React.MouseEvent<HTMLButtonElement>) => {
    if (!!a.unlock && !hasUnlock(lvInfo.level, a.unlock)) {
      say(`亲密度到 Lv.${a.lock} 就能解锁「${a.label}」啦~`)
      return
    }
    const isGame = a.key === 'game'
    const left = isGame ? gameCooling : cooling(a.cdKey)
    if (left > 0) {
      const el = e.currentTarget
      el.classList.remove('shake')
      void el.offsetWidth // 强制 reflow,连续点击也重播抖动
      el.classList.add('shake')
      const t = Date.now()
      if (t - actHintAt.current > 2000) {
        actHintAt.current = t
        say(
          isGame
            ? '葱还在长呢,等它一会儿嘛~'
            : `「${a.label}」还在休息中,${left >= 60 ? `${Math.ceil(left / 60)} 分钟` : `${left} 秒`}后再来~`,
        )
      }
      return
    }
    a.onClick()
  }

  // 成就任务券:按当前互动计数实时推导各成就档位(票色与票根章位随之上走)
  const achRows = achievementView(pet)
  const achStamped = achRows.reduce((n, r) => n + Math.max(0, r.tier + 1), 0)
  const achTotal = achRows.reduce((n, r) => n + r.thresholds.length, 0)

  type ActionDef = {
    key: string
    label: string
    lock: number
    unlock?: Parameters<typeof hasUnlock>[1]
    cdKey: string
    onClick: () => void
  }
  const actions: ActionDef[] = [
    { key: 'pat', label: '摸摸头', lock: 0, cdKey: 'pat', onClick: doPat },
    { key: 'leek', label: '喂大葱', lock: 0, cdKey: 'feed-leek', onClick: feed('leek') },
    { key: 'snack', label: '喂点心', lock: 0, cdKey: 'feed-snack', onClick: feed('snack') },
    { key: 'pudding', label: '喂布丁', lock: 2, unlock: 'pudding', cdKey: 'feed-pudding', onClick: feed('pudding') },
    { key: 'highfive', label: '击掌', lock: 3, unlock: 'highfive', cdKey: 'highfive', onClick: doHighfive },
    { key: 'request', label: '点歌', lock: 4, unlock: 'request', cdKey: 'request', onClick: doRequest },
    { key: 'play', label: '一起玩', lock: 0, cdKey: 'play', onClick: doPlay },
    { key: 'sing', label: '唱首歌', lock: 0, cdKey: 'sing', onClick: doSing },
    { key: 'game', label: '接大葱', lock: 0, cdKey: 'game-open', onClick: openGame },
  ]

  return (
    <div className="raise-body" ref={bodyRef}>
      <section className="raise-left">
        <div className="raise-main">
        <header className="raise-head">
          <h2 className="raise-title">
            <span className="tag">MIKU</span>
            <i>/</i>养成
          </h2>
          <span className="raise-head-badges">
            <button
              className="raise-guide-btn"
              onClick={() => setGuideOpen(true)}
              title="怎么和 Miku 玩?看看手势指南"
              aria-label="互动手势指南"
            >
              ?
            </button>
            <button className="raise-ach-pill" onClick={() => setAchOpen(true)} title="成就任务券">
              <IconTicket />
              {achStamped}/{achTotal}
            </button>
            {(pet.visitStreak ?? 0) >= 2 && (
              <span className="raise-streak" title={`连续来访 ${pet.visitStreak} 天`}>
                🔥 {pet.visitStreak} 天
              </span>
            )}
            <span className="raise-lv" title={`累计亲密度 ${pet.bond}`}>
              {petTitle(lvInfo.level)} · Lv.{lvInfo.level}
            </span>
          </span>
        </header>

        <div className={`raise-stage-wrap band-${timeBand}${mikuQQ ? ' is-qq' : ''}`} ref={stageWrapRef}>
          {/* 场景装饰层铺满整个舞台容器(而非仅中间的舞台盒):天色/月亮星星云/地台,
              纯 CSS 不碰 Live2D 画布;影子留在舞台盒内与 Miku 脚底对齐 */}
          <div className={`stage-scene scene-${timeBand}`} aria-hidden="true">
            <i className="scene-moon" />
            <i className="scene-star s1" />
            <i className="scene-star s2" />
            <i className="scene-star s3" />
            <i className="scene-star s4" />
            <i className="scene-star s5" />
            <i className="scene-star s6" />
            <i className="scene-cloud c1" />
            <i className="scene-cloud c2" />
            <div className="stage-ground" />
          </div>
          {bubble && (
            <div key={bubble.id} className="raise-bubble" role="status">
              {bubble.ach && <AchChip k={bubble.ach.key} tier={bubble.ach.tier} />}
              {bubble.text}
            </div>
          )}
          {combo && (
            <div key={combo.id} className={`raise-combo${combo.done ? ' done' : ''}`} aria-hidden="true">
              {combo.done ? '💖 比心!' : `×${combo.count}`}
            </div>
          )}
          {floats.map((f) => (
            <span
              key={f.id}
              className={`raise-float${f.neg ? ' neg' : ''}`}
              style={{ left: `${f.x}%` }}
              aria-hidden="true"
            >
              {f.text}
            </span>
          ))}
          {confettiAt > 0 && (
            <div className="raise-confetti" aria-hidden="true">
              {Array.from({ length: 24 }, (_, i) => (
                <i
                  key={i}
                  style={{
                    left: `${4 + Math.random() * 92}%`,
                    background: ['#e78a9b', '#e0b25c', '#0f766e', '#7fb3a8', '#b6a4d8'][i % 5],
                    animationDelay: `${(Math.random() * 0.6).toFixed(2)}s`,
                    animationDuration: `${(1.6 + Math.random() * 0.9).toFixed(2)}s`,
                  }}
                />
              ))}
            </div>
          )}
          <div
            className="raise-stage"
            ref={stageRef}
            style={size ? { width: size.w, height: size.h } : undefined}
            role="button"
            aria-label="摸摸 Miku"
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerEnd}
            onPointerCancel={onStagePointerEnd}
            onPointerLeave={onStagePointerEnd}
            onClick={onStageTap}
            onDoubleClick={() => window.dispatchEvent(new CustomEvent(MIKU_QQ_EVENT))}
            title="摸摸她 · 长按摸头 · 拖动她换位置 · 双击变 QQ 形态"
          >
            {/* 影子由 MikuStage 宿主自带(随模型重挂一起重置),此处不再放 */}
            {!ready && !failed && (
              <div className="raise-loading">
                <span className="boot-spinner" aria-hidden="true" />
                正在召唤 Miku…
              </div>
            )}
            {failed && (
              <div className="raise-loading">
                <span>Live2D 加载失败,养成数值仍然有效</span>
                <button
                  className="raise-retry"
                  onClick={() => {
                    setFailed(false)
                    setStageEpoch((x) => x + 1)
                  }}
                >
                  重新召唤
                </button>
              </div>
            )}
            {/* 离开本页即卸载:同页并存两只 Live2D 模型会毒害先创建那只的形变管线
                (WASM 层,详见 MikuStage.onModelDead 注释),只保留最新创建的一只;
                重进本页重载模型约 1-2 秒,期间显示召唤提示 */}
            {size && visible && (
              <MikuStage
                key={stageEpoch}
                ref={stageApiRef}
                variant="page"
                width={size.w}
                height={size.h}
                onReady={() => setReady(true)}
                onFailed={() => setFailed(true)}
                qqOn={mikuQQ}
                onQQChange={onQQChange}
                onModelDead={() => setStageEpoch((x) => x + 1)}
              />
            )}
          </div>
          {foods.map((f) => (
            <span
              key={f.id}
              className="raise-food"
              aria-hidden="true"
              style={
                {
                  left: f.left,
                  top: f.top,
                  '--dx': `${f.dx}px`,
                  '--dy': `${f.dy}px`,
                } as React.CSSProperties
              }
            >
              {f.emoji}
            </span>
          ))}
          {guideOpen && (
            <div className="raise-guide" role="dialog" aria-label="互动手势指南">
              <div className="raise-guide-title">和 Miku 玩的正确姿势</div>
              <ul>
                <li>
                  <b>点一点</b>摸摸她,头顶 · 脸 · 身体反应不同
                </li>
                <li>
                  <b>长按</b>害羞地摸摸头
                </li>
                <li>
                  <b>拖一拖</b>带她换个位置站
                </li>
                <li>
                  <b>双击</b>变身 QQ 形态
                </li>
                <li>
                  <b>连点 5 下</b>比心彩蛋
                </li>
              </ul>
              <button
                className="raise-guide-ok"
                onClick={() => {
                  setGuideOpen(false)
                  localStorage.setItem(GUIDE_KEY, '1')
                }}
              >
                知道啦
              </button>
            </div>
          )}
          {gameOpen && <LeekGame onEnd={onGameEnd} />}
        </div>

        <div className="raise-stats">
          <div className="raise-bars">
            <div className="raise-bar-row">
              <span className="raise-bar-label">心情</span>
              <span className="raise-bar">
                <i className={`mood${cur.mood < 15 ? ' low' : ''}`} style={{ width: `${cur.mood}%` }} />
              </span>
              <span className="raise-bar-val">
                {Math.round(cur.mood)} · {moodLabel(cur.mood)}
              </span>
            </div>
            <div className="raise-bar-row">
              <span className="raise-bar-label">饱食</span>
              <span className="raise-bar">
                <i className={`full${cur.fullness < 15 ? ' low' : ''}`} style={{ width: `${cur.fullness}%` }} />
              </span>
              <span className="raise-bar-val">
                {Math.round(cur.fullness)} · {fullnessLabel(cur.fullness)}
              </span>
            </div>
            <div className="raise-bar-row">
              <span className="raise-bar-label">亲密</span>
              <span className="raise-bar">
                <i className="bond" style={{ width: `${Math.min(100, (lvInfo.cur / lvInfo.need) * 100)}%` }} />
              </span>
              <span className="raise-bar-val">
                Lv.{lvInfo.level} {lvInfo.cur}/{lvInfo.need}
              </span>
            </div>
          </div>
        </div>
        </div>

        <aside className={`raise-side ${mobileTab === 'emotes' ? 'tab-emotes' : 'tab-actions'}`}>
          <div className="raise-tabs" role="tablist">
            <button
              className={`raise-tab${mobileTab === 'actions' ? ' on' : ''}`}
              onClick={() => setMobileTab('actions')}
            >
              互动
            </button>
            <button
              className={`raise-tab${mobileTab === 'emotes' ? ' on' : ''}`}
              onClick={() => setMobileTab('emotes')}
            >
              动作
            </button>
          </div>
          <div className="raise-group raise-group-actions">
          <div className="raise-side-title">互动</div>
          <div className="raise-actions">
            {actions.map((a) => {
              const locked = !!a.unlock && !hasUnlock(lvInfo.level, a.unlock)
              const left = cooling(a.cdKey)
              const isGame = a.key === 'game'
              const disabled = left > 0 || locked || (isGame && gameCooling > 0)
              const label = locked ? `${a.label} Lv.${a.lock}` : a.label
              const suffix = isGame && gameCooling > 0 ? ` ${Math.ceil(gameCooling / 60)}分` : left > 0 ? ` ${left}s` : ''
              return (
                <button
                  key={a.key}
                  className={`raise-act${locked ? ' locked' : ''}`}
                  aria-disabled={disabled || undefined}
                  onClick={(e) => onActClick(a, e)}
                  title={
                    locked
                      ? `亲密度达到 Lv.${a.lock} 解锁`
                      : left > 0
                        ? `冷却中 ${left}s`
                        : isGame && gameCooling > 0
                          ? '葱还在长,稍后再来'
                          : undefined
                  }
                >
                  {label}
                  {suffix}
                </button>
              )
            })}
          </div>
          </div>
          <div className="raise-group raise-group-emotes">
          <div className="raise-side-title">动作</div>
          <div className="raise-emotes">
            <button
              className={`raise-emote${mikuAction === null && !Object.values(emoteOn).some(Boolean) ? ' on' : ''}`}
              onClick={clearEmotes}
              title="清空可叠加表情并解除保留动作"
            >
              默认
            </button>
            {/* 脸红/圈圈/前倾参数互不冲突,可叠加;比心/唱歌/拿葱舞共用手部骨架,三选一 */}
            {(['脸红', '圈圈', '前倾'] as const).map((name) => (
              <button
                key={name}
                className={`raise-emote${emoteOn[name] ? ' on' : ''}`}
                onClick={() => toggleEmote(name)}
                title="可与其他动作同时生效"
              >
                {name}
              </button>
            ))}
            {(
              [
                ['比心', undefined],
                ['唱歌', 3200],
                ['拿葱舞', undefined],
              ] as const
            ).map(([name, talkMs]) => (
              <button
                key={name}
                className={`raise-emote${mikuAction === name ? ' on' : ''}`}
                onClick={() => playMiku(name, talkMs)}
              >
                {name}
              </button>
            ))}
            <button
              className={`raise-emote${mikuQQ ? ' on' : ''}`}
              onClick={() => window.dispatchEvent(new CustomEvent(MIKU_QQ_EVENT))}
              title="双击舞台也可以切换"
            >
              QQ人
            </button>
          </div>
          </div>
          <button className="raise-ach-strip" onClick={() => setAchOpen(true)} title="成就任务券:点开查看全部">
            {achRows.map((r) => (
              <AchChip key={r.key} k={r.key} tier={r.tier} />
            ))}
            <span className="raise-ach-strip-cnt">
              {achStamped}/{achTotal}
            </span>
            <svg width="7" height="11" viewBox="0 0 7 11" aria-hidden="true">
              <path
                d="M1.2 1.3 5.7 5.5 1.2 9.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </aside>
      </section>
      {achOpen && <AchievementModal pet={pet} onClose={() => setAchOpen(false)} />}
    </div>
  )
}
