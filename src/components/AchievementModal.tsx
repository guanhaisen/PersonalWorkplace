// 成就浮层 + 任务券徽章组件:方向 B「任务旅行券」(动森哩数票券迁移,定稿记录见
// miku-badges/direction-approved.md)。票券即徽章:米白票面 + 齿孔撕线 + 半圆打口,
// 图案为印章式单色 SVG;档位 = 票根 4 章位(实心绿章=已达成 / 朱红虚圈=下一枚 /
// 灰虚圈=未到)+ 票色 白→米→浅青→深青 双通道表达。数据来自 achievementView:
// 按当前互动计数实时推导档位,不依赖存档里固化的成就位阶,侧栏摘要/气泡也能复用。
import { useEffect } from 'react'
import { achievementView, type MikuPet } from '../mikuPet'
import {
  AchIconFeed,
  AchIconGame,
  AchIconPat,
  AchIconPlay,
  AchIconSing,
} from './icons'

const ACH_ICONS = {
  pat: AchIconPat,
  feed: AchIconFeed,
  play: AchIconPlay,
  sing: AchIconSing,
  game: AchIconGame,
} as const

export type AchKey = keyof typeof ACH_ICONS

/** 票色阶:未盖章 t0(空白虚线券)→ 第Ⅰ~Ⅳ档 t1~t4(t4 深青满章) */
const faceClass = (tier: number) => (tier < 0 ? 'ach-t0' : `ach-t${tier + 1}`)

/** 印章图案(按成就 key 染色) */
export function AchIcon({ k, size = 16 }: { k: AchKey; size?: number }) {
  const Icon = ACH_ICONS[k]
  return <Icon size={size} />
}

/** 迷你章 chip:侧栏摘要行与达成播报气泡句首用(无票根) */
export function AchChip({ k, tier }: { k: AchKey; tier: number }) {
  return (
    <span className={`ach-chip ${faceClass(tier)}`}>
      <AchIcon k={k} size={14} />
    </span>
  )
}

/** 票根章位:实心=已达成,朱红虚圈=下一枚,灰虚圈=未到 */
function Seals({ tier }: { tier: number }) {
  return (
    <span className="ach-seals">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={i <= tier ? 'd' : i === tier + 1 ? 'n' : 'w'} />
      ))}
    </span>
  )
}

/** 完整任务券(浮层行首):票面图案 + 中缝撕线票根 */
function AchTicket({ k, tier }: { k: AchKey; tier: number }) {
  return (
    <span className={`ach-tk ${faceClass(tier)}`}>
      <span className="ach-tk-main">
        <AchIcon k={k} size={18} />
      </span>
      <span className="ach-tk-stub">
        <Seals tier={tier} />
      </span>
    </span>
  )
}

export default function AchievementModal({ pet, onClose }: { pet: MikuPet; onClose: () => void }) {
  const rows = achievementView(pet)
  const stamped = rows.reduce((n, r) => n + Math.max(0, r.tier + 1), 0)
  const total = rows.reduce((n, r) => n + r.thresholds.length, 0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="raise-ach-overlay" onClick={onClose}>
      <div
        className="raise-ach-card"
        role="dialog"
        aria-label="成就徽章"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="raise-ach-head">
          <span>成就 · MILEAGE TASKS</span>
          <span>
            已盖章 <b>{stamped} / {total}</b> 枚
          </span>
        </header>
        {rows.map((r) => {
          const maxed = r.next === undefined
          const target = r.next ?? r.thresholds[r.thresholds.length - 1]
          const pct = Math.min(100, (r.count / target) * 100)
          // 进度条刻在「当前目标档」的标尺上:已越过的前几档留白口
          const marks = r.thresholds.filter((t) => t < target)
          return (
            <div key={r.key} className="raise-ach-row">
              <AchTicket k={r.key} tier={r.tier} />
              <span className="raise-ach-meta">
                <b>{r.name}</b>
                <i className={r.tier < 0 ? 'warn' : undefined}>
                  {maxed
                    ? `已盖章 ${r.thresholds.length} / ${r.thresholds.length} · 满章!`
                    : r.tier < 0
                      ? `待盖章 0 / ${r.thresholds.length} · 首章 ${target}`
                      : `已盖章 ${r.tier + 1} / ${r.thresholds.length} · 下一档 ${target}`}
                </i>
              </span>
              <span className="raise-ach-pcol">
                <span className={`raise-ach-bar${r.tier < 0 ? ' lock' : ''}${maxed ? ' done' : ''}`}>
                  <b style={{ width: `${pct}%` }} />
                  {marks.map((t) => (
                    <s key={t} style={{ left: `${(t / target) * 100}%` }} />
                  ))}
                </span>
                <span className="raise-ach-num">
                  {r.count} / {target}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
