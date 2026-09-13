import { useEffect, useRef, useState } from 'react'
import type { PomodoroSession } from '../types'
import { todayStr, uid } from '../api'
import type { UpdateFn } from '../App'
import TickDial from './TickDial'

interface Props {
  pomodoros: PomodoroSession[]
  update: UpdateFn
}

const clampMinutes = (n: number) => Math.min(180, Math.max(1, Math.round(n) || 1))

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

// 计时状态持久化:刷新/误关标签页后可恢复倒计时
const TIMER_KEY = 'pomodoro.timer'

interface PersistedTimer {
  mode: 'focus' | 'break'
  running: boolean
  endAt?: number // running 时的结束时间戳
  secondsLeft: number // paused 时的剩余秒数
}

function saveTimer(s: PersistedTimer) {
  localStorage.setItem(TIMER_KEY, JSON.stringify(s))
}

function loadTimer(): PersistedTimer | null {
  try {
    const raw = localStorage.getItem(TIMER_KEY)
    return raw ? (JSON.parse(raw) as PersistedTimer) : null
  } catch {
    return null
  }
}

export default function PomodoroPanel({ pomodoros, update }: Props) {
  const [focusMin, setFocusMin] = useState(() => Number(localStorage.getItem('pomodoro.focus')) || 25)
  const [breakMin, setBreakMin] = useState(() => Number(localStorage.getItem('pomodoro.break')) || 5)
  const [mode, setMode] = useState<'focus' | 'break'>('focus')
  const [running, setRunning] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(25 * 60)

  const endAtRef = useRef(0)
  const completedRef = useRef(false)
  const audioRef = useRef<AudioContext | null>(null)
  const restoredRef = useRef(false)

  useEffect(() => localStorage.setItem('pomodoro.focus', String(focusMin)), [focusMin])
  useEffect(() => localStorage.setItem('pomodoro.break', String(breakMin)), [breakMin])

  // 挂载时恢复上次计时:running 则继续倒计时;离开期间已到点则补记一节
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const saved = loadTimer()
    if (!saved) return
    const focus = Number(localStorage.getItem('pomodoro.focus')) || 25
    if (saved.running && saved.endAt) {
      const left = Math.round((saved.endAt - Date.now()) / 1000)
      if (left > 0) {
        setMode(saved.mode)
        setSecondsLeft(left)
        endAtRef.current = saved.endAt
        completedRef.current = false
        setRunning(true)
        return
      }
      if (saved.mode === 'focus') {
        update('pomodoros', (items) => [
          ...items,
          { id: uid(), date: todayStr(), minutes: focus, completedAt: new Date().toISOString() },
        ])
      }
    }
    // 休息到点或暂停态:回到专注待开始
    setMode('focus')
    setSecondsLeft(focus * 60)
    completedRef.current = false
    setRunning(false)
    saveTimer({ mode: 'focus', running: false, secondsLeft: focus * 60 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 未运行时,模式或时长变化直接反映到表盘
  useEffect(() => {
    if (!running) {
      setSecondsLeft((mode === 'focus' ? focusMin : breakMin) * 60)
      completedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, focusMin, breakMin])

  const beep = () => {
    try {
      const ctx = audioRef.current
      if (!ctx) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.12, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2)
      osc.start()
      osc.stop(ctx.currentTime + 1.2)
    } catch {
      // 音频不可用就静默跳过
    }
  }

  const handleComplete = () => {
    beep()
    if (mode === 'focus') {
      const session: PomodoroSession = {
        id: uid(),
        date: todayStr(),
        minutes: focusMin,
        completedAt: new Date().toISOString(),
      }
      update('pomodoros', (items) => [...items, session])
      // 专注结束 → 自动进入休息并继续倒计时
      setMode('break')
      setSecondsLeft(breakMin * 60)
      completedRef.current = false
      endAtRef.current = Date.now() + breakMin * 60 * 1000
      setRunning(true)
      saveTimer({ mode: 'break', running: true, endAt: endAtRef.current, secondsLeft: breakMin * 60 })
    } else {
      // 休息结束 → 回到专注,等待手动开始
      setMode('focus')
      setSecondsLeft(focusMin * 60)
      completedRef.current = false
      setRunning(false)
      saveTimer({ mode: 'focus', running: false, secondsLeft: focusMin * 60 })
    }
  }

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      const left = Math.max(0, Math.round((endAtRef.current - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0 && !completedRef.current) {
        completedRef.current = true
        handleComplete()
      }
    }, 250)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  // 计时时把剩余时间放进标签页标题
  useEffect(() => {
    document.title = running ? `${fmt(secondsLeft)} ${mode === 'focus' ? '专注中' : '休息中'} · 个人工作台` : '个人工作台'
  }, [running, secondsLeft, mode])

  const start = () => {
    try {
      if (!audioRef.current) audioRef.current = new AudioContext()
      audioRef.current.resume().catch(() => {})
    } catch {
      // 忽略
    }
    endAtRef.current = Date.now() + secondsLeft * 1000
    completedRef.current = false
    setRunning(true)
    saveTimer({ mode, running: true, endAt: endAtRef.current, secondsLeft })
  }

  const pause = () => {
    setRunning(false)
    saveTimer({ mode, running: false, secondsLeft })
  }

  const reset = () => {
    setRunning(false)
    setMode('focus')
    setSecondsLeft(focusMin * 60)
    completedRef.current = false
    saveTimer({ mode: 'focus', running: false, secondsLeft: focusMin * 60 })
  }

  const total = (mode === 'focus' ? focusMin : breakMin) * 60
  const progress = total > 0 ? 1 - secondsLeft / total : 0

  const today = todayStr()
  const todaySessions = pomodoros.filter((p) => p.date === today)
  const todayMinutes = todaySessions.reduce((sum, p) => sum + p.minutes, 0)

  return (
    <div className="panel panel-pomo">
      <header className="p-head">
        <h2>
          <span className="tag">TIMER</span>
          <i>/</i>番茄钟
        </h2>
        <span className="badge">
          今日 {todaySessions.length} 个 · {todayMinutes} 分钟
        </span>
      </header>

      <div className="dial-wrap">
        <div className="dial">
          <TickDial progress={progress} />
          <div className="dial-center">
            <span className={`mode ${mode}`}>{mode === 'focus' ? '专注' : '休息'}</span>
            <span className="time">{fmt(secondsLeft)}</span>
          </div>
        </div>
      </div>

      <div className="t-controls">
        {running ? (
          <button className="btn solid" onClick={pause}>
            暂停
          </button>
        ) : (
          <button className="btn solid" onClick={start}>
            开始
          </button>
        )}
        <button className="btn ghost" onClick={reset}>
          重置
        </button>
      </div>

      <div className="pomo-steppers">
        <div className="step">
          <span className="lb">专注</span>
          <button className="stp" disabled={running} onClick={() => setFocusMin(clampMinutes(focusMin - 5))}>
            −
          </button>
          <b>{focusMin}</b>
          <button className="stp" disabled={running} onClick={() => setFocusMin(clampMinutes(focusMin + 5))}>
            +
          </button>
        </div>
        <div className="step">
          <span className="lb">休息</span>
          <button className="stp" disabled={running} onClick={() => setBreakMin(clampMinutes(breakMin - 5))}>
            −
          </button>
          <b>{breakMin}</b>
          <button className="stp" disabled={running} onClick={() => setBreakMin(clampMinutes(breakMin + 5))}>
            +
          </button>
        </div>
      </div>
    </div>
  )
}
