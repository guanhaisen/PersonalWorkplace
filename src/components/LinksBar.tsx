import { useEffect, useRef, useState } from 'react'
import type { LinkItem } from '../types'
import type { UpdateFn } from '../App'
import { uid } from '../api'

interface Props {
  links: LinkItem[]
  update: UpdateFn
}

// 补全协议,避免 "github.com" 被当成相对路径打开
const normalizeUrl = (raw: string) => (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)

// 标题留空时按域名生成展示名
const titleFromUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

interface DragState {
  id: string
  fromIndex: number
  targetIndex: number
  startX: number
  startY: number
  active: boolean
  press: HTMLElement
  pointerId: number
  pills: HTMLElement[] | null
  rects: DOMRect[] | null
  gap: number
}

export default function LinksBar({ links, update }: Props) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const firstInputRef = useRef<HTMLInputElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (adding) requestAnimationFrame(() => firstInputRef.current?.focus())
  }, [adding])

  const submit = () => {
    const raw = url.trim()
    if (!raw) return
    const finalUrl = normalizeUrl(raw)
    const finalTitle = title.trim() || titleFromUrl(finalUrl)
    update('links', (items) => [...items, { id: uid(), title: finalTitle, url: finalUrl }])
    setTitle('')
    setUrl('')
    setAdding(false)
  }

  const remove = (l: LinkItem) => {
    if (window.confirm(`确定删除收藏的「${l.title}」吗?`)) {
      update('links', (items) => items.filter((i) => i.id !== l.id))
    }
  }

  // ---------- 收藏长按拖动排序:与总览胶囊同一套交互 ----------
  // 长按约 380ms 拾起,药丸悬浮跟随指针,其余按实际宽度平滑让位,松手一次提交;
  // 未满阈值松手是普通点击(打开链接)。拖动全程只改 transform。

  const drag = useRef<DragState | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressClick = useRef(false)

  // 拖动激活后拦截触摸滚动(长按前不拦,保证页面可正常滑动)
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (drag.current?.active) e.preventDefault()
    }
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [])

  const measure = (d: DragState) => {
    const pills = Array.from(innerRef.current?.querySelectorAll<HTMLElement>('.head-link') ?? [])
    const rects = pills.map((p) => p.getBoundingClientRect())
    d.pills = pills
    d.rects = rects
    d.gap = rects.length > 1 ? rects[1].left - rects[0].left - rects[0].width : 8
    d.fromIndex = pills.findIndex((p) => p.dataset.id === d.id)
    d.targetIndex = d.fromIndex
  }

  // 让位位移:按"移除拖动项再插到目标位"后的新顺序,逐个累加 left+width+gap
  // 得出每个药丸的目标位置与原位置的差(药丸宽度不一,不能像等宽网格一样用固定步长)
  const yieldDeltas = (d: DragState, target: number): number[] => {
    const rects = d.rects!
    const n = rects.length
    const order = Array.from({ length: n }, (_, i) => i)
    order.splice(d.fromIndex, 1)
    order.splice(target, 0, d.fromIndex)
    const newLeft = new Array<number>(n)
    order.forEach((pill, k) => {
      newLeft[pill] =
        k === 0 ? rects[0].left : newLeft[order[k - 1]] + rects[order[k - 1]].width + d.gap
    })
    return newLeft.map((l, i) => l - rects[i].left)
  }

  const onLinkPress = (l: LinkItem, e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as HTMLElement).closest('.head-link-x')) return // ✕ 照常删除
    const press = e.currentTarget
    drag.current = {
      id: l.id,
      fromIndex: 0,
      targetIndex: 0,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      press,
      pointerId: e.pointerId,
      pills: null,
      rects: null,
      gap: 8,
    }
    clearTimeout(pressTimer.current!)
    pressTimer.current = setTimeout(() => {
      const d = drag.current
      if (!d || d.press !== press) return
      d.active = true
      try {
        press.setPointerCapture(d.pointerId)
      } catch {
        // 指针可能已释放,交给 pointercancel 清理
      }
      press.classList.add('link-dragging')
      navigator.vibrate?.(15)
    }, 380)
  }

  const onLinkMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (!d.active) {
      // 长按生效前的大幅移动是滚动手势,取消长按
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 10) {
        clearTimeout(pressTimer.current!)
        drag.current = null
      }
      return
    }
    if (!d.rects) measure(d) // 首次移动时测量
    const rects = d.rects
    if (!rects || !d.pills?.length || d.fromIndex < 0) return
    const from = d.fromIndex
    const last = rects.length - 1
    const dxMin = rects[0].left - rects[from].left
    const dxMax = rects[last].left + rects[last].width - rects[from].width - rects[from].left
    const dx = Math.min(Math.max(e.clientX - d.startX, dxMin), dxMax)
    d.pills[from].style.setProperty('transform', `translateX(${dx}px)`)
    const center = rects[from].left + rects[from].width / 2 + dx
    let target = 0
    let best = Infinity
    rects.forEach((r, i) => {
      const dist = Math.abs(center - (r.left + r.width / 2))
      if (dist < best) {
        best = dist
        target = i
      }
    })
    if (target !== d.targetIndex) {
      d.targetIndex = target
      const deltas = yieldDeltas(d, target)
      d.pills.forEach((p, i) => {
        if (i === from) return
        p.style.setProperty('transform', deltas[i] ? `translateX(${deltas[i]}px)` : '')
      })
    }
  }

  const onLinkEnd = () => {
    clearTimeout(pressTimer.current!)
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.active) return // 未进入拖动:交给 <a> 打开链接
    suppressClick.current = true
    if (d.targetIndex !== d.fromIndex) {
      const { fromIndex, targetIndex } = d
      update('links', (items) => {
        const arr = [...items]
        const [moved] = arr.splice(fromIndex, 1)
        arr.splice(targetIndex, 0, moved)
        return arr
      })
    }
    const pills =
      d.pills ?? Array.from(innerRef.current?.querySelectorAll<HTMLElement>('.head-link') ?? [])
    pills.forEach((p) => {
      p.style.removeProperty('transform')
      p.classList.remove('link-dragging')
    })
  }

  return (
    <div className="head-links">
      <div className="head-links-inner" ref={innerRef}>
        {links.map((l) => (
          <span
            key={l.id}
            data-id={l.id}
            className="head-link"
            onPointerDown={(e) => onLinkPress(l, e)}
            onPointerMove={onLinkMove}
            onPointerUp={onLinkEnd}
            onPointerCancel={onLinkEnd}
            onContextMenu={(e) => {
              // 长按拖动期间屏蔽系统链接菜单(普通右键不受影响)
              if (drag.current) e.preventDefault()
            }}
          >
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={l.url}
              draggable={false}
              onClick={(e) => {
                if (suppressClick.current) {
                  e.preventDefault()
                  suppressClick.current = false
                }
              }}
            >
              {l.title}
            </a>
            <button
              className="head-link-x"
              title="删除"
              onClick={() => remove(l)}
            >
              ✕
            </button>
          </span>
        ))}
        {adding ? (
          <span className="head-link-form">
            <input
              ref={firstInputRef}
              className="in"
              value={title}
              placeholder="名称(可选)"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <input
              className="in"
              value={url}
              placeholder="网址,如 github.com"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <button className="btn solid" onClick={submit} disabled={!url.trim()}>
              添加
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              取消
            </button>
          </span>
        ) : (
          <button className="head-link-add" title="收藏一个网页地址" onClick={() => setAdding(true)}>
            ＋ 收藏网页
          </button>
        )}
      </div>
    </div>
  )
}
