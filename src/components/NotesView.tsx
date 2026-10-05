// 随手记视图:随手输入 → AI 实时整理进当日日报 → 周报由一周日报生成。
// 整理编排器(org)由 App 统一持有(与总览随手记卡共享同一条队列),本组件管交互与展示。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppData, NoteEntry } from '../types'
import { todayStr } from '../api'
import { isoWeekKey, weekKeyToDays, weekdayCn, type NotesOrg } from '../notesOrg'
import MiniMarkdown from './MiniMarkdown'

interface Props {
  data: AppData
  org: NotesOrg
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
/** ISO 时间串 → 本地「MM-DD HH:mm」(updatedAt 展示用,直接 slice 会露出 UTC 时刻) */
const fmtLocal = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm(iso)}`
}
/** 本地日期串 → MM-DD(列表里紧凑展示) */
const short = (date: string) => date.slice(5, 10).replace('-', '/')
/** Date → 本地 YYYY-MM-DD(与 todayStr 同口径) */
const dstr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

export default function NotesView({ data, org }: Props) {
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<'daily' | 'weekly'>('daily')
  // 日报查看偏移:0 = 今天,负数往前(不允许未来)
  const [dayOffset, setDayOffset] = useState(0)
  // 周报查看偏移:0 = 本周
  const [weekOffset, setWeekOffset] = useState(0)
  const [weeklyError, setWeeklyError] = useState('')
  const [copied, setCopied] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const orgRef = useRef(org)
  orgRef.current = org

  const today = todayStr()
  // 挂载即补齐缺失的历史周报(整理链内部串行、失败不重试,与 SpringNote 的启动补齐同思路)
  useEffect(() => {
    orgRef.current.backfillWeeks()
  }, [])
  // 有随手记但当天还没有日报的(如导入的数据),挂载时补触发一次整理
  useEffect(() => {
    const seen = new Set<string>()
    for (const n of data.notes) {
      if (seen.has(n.date)) continue
      seen.add(n.date)
      if (!data.reports.some((r) => r.kind === 'daily' && r.id === n.date)) {
        orgRef.current.mergeDaily(n.date)
      }
    }
    // 只随数据整体变化跑一次级整理;mergeDaily 自身有去重与串行保护
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.notes.length, data.reports.length])

  // 命令面板 / 快捷键 m:聚焦输入框
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('workbench:focus-note-input', focus)
    return () => window.removeEventListener('workbench:focus-note-input', focus)
  }, [])

  // Miku 代记(add_note 工具):带原始条目触发整理,补偿 dataRef 未更新的竞态
  useEffect(() => {
    const onAdded = (e: Event) => {
      const entry = (e as CustomEvent).detail as NoteEntry | undefined
      if (entry?.date) orgRef.current.mergeDaily(entry.date, [entry])
    }
    window.addEventListener('workbench:note-added', onAdded)
    return () => window.removeEventListener('workbench:note-added', onAdded)
  }, [])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    org.submitNote(text)
    setDraft('')
  }

  // ---------- 选中日期 / 周期 ----------
  const selDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    return dstr(d)
  }, [dayOffset])
  const weekKey = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + weekOffset * 7)
    return isoWeekKey(dstr(d))
  }, [weekOffset])
  const weekDays = useMemo(() => weekKeyToDays(weekKey), [weekKey])

  const dayEntries = useMemo(
    () => data.notes.filter((n) => n.date === selDate).sort((a, b) => a.ts.localeCompare(b.ts)),
    [data.notes, selDate],
  )
  const dayReport = data.reports.find((r) => r.kind === 'daily' && r.id === selDate)
  const weekReport = data.reports.find((r) => r.kind === 'weekly' && r.id === weekKey)
  // 该周是否有可生成材料(日报或随手记)
  const weekHasMaterial = useMemo(
    () => weekDays.some((d) => data.notes.some((n) => n.date === d) || data.reports.some((r) => r.kind === 'daily' && r.id === d)),
    [weekDays, data.notes, data.reports],
  )
  const todayReport = data.reports.find((r) => r.kind === 'daily' && r.id === today)
  const todayPending = todayReport?.ai ? (todayReport.pendingIds?.length ?? 0) : 0
  const generatingWeeks = Object.keys(org.generating)

  const genWeekly = (force: boolean) => {
    setWeeklyError('')
    org.generateWeekly(weekKey, force).catch((err) => {
      setWeeklyError((err as Error)?.message || '生成失败,请重试')
    })
  }

  const copyReport = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied(''), 1500)
    } catch {
      // 剪贴板不可用(非安全上下文等):静默
    }
  }

  const dayNav = (
    <div className="week-nav">
      <button className="week-btn" title="前一天" onClick={() => setDayOffset((o) => o - 1)}>
        ‹
      </button>
      <span className="week-label">
        {selDate} 周{weekdayCn(selDate)}
        {dayOffset === 0 ? ' · 今天' : ''}
      </span>
      <button className="week-btn" title="后一天" disabled={dayOffset >= 0} onClick={() => setDayOffset((o) => o + 1)}>
        ›
      </button>
    </div>
  )

  const weekNav = (
    <div className="week-nav">
      <button className="week-btn" title="上一周" onClick={() => setWeekOffset((o) => o - 1)}>
        ‹
      </button>
      <span className="week-label">
        {weekKey} · {short(weekDays[0])} ~ {short(weekDays[6])}
        {weekOffset === 0 ? ' · 本周' : ''}
      </span>
      <button className="week-btn" title="下一周" disabled={weekOffset >= 0} onClick={() => setWeekOffset((o) => o + 1)}>
        ›
      </button>
    </div>
  )

  const reportActions = (id: string, content: string) => (
    <div className="note-rep-actions">
      <button className="btn ghost note-act-btn" onClick={() => copyReport(id, content)}>
        {copied === id ? '已复制 ✓' : '复制'}
      </button>
    </div>
  )

  return (
    <div className="panel panel-notes">
      <header className="p-head">
        <h2>
          <span className="tag">NOTES</span>
          <i>/</i>随手记
        </h2>
        {org.merging[today] && <span className="note-busy">Miku 正在整理今日日报…</span>}
        {generatingWeeks.length > 0 && (
          <span className="note-busy">正在补齐周报 {generatingWeeks.join('、')}</span>
        )}
      </header>

      {/* 快速输入:Enter 提交(兼容中文输入法组词),Shift+Enter 换行 */}
      <div className="note-capture">
        <textarea
          ref={inputRef}
          className="note-input"
          rows={2}
          value={draft}
          maxLength={2000}
          placeholder="记点什么…(Enter 提交,AI 自动整理进今日日报)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="note-capture-foot">
          <span className="note-hint">
            {draft.trim() ? 'Enter 提交' : '想法、进展、待跟进的事,随手记下就好'}
          </span>
          <button className="btn solid note-send" onClick={submit} disabled={!draft.trim()}>
            记一笔
          </button>
        </div>
      </div>

      <div className="note-tabs" role="tablist">
        <button
          className={`note-tab ${tab === 'daily' ? 'on' : ''}`}
          role="tab"
          aria-selected={tab === 'daily'}
          onClick={() => setTab('daily')}
        >
          日报
          {todayPending > 0 && <i className="note-dot" title="有记录待整理" />}
        </button>
        <button
          className={`note-tab ${tab === 'weekly' ? 'on' : ''}`}
          role="tab"
          aria-selected={tab === 'weekly'}
          onClick={() => setTab('weekly')}
        >
          周报
        </button>
      </div>

      {tab === 'daily' ? (
        <section className="rsec note-sec">
          <div className="note-sec-head">
            <h3 className="rsec-title">
              当日随手记<span className="rsec-sub">{dayEntries.length} 条</span>
            </h3>
            {dayNav}
          </div>
          {dayEntries.length > 0 ? (
            <div className="note-entries">
              {dayEntries.map((n) => (
                <div key={n.id} className="note-entry">
                  <span className="note-entry-time">{hhmm(n.ts)}</span>
                  <span className="note-entry-text">{n.content}</span>
                  <button className="note-entry-x" title="删除这条记录" onClick={() => org.deleteNote(n.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-hint">{selDate === today ? '今天还没有记录,在上面随手记一条吧' : '这一天没有记录'}</div>
          )}

          <h3 className="rsec-title note-rep-title">
            当日日报
            {dayReport?.ai ? (
              <span className="rsec-sub">AI 整理 · {fmtLocal(dayReport.updatedAt)}</span>
            ) : dayReport ? (
              <span className="note-local-tag">本地备份 · 未整理</span>
            ) : null}
          </h3>
          {/* 待整理提示:AI 版尚有未吸收的记录(上次整理失败或整理期间新记的) */}
          {dayReport?.ai && (dayReport.pendingIds?.length ?? 0) > 0 && (
            <div className="note-retry-bar">
              有 {dayReport.pendingIds!.length} 条记录还没整理进日报
              <button className="btn ghost note-act-btn" onClick={() => org.mergeDaily(selDate)} disabled={!org.aiUsable}>
                整理
              </button>
            </div>
          )}
          {org.merging[selDate] ? (
            <div className="ai-bubble ai-typing note-typing">
              <span className="ai-dots">
                <i />
                <i />
                <i />
              </span>
              Miku 正在整理这天的日报…
            </div>
          ) : dayReport?.content.trim() ? (
            <div className="note-report">
              <MiniMarkdown text={dayReport.content} />
              {!dayReport.ai && org.aiUsable && (
                <button className="btn ghost note-act-btn note-retry" onClick={() => org.mergeDaily(selDate)}>
                  让 AI 重新整理
                </button>
              )}
              {reportActions(dayReport.id, dayReport.content)}
            </div>
          ) : (
            <div className="empty-hint">
              {dayEntries.length > 0
                ? org.aiUsable
                  ? '还没有日报,提交记录后会自动整理'
                  : '还没有日报(未配置 AI,记录将以原样保留)'
                : '没有记录就没有日报'}
            </div>
          )}
        </section>
      ) : (
        <section className="rsec note-sec">
          <div className="note-sec-head">
            <h3 className="rsec-title">周报</h3>
            {weekNav}
          </div>
          {weeklyError && (
            <div className="ai-error">
              <span>{weeklyError}</span>
              <button onClick={() => setWeeklyError('')}>知道了</button>
            </div>
          )}
          {org.generating[weekKey] ? (
            <div className="ai-bubble ai-typing note-typing">
              <span className="ai-dots">
                <i />
                <i />
                <i />
              </span>
              Miku 正在根据这一周的日报写周报…
            </div>
          ) : weekReport?.content.trim() ? (
            <div className="note-report">
              <MiniMarkdown text={weekReport.content} />
              <div className="note-rep-actions">
                <button
                  className="btn ghost note-act-btn"
                  onClick={() => genWeekly(true)}
                  disabled={!org.aiUsable}
                  title="依据当前记录重新生成"
                >
                  重新生成
                </button>
                <button className="btn ghost note-act-btn" onClick={() => copyReport(weekReport.id, weekReport.content)}>
                  {copied === weekReport.id ? '已复制 ✓' : '复制'}
                </button>
              </div>
            </div>
          ) : (
            <div className="note-week-empty">
              <div className="empty-hint">
                {weekHasMaterial
                  ? weekOffset === 0
                    ? '这一周还在进行中,随时可以生成当前的周报'
                    : org.aiUsable
                      ? '这一周还没有周报,可以现在生成'
                      : '这一周还没有周报(未配置 AI)'
                  : '这一周没有日报或随手记,没有可整理的材料'}
              </div>
              {weekHasMaterial && (
                <button className="btn solid note-act-btn" onClick={() => genWeekly(true)} disabled={!org.aiUsable}>
                  {weekOffset === 0 ? '生成本周周报' : '生成周报'}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
