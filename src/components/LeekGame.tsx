// 接大葱小游戏:养成页舞台上的覆盖层。光标/手指左右移动篮子,接住掉落的大葱(1 分)
// 与星星(2 分),漏 3 个或 25 秒结束。接住时向舞台派发 miku:cheer(Miku 弹跳+轻表情,
// 无冷却),她的眼神跟随本来就在追光标,天然像在盯着篮子。
// 掉落物与篮子用 DOM + rAF 直改 transform,不经 React 状态,保证 60fps 不重渲染。
import { useEffect, useRef, useState } from 'react'
import { MIKU_CHEER_EVENT } from './MikuStage'

const DURATION_S = 25
const MISS_LIMIT = 3
const BASKET_HALF = 34 // 篮子判定半径(px)
const BASKET_BOTTOM = 56 // 篮子中心距底缘(px)
const ITEM_HALF = 16

interface Props {
  /** 结束回调(自然到时/漏超/手动退出),score 为最终得分 */
  onEnd: (score: number) => void
}

export default function LeekGame({ onEnd }: Props) {
  const areaRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const basketRef = useRef<HTMLDivElement>(null)
  const [score, setScore] = useState(0)
  const [miss, setMiss] = useState(0)
  const [timeLeft, setTimeLeft] = useState(DURATION_S)
  const scoreRef = useRef(0)
  const endedRef = useRef(false)
  const rafRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd

  const end = () => {
    if (endedRef.current) return
    endedRef.current = true
    cancelAnimationFrame(rafRef.current)
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    onEndRef.current(scoreRef.current)
  }

  useEffect(() => {
    const area = areaRef.current
    const layer = layerRef.current
    if (!area || !layer) return
    const W = area.clientWidth
    const H = area.clientHeight
    const basketY = H - BASKET_BOTTOM
    const items: { el: HTMLSpanElement; x: number; y: number; vy: number; star: boolean }[] = []
    let basketX = W / 2
    let missCount = 0
    let last = performance.now()
    let spawnAt = last + 500

    const onMove = (e: PointerEvent) => {
      const r = area.getBoundingClientRect()
      basketX = Math.min(Math.max(e.clientX - r.left, BASKET_HALF), Math.max(W - BASKET_HALF, BASKET_HALF))
      if (basketRef.current) {
        basketRef.current.style.transform = `translateX(${Math.round(basketX - BASKET_HALF)}px)`
      }
    }
    area.addEventListener('pointermove', onMove)

    const step = (now: number) => {
      if (endedRef.current) return
      const dt = Math.min(50, now - last)
      last = now
      if (now >= spawnAt) {
        spawnAt = now + 520 + Math.random() * 480
        const star = Math.random() < 0.2
        const el = document.createElement('span')
        el.className = `raise-game-item${star ? ' star' : ''}`
        el.textContent = star ? '⭐' : '🥬'
        layer.appendChild(el)
        items.push({ el, x: 24 + Math.random() * Math.max(1, W - 48), y: -30, vy: 165 + Math.random() * 95, star })
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        it.y += (it.vy * dt) / 1000
        if (it.y >= basketY - 6 && it.y <= basketY + 30 && Math.abs(it.x - basketX) < BASKET_HALF) {
          layer.removeChild(it.el)
          items.splice(i, 1)
          scoreRef.current += it.star ? 2 : 1
          setScore(scoreRef.current)
          window.dispatchEvent(new CustomEvent(MIKU_CHEER_EVENT))
          continue
        }
        if (it.y > H + 24) {
          layer.removeChild(it.el)
          items.splice(i, 1)
          missCount++
          setMiss(missCount)
          if (missCount >= MISS_LIMIT) end()
          continue
        }
        it.el.style.transform = `translate(${Math.round(it.x - ITEM_HALF)}px, ${Math.round(it.y)}px)`
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    timerRef.current = window.setInterval(() => {
      setTimeLeft((t) => {
        const n = t - 1
        if (n <= 0) end()
        return Math.max(0, n)
      })
    }, 1000)

    return () => {
      // 注意:这里不能把 endedRef 置 true——StrictMode 挂载-卸载-再挂载时 ref 会被
      // 第二趟 effect 沿用,置 true 会让重开的循环与结束按钮全部哑火;
      // 真正的卸载靠下面的 cancel/clear 收尾即可
      cancelAnimationFrame(rafRef.current)
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      area.removeEventListener('pointermove', onMove)
      for (const it of items) it.el.remove()
    }
    // 面板挂载一次玩一局;onEnd 走 ref 取最新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="raise-game" ref={areaRef}>
      <div className="raise-game-hud">
        <span>
          🧺 <b>{score}</b> 分
        </span>
        <span className={miss > 0 ? 'bad' : ''}>
          漏 {miss}/{MISS_LIMIT}
        </span>
        <span>{timeLeft}s</span>
        <button className="raise-game-quit" onClick={end} title="提前结束">
          结束
        </button>
      </div>
      <div className="raise-game-layer" ref={layerRef} />
      <div className="raise-game-basket" ref={basketRef}>
        🧺
      </div>
      <div className="raise-game-hint">左右移动接住大葱,别漏掉啦!</div>
    </div>
  )
}
