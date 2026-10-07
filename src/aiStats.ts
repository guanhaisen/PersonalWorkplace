// Miku 统计问答(query_stats 工具)的纯计算层:scope × range → 聚合结果。
// 口径与报告页(ReportPanel)一致:待办完成按 completedAt、新建按 createdAt、
// 打卡按本地日期;逾期 = 未完成且截止日早于今天。纯函数,便于测试与复用。
import type { AppData } from './types'
import { streak, todayStr } from './api'
import { parseLocalDate, weekDaysOf } from './notesOrg'

export type StatsScope = 'todos' | 'habits' | 'overview'
export type StatsRange = 'today' | 'thisWeek' | 'lastWeek' | 'last7d' | 'month' | 'all'

export interface StatsArgs {
  scope: StatsScope
  range?: StatsRange
}

export interface StatsResult {
  range: { start: string; end: string; label: string }
  todos?: {
    done: number
    created: number
    pending: number
    /** 未完成且已逾期(最多 10 条) */
    overdue: { title: string; dueDate: string }[]
    /** 区间内完成的任务标题(最多 10 条) */
    doneTitles: string[]
  }
  habits?: {
    /** 习惯个数 */
    count: number
    /** 区间内打卡总次数 */
    done: number
    /** 按日打卡次数(仅有限区间提供) */
    perDay?: number[]
    rows: { name: string; done: number; streak: number }[]
  }
  /** overview 附加概况 */
  extras?: string[]
}

/** 各范围的中文说明(结果里带回,模型直接引用) */
const RANGE_LABEL: Record<StatsRange, string> = {
  today: '今天',
  thisWeek: '本周(周一起算)',
  lastWeek: '上周',
  last7d: '近 7 天(含今天)',
  month: '本月',
  all: '全部历史',
}

/** 范围 → [start, end] 本地日期闭区间;all 返回空串表示不限 */
export function statsRangeBounds(range: StatsRange): { start: string; end: string } {
  const today = todayStr()
  switch (range) {
    case 'today':
      return { start: today, end: today }
    case 'thisWeek': {
      const days = weekDaysOf(today)
      return { start: days[0], end: days[6] }
    }
    case 'lastWeek': {
      const d = parseLocalDate(today)
      d.setDate(d.getDate() - 7)
      const days = weekDaysOf(todayStr(d))
      return { start: days[0], end: days[6] }
    }
    case 'last7d': {
      const d = parseLocalDate(today)
      d.setDate(d.getDate() - 6)
      return { start: todayStr(d), end: today }
    }
    case 'month': {
      const d = parseLocalDate(today)
      const start = `${today.slice(0, 7)}-01`
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      return { start, end: todayStr(end) }
    }
    case 'all':
      return { start: '', end: '' }
  }
}

const inRange = (date: string, r: { start: string; end: string }) =>
  (!r.start || date >= r.start) && (!r.end || date <= r.end)

/** UTC ISO 时间串 → 本地日期 YYYY-MM-DD(与报告页同口径) */
const localDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : todayStr(d)
}

/** 按天列出区间内每一天(仅 ≤31 天的有限区间) */
function rangeDays(r: { start: string; end: string }): string[] | null {
  if (!r.start || !r.end) return null
  const days: string[] = []
  const d = parseLocalDate(r.start)
  // 上限保护:异常区间(>62 天)不逐天展开
  for (let i = 0; i < 62; i++) {
    const s = todayStr(d)
    if (s > r.end) break
    days.push(s)
    d.setDate(d.getDate() + 1)
  }
  return days.length && days[days.length - 1] === r.end ? days : null
}

/** 主入口:按 scope 聚合;日期字段非法(空/解析不出)的记录不计入区间统计 */
export function queryStats(data: AppData, args: StatsArgs): StatsResult {
  const range = args.range ?? 'thisWeek'
  const r = statsRangeBounds(range)
  const result: StatsResult = { range: { ...r, label: RANGE_LABEL[range] } }

  if (args.scope === 'todos' || args.scope === 'overview') {
    const doneItems = data.todos.filter((t) => t.done && t.completedAt && inRange(localDate(t.completedAt), r))
    const created = data.todos.filter((t) => inRange(localDate(t.createdAt), r))
    const today = todayStr()
    const overdue = data.todos
      .filter((t) => !t.done && t.dueDate && t.dueDate < today)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
    const pending = data.todos.filter((t) => !t.done).length
    result.todos = {
      done: doneItems.length,
      created: created.length,
      pending,
      overdue: overdue
        .slice(0, 10)
        .map((t) => ({ title: t.title, dueDate: t.dueDate! })),
      doneTitles: doneItems
        .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
        .slice(0, 10)
        .map((t) => t.title),
    }
  }

  if (args.scope === 'habits' || args.scope === 'overview') {
    const days = rangeDays(r)
    const rows = data.habits.map((h) => {
      const ids = Object.keys(h.records).filter((d) => inRange(d, r))
      return { name: h.name, done: ids.length, streak: streak(h.records) }
    })
    result.habits = {
      count: rows.length,
      done: rows.reduce((s, x) => s + x.done, 0),
      perDay: days?.map((d) => data.habits.filter((h) => h.records[d]).length),
      rows,
    }
  }

  if (args.scope === 'overview') {
    const today = todayStr()
    const dow = parseLocalDate(today).getDay()
    const coursesToday = data.courses.filter((c) => c.weekday % 7 === dow).length
    const pendingReminders = data.reminders.filter((x) => !x.firedAt).length
    result.extras = [`今日课程 ${coursesToday} 门`, `未触发提醒 ${pendingReminders} 条`, `随手记累计 ${data.notes.length} 条`]
  }

  return result
}
