import { useEffect, useMemo, useRef, useState } from 'react'
import type { Habit } from '../types'
import type { UpdateFn } from '../App'
import { streak, todayStr } from '../api'
import { celebrateMiku } from './MikuStage'

interface Props {
  habit: Habit
  update: UpdateFn
  onClose: () => void
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // 周一开头

export default function HabitDetailCard({ habit, update, onClose }: Props) {
  const [draft, setDraft] = useState(habit.name)
  const nameRef = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(() => {
    const t = new Date()
    return { year: t.getFullYear(), month: t.getMonth() }
  })
  const today = todayStr()

  // 名称超出输入框宽度时缓慢向右滑动(跑马灯):到结尾停顿约 1.2s → 回到开头停顿约 0.7s → 循环,
  // 放得下则不动;聚焦编辑时完全交给浏览器按光标滚动,失焦自动恢复
  useEffect(() => {
    const el = nameRef.current
    if (!el) return
    const SPEED = 70 // px/s
    let raf = 0
    let last = performance.now()
    let phase: 'run' | 'holdEnd' | 'holdStart' = 'run'
    let phaseUntil = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const max = el.scrollWidth - el.clientWidth
      // 编辑中不抢光标;放得下就归零静止
      if (document.activeElement === el || max <= 0) {
        last = now
        if (max <= 0) el.scrollLeft = 0
        return
      }
      const dt = Math.min(now - last, 100) / 1000
      last = now
      if (phase === 'run') {
        const next = el.scrollLeft + SPEED * dt
        if (next >= max) {
          el.scrollLeft = max
          phase = 'holdEnd'
          phaseUntil = now + 1200
        } else {
          el.scrollLeft = next
        }
        return
      }
      if (now < phaseUntil) return
      if (phase === 'holdEnd') {
        el.scrollLeft = 0
        phase = 'holdStart'
        phaseUntil = now + 700
      } else {
        phase = 'run'
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = (fn: (h: Habit) => Habit) =>
    update('habits', (items) => items.map((h) => (h.id === habit.id ? fn(h) : h)))

  const setRecord = (day: string) => {
    // 打卡今天时让 Miku 庆祝一下(取消/补历史日期不庆祝)
    if (day === today && !habit.records[day]) celebrateMiku()
    patch((h) => {
      const records = { ...h.records }
      if (records[day]) delete records[day]
      else records[day] = true
      return { ...h, records }
    })
  }

  const rename = () => {
    const n = draft.trim()
    if (!n) {
      setDraft(habit.name)
      return
    }
    if (n !== habit.name) patch((h) => ({ ...h, name: n }))
  }

  // 近 30 天完成率
  const rate = useMemo(() => {
    let hit = 0
    for (let i = 0; i < 30; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      if (habit.records[todayStr(d)]) hit++
    }
    return Math.round((hit / 30) * 100)
  }, [habit.records])

  const total = Object.keys(habit.records).length

  const { cells } = useMemo(() => {
    const { year, month } = cursor
    const first = new Date(year, month, 1)
    const leading = (first.getDay() + 6) % 7 // 周一为第 0 列
    const dayCount = new Date(year, month + 1, 0).getDate()
    const list: (number | null)[] = Array.from({ length: leading }, () => null)
    for (let d = 1; d <= dayCount; d++) list.push(d)
    while (list.length % 7 !== 0) list.push(null)
    return { cells: list }
  }, [cursor])

  const move = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })

  const del = () => {
    update('habits', (items) => items.filter((h) => h.id !== habit.id))
    onClose()
  }

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="hb-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="p-head">
          <h2>
            <span className="tag">HABIT</span>
            <i>/</i>习惯详情
          </h2>
          <span className="p-meta">创建于 {habit.createdAt.slice(0, 10)}</span>
        </header>

        <input
          ref={nameRef}
          className="hb-name-edit"
          value={draft}
          placeholder="习惯名称"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />

        <div className="hb-stats">
          <div className="hb-stat">
            <b>{streak(habit.records)}</b>
            <span>连续天数</span>
          </div>
          <div className="hb-stat">
            <b>{total}</b>
            <span>累计打卡</span>
          </div>
          <div className="hb-stat">
            <b>{rate}%</b>
            <span>近 30 天</span>
          </div>
        </div>

        <div className="hb-cal-head">
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

        <div className="hb-wd-row">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>

        <div className="hb-cal">
          {cells.map((d, i) => {
            if (d === null) return <span key={i} />
            const key = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            const future = key > today
            const on = !!habit.records[key]
            return (
              <button
                key={i}
                className={`hb-day ${on ? 'on' : ''} ${key === today ? 'today' : ''}`}
                disabled={future}
                title={future ? key : `${key} · ${on ? '已打卡,点击取消' : '未打卡,点击补卡'}`}
                onClick={() => setRecord(key)}
              >
                {d}
              </button>
            )
          })}
        </div>

        <footer className="hb-foot">
          <button className="btn ghost danger" onClick={del}>
            删除习惯
          </button>
          <button className="btn solid" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  )
}
