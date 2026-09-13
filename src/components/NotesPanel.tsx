import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../types'
import { uid } from '../api'
import type { UpdateFn } from '../App'
import { IconSearch } from './icons'

interface Props {
  notes: Note[]
  update: UpdateFn
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 内容变化时自动长高的输入框
function AutoTextarea({
  value,
  onChange,
  placeholder,
  autoFocus,
  onBlur,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  onBlur?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onBlur={onBlur}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export default function NotesPanel({ notes, update }: Props) {
  const [query, setQuery] = useState('')
  const [newId, setNewId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [, setTick] = useState(0)

  // 相对时间戳每 30 秒自动刷新
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter((n) => !q || n.content.toLowerCase().includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
  }, [notes, query])

  const add = () => {
    const note: Note = {
      id: uid(),
      content: '',
      pinned: false,
      updatedAt: new Date().toISOString(),
    }
    update('notes', (items) => [note, ...items])
    setNewId(note.id)
  }

  const change = (id: string, content: string) =>
    update('notes', (items) =>
      items.map((n) => (n.id === id ? { ...n, content, updatedAt: new Date().toISOString() } : n)),
    )

  const togglePin = (id: string) =>
    update('notes', (items) => items.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)))

  const remove = (id: string) => update('notes', (items) => items.filter((n) => n.id !== id))

  // 全局快捷键:新建笔记 / 聚焦搜索(延迟一拍,等视图切换渲染完成)
  useEffect(() => {
    const onNew = () => add()
    const onFocusSearch = () => setTimeout(() => searchRef.current?.focus(), 60)
    window.addEventListener('workbench:new-note', onNew)
    window.addEventListener('workbench:focus-search', onFocusSearch)
    return () => {
      window.removeEventListener('workbench:new-note', onNew)
      window.removeEventListener('workbench:focus-search', onFocusSearch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="panel panel-notes">
      <header className="p-head">
        <h2>
          <span className="tag">NOTES</span>
          <i>/</i>笔记
        </h2>
        <span className="p-meta">共 {notes.length} 条</span>
      </header>

      <div className="tools">
        <div className="search">
          <IconSearch />
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索笔记"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn solid" onClick={add}>
          新建
        </button>
      </div>

      <div className="note-list">
        {shown.map((n) => (
          <div key={n.id} className={`note ${n.pinned ? 'pinned' : ''}`}>
            <AutoTextarea
              value={n.content}
              onChange={(v) => change(n.id, v)}
              placeholder="记录点什么…"
              autoFocus={n.id === newId}
              onBlur={() => {
                // 失焦时空笔记自动清理
                if (!n.content.trim()) remove(n.id)
              }}
            />
            <div className="note-foot">
              <span className="note-time">{relativeTime(n.updatedAt)}</span>
              <span className="item-actions">
                <button title={n.pinned ? '取消置顶' : '置顶'} onClick={() => togglePin(n.id)}>
                  {n.pinned ? '★' : '☆'}
                </button>
                <button title="删除" onClick={() => remove(n.id)}>
                  ✕
                </button>
              </span>
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="empty-hint">{query ? '没有匹配的笔记。' : '还没有笔记,点「新建」记录第一条。'}</div>
        )}
      </div>
    </div>
  )
}
