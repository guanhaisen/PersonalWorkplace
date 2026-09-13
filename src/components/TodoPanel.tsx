import { useMemo, useState } from 'react'
import type { Priority, Todo } from '../types'
import { todayStr, uid } from '../api'
import type { UpdateFn } from '../App'
import { IconCheck, IconFlag } from './icons'

const PRIORITY_LABEL: Record<Priority, string> = { high: '高', mid: '中', low: '低' }

type Filter = 'active' | 'overdue' | 'done' | 'all'

interface Props {
  todos: Todo[]
  update: UpdateFn
}

function dueText(dueDate: string, today: string): string {
  if (dueDate === today) return '今天'
  const diff = Math.round(
    (new Date(dueDate + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000,
  )
  if (diff === 1) return '明天'
  const d = new Date(dueDate + 'T00:00:00')
  return `${d.getMonth() + 1}-${d.getDate()}`
}

export default function TodoPanel({ todos, update }: Props) {
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<Priority>('mid')
  const [dueDate, setDueDate] = useState('')
  const [filter, setFilter] = useState<Filter>('active')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)

  const today = todayStr()

  // 手动排序:数组顺序即显示顺序,拖拽改变顺序;筛选只做过滤
  const visible = useMemo(() => {
    return todos.filter((t) => {
      switch (filter) {
        case 'done':
          return t.done
        case 'overdue':
          return !t.done && !!t.dueDate && t.dueDate < today
        case 'all':
          return true
        default:
          return !t.done
      }
    })
  }, [todos, filter, today])

  const activeCount = todos.filter((t) => !t.done).length
  const overdueCount = todos.filter((t) => !t.done && !!t.dueDate && t.dueDate < today).length
  const doneCount = todos.length - activeCount

  // 清空已完成任务
  const clearDone = () => {
    if (doneCount === 0) return
    if (!window.confirm(`清空 ${doneCount} 项已完成任务?`)) return
    update('todos', (items) => items.filter((t) => !t.done))
  }

  const add = () => {
    const title = text.trim()
    if (!title) return
    const todo: Todo = {
      id: uid(),
      title,
      done: false,
      priority,
      dueDate: dueDate || undefined,
      createdAt: new Date().toISOString(),
    }
    update('todos', (items) => [todo, ...items])
    setText('')
    setDueDate('')
  }

  const toggle = (id: string) =>
    update('todos', (items) =>
      items.map((t) =>
        t.id === id
          ? { ...t, done: !t.done, completedAt: !t.done ? new Date().toISOString() : undefined }
          : t,
      ),
    )

  const remove = (id: string) => update('todos', (items) => items.filter((t) => t.id !== id))

  const startEdit = (t: Todo) => {
    setEditingId(t.id)
    setEditingText(t.title)
  }

  const saveEdit = () => {
    const id = editingId
    const title = editingText.trim()
    setEditingId(null)
    if (!id || !title) return
    update('todos', (items) => items.map((t) => (t.id === id ? { ...t, title } : t)))
  }

  // 拖拽排序:把 source 移动到 target 的 before/after 位置
  const reorder = (sourceId: string, targetId: string, pos: 'before' | 'after') => {
    if (sourceId === targetId) return
    update('todos', (items) => {
      const next = [...items]
      const from = next.findIndex((t) => t.id === sourceId)
      if (from < 0) return items
      const [moved] = next.splice(from, 1)
      let to = next.findIndex((t) => t.id === targetId)
      if (to < 0) {
        next.splice(from, 0, moved) // 目标不在了,放回原位
        return next
      }
      if (pos === 'after') to += 1
      next.splice(to, 0, moved)
      return next
    })
  }

  return (
    <div className="panel panel-todo">
      <header className="p-head">
        <h2>
          <span className="tag">TODO</span>
          <i>/</i>待办任务
        </h2>
        <span className="p-meta">{activeCount} 项进行中</span>
      </header>

      <div className="tabs">
        {(
          [
            ['active', '进行中', activeCount],
            ['overdue', '已过期', overdueCount],
            ['done', '已完成', doneCount],
            ['all', '全部', todos.length],
          ] as [Filter, string, number][]
        ).map(([f, label, count]) => (
          <button key={f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {label} <em>{count}</em>
          </button>
        ))}
        {doneCount > 0 && (
          <button className="tab-clear" onClick={clearDone} title="删除全部已完成任务">
            清空已完成
          </button>
        )}
      </div>

      <div className="task-list">
        {visible.map((t) => {
          const overdue = !t.done && !!t.dueDate && t.dueDate < today
          return (
            <div
              key={t.id}
              className={[
                'task',
                t.done ? 'is-done' : '',
                dragId === t.id ? 'dragging' : '',
                dropHint?.id === t.id ? `drop-${dropHint.pos}` : '',
              ]
                .filter(Boolean)
                .join(' ')}
              draggable={editingId !== t.id}
              onDragStart={(e) => {
                setDragId(t.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', t.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setDropHint(null)
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === t.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                if (dropHint?.id !== t.id || dropHint.pos !== pos) setDropHint({ id: t.id, pos })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dropHint?.id === t.id) reorder(dragId, t.id, dropHint.pos)
                setDragId(null)
                setDropHint(null)
              }}
            >
              <button
                className={`cb ${t.done ? 'on' : ''}`}
                onClick={() => toggle(t.id)}
                aria-label="标记完成"
              >
                {t.done && <IconCheck />}
              </button>
              <div className="task-body">
                {editingId === t.id ? (
                  <input
                    className="edit-input"
                    autoFocus
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={saveEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <div className="task-tt" onDoubleClick={() => startEdit(t)}>
                    {t.title}
                  </div>
                )}
                <div className="task-mt">
                  <span className="prio">
                    <IconFlag level={t.priority} />
                    {PRIORITY_LABEL[t.priority]}
                  </span>
                  {t.dueDate && (
                    <>
                      <span className="sep">·</span>
                      <span className="due">
                        截止{' '}
                        <b className={`chip ${overdue ? 'overdue' : t.dueDate === today ? 'hot' : ''}`}>
                          {dueText(t.dueDate, today)}
                        </b>
                      </span>
                    </>
                  )}
                  <span className="item-actions">
                    <button title="编辑" onClick={() => startEdit(t)}>
                      ✎
                    </button>
                    <button title="删除" onClick={() => remove(t.id)}>
                      ✕
                    </button>
                  </span>
                </div>
              </div>
            </div>
          )
        })}
        {visible.length === 0 && <div className="empty-hint">暂无任务,添加一个开始今天吧。</div>}
      </div>

      <div className="todo-add">
        <input
          className="in"
          value={text}
          placeholder="添加任务,回车确认"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <div className="add-row2">
          <select
            className="field select-field"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            title="优先级"
          >
            {(['high', 'mid', 'low'] as Priority[]).map((p) => (
              <option key={p} value={p}>
                优先级 · {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <input
            className="field date-field"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            title="截止日期(可选)"
          />
          <span className="spacer" />
          <button className="btn solid" onClick={add}>
            添加
          </button>
        </div>
      </div>
    </div>
  )
}
