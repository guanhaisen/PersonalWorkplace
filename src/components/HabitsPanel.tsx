import { useEffect, useMemo, useRef, useState } from 'react'
import type { Habit } from '../types'
import { streak, todayStr, uid } from '../api'
import type { UpdateFn } from '../App'
import { IconCheck } from './icons'
import HabitDetailCard from './HabitDetailCard'
import { celebrateMiku } from './MikuStage'

interface Props {
  habits: Habit[]
  update: UpdateFn
}

// 名称最多两行,溢出时加渐隐遮罩暗示内容未完(全文见悬停提示与详情卡);不溢出则不加,避免短名被误遮
function ClampedName({ text, onOpen }: { text: string; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [clamped, setClamped] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  return (
    <button
      ref={ref}
      className={`name ${clamped ? 'clamped' : ''}`}
      title={`${text} · 点击查看详情`}
      onClick={onOpen}
    >
      {text}
    </button>
  )
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function HabitsPanel({ habits, update }: Props) {
  const [name, setName] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

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
  const openHabit = habits.find((h) => h.id === openId)

  const add = () => {
    const n = name.trim()
    if (!n) return
    const habit: Habit = { id: uid(), name: n, createdAt: new Date().toISOString(), records: {} }
    update('habits', (items) => [...items, habit])
    setName('')
  }

  const toggle = (habitId: string, day: string) => {
    // 打卡今天时让 Miku 庆祝一下(取消/补历史日期不庆祝)
    const habit = habits.find((x) => x.id === habitId)
    if (habit && day === today && !habit.records[day]) celebrateMiku()
    update('habits', (items) =>
      items.map((h) => {
        if (h.id !== habitId) return h
        const records = { ...h.records }
        if (records[day]) delete records[day]
        else records[day] = true
        return { ...h, records }
      }),
    )
  }

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

      <div className="habit-list">
        {/* 表头放进滚动容器并吸顶:与条目行共用同一宽度,有滚动条也对齐 */}
        <div className="habit-grid habit-head">
          <span className="hlabel">今</span>
          {/* 占住名称列,让星期标签与下方圆点列一一对齐 */}
          <span aria-hidden />
          {last7.map((d) => (
            <span key={d.date} className={`hd ${d.date === today ? 'today' : ''}`}>
              {d.label}
            </span>
          ))}
          <span className="hs">连续</span>
        </div>

        {habits.map((h) => {
          const s = streak(h.records)
          const doneToday = !!h.records[today]
          return (
            <div key={h.id} className="habit-line">
              <button
                className={`today-cb ${doneToday ? 'on' : ''}`}
                title={doneToday ? '取消今天打卡' : '打卡今天'}
                onClick={() => toggle(h.id, today)}
              >
                {doneToday && <IconCheck />}
              </button>
              <ClampedName text={h.name} onOpen={() => setOpenId(h.id)} />
              {last7.map((d) => (
                <button
                  key={d.date}
                  className={`dot-cell ${h.records[d.date] ? (d.date === today ? 'on now' : 'on') : d.date === today ? 'today' : ''}`}
                  title={d.date === today ? '今天' : d.date}
                  onClick={() => toggle(h.id, d.date)}
                />
              ))}
              <span className="streak">{s > 0 ? <><b>{s}</b> 天</> : '—'}</span>
              <button className="habit-del" title="删除" onClick={() => remove(h.id)}>
                ✕
              </button>
            </div>
          )
        })}
        {habits.length === 0 && (
          <div className="empty-hint">还没有习惯,添加一个开始打卡,比如「读书 30 分钟」。</div>
        )}
      </div>

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

      {openHabit && (
        <HabitDetailCard
          key={openHabit.id}
          habit={openHabit}
          update={update}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
