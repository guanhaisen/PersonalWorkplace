import { useEffect, useMemo, useState } from 'react'
import type { AppData } from '../types'
import { todayStr } from '../api'
import { aiChat, buildReportMessages, loadAiConfig, type AiConfigInfo } from '../ai'

// 周一起始,与日历面板一致
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

interface WeekRange {
  /** 偏移:0 = 本周,-1 = 上周 */
  offset: number
  label: string
  start: string
  end: string
  /** 周一~周日的 7 个日期(YYYY-MM-DD) */
  days: string[]
}

function weekRange(offset: number): WeekRange {
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7)
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    days.push(todayStr(d))
  }
  const label = offset === 0 ? '本周' : offset === -1 ? '上周' : `${-offset} 周前`
  return { offset, label, start: days[0], end: days[6], days }
}

/** UTC ISO 时间串 → 本地日期 YYYY-MM-DD(与番茄钟/习惯的本地口径一致) */
const localDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : todayStr(d)
}

function buildStats(data: AppData, week: WeekRange) {
  const inWeek = (date: string) => date >= week.start && date <= week.end
  const today = todayStr()
  // 番茄:按日聚合分钟数
  const perDay = week.days.map((d) =>
    data.pomodoros.filter((p) => p.date === d).reduce((s, p) => s + p.minutes, 0),
  )
  const focusMinutes = perDay.reduce((a, b) => a + b, 0)
  const focusDays = perDay.filter((m) => m > 0).length
  // 待办:完成按 completedAt 归周,新建按 createdAt 归周
  const doneWeek = data.todos
    .filter((t) => t.done && t.completedAt && inWeek(localDate(t.completedAt)))
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
  const createdWeek = data.todos.filter((t) => inWeek(localDate(t.createdAt)))
  const overdue = data.todos.filter((t) => !t.done && t.dueDate && t.dueDate < today)
  // 习惯:本周每天的打卡情况
  const habitRows = data.habits.map((h) => ({
    id: h.id,
    name: h.name,
    marks: week.days.map((d) => !!h.records[d]),
    count: week.days.filter((d) => h.records[d]).length,
  }))
  const habitDone = habitRows.reduce((s, h) => s + h.count, 0)
  const habitTotal = data.habits.length * 7
  // 笔记没有 createdAt,按最后更新时间归周
  const notesWeek = data.notes.filter((n) => inWeek(localDate(n.updatedAt))).length
  return { today, perDay, focusMinutes, focusDays, doneWeek, createdWeek, overdue, habitRows, habitDone, habitTotal, notesWeek }
}

const fmtMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`)

export default function ReportPanel({ data }: { data: AppData }) {
  const [offset, setOffset] = useState(0)
  const week = useMemo(() => weekRange(offset), [offset])
  const stats = useMemo(() => buildStats(data, week), [data, week])
  const [cfg, setCfg] = useState<AiConfigInfo | null>(null)
  const [comment, setComment] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    loadAiConfig()
      .then(setCfg)
      .catch(() => setCfg(null))
  }, [])

  // 切换周时清空上一周的点评
  useEffect(() => {
    setComment('')
    setAiError('')
  }, [offset])

  const configured = !!cfg && !!cfg.baseUrl && !!cfg.model && cfg.hasKey

  const genComment = async () => {
    setAiBusy(true)
    setAiError('')
    try {
      const lines = [
        `- 番茄专注:共 ${stats.focusMinutes} 分钟,有记录 ${stats.focusDays} 天,按日分布(周一~周日)为 ${stats.perDay.join(', ')} 分钟`,
        `- 待办:本周完成 ${stats.doneWeek.length} 条,新建 ${stats.createdWeek.length} 条,当前逾期 ${stats.overdue.length} 条${
          stats.overdue.length ? `(逾期项:${stats.overdue.slice(0, 5).map((t) => t.title).join('、')})` : ''
        }`,
        stats.habitRows.length
          ? `- 习惯打卡:共 ${stats.habitDone}/${stats.habitTotal} 次,明细:${stats.habitRows.map((h) => `${h.name} ${h.count}/7`).join('、')}`
          : '- 习惯打卡:还没有创建习惯',
        `- 笔记:本周更新 ${stats.notesWeek} 条`,
      ]
      const res = await aiChat({
        messages: buildReportMessages({ label: week.label, start: week.start, end: week.end, lines }),
      })
      const text = res.message?.content?.trim()
      if (!text) throw new Error('AI 没有返回内容')
      setComment(text)
    } catch (err) {
      setAiError((err as Error)?.message || '请求失败,请重试')
    } finally {
      setAiBusy(false)
    }
  }

  const maxMinutes = Math.max(...stats.perDay, 1)
  const doneShown = stats.doneWeek.slice(0, 6)

  return (
    <div className="panel panel-report">
      <header className="p-head">
        <h2>
          <span className="tag">REPORT</span>
          <i>/</i>周报
        </h2>
        <div className="week-nav">
          <button className="week-btn" title="上一周" onClick={() => setOffset((o) => o - 1)}>
            ‹
          </button>
          <span className="week-label">
            {week.label} · {week.start} ~ {week.end}
          </span>
          <button className="week-btn" title="下一周" disabled={offset >= 0} onClick={() => setOffset((o) => o + 1)}>
            ›
          </button>
        </div>
      </header>

      <div className="report-stats">
        <div className="rstat">
          <b>{fmtMinutes(stats.focusMinutes)}</b>
          <span>专注时长</span>
        </div>
        <div className="rstat">
          <b>
            {stats.doneWeek.length}
            <em>/ {stats.createdWeek.length}</em>
          </b>
          <span>完成 / 新建待办</span>
        </div>
        <div className="rstat">
          <b>
            {stats.habitDone}
            <em>/ {stats.habitTotal}</em>
          </b>
          <span>习惯打卡</span>
        </div>
        <div className="rstat">
          <b>{stats.notesWeek}</b>
          <span>笔记更新</span>
        </div>
      </div>

      <section className="rsec">
        <h3 className="rsec-title">
          专注分布<span className="rsec-sub">分钟 / 天 · {stats.focusDays} 天有记录</span>
        </h3>
        {stats.focusMinutes > 0 ? (
          <div className="report-chart">
            {stats.perDay.map((m, i) => (
              <div key={i} className="rcol">
                {m > 0 && <span className="rval">{m}</span>}
                <div
                  className={`rbar ${m === 0 ? 'zero' : ''} ${week.days[i] === stats.today ? 'today' : ''}`}
                  style={{ height: `${Math.max(Math.round((m / maxMinutes) * 88), 3)}px` }}
                  title={`${week.days[i]}(周${WEEK_LABELS[i]})专注 ${m} 分钟`}
                />
                <span className="rlab">{WEEK_LABELS[i]}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-hint">这一周没有专注记录</div>
        )}
      </section>

      <section className="rsec">
        <h3 className="rsec-title">
          待办
          {stats.overdue.length > 0 && <span className="rsec-warn">{stats.overdue.length} 条逾期</span>}
        </h3>
        {doneShown.length > 0 ? (
          doneShown.map((t) => (
            <div key={t.id} className="rline">
              <span className="rline-title">✓ {t.title}</span>
              <span className="rline-meta">{localDate(t.completedAt || '').slice(5, 10).replace('-', '/')}</span>
            </div>
          ))
        ) : (
          <div className="empty-hint">本周还没有完成的待办</div>
        )}
        {stats.doneWeek.length > doneShown.length && (
          <div className="rmore">…以及另外 {stats.doneWeek.length - doneShown.length} 条</div>
        )}
      </section>

      <section className="rsec">
        <h3 className="rsec-title">习惯打卡</h3>
        {stats.habitRows.length > 0 ? (
          stats.habitRows.map((h) => (
            <div key={h.id} className="rhabit">
              <span className="rhabit-name" title={h.name}>
                {h.name}
              </span>
              <span className="rdots">
                {h.marks.map((on, i) => (
                  <i key={i} className={`rdot ${on ? 'on' : ''}`} title={week.days[i]} />
                ))}
              </span>
              <span className="rhabit-rate">{h.count}/7</span>
            </div>
          ))
        ) : (
          <div className="empty-hint">还没有习惯,去「习惯」页创建一个吧</div>
        )}
      </section>

      <section className="rsec">
        <h3 className="rsec-title">
          <span className="tag">AI</span> 点评
        </h3>
        {aiBusy ? (
          <div className="ai-bubble ai-typing">
            <span className="ai-dots">
              <i />
              <i />
              <i />
            </span>
            AI 正在阅读本周数据…
          </div>
        ) : comment ? (
          <>
            <p className="report-ai-text">{comment}</p>
            <button className="btn ghost report-ai-btn" onClick={genComment} disabled={!configured}>
              重新生成
            </button>
          </>
        ) : configured ? (
          <button className="btn solid report-ai-btn" onClick={genComment}>
            让 AI 点评{week.label}
          </button>
        ) : (
          <div className="empty-hint">在「AI 助手」页配置服务后,可让 AI 点评{week.label}</div>
        )}
        {aiError && (
          <div className="ai-error">
            <span>{aiError}</span>
            <button onClick={() => setAiError('')}>知道了</button>
          </div>
        )}
      </section>
    </div>
  )
}
