import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  /** 快捷键提示,如 "1"、"N" */
  hint?: string
  run: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  commands: Command[]
}

export default function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 让选中项保持可见(等价 nearest 滚动,避免 scrollIntoView)
  useEffect(() => {
    const list = listRef.current
    const el = list?.children[index] as HTMLElement | undefined
    if (!list || !el) return
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight
  }, [index, filtered.length])

  if (!open) return null

  const run = (c: Command) => {
    onClose()
    c.run()
  }

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = filtered[index]
      if (c) run(c)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-input-row">
          <span className="cmd-glyph">⌘</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="输入命令…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmd-list" ref={listRef}>
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`cmd-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(c)}
            >
              <span>{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <div className="cmd-empty">没有匹配的命令</div>}
        </div>
        <div className="cmd-foot">
          <span>
            <kbd>↑↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 执行
          </span>
          <span>
            <kbd>1-5</kbd> 切换视图
          </span>
          <span>
            <kbd>N</kbd> 新笔记
          </span>
          <span>
            <kbd>P</kbd> 番茄钟
          </span>
        </div>
      </div>
    </div>
  )
}
