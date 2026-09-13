import { useMemo, useState } from 'react'
import type { Habit } from '../types'
import { todayStr, uid } from '../api'
import type { UpdateFn } from '../App'

interface Props {
  habits: Habit[]
  update: UpdateFn
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// 连续天数:从今天(或今天未打卡时从昨天)往前数
function streak(records: Record<string, true>): number {
  let n = 0
  const d = new Date()
  if (!records[todayStr(d)]) d.setDate(d.getDate() - 1)
  while (records[todayStr(d)]) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

export default function HabitsPanel({ habits, update }: Props) {
  const [name, setName] = useState('')

  // 最近 7 天(含今天)的日期与星期标签
  const last7 = useMemo(() => {
    const days: { date: string; label: string }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      days.push({ date: todayStr(d), label: WEEKDAYS[d.getDay()] })
    }
    return days
  }, [])

  const today = todayStr()

  const add = () => {
    const n = name.trim()
    if (!n) return
    const habit: Habit = { id: uid(), name: n, createdAt: new Date().toISOString(), records: {} }
    update('habits', (items) => [...items, habit])
    setName('')
  }

  const toggle = (habitId: string, day: string) =>
    update('habits', (items) =>
      items.map((h) => {
        if (h.id !== habitId) return h
        const records = { ...h.records }
        if (records[day]) delete records[day]
        else records[day] = true
        return { ...h, records }
      }),
    )

  const remove = (id: string) => update('habits', (items) => items.filter((h) => h.id !== id))

  return (
    <div className="panel panel-habits">
      <header className="p-head">
        <h2>
          <span className="tag">HABITS</span>
          <i>/</i>习惯打卡
        </h2>
        <span className="p-meta">最近 7 天</span>
      </header>

      <div className="dots-h">
        {last7.map((d) => (
          <span key={d.date} className={d.date === today ? 'today' : ''}>
            {d.label}
          </span>
        ))}
        <span className="dots-h-pad" />
      </div>

      {habits.map((h) => (
        <div key={h.id} className="hab">
          <div className="hab-l">
            <div className="hab-top">
              <span className="name" title={h.name}>
                {h.name}
              </span>
              <span className="streak">
                连续 <b>🔥{streak(h.records)}</b>
              </span>
            </div>
            <div className="dots">
              {last7.map((d) => (
                <button
                  key={d.date}
                  className={`dot-cell ${h.records[d.date] ? (d.date === today ? 'on now' : 'on') : d.date === today ? 'today' : ''}`}
                  title={d.date === today ? '今天' : d.date}
                  onClick={() => toggle(h.id, d.date)}
                />
              ))}
              <span className="dots-pad">
                <button className="icon-btn del" title="删除" onClick={() => remove(h.id)}>
                  ✕
                </button>
              </span>
            </div>
          </div>
        </div>
      ))}

      {habits.length === 0 && (
        <div className="empty-hint">还没有习惯,添加一个开始打卡,比如「读书 30 分钟」。</div>
      )}

      <div className="add-sm">
        <input
          className="in"
          value={name}
          placeholder="新习惯"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn solid" onClick={add}>
          添加
        </button>
      </div>
    </div>
  )
}
