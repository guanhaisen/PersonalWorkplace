import { useMemo, useState } from 'react'
import type { Habit, Todo } from '../types'
import { TODO_DND_MIME } from '../api'
import type { UpdateFn } from '../App'
import { MIKU_NOD_EVENT } from './MikuStage'

interface Props {
  habits: Habit[]
  todos: Todo[]
  update: UpdateFn
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // 周一开头

// 活跃度 = 当天习惯打卡完成率,映射为 0~4 五档热力(无习惯时按打卡次数)
function levelOf(done: number, total: number): number {
  if (done <= 0) return 0
  if (total <= 0) return 2
  const ratio = done / total
  if (ratio >= 1) return 4
  if (ratio >= 0.75) return 3
  if (ratio >= 0.5) return 2
  return 1
}

export default function CalendarPanel({ habits, todos, update }: Props) {
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  // 从待办卡拖任务进来时悬停的日期格(高亮提示落点;仅桌面 HTML5 拖拽)
  const [dropDay, setDropDay] = useState<string | null>(null)

  // 每天的打卡习惯数
  const dayStats = useMemo(() => {
    const map = new Map<string, number>()
    for (const h of habits) {
      for (const day of Object.keys(h.records)) {
        map.set(day, (map.get(day) ?? 0) + 1)
      }
    }
    return map
  }, [habits])

  // 每天到期的未完成待办数(截止日圆点;已完成的无截止日概念,不计)
  const dueStats = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of todos) {
      if (t.done || !t.dueDate) continue
      map.set(t.dueDate, (map.get(t.dueDate) ?? 0) + 1)
    }
    return map
  }, [todos])

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

  // 接住从待办卡拖来的任务:设为该日截止日,Miku 点头示意(安排好了)
  const setDue = (key: string, e: React.DragEvent) => {
    const id = e.dataTransfer.getData(TODO_DND_MIME)
    setDropDay(null)
    if (!id) return
    const todo = todos.find((t) => t.id === id)
    if (!todo || todo.done || todo.dueDate === key) return
    update('todos', (items) => items.map((t) => (t.id === id ? { ...t, dueDate: key } : t)))
    window.dispatchEvent(new CustomEvent(MIKU_NOD_EVENT))
  }

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
          const done = dayStats.get(key) ?? 0
          const dueCount = dueStats.get(key) ?? 0
          const lv = levelOf(done, habits.length)
          const isToday = key === todayKey
          const tip = [
            done > 0 ? `${key} · 习惯打卡 ${done}/${habits.length}` : `${key} · 无记录`,
            dueCount > 0 ? `${dueCount} 个待办在这天截止` : '',
            '从待办卡拖任务到这里可设截止日',
          ]
            .filter(Boolean)
            .join('\n')
          return (
            <span
              key={i}
              className={`day l${lv} ${isToday ? 'today' : ''} ${dropDay === key ? 'drop-ok' : ''}`}
              title={tip}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TODO_DND_MIME)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropDay !== key) setDropDay(key)
              }}
              onDragLeave={(e) => {
                if (e.target === e.currentTarget && dropDay === key) setDropDay(null)
              }}
              onDrop={(e) => {
                if (dropDay === key) {
                  e.preventDefault()
                  setDue(key, e)
                }
              }}
            >
              <span className="num">{d}</span>
              {dueCount > 0 && <i className="due-dot" />}
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
        <span className="legend-hint">习惯打卡完成度</span>
      </div>
    </div>
  )
}
