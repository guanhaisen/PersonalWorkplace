import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// ---------- favicon:直取站点 /favicon.ico,失败回退域名首字字母块 ----------
// 不依赖任何第三方图标服务;色板按域名哈希取色,同一站点颜色稳定

const LETTER_COLORS = [
  '#0f766e',
  '#c24a38',
  '#2f6fd8',
  '#3e9c62',
  '#7c5ca8',
  '#b58a2c',
  '#a85c7c',
  '#5c7ca8',
]

const colorOfHost = (host: string) => {
  let h = 0
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0
  return LETTER_COLORS[h % LETTER_COLORS.length]
}

function Favicon({ url, size }: { url: string; size: number }) {
  const [failed, setFailed] = useState(false)
  const host = hostOf(url)
  useEffect(() => setFailed(false), [host])
  if (!host || failed) {
    return (
      <span
        className="link-ico-letter"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.56),
          background: colorOfHost(host),
        }}
      >
        {(host.replace(/^www\./, '')[0] || '?').toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="link-ico"
      src={`https://${host}/favicon.ico`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
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

// 弹层网格里的拖拽状态:等宽卡片,无需顶栏那套宽度让位,按最近卡片中心换位即可
interface GridDragState {
  id: string
  el: HTMLElement
  pointerId: number
  startX: number
  startY: number
  offX: number
  offY: number
  active: boolean
  order: string[]
  lastTarget: string
}

type Adding = null | 'header' | 'pop'

const GAP = 8 // 与 .head-links-inner 的 gap 保持一致

export default function LinksBar({ links, update }: Props) {
  const [adding, setAdding] = useState<Adding>(null)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [visibleCount, setVisibleCount] = useState(links.length)
  const [moreOpen, setMoreOpen] = useState(false)
  const [popPos, setPopPos] = useState({ left: 0, top: 0 })
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const popFirstInputRef = useRef<HTMLInputElement>(null)

  const hiddenCount = links.length - visibleCount

  const submit = (where: Exclude<Adding, null>) => {
    const raw = url.trim()
    if (!raw) return
    const finalUrl = normalizeUrl(raw)
    const finalTitle = title.trim() || titleFromUrl(finalUrl)
    update('links', (items) => [...items, { id: uid(), title: finalTitle, url: finalUrl }])
    setTitle('')
    setUrl('')
    if (where === 'header') setAdding(null) // 弹层里添加后不关,方便连续收藏
  }

  const remove = (l: LinkItem) => {
    if (window.confirm(`确定删除收藏的「${l.title}」吗?`)) {
      update('links', (items) => items.filter((i) => i.id !== l.id))
    }
  }

  const startEdit = (l: LinkItem) => {
    setEditId(l.id)
    setEditTitle(l.title)
  }

  const commitEdit = () => {
    const t = editTitle.trim()
    if (editId && t) {
      update('links', (items) => items.map((i) => (i.id === editId ? { ...i, title: t } : i)))
    }
    setEditId(null)
  }

  // ---------- 自适应折叠:隐藏测量行量出每个药丸宽度,算出顶栏能放下几个 ----------
  // 测量行与真实行同构(含 +N 按钮与添加按钮/表单),这样 trailing 宽度也是实测值,
  // 不会因「+N 出现→挤掉一个药丸→+N 又消失」来回振荡。

  const fitRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const fit = () => {
      const wrap = wrapRef.current
      const probe = probeRef.current
      if (!wrap || !probe) return
      const w = wrap.clientWidth
      if (!w) return
      const widths = Array.from(probe.querySelectorAll<HTMLElement>('.head-link')).map(
        (p) => p.getBoundingClientRect().width,
      )
      const n = widths.length
      const addEl = probe.querySelector<HTMLElement>(
        adding === 'header' ? '.head-link-form' : '.head-link-add',
      )
      const moreEl = probe.querySelector<HTMLElement>('.head-links-more')
      const addW = addEl?.getBoundingClientRect().width ?? 0
      const moreW = moreEl?.getBoundingClientRect().width ?? 0
      const prefix = [0]
      widths.forEach((x, i) => prefix.push(prefix[i] + x))
      const gaps = (children: number) => Math.max(0, children - 1) * GAP
      let next = n
      if (prefix[n] + gaps(n + 1) + addW > w) {
        // 放不下全部:留出 +N 按钮的位置,从右往左收
        next = n - 1
        while (next > 0 && prefix[next] + gaps(next + 2) + moreW + addW > w) next--
      }
      setVisibleCount(next)
    }
    fitRef.current = fit
    if (!dragOrder) fit() // 弹层网格拖拽的重渲染不必重算
  })

  useEffect(() => {
    // RO 本身就在布局后回调,直接重算即可(不再垫 rAF,免受页面不可见时的帧调度影响)
    const ro = new ResizeObserver(() => fitRef.current())
    if (wrapRef.current) ro.observe(wrapRef.current)
    let cancelled = false
    document.fonts?.ready.then(() => {
      if (!cancelled) fitRef.current() // 字体就绪后字宽可能变化,补一次
    })
    return () => {
      cancelled = true
      ro.disconnect()
    }
  }, [])

  useEffect(() => {
    if (adding === 'header') requestAnimationFrame(() => firstInputRef.current?.focus())
    if (adding === 'pop') requestAnimationFrame(() => popFirstInputRef.current?.focus())
  }, [adding])

  // ---------- +N 弹层:锚定按钮定位,Escape / 点外 / resize 关闭 ----------

  // 弹层锚定 +N 按钮;按钮没了(收藏变少到全部放得下)则由调用方收起
  const anchorPop = () => {
    const r = moreBtnRef.current?.getBoundingClientRect()
    if (!r) return false
    const popW = Math.min(340, window.innerWidth - 24)
    setPopPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - popW - 8)),
      top: Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 488)),
    })
    return true
  }

  const openMore = () => {
    if (moreOpen) {
      setMoreOpen(false)
      return
    }
    if (!anchorPop()) return
    setMoreOpen(true)
  }

  useEffect(() => {
    if (!moreOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false)
        setAdding(null)
      }
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.links-more-pop') || t.closest('.head-links-more')) return
      setMoreOpen(false)
    }
    const onResize = () => {
      // 窗口变化时重新锚定;按钮已消失(+N 收起)才关闭
      if (!anchorPop()) setMoreOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onResize)
    }
  }, [moreOpen])

  // 收藏变少到全部放得下时 +N 消失,弹层失去锚点,一并收起
  useEffect(() => {
    if (moreOpen && hiddenCount === 0) setMoreOpen(false)
  }, [moreOpen, hiddenCount])

  // 弹层关闭时拖拽可能被打断,把网格拖拽状态清干净
  useEffect(() => {
    if (moreOpen) return
    setDragOrder(null)
    clearTimeout(gridTimer.current!)
    gridDrag.current = null
  }, [moreOpen])

  // ---------- 收藏长按拖动排序:与总览胶囊同一套交互 ----------
  // 长按约 380ms 拾起,药丸悬浮跟随指针,其余按实际宽度平滑让位,松手一次提交;
  // 未满阈值松手是普通点击(打开链接)。拖动全程只改 transform。
  // 折叠后顶栏只渲染切片,提交时经 data-id 换算成整表真实索引。

  const drag = useRef<DragState | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressClick = useRef(false)

  // 拖动激活后拦截触摸滚动(长按前不拦,保证页面可正常滑动)
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (drag.current?.active || gridDrag.current?.active) e.preventDefault()
    }
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [])

  const measure = (d: DragState) => {
    const pills = Array.from(innerRef.current?.querySelectorAll<HTMLElement>('.head-link') ?? [])
    const rects = pills.map((p) => p.getBoundingClientRect())
    d.pills = pills
    d.rects = rects
    d.gap = rects.length > 1 ? rects[1].left - rects[0].left - rects[0].width : GAP
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
      gap: GAP,
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
      const toId = d.pills?.[d.targetIndex]?.dataset.id
      update('links', (items) => {
        const from = items.findIndex((i) => i.id === d.id)
        const to = items.findIndex((i) => i.id === toId)
        if (from < 0 || to < 0 || from === to) return items
        const arr = [...items]
        const [moved] = arr.splice(from, 1)
        arr.splice(to, 0, moved)
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

  // ---------- 弹层网格拖拽:长按拾起后卡片脱离网格流跟随指针,其余按最近中心实时换位 ----------

  const gridDrag = useRef<GridDragState | null>(null)
  const gridTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressCardClick = useRef(false)

  const visualIds = dragOrder ?? links.map((l) => l.id)
  const byId = new Map(links.map((l) => [l.id, l]))

  const onCardPress = (l: LinkItem, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as HTMLElement).closest('.links-more-act, .links-more-edit')) return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    gridDrag.current = {
      id: l.id,
      el,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      active: false,
      order: (dragOrder ?? links.map((i) => i.id)).slice(),
      lastTarget: l.id,
    }
    clearTimeout(gridTimer.current!)
    gridTimer.current = setTimeout(() => {
      const d = gridDrag.current
      if (!d || d.el !== el) return
      d.active = true
      try {
        el.setPointerCapture(d.pointerId)
      } catch {
        // 指针可能已释放
      }
      el.classList.add('grid-dragging')
      el.style.width = `${r.width}px`
      el.style.left = `${e.clientX - d.offX}px`
      el.style.top = `${e.clientY - d.offY}px`
      navigator.vibrate?.(15)
    }, 380)
  }

  const onCardMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = gridDrag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 10) {
        clearTimeout(gridTimer.current!)
        gridDrag.current = null
      }
      return
    }
    d.el.style.left = `${e.clientX - d.offX}px`
    d.el.style.top = `${e.clientY - d.offY}px`
    const cards = Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>('.links-more-card:not(.grid-dragging)') ??
        [],
    )
    let best = Infinity
    let target = ''
    for (const c of cards) {
      const r = c.getBoundingClientRect()
      const dist = Math.hypot(
        e.clientX - (r.left + r.width / 2),
        e.clientY - (r.top + r.height / 2),
      )
      if (dist < best) {
        best = dist
        target = c.dataset.id ?? ''
      }
    }
    if (!target || target === d.lastTarget) return
    d.lastTarget = target
    const order = d.order.filter((x) => x !== d.id)
    const ti = order.indexOf(target)
    if (ti < 0) return
    order.splice(ti, 0, d.id)
    d.order = order
    setDragOrder(order)
  }

  const onCardEnd = () => {
    clearTimeout(gridTimer.current!)
    const d = gridDrag.current
    gridDrag.current = null
    if (!d) return
    if (!d.active) return // 普通点击:交给 <a> 打开链接
    suppressCardClick.current = true
    d.el.classList.remove('grid-dragging')
    d.el.style.removeProperty('width')
    d.el.style.removeProperty('left')
    d.el.style.removeProperty('top')
    const finalOrder = d.order
    setDragOrder(null)
    update('links', (items) => {
      if (finalOrder.length !== items.length) return items // 拖拽期间数据变动,放弃重排
      const map = new Map(items.map((i) => [i.id, i]))
      return finalOrder.map((id) => map.get(id)!)
    })
  }

  const visible = links.slice(0, visibleCount)

  return (
    <div className="head-links" ref={wrapRef}>
      {/* 隐藏测量行:与真实药丸同构,量宽度供折叠计算,不可交互 */}
      <div className="head-links-probe" aria-hidden="true" ref={probeRef}>
        {links.map((l) => (
          <span key={l.id} className="head-link">
            <a>
              <Favicon url={l.url} size={16} />
              <span className="head-link-t">{l.title}</span>
            </a>
            <button type="button" className="head-link-x" tabIndex={-1}>
              ✕
            </button>
          </span>
        ))}
        <button type="button" className="head-links-more" tabIndex={-1}>
          +99<span className="more-chev">▾</span>
        </button>
        <button type="button" className="head-link-add" tabIndex={-1}>
          ＋ 收藏网页
        </button>
        {adding === 'header' && (
          <span className="head-link-form">
            <input className="in" placeholder="名称(可选)" readOnly tabIndex={-1} />
            <input className="in" placeholder="网址,如 github.com" readOnly tabIndex={-1} />
            <button type="button" className="btn solid" tabIndex={-1}>
              添加
            </button>
            <button type="button" className="btn ghost" tabIndex={-1}>
              取消
            </button>
          </span>
        )}
      </div>

      <div className="head-links-inner" ref={innerRef}>
        {visible.map((l) => (
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
              <Favicon url={l.url} size={16} />
              <span className="head-link-t">{l.title}</span>
            </a>
            <button className="head-link-x" title="删除" onClick={() => remove(l)}>
              ✕
            </button>
          </span>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            ref={moreBtnRef}
            className={`head-links-more${moreOpen ? ' open' : ''}`}
            title="全部收藏"
            aria-expanded={moreOpen}
            onClick={openMore}
          >
            +{hiddenCount}
            <span className="more-chev">▾</span>
          </button>
        )}
        {adding === 'header' ? (
          <span className="head-link-form">
            <input
              ref={firstInputRef}
              className="in"
              value={title}
              placeholder="名称(可选)"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit('header')
                if (e.key === 'Escape') setAdding(null)
              }}
            />
            <input
              className="in"
              value={url}
              placeholder="网址,如 github.com"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit('header')
                if (e.key === 'Escape') setAdding(null)
              }}
            />
            <button className="btn solid" onClick={() => submit('header')} disabled={!url.trim()}>
              添加
            </button>
            <button className="btn ghost" onClick={() => setAdding(null)}>
              取消
            </button>
          </span>
        ) : (
          <button className="head-link-add" title="收藏一个网页地址" onClick={() => setAdding('header')}>
            ＋ 收藏网页
          </button>
        )}
      </div>

      {moreOpen && hiddenCount > 0 && (
        <div className="links-more-pop" style={{ left: popPos.left, top: popPos.top }}>
          <div className="links-more-head">
            <span>全部收藏</span>
            <span className="links-more-cnt">{links.length}</span>
          </div>
          <div className="links-more-grid" ref={gridRef}>
            {visualIds.map((id) => {
              const l = byId.get(id)
              if (!l) return null
              return editId === l.id ? (
                <div key={l.id} className="links-more-card editing">
                  <Favicon url={l.url} size={18} />
                  <input
                    className="in links-more-edit"
                    value={editTitle}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      e.stopPropagation() // Esc 只取消重命名,不关弹层
                      if (e.key === 'Enter') commitEdit()
                      if (e.key === 'Escape') setEditId(null)
                    }}
                  />
                </div>
              ) : (
                <div
                  key={l.id}
                  data-id={l.id}
                  className="links-more-card"
                  onPointerDown={(e) => onCardPress(l, e)}
                  onPointerMove={onCardMove}
                  onPointerUp={onCardEnd}
                  onPointerCancel={onCardEnd}
                  onContextMenu={(e) => {
                    if (gridDrag.current) e.preventDefault()
                  }}
                >
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    title={l.url}
                    draggable={false}
                    onClick={(e) => {
                      if (suppressCardClick.current) {
                        e.preventDefault()
                        suppressCardClick.current = false
                      }
                    }}
                  >
                    <Favicon url={l.url} size={18} />
                    <span className="links-more-t">{l.title}</span>
                  </a>
                  <button className="links-more-act edit" title="重命名" onClick={() => startEdit(l)}>
                    ✎
                  </button>
                  <button className="links-more-act" title="删除" onClick={() => remove(l)}>
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
          <div className="links-more-foot">
            {adding === 'pop' ? (
              <span className="links-more-form">
                <input
                  ref={popFirstInputRef}
                  className="in"
                  value={title}
                  placeholder="名称(可选)"
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation() // Esc 只收起表单,不关弹层
                    if (e.key === 'Enter') submit('pop')
                    if (e.key === 'Escape') setAdding(null)
                  }}
                />
                <input
                  className="in"
                  value={url}
                  placeholder="网址,如 github.com"
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') submit('pop')
                    if (e.key === 'Escape') setAdding(null)
                  }}
                />
                <span className="links-more-form-btns">
                  <button className="btn solid" onClick={() => submit('pop')} disabled={!url.trim()}>
                    添加
                  </button>
                  <button className="btn ghost" onClick={() => setAdding(null)}>
                    取消
                  </button>
                </span>
              </span>
            ) : (
              <button className="head-link-add" title="收藏一个网页地址" onClick={() => setAdding('pop')}>
                ＋ 收藏网页
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
