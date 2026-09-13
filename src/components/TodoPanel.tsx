import { useMemo, useState } from 'react'
import type { Priority, Todo } from '../types'
import { todayStr, uid } from '../api'
import type { UpdateFn } from '../App'
import { IconCheck, IconFlag } from './icons'

const PRIORITY_LABEL: Record<Priority, string> = { high: '高', mid: '中', low: '低' }
const PRIORITY_ORDER: Record<Priority, number> = { high: 0, mid: 1, low: 2 }

type Filter = 'active' | 'done' | 'all'

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

  const today = todayStr()

  const visible = useMemo(() => {
    const filtered = todos.filter((t) =>
      filter === 'all' ? true : filter === 'done' ? t.done : !t.done,
    )
    // 未完成的在前,同组内高优先级在前
    return [...filtered].sort(
      (a, b) => Number(a.done) - Number(b.done) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    )
  }, [todos, filter])

  const activeCount = todos.filter((t) => !t.done).length

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
            ['done', '已完成', todos.length - activeCount],
            ['all', '全部', todos.length],
          ] as [Filter, string, number][]
        ).map(([f, label, count]) => (
          <button key={f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {label} <em>{count}</em>
          </button>
        ))}
      </div>

      <div className="task-list">
        {visible.map((t) => {
          const overdue = !t.done && !!t.dueDate && t.dueDate < today
          return (
            <div key={t.id} className={`task ${t.done ? 'is-done' : ''}`}>
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
