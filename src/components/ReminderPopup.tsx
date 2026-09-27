import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppData } from '../types'
import type { UpdateFn } from '../App'
import { formatLocal, nowLocalStr, todayStr } from '../api'
import { fetchAiBriefing, loadAiConfig, type AiConfigInfo } from '../ai'
import { IconAi } from './icons'

interface Props {
  data: AppData
  update: UpdateFn
}

type Pos = { right: number; bottom: number }

const GAP = 12
const BRIEFING_GAP_MS = 60 * 60 * 1000 // 巡查间隔:每小时;打开应用后先查一次
const BRIEFING_SNOOZE_MS = 10 * 60 * 1000 // 「稍后」:10 分钟后重新浮现

// 弹窗锚定 AI 悬浮球上方(与聊天窗同款锚定思路);悬浮球不在 DOM(Miku 页)时退到右下角。
// 用 bottom 锚定,内容变多时弹窗自动向上生长,不会盖住悬浮球。
function anchorToFab(): Pos {
  const fab = document.querySelector<HTMLElement>('.ai-fab')
  if (!fab) return { right: 30, bottom: 30 }
  const r = fab.getBoundingClientRect()
  return {
    right: Math.max(window.innerWidth - r.right, 8),
    bottom: Math.max(window.innerHeight - r.top + GAP, 8),
  }
}

// 系统通知只在页面打开期间到点时发;补弹的「错过」提醒只用应用内弹窗
function notifySystem(r: { id: string; title: string }) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const n = new Notification('个人工作台 · 提醒', { body: r.title, tag: r.id })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // 通知构造失败不影响应用内弹窗
  }
}

export default function ReminderPopup({ data, update }: Props) {
  const [pos, setPos] = useState<Pos | null>(null)
  const [tick, setTick] = useState(0)
  // 系统通知授权状态;'default' 时在弹窗里提供授权入口(浏览器要求用户手势)
  const [notif, setNotif] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  // AI 巡查:本会话的巡查结果、已知道了的行(会话内去重)、稍后期限、AI 配置
  const [briefing, setBriefing] = useState<string[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [snoozeUntil, setSnoozeUntil] = useState(0)
  const [aiCfg, setAiCfg] = useState<AiConfigInfo | null>(null)
  // 挂载时刻:早于它的到期提醒视为应用关闭期间错过,只走应用内弹窗
  const mountStr = useRef(nowLocalStr())
  // 已发过系统通知的 id,防止周期扫描重复发
  const notifiedRef = useRef<Set<string>>(new Set())
  const lastCheckRef = useRef(0)
  const checkingRef = useRef(false)
  const dismissedRef = useRef(dismissed)
  dismissedRef.current = dismissed
  const dataRef = useRef(data)
  dataRef.current = data

  // 到期 = 还没触发过且时间已到;dueAt 与 nowLocalStr 同格式,字符串比较即可
  const due = useMemo(
    () => (data.reminders ?? []).filter((r) => !r.firedAt && r.dueAt <= nowLocalStr()),
    [data.reminders, tick],
  )
  const briefingSnoozed = Date.now() < snoozeUntil
  const visibleBriefing = useMemo(
    () => (briefingSnoozed ? [] : briefing.filter((l) => !dismissed.has(l))),
    // tick 参与依赖:30s 扫描让「稍后」期满后自动重新浮现
    [briefing, dismissed, briefingSnoozed, tick],
  )

  // 周期扫描到点;页面重新可见 / 窗口聚焦时立即补扫,覆盖后台标签页被节流的情况
  useEffect(() => {
    const rescan = () => setTick((t) => t + 1)
    const timer = setInterval(rescan, 30_000)
    document.addEventListener('visibilitychange', rescan)
    window.addEventListener('focus', rescan)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', rescan)
      window.removeEventListener('focus', rescan)
    }
  }, [])

  // AI 主动巡查:打开应用后先查一次,之后每小时一次;页面在后台时跳过,回前台由补扫触发
  const maybeBriefing = useCallback(async () => {
    if (document.hidden || checkingRef.current) return
    if (Date.now() - lastCheckRef.current < BRIEFING_GAP_MS) return
    checkingRef.current = true
    lastCheckRef.current = Date.now()
    try {
      const cfg = await loadAiConfig()
      setAiCfg(cfg)
      if (!cfg.baseUrl || !cfg.model || !cfg.hasKey) return
      const lines = await fetchAiBriefing(dataRef.current)
      const fresh = lines.filter((l) => !dismissedRef.current.has(l))
      // 全部都是已知道过的旧内容时不重新弹;否则替换为最新一批
      if (fresh.length > 0) setBriefing(fresh)
    } catch {
      // 巡查失败保持安静(定时提醒不受影响),下个周期再试
    } finally {
      checkingRef.current = false
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void maybeBriefing(), 1500)
    return () => clearTimeout(t)
  }, [maybeBriefing])

  useEffect(() => {
    for (const r of due) {
      if (notifiedRef.current.has(r.id)) continue
      notifiedRef.current.add(r.id)
      if (r.dueAt >= mountStr.current) notifySystem(r)
    }
  }, [due])

  // 弹出时锚定悬浮球一次;之后内容增减不跳位
  useEffect(() => {
    const count = due.length + visibleBriefing.length
    setPos((p) => (count > 0 ? (p ?? anchorToFab()) : null))
  }, [due.length, visibleBriefing.length])

  // 窗口尺寸变化时重新锚定;悬浮球被拖动不影响已弹出的位置
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? anchorToFab() : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 30s 扫描里顺带判断是否该做下一轮巡查(内部按一小时节流)
  useEffect(() => {
    void maybeBriefing()
  }, [tick, maybeBriefing])

  const ack = (ids: Set<string>) => {
    const iso = new Date().toISOString()
    update('reminders', (items) => items.map((r) => (ids.has(r.id) ? { ...r, firedAt: iso } : r)))
  }

  const dismissLine = (line: string) =>
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(line)
      return next
    })

  const askNotify = async () => {
    if (typeof Notification === 'undefined') return
    try {
      setNotif(await Notification.requestPermission())
    } catch {
      // 老浏览器回调式 API 或用户关闭弹窗,保持原状态
      setNotif(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    }
  }

  const snoozeReminders = () => {
    const ids = new Set(due.map((r) => r.id))
    update('reminders', (items) =>
      items.map((r) => {
        if (!ids.has(r.id)) return r
        const t = new Date(r.dueAt.replace(' ', 'T'))
        t.setMinutes(t.getMinutes() + 10)
        return { ...r, dueAt: formatLocal(t) }
      }),
    )
  }

  if (due.length === 0 && visibleBriefing.length === 0) return null

  const label = (r: { dueAt: string }) => {
    const time = r.dueAt.split(' ')[1]
    if (r.dueAt < mountStr.current) {
      const date = r.dueAt.split(' ')[0]
      return date === todayStr() ? `错过 · ${time}` : `错过 · ${r.dueAt}`
    }
    return `到点 · ${time}`
  }

  const aiConfigured = !!aiCfg && !!aiCfg.baseUrl && !!aiCfg.model && aiCfg.hasKey
  const totalCount = due.length + visibleBriefing.length

  return (
    <div className="rem-pop" style={pos ?? undefined} role="alert">
      <header className="rem-pop-head">
        <span className="rem-pop-badge">
          <IconAi />
        </span>
        <b>AI 提醒</b>
        {totalCount > 1 && <span className="rem-pop-count">{totalCount}</span>}
      </header>
      <div className="rem-pop-list">
        {due.map((r) => (
          <div key={r.id} className="rem-pop-item">
            <div className="rem-pop-row">
              <span className={`rem-pop-time ${r.dueAt < mountStr.current ? 'missed' : ''}`}>{label(r)}</span>
              <button className="rem-pop-ack" onClick={() => ack(new Set([r.id]))}>
                知道了
              </button>
            </div>
            <p>{r.title}</p>
          </div>
        ))}
        {visibleBriefing.map((line) => (
          <div key={line} className="rem-pop-item">
            <div className="rem-pop-row">
              <span className="rem-pop-time ai">AI 巡查</span>
              <button className="rem-pop-ack" onClick={() => dismissLine(line)}>
                知道了
              </button>
            </div>
            <p>{line}</p>
          </div>
        ))}
      </div>
      <footer className="rem-pop-foot">
        <span className="rem-pop-foot-left">
          {notif === 'default' && (
            <button className="rem-pop-notify" onClick={askNotify} title="授权后到点同时弹系统通知">
              开启系统通知
            </button>
          )}
          {aiCfg && !aiConfigured && (
            <span className="rem-pop-hint" title="在 Miku 的设置里填好接口与 Key">
              配置 AI 后可自动巡查待办 · 习惯 · 课表
            </span>
          )}
        </span>
        <button
          className="btn ghost"
          onClick={() => {
            if (due.length > 0) snoozeReminders()
            if (visibleBriefing.length > 0) setSnoozeUntil(Date.now() + BRIEFING_SNOOZE_MS)
          }}
        >
          稍后 10 分钟
        </button>
        {totalCount > 1 && (
          <button
            className="btn solid"
            onClick={() => {
              ack(new Set(due.map((r) => r.id)))
              visibleBriefing.forEach(dismissLine)
            }}
          >
            全部知道了
          </button>
        )}
      </footer>
    </div>
  )
}
