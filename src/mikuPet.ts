// Miku 养成数值模型:亲密度/心情/饱食度的纯函数计算。
// 存档只记「ts 时刻的值」,展示值按流逝时间即时回推(心情/饱食度随时间衰减,
// 亲密度只增不减),因此离线也在"变饿变无聊",但不需要任何后台定时器或定时写库。
// 存档挂在 /api/settings 的 mikuPet 键下(按账号存服务端,浅合并覆盖整个对象)。
import type { AppData } from './types'
import { nowLocalStr, streak, todayStr } from './api'

export interface MikuPetCounters {
  pat: number
  feed: number
  play: number
  sing: number
  game: number
}

export interface MikuPet {
  /** 累计亲密度(经验值,只增不减),等级由此推导 */
  bond: number
  /** 心情 0-100(存档值,对应 ts 时刻) */
  mood: number
  /** 饱食度 0-100(存档值,对应 ts 时刻) */
  fullness: number
  /** 存档值对应的时刻(ms),衰减据此回推 */
  ts: number
  /** 最后一次领「每日见面礼」的日期(YYYY-MM-DD) */
  lastBonus?: string
  /** 最后一次来访的日期(签到用) */
  lastVisitDate?: string
  /** 连续来访天数 */
  visitStreak?: number
  /** 累计互动次数(成就用) */
  counters?: MikuPetCounters
  /** 已达成的成就:key → 达成时的阈值档位(索引) */
  achievements?: Record<string, number>
}

/** 心情/饱食度每小时衰减量;饿肚子时心情额外加速下滑 */
export const PET_MOOD_DECAY = 2.5
export const PET_FULLNESS_DECAY = 3.5
export const PET_HUNGRY_EXTRA_DECAY = 1.5

const clamp01 = (v: number) => Math.min(100, Math.max(0, v))

/** 新档 */
export function freshPet(): MikuPet {
  return { bond: 0, mood: 70, fullness: 60, ts: Date.now() }
}

/** 服务端读回的存档做形状与区间校验,坏档回退默认值 */
export function sanitizePet(raw: unknown): MikuPet {
  const r = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number, hi = 100) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(0, v)) : fallback
  const countersRaw = (r.counters ?? {}) as Record<string, unknown>
  const counters: MikuPetCounters = {
    pat: num(countersRaw.pat, 0, 1_000_000),
    feed: num(countersRaw.feed, 0, 1_000_000),
    play: num(countersRaw.play, 0, 1_000_000),
    sing: num(countersRaw.sing, 0, 1_000_000),
    game: num(countersRaw.game, 0, 1_000_000),
  }
  const achievements: Record<string, number> = {}
  if (r.achievements && typeof r.achievements === 'object') {
    for (const [k, v] of Object.entries(r.achievements as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) achievements[k] = v
    }
  }
  return {
    bond: num(r.bond, 0, 10_000_000),
    mood: num(r.mood, 70),
    fullness: num(r.fullness, 60),
    ts:
      typeof r.ts === 'number' && Number.isFinite(r.ts) && r.ts > 0
        ? r.ts
        : Date.now(),
    lastBonus: typeof r.lastBonus === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastBonus) ? r.lastBonus : undefined,
    lastVisitDate:
      typeof r.lastVisitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastVisitDate) ? r.lastVisitDate : undefined,
    visitStreak: num(r.visitStreak, 0, 10_000),
    counters,
    achievements,
  }
}

/** 当前展示值:把 ts 以来的衰减应用掉(纯计算,不写档) */
export function petNow(p: MikuPet): { mood: number; fullness: number } {
  const hours = Math.max(0, (Date.now() - p.ts) / 3_600_000)
  const fullness = clamp01(p.fullness - hours * PET_FULLNESS_DECAY)
  const moodRate = PET_MOOD_DECAY + (fullness < 20 ? PET_HUNGRY_EXTRA_DECAY : 0)
  return { mood: clamp01(p.mood - hours * moodRate), fullness }
}

/** 一次互动:取当前展示值叠加增量后固化为新档(ts = 现在)。其余字段原样保留 */
export function applyPet(p: MikuPet, delta: { mood?: number; fullness?: number; bond?: number }): MikuPet {
  const cur = petNow(p)
  return {
    ...p,
    bond: Math.max(0, p.bond + (delta.bond ?? 0)),
    mood: clamp01(cur.mood + (delta.mood ?? 0)),
    fullness: clamp01(cur.fullness + (delta.fullness ?? 0)),
    ts: Date.now(),
  }
}

// ---------- 等级:亲密度经验 → 等级,升级所需经验每级 ×1.3 ----------

export const PET_TITLES = ['初识', '相识', '朋友', '好友', '挚友', '密友', '家人']

export function petLevel(bond: number): { level: number; cur: number; need: number } {
  let level = 1
  let rest = Math.max(0, bond)
  let need = 60
  while (rest >= need) {
    rest -= need
    level++
    need = Math.round(need * 1.3)
  }
  return { level, cur: rest, need }
}

/** 等级称号;超出称号表后停在最后一个并带 Lv 标号 */
export function petTitle(level: number): string {
  const max = PET_TITLES.length
  return level <= max ? PET_TITLES[level - 1] : `${PET_TITLES[max - 1]} Lv.${level}`
}

// ---------- 签到:连续来访加成 ----------

const dayDiff = (a: string, b: string): number => {
  const da = new Date(`${a}T00:00:00`)
  const db = new Date(`${b}T00:00:00`)
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

/** 每日来访签到:昨天来过 → streak+1,今天已签 → 原样,断签 → 重置为 1。
 * 奖励 = min(streak,7) 点亲密度(仅今天首访发放) */
export function registerVisit(p: MikuPet, today = todayStr()): { pet: MikuPet; streak: number; bonus: number } {
  const prev = p.lastVisitDate
  let streak: number
  let bonus = 0
  if (prev === today) {
    return { pet: p, streak: Math.max(1, p.visitStreak ?? 1), bonus: 0 }
  }
  const wasYesterday = prev ? dayDiff(prev, today) === 1 : false
  streak = wasYesterday ? (p.visitStreak ?? 0) + 1 : 1
  bonus = Math.min(streak, 7)
  const next = applyPet(p, { bond: bonus })
  return { pet: { ...next, lastVisitDate: today, visitStreak: streak }, streak, bonus }
}

// ---------- 成就:互动计数里程碑 ----------

export const ACHIEVEMENT_META: {
  key: keyof MikuPetCounters
  emoji: string
  name: string
  thresholds: number[]
}[] = [
  { key: 'pat', emoji: '🤚', name: '摸摸大师', thresholds: [10, 50, 100, 300] },
  { key: 'feed', emoji: '🍚', name: '饲养员', thresholds: [10, 50, 100, 300] },
  { key: 'play', emoji: '🎪', name: '玩伴', thresholds: [10, 50, 100, 300] },
  { key: 'sing', emoji: '🎤', name: '头号歌迷', thresholds: [10, 50, 100, 300] },
  { key: 'game', emoji: '🧺', name: '接葱达人', thresholds: [10, 30, 80, 150] },
]

/** 对照阈值检查新达成的成就档位(仅返回尚未记录的),达成即固化进存档 */
export function checkAchievements(p: MikuPet): { key: string; tier: number; name: string; emoji: string; next: number }[] {
  const counters = p.counters ?? { pat: 0, feed: 0, play: 0, sing: 0, game: 0 }
  const done = p.achievements ?? {}
  const out: { key: string; tier: number; name: string; emoji: string; next: number }[] = []
  for (const meta of ACHIEVEMENT_META) {
    const count = counters[meta.key]
    let tier = -1
    for (let i = 0; i < meta.thresholds.length; i++) {
      if (count >= meta.thresholds[i]) tier = i
    }
    const recorded = done[meta.key]
    if (tier >= 0 && (recorded === undefined || tier > recorded)) {
      out.push({
        key: meta.key,
        tier,
        name: meta.name,
        emoji: meta.emoji,
        next: meta.thresholds[tier + 1] ?? meta.thresholds[tier],
      })
    }
  }
  return out
}

/** 成就徽章的展示态:key → {tier, count, next} */
export function achievementView(p: MikuPet) {
  const counters = p.counters ?? { pat: 0, feed: 0, play: 0, sing: 0, game: 0 }
  const done = p.achievements ?? {}
  return ACHIEVEMENT_META.map((meta) => {
    const count = counters[meta.key]
    let tier = -1
    for (let i = 0; i < meta.thresholds.length; i++) {
      if (count >= meta.thresholds[i]) tier = i
    }
    return { ...meta, count, tier: Math.max(tier, done[meta.key] ?? -1), next: meta.thresholds.find((t) => t > count) }
  })
}

// ---------- 等级解锁 ----------

export type PetUnlockKey = 'pudding' | 'highfive' | 'request'
export const UNLOCKS: { lv: number; key: PetUnlockKey; label: string }[] = [
  { lv: 2, key: 'pudding', label: '喂布丁' },
  { lv: 3, key: 'highfive', label: '击掌' },
  { lv: 4, key: 'request', label: '点歌' },
]
export const hasUnlock = (level: number, key: PetUnlockKey) => level >= (UNLOCKS.find((u) => u.key === key)?.lv ?? 99)

// ---------- 闲置碎碎念与问候台词(自 App.tsx 迁入,养成页与悬浮球共用) ----------

const pad2 = (n: number) => String(n).padStart(2, '0')
const localStamp = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`

type PetState = { mood: number; fullness: number }

/** 进养成页的问候:按时段 × 她的当前状态 */
export function makeGreetLine(p: MikuPet, now = new Date()): string {
  const h = now.getHours()
  const { mood, fullness } = petNow(p)
  const night = h >= 21 || h < 6
  if (fullness < 25) return '肚子空空的…有吃的吗?有大葱更好了!'
  if (mood < 25) return '呜…有点无聊,陪我玩一会儿嘛'
  if (night) return pickGreet(['这么晚才来呀,是想我了吗?', '嘘——夜深了,小声一点哦'])
  if (h < 11) return pickGreet(['早上好!今天也一起加油哦', '早安!新的一天,元气满满!'])
  if (h < 14) return pickGreet(['午安~吃过午饭了吗?', '午后犯困…陪我聊聊天吧'])
  if (h < 18) return pickGreet(['下午好呀!记得起来活动一下哦', '来啦!刚好无聊,陪我玩嘛'])
  return pickGreet(['晚上好~今天辛苦啦', '你来啦!今天有什么开心的事吗?'])
}

const pickGreet = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

/** 闲置碎碎念:传入她的当前状态时,状态差会主动撒娇(置于池前部,更常被抽中) */
export function makeMurmurLine(d: AppData | null, state?: PetState): string {
  const now = new Date()
  const h = now.getHours()
  const night = h >= 21 || h < 6
  const todos = d?.todos ?? []
  const pending = todos.filter((t) => !t.done)
  const overdue = pending.filter((t) => !!t.dueDate && t.dueDate < todayStr())
  const habits = d?.habits ?? []
  const unchecked = habits.filter((hb) => !hb.records[todayStr()])
  const hm = `${pad2(h)}:${pad2(now.getMinutes())}`
  const classesLeft = (d?.courses ?? []).filter((c) => c.weekday % 7 === now.getDay() && c.end > hm)
  const soonReminder = (d?.reminders ?? []).find(
    (r) => !r.firedAt && r.dueAt >= nowLocalStr() && r.dueAt <= localStamp(new Date(Date.now() + 3_600_000)),
  )

  const pool: string[] = []
  // 状态撒娇:饿/无聊优先
  if (state && state.fullness < 25) {
    pool.push('肚子咕咕叫了…喂我点东西嘛', '好饿…这个点,该有大葱了吧?', '闻到葱香了…是错觉吗?')
  }
  if (state && state.mood < 30) {
    pool.push('无聊…陪我玩一会儿嘛', '摸摸头也行,人家想你了', '发呆好累,来点乐子吧~')
  }
  if (night) {
    pool.push('夜深了,我也犯困了…你也早点休息哦', '这么晚还在忙吗?别熬太晚呀')
    if (pending.length > 0) pool.push(`还有 ${pending.length} 件待办,做完早点睡哦`)
  } else if (h < 11) {
    pool.push('早上好呀,新的一天也要元气满满哦')
    if (classesLeft.length > 0) pool.push(`今天还有 ${classesLeft.length} 节课,别迟到啦`)
    if (unchecked[0]) pool.push(`新的一天,从打卡「${unchecked[0].name}」开始吧`)
  } else if (h < 14) {
    pool.push('午休一下下,下午更有精神哦', '午饭吃了吗?吃饱才有力气干活')
  } else if (h < 18) {
    pool.push('记得起来活动一下,眼睛也要休息哦', '喝口水,休息一下吧~')
  } else {
    pool.push('今天辛苦啦~', '晚饭吃了吗?别饿着肚子干活')
  }
  if (!night) {
    if (overdue.length > 0) pool.push(`有 ${overdue.length} 件待办已经逾期了,先处理一下?`)
    if (pending.length > 0 && h >= 14) pool.push(`还有 ${pending.length} 个待办没完成,加油鸭`)
    if (unchecked[0]) pool.push(`今天的「${unchecked[0].name}」还没打卡哦`)
    if (soonReminder) pool.push(`「${soonReminder.title}」一小时后就要提醒你咯`)
    const proud = habits.find((hb) => !!hb.records[todayStr()] && streak(hb.records) >= 3)
    if (proud) pool.push(`「${proud.name}」已经连续 ${streak(proud.records)} 天啦,好厉害!`)
  }
  if (pool.length === 0) pool.push('有什么想做的,随时告诉我哦~')
  return pool[Math.floor(Math.random() * pool.length)]
}
