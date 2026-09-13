import { useMemo, useState } from 'react'
import type { Habit, PomodoroSession } from '../types'

interface Props {
  pomodoros: PomodoroSession[]
  habits: Habit[]
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // 周一开头

export default function CalendarPanel({ pomodoros, habits }: Props) {
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })

  const pomDays = useMemo(() => new Set(pomodoros.map((p) => p.date)), [pomodoros])

  // 所有习惯都打卡的日期
  const allDoneDays = useMemo(() => {
    const full = new Set<string>()
    if (habits.length === 0) return full
    const days = new Set<string>()
    for (const h of habits) for (const day of Object.keys(h.records)) days.add(day)
    for (const day of days) if (habits.every((h) => h.records[day])) full.add(day)
    return full
  }, [habits])

  const { cells, todayStr } = useMemo(() => {
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
      todayStr: `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`,
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
          const dateStr = `${cursor.year}-${cursor.month}-${d}`
          const isToday = dateStr === todayStr
          const key = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          return (
            <span key={i} className={`day ${isToday ? 'today' : ''}`}>
              <span className="num">{d}</span>
              <span className="marks">
                {pomDays.has(key) && <i className="b" title="有完成的番茄" />}
                {allDoneDays.has(key) && <i className="g" title="习惯全部打卡" />}
              </span>
            </span>
          )
        })}
      </div>

      <div className="legend">
        <span>
          <i className="b" /> 番茄
        </span>
        <span>
          <i className="g" /> 习惯全勤
        </span>
      </div>
    </div>
  )
}
