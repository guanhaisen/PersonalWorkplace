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

// 空状态模板:一键添加常见习惯,降低起步成本
const PRESETS = ['读书 30 分钟', '每天喝 1L 水', '运动 20 分钟', '背 15 分钟单词', '早睡']

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
  // 删除二次确认:第一击只武装成「确认删除?」(2.5s 不点自动复位),再击真删;
  // 删除后整包快照进撤销条——习惯带着全部打卡历史,误删必须能后悔
  const [delArmId, setDelArmId] = useState<string | null>(null)
  const delArmTimer = useRef<number | null>(null)
  // 撤销:操作前整包快照,5s 内可一键还原(单槽,新操作顶掉旧的)
  const [undo, setUndo] = useState<{ id: number; label: string; snapshot: Habit[] } | null>(null)
  const undoTimer = useRef<number | null>(null)

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
  const doneTodayCount = habits.filter((h) => h.records[today]).length
  const pendingToday = habits.length - doneTodayCount

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      if (delArmTimer.current !== null) window.clearTimeout(delArmTimer.current)
    },
    [],
  )

  const pushUndo = (label: string) => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    setUndo({ id: Date.now(), label, snapshot: habits })
    undoTimer.current = window.setTimeout(() => setUndo(null), 5000)
  }

  const applyUndo = () => {
    const u = undo
    if (!u) return
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    setUndo(null)
    update('habits', () => u.snapshot)
  }

  const disarmDel = () => {
    if (delArmTimer.current !== null) window.clearTimeout(delArmTimer.current)
    delArmTimer.current = null
    setDelArmId(null)
  }

  const onDelClick = (h: Habit) => {
    if (delArmId !== h.id) {
      if (delArmTimer.current !== null) window.clearTimeout(delArmTimer.current)
      setDelArmId(h.id)
      delArmTimer.current = window.setTimeout(() => setDelArmId(null), 2500)
      return
    }
    disarmDel()
    pushUndo(`已删除「${h.name}」`)
    update('habits', (items) => items.filter((x) => x.id !== h.id))
  }

  const addNamed = (n: string) => {
    const habit: Habit = { id: uid(), name: n, createdAt: new Date().toISOString(), records: {} }
    update('habits', (items) => [...items, habit])
  }

  const add = () => {
    const n = name.trim()
    if (!n) return
    addNamed(n)
    setName('')
    // 连续录入:输入框保持焦点
  }

  const toggle = (habitId: string, day: string) => {
    // 打卡今天时让 Miku 庆祝一下(取消/补历史日期不庆祝);label 供养成页气泡播报
    const habit = habits.find((x) => x.id === habitId)
    if (habit && day === today && !habit.records[day]) celebrateMiku(`「${habit.name}」`)
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

  // 一键全部打卡:今天还欠着的习惯一次勾完;不逐个惊动 Miku,只在全勤时庆祝一次
  const toggleAllToday = () => {
    if (pendingToday === 0) return
    celebrateMiku('全部习惯')
    update('habits', (items) =>
      items.map((h) => (h.records[today] ? h : { ...h, records: { ...h.records, [today]: true } })),
    )
  }

  return (
    <div className="panel panel-habits">
      <header className="p-head">
        <h2>
          <span className="tag">HABITS</span>
          <i>/</i>习惯打卡
        </h2>
        <span className="p-head-extra">
          {pendingToday > 0 && habits.length > 0 && (
            <button className="hab-all-cb" onClick={toggleAllToday} title="把今天还没打的全部勾上">
              一键全部打卡
            </button>
          )}
          <span className="p-meta">最近 7 天</span>
        </span>
      </header>

      {/* 添加表单上移到列表上方(高频动作不再隔半屏空白);移动端经 CSS order 压回
          列表后的拇指区,与待办页同款布局策略 */}
      <div className="add-sm">
        <input
          className="in"
          value={name}
          placeholder="新习惯,回车确认"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn solid" onClick={add}>
          添加
        </button>
      </div>

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
          const armed = delArmId === h.id
          return (
            <div key={h.id} className={`habit-line${doneToday ? ' done-today' : ''}`}>
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
              <button
                className={`habit-del${armed ? ' armed' : ''}`}
                title={armed ? '再点一次确认删除(含全部打卡记录)' : '删除'}
                onClick={() => onDelClick(h)}
              >
                {armed ? '确认删除?' : '✕'}
              </button>
            </div>
          )
        })}
        {habits.length === 0 && (
          <div className="empty-hint hab-empty">
            <span className="todo-empty-art" aria-hidden="true">
              ♪
            </span>
            <p className="todo-empty-main">还没有习惯,挑一个开始打卡吧</p>
            <div className="hab-presets">
              {PRESETS.map((p) => (
                <button key={p} className="hab-preset" onClick={() => addNamed(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {undo && (
        <div key={undo.id} className="todo-undo" role="status">
          <span className="todo-undo-text">{undo.label}</span>
          <button onClick={applyUndo}>撤销</button>
        </div>
      )}

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
