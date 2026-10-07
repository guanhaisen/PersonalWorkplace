import { useEffect, useMemo, useState } from 'react'
import type { AppData } from '../types'
import type { UpdateFn } from '../App'
import { todayStr } from '../api'
import { isoWeekKey } from '../notesOrg'
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

/** UTC ISO 时间串 → 本地日期 YYYY-MM-DD(与习惯打卡的本地口径一致) */
const localDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : todayStr(d)
}

function buildStats(data: AppData, week: WeekRange) {
  const inWeek = (date: string) => date >= week.start && date <= week.end
  const today = todayStr()
  // 习惯:本周每天的打卡情况
  const habitRows = data.habits.map((h) => ({
    id: h.id,
    name: h.name,
    marks: week.days.map((d) => !!h.records[d]),
    count: week.days.filter((d) => h.records[d]).length,
  }))
  const habitDone = habitRows.reduce((s, h) => s + h.count, 0)
  const habitTotal = data.habits.length * 7
  // 按日聚合打卡次数,画周分布柱状图
  const habitPerDay = week.days.map((d) => data.habits.filter((h) => h.records[d]).length)
  const habitDays = habitPerDay.filter((n) => n > 0).length
  // 待办:完成按 completedAt 归周,新建按 createdAt 归周
  const doneWeek = data.todos
    .filter((t) => t.done && t.completedAt && inWeek(localDate(t.completedAt)))
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
  const createdWeek = data.todos.filter((t) => inWeek(localDate(t.createdAt)))
  const overdue = data.todos.filter((t) => !t.done && t.dueDate && t.dueDate < today)
  return { today, habitRows, habitDone, habitTotal, habitPerDay, habitDays, doneWeek, createdWeek, overdue }
}

export default function ReportPanel({ data, update }: { data: AppData; update: UpdateFn }) {
  const [offset, setOffset] = useState(0)
  const week = useMemo(() => weekRange(offset), [offset])
  const stats = useMemo(() => buildStats(data, week), [data, week])
  // 环比:上一周的同期统计(周报的核心问题「比起上周怎么样」)
  const lastStats = useMemo(() => buildStats(data, weekRange(offset - 1)), [data, offset])
  const [cfg, setCfg] = useState<AiConfigInfo | null>(null)
  const [comment, setComment] = useState('')
  const [copied, setCopied] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  // 周报在 reports 集合里以 ISO 周键存取;点评随 GenReport 落库,刷新/切周不丢
  const weekKey = useMemo(() => isoWeekKey(week.start), [week])
  const savedComment = useMemo(
    () => data.reports.find((r) => r.kind === 'weekly' && r.id === weekKey)?.comment ?? '',
    [data.reports, weekKey],
  )

  useEffect(() => {
    loadAiConfig()
      .then(setCfg)
      .catch(() => setCfg(null))
  }, [])

  // 切周(或周报数据变化)时,从已落库的点评恢复
  useEffect(() => {
    setComment(savedComment)
    setAiError('')
  }, [savedComment])

  const configured = !!cfg && !!cfg.baseUrl && !!cfg.model && cfg.hasKey

  // 环比标记:与上一周同期比;上周无记录时如实说明,持平灰、向好绿、变差红
  // (逾期卡反转:减少是好事)。上周值可以从任何周看
  const deltaChip = (cur: number, prev: number, invert = false) => {
    if (prev === 0) return <i className="rdelta na">上周无记录</i>
    const d = cur - prev
    if (d === 0) return <i className="rdelta flat">较上周持平</i>
    const good = invert ? d < 0 : d > 0
    return (
      <i className={`rdelta ${good ? 'good' : 'bad'}`}>
        {d > 0 ? '↑' : '↓'} 较上周 {d > 0 ? `+${d}` : d}
      </i>
    )
  }

  // 空周语境:本周(且正在看本周)三样全零时给一句动态引导,周末顺手递上上周
  const weekAllEmpty =
    stats.doneWeek.length === 0 && stats.createdWeek.length === 0 && stats.habitDone === 0
  const dow = new Date().getDay() // 0 = 周日
  const lateWeek = dow === 0 || dow >= 4 // 周四五六十日算「后半程」
  const lastWeekHasData = lastStats.doneWeek.length > 0 || lastStats.habitDone > 0

  const copyComment = async () => {
    try {
      await navigator.clipboard.writeText(comment)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用(非安全上下文等):静默,按钮保持原样
    }
  }

  const genComment = async () => {
    setAiBusy(true)
    setAiError('')
    try {
      const lines = [
        `- 待办:本周完成 ${stats.doneWeek.length} 条,新建 ${stats.createdWeek.length} 条,当前逾期 ${stats.overdue.length} 条${
          stats.overdue.length ? `(逾期项:${stats.overdue.slice(0, 5).map((t) => t.title).join('、')})` : ''
        }`,
        stats.habitRows.length
          ? `- 习惯打卡:共 ${stats.habitDone}/${stats.habitTotal} 次,按日分布(周一~周日)为 ${stats.habitPerDay.join(', ')} 次,明细:${stats.habitRows.map((h) => `${h.name} ${h.count}/7`).join('、')}`
          : '- 习惯打卡:还没有创建习惯',
      ]
      const res = await aiChat({
        messages: buildReportMessages({ label: week.label, start: week.start, end: week.end, lines }),
      })
      const text = res.message?.content?.trim()
      if (!text) throw new Error('AI 没有返回内容')
      setComment(text)
      // 点评写回对应周报;该周还没有周报 GenReport 时无处可写,保持会话内展示
      update('reports', (items) =>
        items.map((r) => (r.kind === 'weekly' && r.id === weekKey ? { ...r, comment: text } : r)),
      )
    } catch (err) {
      setAiError((err as Error)?.message || '请求失败,请重试')
    } finally {
      setAiBusy(false)
    }
  }

  const maxCount = Math.max(...stats.habitPerDay, 1)
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

      {offset === 0 && weekAllEmpty && (
        <div className="report-context">
          <p>{lateWeek ? '这周快结束了,还没有留下记录' : '新的一周刚开始,完成第一件小事就会出现这里'}</p>
          {lateWeek && lastWeekHasData && (
            <button className="btn ghost report-context-btn" onClick={() => setOffset(-1)}>
              看上周(完成 {lastStats.doneWeek.length} · 打卡 {lastStats.habitDone})
            </button>
          )}
        </div>
      )}

      <div className="report-stats">
        <div className="rstat">
          <b>
            {stats.doneWeek.length}
            <em>/ {stats.createdWeek.length}</em>
          </b>
          <span>完成 / 新建待办</span>
          {deltaChip(stats.doneWeek.length, lastStats.doneWeek.length)}
        </div>
        <div className="rstat">
          <b>
            {stats.habitDone}
            <em>/ {stats.habitTotal}</em>
          </b>
          <span>习惯打卡</span>
          {deltaChip(stats.habitDone, lastStats.habitDone)}
        </div>
        <div className={`rstat ${stats.overdue.length > 0 ? 'warn' : ''}`}>
          <b>{stats.overdue.length}</b>
          <span>逾期待办</span>
          {deltaChip(stats.overdue.length, lastStats.overdue.length, true)}
        </div>
      </div>

      <section className="rsec">
        <h3 className="rsec-title">
          习惯打卡分布<span className="rsec-sub">次数 / 天 · {stats.habitDays} 天有记录</span>
        </h3>
        {/* 图表恒渲染:全零时就是 7 根 3px 灰柱,比「没有记录」一句话更有骨架感 */}
        <div className="report-chart">
          {stats.habitPerDay.map((n, i) => (
            <div key={i} className="rcol">
              {n > 0 && <span className="rval">{n}</span>}
              <div
                className={`rbar ${n === 0 ? 'zero' : ''} ${week.days[i] === stats.today ? 'today' : ''}`}
                style={{ height: `${Math.max(Math.round((n / maxCount) * 88), 3)}px` }}
                title={`${week.days[i]}(周${WEEK_LABELS[i]})打卡 ${n} 次`}
              />
              <span className="rlab">{WEEK_LABELS[i]}</span>
            </div>
          ))}
        </div>
        {stats.habitDone === 0 && (
          <div className="empty-hint">这一周没有打卡记录,去「习惯」页打卡后,这里会出现周分布柱状图</div>
        )}
      </section>

      <section className="rsec">
        <h3 className="rsec-title">
          待办
          {stats.overdue.length > 0 && <span className="rsec-warn">{stats.overdue.length} 条逾期</span>}
        </h3>
        {/* 逾期清单:卡上只有数字,逾期了什么要一眼可见(≤5 条,含截止日) */}
        {stats.overdue.length > 0 && (
          <div className="roverdue">
            {stats.overdue.slice(0, 5).map((t) => (
              <div key={t.id} className="roverdue-row">
                <span className="roverdue-title" title={t.title}>
                  {t.title}
                </span>
                <span className="roverdue-due">截止 {t.dueDate!.slice(5, 10).replace('-', '/')}</span>
              </div>
            ))}
            {stats.overdue.length > 5 && (
              <div className="rmore">…以及另外 {stats.overdue.length - 5} 条逾期</div>
            )}
          </div>
        )}
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
            <div key={h.id} className={`rhabit${h.count === 0 ? ' zero' : ''}`}>
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
            <div className="report-ai-actions">
              <button className="btn ghost report-ai-btn" onClick={genComment} disabled={!configured}>
                重新生成
              </button>
              <button className="btn ghost report-ai-btn" onClick={copyComment}>
                {copied ? '已复制 ✓' : '复制点评'}
              </button>
            </div>
          </>
        ) : configured ? (
          <button className="btn solid report-ai-btn" onClick={genComment}>
            让 AI 点评{week.label}
          </button>
        ) : (
          <div className="empty-hint">在「Miku」页设置 AI 服务(接口地址 + 模型 + 密钥)后,可让 AI 点评{week.label}</div>
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
