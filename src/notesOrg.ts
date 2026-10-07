// 随手记 → AI 日报/周报 的编排层:周期计算、源文本拼接、本地兜底合并、检索,
// 以及把「提交随手记 → 触发 AI 重写当日日报 → 周报自动补齐」串起来的 useNotesOrg。
// AI 请求在 ai.ts(generateDailyReport / generateWeeklyReport);数据写入走 App 的 update。
// 借鉴 SpringNote 的设计原则:AI 只做重写合并而非追加;任何失败都降级为确定性本地合并,内容永不丢。
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppData, GenReport, NoteEntry } from './types'
import { todayStr, uid } from './api'
import type { UpdateFn } from './App'
import { generateDailyReport, generateMonthlyReport, generateWeeklyReport, loadAiConfig, type AiConfigInfo } from './ai'

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']
const pad2 = (n: number) => String(n).padStart(2, '0')
const nowIso = () => new Date().toISOString()

// ---------- 日期与周期 ----------

/** 本地日期串 → 当天零点的 Date(按字段解析,避免 UTC 偏移) */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}

/** 某日所在周的周一 ~ 周日(7 个 YYYY-MM-DD) */
export function weekDaysOf(dateStr: string): string[] {
  const d = parseLocalDate(dateStr)
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday)
    x.setDate(monday.getDate() + i)
    return todayStr(x)
  })
}

/** ISO 周标识 YYYY-Www(周一为一周起点;含第一个周四的那周是第 1 周) */
export function isoWeekKey(dateStr: string): string {
  const d = parseLocalDate(dateStr)
  // 本周的周四:决定 ISO 周号与归属年份
  const thursday = new Date(d)
  thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3)
  const jan1 = new Date(thursday.getFullYear(), 0, 1)
  const week = Math.round((thursday.getTime() - jan1.getTime()) / 86400000 / 7) + 1
  return `${thursday.getFullYear()}-W${pad2(week)}`
}

/** ISO 周标识 → 该周周一 ~ 周日(YYYY-MM-DD×7) */
export function weekKeyToDays(key: string): string[] {
  const y = Number(key.slice(0, 4))
  const w = Number(key.slice(6))
  // 1 月 4 日恒在 ISO 第 1 周,从它所在周的周一起算
  const jan4 = new Date(y, 0, 4)
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7)
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday)
    x.setDate(monday.getDate() + i)
    return todayStr(x)
  })
}

/** 本地日期串 → 月份标识 YYYY-MM */
export const monthKeyOf = (dateStr: string) => dateStr.slice(0, 7)

/** 月份标识 YYYY-MM → 该月 1 日与最后一天(YYYY-MM-DD) */
export function monthBounds(monthKey: string): { start: string; end: string } {
  const [y, m] = monthKey.split('-').map(Number)
  const endD = new Date(y || 1970, m || 1, 0)
  return { start: `${monthKey}-01`, end: `${monthKey}-${pad2(endD.getDate())}` }
}

export const weekdayCn = (dateStr: string) => WEEKDAY_CN[parseLocalDate(dateStr).getDay()]

const hhmm = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// ---------- 文本组装 ----------

/** 无 AI 时的确定性日报:标题 + 每条随手记一节(幂等,重跑不重复) */
export function buildFallbackDaily(date: string, entries: NoteEntry[]): string {
  const parts = [`# ${date} 日报`]
  for (const e of entries) {
    parts.push(`## ${hhmm(e.ts)} 随手记录`, `- ${e.content.trim()}`)
  }
  return parts.join('\n\n')
}

/** 周报来源:一周内每天一节日报;有日报用日报,没有但当天有随手记就用兜底版 */
export function buildWeeklySource(data: AppData, days: string[]): string {
  const sections: string[] = []
  for (const date of days) {
    const report = data.reports.find((r) => r.kind === 'daily' && r.id === date)
    const dayEntries = data.notes.filter((n) => n.date === date).sort((a, b) => a.ts.localeCompare(b.ts))
    let body = report?.content.trim() || ''
    if (!body && dayEntries.length) body = buildFallbackDaily(date, dayEntries)
    if (body) sections.push(`## ${date} 日报\n\n${body}`)
  }
  return sections.join('\n\n')
}

/** 月报来源:该月覆盖到的每一周,优先用周报;缺周报的周用落在本月内的日报/随手记兜底 */
export function buildMonthlySource(data: AppData, monthKey: string): string {
  const { start, end } = monthBounds(monthKey)
  const seenWeeks = new Set<string>()
  const sections: string[] = []
  for (const d = parseLocalDate(start); ; d.setDate(d.getDate() + 1)) {
    const date = todayStr(d)
    if (date > end) break
    const wk = isoWeekKey(date)
    if (seenWeeks.has(wk)) continue
    seenWeeks.add(wk)
    const weekly = data.reports.find((r) => r.kind === 'weekly' && r.id === wk)
    if (weekly?.content.trim()) {
      sections.push(`## ${wk} 周报\n\n${weekly.content.trim()}`)
      continue
    }
    // 该周缺周报:只取落在本月内的日子,避免把相邻月的内容混进来
    const inMonth = weekKeyToDays(wk).filter((x) => x >= start && x <= end)
    const parts: string[] = []
    for (const day of inMonth) {
      const rep = data.reports.find((r) => r.kind === 'daily' && r.id === day)
      const entries = data.notes.filter((n) => n.date === day).sort((a, b) => a.ts.localeCompare(b.ts))
      let body = rep?.content.trim() || ''
      if (!body && entries.length) body = buildFallbackDaily(day, entries)
      if (body) parts.push(`### ${day}\n\n${body}`)
    }
    if (parts.length) sections.push(`## ${wk}(无周报,按日汇总)\n\n${parts.join('\n\n')}`)
  }
  return sections.join('\n\n')
}

// ---------- 检索(Miku 工具用) ----------

export interface NoteHit {
  date: string
  time: string
  content: string
}

export function searchNotes(
  data: AppData,
  args: { keyword: string; dateFrom?: string; dateTo?: string },
): { hits: NoteHit[]; total: number } {
  const kw = args.keyword.trim().toLowerCase()
  const hits: NoteHit[] = []
  for (const n of data.notes) {
    if (args.dateFrom && n.date < args.dateFrom) continue
    if (args.dateTo && n.date > args.dateTo) continue
    if (!n.content.toLowerCase().includes(kw)) continue
    hits.push({ date: n.date, time: hhmm(n.ts), content: n.content })
  }
  hits.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  return { hits: hits.slice(0, 20), total: hits.length }
}

/** 读日报工具:有日报给日报;没有但当天有随手记时,如实返回原始记录 */
export function readDailyReport(
  data: AppData,
  date: string,
): { ok: true; date: string; content: string; ai: boolean } | { ok: false; error: string } {
  const report = data.reports.find((r) => r.kind === 'daily' && r.id === date)
  if (report?.content.trim()) return { ok: true, date, content: report.content, ai: report.ai }
  const dayEntries = data.notes.filter((n) => n.date === date).sort((a, b) => a.ts.localeCompare(b.ts))
  if (dayEntries.length) {
    return {
      ok: true,
      date,
      content: dayEntries.map((n) => `- ${hhmm(n.ts)} ${n.content}`).join('\n'),
      ai: false,
    }
  }
  return { ok: false, error: `${date} 没有日报,当天也没有随手记` }
}

/** 读周报工具:week 接受 2026-W41 或该周内任一天日期(自动换算 ISO 周) */
export function readWeeklyReport(
  data: AppData,
  week: string,
): { ok: true; week: string; content: string } | { ok: false; error: string } {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(week.trim()) ? isoWeekKey(week.trim()) : week.trim()
  const report = data.reports.find((r) => r.kind === 'weekly' && r.id === key)
  if (report?.content.trim()) return { ok: true, week: key, content: report.content }
  return { ok: false, error: `还没有 ${key} 的周报` }
}

// ---------- 编排 ----------

export interface NotesOrg {
  /** 提交一条随手记:入集合 + 触发当日日报整理(队列串行) */
  submitNote: (content: string) => void
  deleteNote: (id: string) => void
  /** 整理某天的日报(重试/补触发);extra 用于 Miku 代记时补偿尚未入 dataRef 的新条目 */
  mergeDaily: (date: string, extra?: NoteEntry[]) => Promise<void>
  /** 手动生成/重新生成某周周报;AI 失败会抛错供界面提示 */
  generateWeekly: (weekKey: string, force?: boolean) => Promise<void>
  /** 补齐所有缺失的历史周报(从近到远,串行);本会话已尝试失败的周可 force 重试 */
  backfillWeeks: (force?: boolean) => Promise<void>
  /** 手动生成/重新生成某月月报(源为该月各周周报);AI 失败会抛错 */
  generateMonthly: (monthKey: string, force?: boolean) => Promise<void>
  /** 补齐所有缺失的历史月报(从近到远,串行) */
  backfillMonths: (force?: boolean) => Promise<void>
  /** 正在整理日报的日期集合 */
  merging: Record<string, true>
  /** 正在生成周报的周 key 集合 */
  generating: Record<string, true>
  /** 正在生成月报的月 key 集合 */
  generatingMonths: Record<string, true>
  /** AI 是否可用(未配置时直接走本地合并,不发无效请求) */
  aiUsable: boolean
}

type BusySetter = Dispatch<SetStateAction<Record<string, true>>>

export function useNotesOrg(data: AppData | null, update: UpdateFn): NotesOrg {
  // 与 AiPanel 相同的 dataRef 模式:异步整理链里始终读最新数据
  const dataRef = useRef<AppData | null>(data)
  dataRef.current = data

  const [merging, setMerging] = useState<Record<string, true>>({})
  const [generating, setGenerating] = useState<Record<string, true>>({})
  const [generatingMonths, setGeneratingMonths] = useState<Record<string, true>>({})
  const [aiUsable, setAiUsable] = useState(false)
  // 本会话已自动尝试过的周(成功或失败都记,防止失败循环重试);force 路径不受限
  const attemptedWeeks = useRef<Set<string>>(new Set())
  // 同一天 / 周报 / 月报生成的串行链:前一次 AI 写回后,后一次才能读到最新报告
  const dayChains = useRef<Map<string, Promise<void>>>(new Map())
  const weekChain = useRef<Promise<void>>(Promise.resolve())
  const monthChain = useRef<Promise<void>>(Promise.resolve())
  // 编排器在 App 层持有,跨账号存活:数据从无到有(登录/换号)时清空上个会话期的状态
  const hadDataRef = useRef(false)
  if (!data) {
    hadDataRef.current = false
  } else if (!hadDataRef.current) {
    hadDataRef.current = true
    attemptedWeeks.current.clear()
    dayChains.current.clear()
    weekChain.current = Promise.resolve()
    monthChain.current = Promise.resolve()
  }

  const upsertReport = useCallback(
    (r: GenReport) => {
      update('reports', (items) => {
        const i = items.findIndex((x) => x.id === r.id && x.kind === r.kind)
        if (i === -1) return [...items, r]
        const next = items.slice()
        next[i] = r
        return next
      })
    },
    [update],
  )

  const checkAi = useCallback(async (): Promise<AiConfigInfo | null> => {
    const cfg = await loadAiConfig().catch(() => null)
    const ok = !!cfg && !!cfg.baseUrl && !!cfg.model && cfg.hasKey
    setAiUsable(ok)
    return ok ? cfg : null
  }, [])

  const markBusy = (setter: BusySetter, key: string, on: boolean) => {
    setter((prev) => {
      if (on) return { ...prev, [key]: true as const }
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  /** 整理某一天的日报:把 pending(或全部,若当前为本地兜底版)随手记喂给 AI 重写 */
  const runDailyMerge = useCallback(
    async (date: string, extra: NoteEntry[] = []) => {
      const d = dataRef.current
      if (!d) return
      const pool = d.notes.filter((n) => n.date === date)
      // 额外条目(提交/Miku 代记的竞态补偿):dataRef 还没吃到时手工并入
      for (const e of extra) {
        if (!pool.some((n) => n.id === e.id)) pool.push(e)
      }
      pool.sort((a, b) => a.ts.localeCompare(b.ts))
      if (!pool.length) return
      const report = d.reports.find((r) => r.kind === 'daily' && r.id === date)
      // 待整理集 = 显式登记的 pendingIds ∪ 上次整理之后新提交的(按提交时间推导,
      // 这样提交路径无需可靠的「登记」时序);ai:false/无报告/异常空文 → 本地版不值得保留,全量重写
      const fresh = !report?.ai || !report.content.trim()
      let pendingIds: Set<string>
      if (fresh) {
        pendingIds = new Set(pool.map((e) => e.id))
      } else {
        pendingIds = new Set(report!.pendingIds ?? [])
        for (const e of pool) if (e.ts > report!.updatedAt) pendingIds.add(e.id)
        for (const e of extra) pendingIds.add(e.id)
      }
      const pending = pool.filter((e) => pendingIds.has(e.id))
      if (!pending.length) return

      markBusy(setMerging, date, true)
      try {
        const cfg = await checkAi()
        if (!cfg) throw new Error('未配置 AI')
        const { text, usage } = await generateDailyReport({
          date,
          weekday: weekdayCn(date),
          existing: fresh ? '' : report!.content,
          entries: pending.map((e) => ({ time: hhmm(e.ts), content: e.content.trim() })),
        })
        upsertReport({
          id: date,
          kind: 'daily',
          content: text,
          ai: true,
          pendingIds: [],
          updatedAt: nowIso(),
          usage,
        })
      } catch {
        // 本地兜底:此前是 AI 文 → 在其后追加 pending 的原样小节;否则从原始记录全量重建
        const prev = dataRef.current?.reports.find((r) => r.kind === 'daily' && r.id === date)
        const appended = pending.map((e) => `## ${hhmm(e.ts)} 随手记录\n\n- ${e.content.trim()}`).join('\n\n')
        const content =
          prev?.ai && prev.content.trim() ? `${prev.content.trim()}\n\n${appended}` : buildFallbackDaily(date, pool)
        upsertReport({
          id: date,
          kind: 'daily',
          content,
          ai: false,
          pendingIds: pool.map((e) => e.id),
          updatedAt: nowIso(),
        })
      } finally {
        markBusy(setMerging, date, false)
      }
    },
    [checkAi, upsertReport],
  )

  const mergeDaily = useCallback(
    (date: string, extra: NoteEntry[] = []) => {
      const prev = dayChains.current.get(date) ?? Promise.resolve()
      const run = prev.then(() => runDailyMerge(date, extra)).catch(() => {})
      dayChains.current.set(date, run)
      return run
    },
    [runDailyMerge],
  )

  const generateWeeklyRun = useCallback(
    async (weekKey: string, force: boolean) => {
      const d = dataRef.current
      if (!d) return
      const existing = d.reports.find((r) => r.kind === 'weekly' && r.id === weekKey)
      if (existing?.content.trim() && !force) return
      const days = weekKeyToDays(weekKey)
      const source = buildWeeklySource(d, days)
      if (!source.trim()) return
      markBusy(setGenerating, weekKey, true)
      try {
        const cfg = await checkAi()
        if (!cfg) throw new Error('未配置 AI')
        const { text, usage } = await generateWeeklyReport({ weekKey, start: days[0], end: days[6], source })
        upsertReport({ id: weekKey, kind: 'weekly', content: text, ai: true, updatedAt: nowIso(), usage })
        attemptedWeeks.current.add(weekKey)
      } finally {
        markBusy(setGenerating, weekKey, false)
      }
    },
    [checkAi, upsertReport],
  )

  const generateWeekly = useCallback(
    (weekKey: string, force = false) => {
      const prev = weekChain.current
      const run = prev.then(() => generateWeeklyRun(weekKey, force))
      // 失败不吞:手动调用方要 catch 弹提示;链上吞掉,避免断掉后续排队的周
      weekChain.current = run.catch(() => {})
      return run
    },
    [generateWeeklyRun],
  )

  const backfillWeeks = useCallback(
    (force = false) => {
      const run = weekChain.current.then(async () => {
        const d = dataRef.current
        if (!d) return
        const cfg = await checkAi()
        if (!cfg) return
        if (force) attemptedWeeks.current.clear()
        const currentKey = isoWeekKey(todayStr())
        const touched = new Set<string>()
        for (const r of d.reports) if (r.kind === 'daily') touched.add(isoWeekKey(r.id))
        for (const n of d.notes) touched.add(isoWeekKey(n.date))
        // 字典序即时间序(YYYY-Www 补零),从近到远补
        const weeks = [...touched].filter((k) => k < currentKey).sort().reverse()
        for (const k of weeks) {
          const has = d.reports.some((r) => r.kind === 'weekly' && r.id === k && r.content.trim())
          if (has) continue
          if (!force && attemptedWeeks.current.has(k)) continue
          attemptedWeeks.current.add(k)
          await generateWeeklyRun(k, false).catch(() => {})
        }
      })
      weekChain.current = run.catch(() => {})
      return run
    },
    [checkAi, generateWeeklyRun],
  )

  /** 生成某月月报:把该月覆盖的各周周报(缺则按日兜底)喂给 AI;失败抛错供界面提示 */
  const generateMonthlyRun = useCallback(
    async (monthKey: string, force: boolean) => {
      const d = dataRef.current
      if (!d) return
      const existing = d.reports.find((r) => r.kind === 'monthly' && r.id === monthKey)
      if (existing?.content.trim() && !force) return
      const { start, end } = monthBounds(monthKey)
      const source = buildMonthlySource(d, monthKey)
      if (!source.trim()) return
      markBusy(setGeneratingMonths, monthKey, true)
      try {
        const cfg = await checkAi()
        if (!cfg) throw new Error('未配置 AI')
        const { text, usage } = await generateMonthlyReport({ monthKey, start, end, source })
        upsertReport({ id: monthKey, kind: 'monthly', content: text, ai: true, updatedAt: nowIso(), usage })
      } finally {
        markBusy(setGeneratingMonths, monthKey, false)
      }
    },
    [checkAi, upsertReport],
  )

  const generateMonthly = useCallback(
    (monthKey: string, force = false) => {
      const prev = monthChain.current
      const run = prev.then(() => generateMonthlyRun(monthKey, force))
      // 失败不吞:手动调用方要 catch 弹提示;链上吞掉,避免断掉后续排队的月
      monthChain.current = run.catch(() => {})
      return run
    },
    [generateMonthlyRun],
  )

  const backfillMonths = useCallback(
    (force = false) => {
      const run = monthChain.current.then(async () => {
        const d = dataRef.current
        if (!d) return
        const cfg = await checkAi()
        if (!cfg) return
        const currentKey = monthKeyOf(todayStr())
        const touched = new Set<string>()
        for (const r of d.reports) if (r.kind === 'weekly') touched.add(monthKeyOf(weekKeyToDays(r.id)[0]))
        for (const n of d.notes) touched.add(monthKeyOf(n.date))
        // 字典序即时间序(YYYY-MM 补零),从近到远补;当月不自动生成(还在进行中)
        const months = [...touched].filter((k) => k < currentKey).sort().reverse()
        for (const k of months) {
          const has = d.reports.some((r) => r.kind === 'monthly' && r.id === k && r.content.trim())
          if (has) continue
          await generateMonthlyRun(k, force).catch(() => {})
        }
      })
      monthChain.current = run.catch(() => {})
      return run
    },
    [checkAi, generateMonthlyRun],
  )

  const submitNote = useCallback(
    (content: string) => {
      const text = content.trim()
      if (!text) return
      const entry: NoteEntry = { id: uid(), content: text, date: todayStr(), ts: nowIso() }
      update('notes', (items) => [...items, entry])
      // 新条目随触发一并传入:React 渲染时序不可靠,extra 保证合并能读到它
      mergeDaily(entry.date, [entry])
    },
    [mergeDaily, update],
  )

  const deleteNote = useCallback(
    (id: string) => {
      const target = dataRef.current?.notes.find((n) => n.id === id)
      update('notes', (items) => items.filter((n) => n.id !== id))
      if (!target) return
      // 本地兜底版是纯函数产物,直接重建即可摘掉该条;AI 版不动正文(可手动重新整理)
      const report = dataRef.current?.reports.find((r) => r.kind === 'daily' && r.id === target.date)
      if (report && !report.ai) {
        const rest = (dataRef.current?.notes ?? []).filter((n) => n.id !== id && n.date === target.date)
        upsertReport({ ...report, content: buildFallbackDaily(target.date, rest), updatedAt: nowIso() })
      }
    },
    [update, upsertReport],
  )

  return {
    submitNote,
    deleteNote,
    mergeDaily,
    generateWeekly,
    backfillWeeks,
    generateMonthly,
    backfillMonths,
    merging,
    generating,
    generatingMonths,
    aiUsable,
  }
}
