import { useMemo, useState } from 'react'
import type { Habit, PomodoroSession } from '../types'

interface Props {
  pomodoros: PomodoroSession[]
  habits: Habit[]
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // 周一开头

interface DayStat {
  minutes: number
  habits: number
}

// 活跃度 = 专注分钟 + 打卡次数 ×10,映射为 0~4 五档热力
function levelOf(s?: DayStat): number {
  if (!s) return 0
  const score = s.minutes + s.habits * 10
  if (score >= 131) return 4
  if (score >= 71) return 3
  if (score >= 31) return 2
  return 1
}

export default function CalendarPanel({ pomodoros, habits }: Props) {
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })

  // 每天的专注分钟与打卡次数
  const dayStats = useMemo(() => {
    const map = new Map<string, DayStat>()
    for (const p of pomodoros) {
      const s = map.get(p.date) ?? { minutes: 0, habits: 0 }
      s.minutes += p.minutes
      map.set(p.date, s)
    }
    for (const h of habits) {
      for (const day of Object.keys(h.records)) {
        const s = map.get(day) ?? { minutes: 0, habits: 0 }
        s.habits += 1
        map.set(day, s)
      }
    }
    return map
  }, [pomodoros, habits])

  const { cells, todayKey } = useMemo(() => {
    const { year, month } = cursor
    const first = new Date(year, month, 1)
    const leading = (first.getDay() + 6) % 7 // 周一为第 0 列
    const dayCount = new Date(year, month + 1, 0).getDate()
    const list: (number | null)[] = Array.from({ length: leading }, () => null)
    for (let d = 1; d <= dayCount; d++) list.push(d)
    while (list.length % 7 !== 0) list.push(null)
    const t = new Date()
    return {
      cells: list,
      todayKey: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
    }
  }, [cursor])

  const move = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })

  return (
    <div className="panel panel-cal">
      <header className="p-head">
        <h2>
          <span className="tag">CAL</span>
          <i>/</i>日历
        </h2>
        <div className="cal-nav">
          <button className="cal-btn" onClick={() => move(-1)} title="上个月">
            ‹
          </button>
          <span className="p-meta">
            {cursor.year} 年 {cursor.month + 1} 月
          </span>
          <button className="cal-btn" onClick={() => move(1)} title="下个月">
            ›
          </button>
        </div>
      </header>

      <div className="wd-row">
        {WEEKDAYS.map((w) => (
          <span key={w} className="wd">
            {w}
          </span>
        ))}
      </div>

      <div className="cal-grid">
        {cells.map((d, i) => {
          if (d === null) return <span key={i} className="day off" />
          const key = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          const stat = dayStats.get(key)
          const lv = levelOf(stat)
          const isToday = key === todayKey
          const tip = stat
            ? `${key} · 专注 ${stat.minutes} 分钟 · 习惯打卡 ${stat.habits} 次`
            : `${key} · 无记录`
          return (
            <span key={i} className={`day l${lv} ${isToday ? 'today' : ''}`} title={tip}>
              <span className="num">{d}</span>
            </span>
          )
        })}
      </div>

      <div className="legend">
        <span>少</span>
        <span className="heat-scale">
          {[1, 2, 3, 4].map((l) => (
            <i key={l} className={`heat l${l}`} />
          ))}
        </span>
        <span>多</span>
        <span className="legend-hint">专注时长 + 习惯打卡</span>
      </div>
    </div>
  )
}
