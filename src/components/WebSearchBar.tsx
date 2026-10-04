import { useEffect, useRef, useState } from 'react'
import { IconSearch } from './icons'

/** sugrec 联想条目:当前线上只返回 q 字段,word 是旧版字段,兜底取 */
interface SugItem {
  q?: string
  word?: string
}

let sugSeq = 0

/** 百度联想词(JSONP 拉 sugrec,不受 CORS 限制);3 秒超时/失败兜底为空,回车直搜不受影响 */
function fetchSugs(wd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const cb = `__baiduSug_${Date.now().toString(36)}_${++sugSeq}`
    const w = window as unknown as Record<string, unknown>
    const script = document.createElement('script')
    const done = (res?: { g?: SugItem[] }) => {
      window.clearTimeout(timer)
      delete w[cb]
      script.remove()
      resolve((res?.g ?? []).map((it) => it.q || it.word || '').filter(Boolean))
    }
    const timer = window.setTimeout(() => done(), 3000)
    w[cb] = done
    script.onerror = () => done()
    script.src = `https://www.baidu.com/sugrec?prod=pc&wd=${encodeURIComponent(wd)}&cb=${cb}`
    document.head.appendChild(script)
  })
}

export default function WebSearchBar() {
  const [query, setQuery] = useState('')
  const [sugs, setSugs] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  // -1 = 输入框原文,0..n-1 = 联想词;↓ 从原文进入列表,↑ 走回头
  const [index, setIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 输入防抖拉联想词;递增序号只采纳最新一次,防慢响应串词
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSugs([])
      setOpen(false)
      setIndex(-1)
      return
    }
    const seq = ++seqRef.current
    const timer = window.setTimeout(async () => {
      const list = await fetchSugs(q)
      if (!aliveRef.current || seq !== seqRef.current) return
      setSugs(list)
      setIndex(-1)
      setOpen(list.length > 0)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [query])

  const go = (kw: string) => {
    const q = kw.trim()
    if (!q) return
    window.open(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, '_blank', 'noopener')
    setOpen(false)
    setIndex(-1)
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open || sugs.length === 0) return
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setIndex((i) => {
        const next = i + delta
        if (next < -1) return sugs.length - 1
        if (next >= sugs.length) return -1
        return next
      })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(index >= 0 && index < sugs.length ? sugs[index] : query)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
    }
  }

  // 「/」聚焦搜索框:只在总览(头部可见)时生效,输入框打字时不抢焦点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable
      )
        return
      if (!wrapRef.current?.offsetParent) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const clear = () => {
    setQuery('')
    setSugs([])
    setOpen(false)
    setIndex(-1)
    inputRef.current?.focus()
  }

  return (
    <div className="ws-bar" ref={wrapRef}>
      <span className="ws-glyph" aria-hidden="true">
        <IconSearch />
      </span>
      <input
        ref={inputRef}
        value={query}
        placeholder="搜索网页"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(-1)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (query.trim() && sugs.length > 0) setOpen(true)
        }}
        onClick={() => {
          // 已聚焦时再点输入框也要重新拉起联想(百度行为);onFocus 只覆盖焦点切换
          if (query.trim() && sugs.length > 0) setOpen(true)
        }}
        onBlur={() => setOpen(false)}
      />
      {query && (
        <button
          type="button"
          className="ws-clear"
          title="清空"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
        >
          ×
        </button>
      )}
      <button
        type="button"
        className="ws-go"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => go(query)}
      >
        百度一下
      </button>
      {open && sugs.length > 0 && (
        <div className="ws-pop">
          {sugs.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`ws-item ${i === index ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => go(s)}
            >
              <IconSearch />
              <span>{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
