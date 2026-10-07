import { useEffect, useRef } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'

export interface LongPressDragBind {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

interface Session {
  press: HTMLElement
  pointerId: number
  startX: number
  startY: number
  active: boolean
}

/**
 * 长按指针拖动手势——导航排序/总览胶囊/停靠拖动里反复内联的「黄金模板」收敛成的
 * 共享 hook:长按约 380ms 进入拖动(指针捕获 + vibrate + document 级拦截触摸滚动),
 * 生效前大幅移动视为滚动手势直接取消(列表照常能滑),Esc 中止,pointercancel 与
 * 松手共用收尾。鼠标指针不归它管(桌面走 HTML5 拖拽,与导航项同一分工)。
 * 排序/放置逻辑由调用方在 onActivate/onMove/onEnd 里实现,这里只管手势生命周期;
 * 拖过的那次点击经 wasDragRef 抑制,由调用方在 onClick 里消费。
 */
export function useLongPressDrag(opts: {
  disabled?: boolean
  longPressMs?: number
  cancelRadius?: number
  /** 长按生效:加拖动类、测量兄弟元素等一次性准备;press 即按住的那个元素 */
  onActivate: (press: HTMLElement, x: number, y: number) => void
  /** 拖动中的每次指针移动(激活后才会调用) */
  onMove: (x: number, y: number) => void
  /** 收尾:cancelled=true 表示 Esc 中止(不要提交),否则是松手/pointercancel */
  onEnd: (cancelled: boolean) => void
}): { bind: LongPressDragBind; wasDragRef: MutableRefObject<boolean> } {
  // 回调每次渲染都换,拖动会话里只留一份引用,保证进行中的拖动读到的是最新逻辑
  const optsRef = useRef(opts)
  optsRef.current = opts
  const session = useRef<Session | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 会话级监听(拦截触摸滚动 + Esc)挂在 AbortController 上,收尾/卸载一次解除
  const abort = useRef<AbortController | null>(null)
  const wasDragRef = useRef(false)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
      abort.current?.abort()
    },
    [],
  )

  const finish = (cancelled: boolean) => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    abort.current?.abort()
    abort.current = null
    const d = session.current
    session.current = null
    if (!d || !d.active) return // 未进入拖动:交给 onClick
    wasDragRef.current = true
    optsRef.current.onEnd(cancelled)
  }

  const bind: LongPressDragBind = {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse') return // 鼠标走 HTML5 拖拽
      if (optsRef.current.disabled) return
      if (session.current) return // 已有进行中的拖动,忽略多指
      const press = e.currentTarget
      session.current = {
        press,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      }
      wasDragRef.current = false
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const d = session.current
        if (!d || d.press !== press) return
        d.active = true
        try {
          press.setPointerCapture(d.pointerId)
        } catch {
          // 指针可能已释放,交给 pointercancel 清理
        }
        navigator.vibrate?.(15)
        const ac = new AbortController()
        abort.current = ac
        document.addEventListener(
          'touchmove',
          (ev) => ev.preventDefault(), // 拖动期间不让页面滚动
          { passive: false, signal: ac.signal },
        )
        window.addEventListener(
          'keydown',
          (ev) => {
            if (ev.key === 'Escape') finish(true)
          },
          { signal: ac.signal },
        )
        optsRef.current.onActivate(press, d.startX, d.startY)
      }, optsRef.current.longPressMs ?? 380)
    },
    onPointerMove: (e) => {
      const d = session.current
      if (!d || e.pointerId !== d.pointerId) return
      if (!d.active) {
        // 长按生效前的大幅移动是滚动手势,取消长按
        const radius = optsRef.current.cancelRadius ?? 10
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > radius) {
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = null
          session.current = null
        }
        return
      }
      optsRef.current.onMove(e.clientX, e.clientY)
    },
    onPointerUp: () => finish(false),
    onPointerCancel: () => finish(false),
  }

  return { bind, wasDragRef }
}
