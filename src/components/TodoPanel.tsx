import { useEffect, useMemo, useRef, useState } from 'react'
import type { Todo } from '../types'
import { todayStr, uid } from '../api'
import type { UpdateFn } from '../App'
import { IconCheck } from './icons'
import { celebrateMiku } from './MikuStage'

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

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function TodoPanel({ todos, update }: Props) {
  const [text, setText] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [filter, setFilter] = useState<Filter>('active')
  // 「按截止日」排序开关:会话内生效。默认保持手动拖拽顺序(数组序即显示序),
  // 开启后未完成任务按截止日升序(无日期沉底,同日期保持手动序),拖拽禁用
  const [sortByDue, setSortByDue] = useState(false)
  // 行内编辑:标题 + 截止日期(原先改日期只能删除重加)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editingDue, setEditingDue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  // 撤销:删除/勾选/清空已完成前的整包快照,5s 内可一键还原(单槽,新操作顶掉旧的)
  const [undo, setUndo] = useState<{ id: number; label: string; snapshot: Todo[] } | null>(null)
  const undoTimer = useRef<number | null>(null)

  const today = todayStr()

  // 全局快捷键:聚焦「新建待办」输入框(延迟一拍,等视图切换渲染完成)
  useEffect(() => {
    const onFocusInput = () => setTimeout(() => addInputRef.current?.focus(), 60)
    window.addEventListener('workbench:focus-todo-input', onFocusInput)
    return () => window.removeEventListener('workbench:focus-todo-input', onFocusInput)
  }, [])

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    },
    [],
  )

  // 操作前快照当前列表,浮出撤销条(5s 自动失效;连续操作以最后一次为准)
  const pushUndo = (label: string) => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    setUndo({ id: Date.now(), label, snapshot: todos })
    undoTimer.current = window.setTimeout(() => setUndo(null), 5000)
  }

  const applyUndo = () => {
    const u = undo
    if (!u) return
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    setUndo(null)
    update('todos', () => u.snapshot)
  }

  // 显示顺序:已完成按完成时间降序(供今天/更早分组);按截止日模式下未完成任务
  // 以截止日升序(无日期沉底),稳定排序保证同日期/无日期之间手动相对顺序不乱
  const visible = useMemo(() => {
    const list = todos.filter((t) => {
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
    if (filter === 'done') {
      return [...list].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    }
    if (sortByDue) {
      return [...list].sort((a, b) => {
        const da = !a.done && a.dueDate ? a.dueDate : '9999-12-31'
        const db = !b.done && b.dueDate ? b.dueDate : '9999-12-31'
        return da < db ? -1 : da > db ? 1 : 0
      })
    }
    return list
  }, [todos, filter, today, sortByDue])

  const activeCount = todos.filter((t) => !t.done).length
  const overdueCount = todos.filter((t) => !t.done && !!t.dueDate && t.dueDate < today).length
  const doneCount = todos.length - activeCount
  // 今日进度:分母 = 今天已完成 + 今天到期/过期未完成,分母为 0 不显示进度条
  const doneToday = todos.filter((t) => t.done && (t.completedAt ?? '').slice(0, 10) === today).length
  const dueTodayActive = todos.filter((t) => !t.done && !!t.dueDate && t.dueDate <= today).length
  const todayTotal = doneToday + dueTodayActive
  const todayPct = todayTotal ? Math.round((doneToday / todayTotal) * 100) : 0

  // 清空已完成任务
  const clearDone = () => {
    if (doneCount === 0) return
    if (!window.confirm(`清空 ${doneCount} 项已完成任务?`)) return
    pushUndo(`已清空 ${doneCount} 项已完成`)
    update('todos', (items) => items.filter((t) => !t.done))
  }

  const add = () => {
    const title = text.trim()
    if (!title) return
    const todo: Todo = {
      id: uid(),
      title,
      done: false,
      dueDate: dueDate || undefined,
      createdAt: new Date().toISOString(),
    }
    update('todos', (items) => [todo, ...items])
    setText('')
    setDueDate('')
    // 连续录入:输入框保持焦点,日期清空后快捷 chip 高亮自然熄灭
  }

  const toggle = (id: string) => {
    const todo = todos.find((t) => t.id === id)
    if (!todo) return
    // 勾选完成时让 Miku 庆祝一下(取消完成不庆祝);label 供养成页气泡播报事项名
    if (!todo.done) celebrateMiku(`「${todo.title}」`)
    pushUndo(todo.done ? `已恢复「${todo.title}」` : `已完成「${todo.title}」`)
    update('todos', (items) =>
      items.map((t) =>
        t.id === id
          ? { ...t, done: !t.done, completedAt: !t.done ? new Date().toISOString() : undefined }
          : t,
      ),
    )
  }

  const remove = (id: string) => {
    const todo = todos.find((t) => t.id === id)
    pushUndo(todo ? `已删除「${todo.title}」` : '已删除任务')
    update('todos', (items) => items.filter((t) => t.id !== id))
  }

  const startEdit = (t: Todo) => {
    setEditingId(t.id)
    setEditingText(t.title)
    setEditingDue(t.dueDate ?? '')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingText('')
    setEditingDue('')
  }

  const saveEdit = () => {
    const id = editingId
    const title = editingText.trim()
    if (!id || !title) {
      cancelEdit()
      return
    }
    const due = editingDue || undefined
    update('todos', (items) => items.map((t) => (t.id === id ? { ...t, title, dueDate: due } : t)))
    cancelEdit()
  }

  // 拖拽排序:把 source 移动到 target 的 before/after 位置(按截止日模式下禁用)
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

  // 空状态文案:按时段给「进行中」空列表一句陪伴话,其余 tab 各一句
  const hour = new Date().getHours()
  const emptyMain: Record<Filter, string> = {
    active:
      hour < 6
        ? '夜深了,今天没有任务啦'
        : hour < 12
          ? '上午好,加一件今天想做的事吧'
          : hour < 18
            ? '下午好,列表空空的,真舒服'
            : '晚上好,今天收工啦',
    overdue: '没有过期任务,节奏保持得很好',
    done: '还没有完成的任务,去勾掉一件吧',
    all: '暂无任务,添加一个开始今天吧',
  }

  // 已完成 tab 按「今天 / 更早」分组(completedAt 缺失的旧数据归入更早)
  const doneGroups =
    filter === 'done'
      ? [
          {
            key: 'today',
            label: `今天 · ${visible.filter((t) => (t.completedAt ?? '').slice(0, 10) === today).length}`,
            items: visible.filter((t) => (t.completedAt ?? '').slice(0, 10) === today),
          },
          {
            key: 'earlier',
            label: `更早 · ${visible.filter((t) => (t.completedAt ?? '').slice(0, 10) !== today).length}`,
            items: visible.filter((t) => (t.completedAt ?? '').slice(0, 10) !== today),
          },
        ].filter((g) => g.items.length > 0)
      : [{ key: 'all', label: '', items: visible }]

  const renderTask = (t: Todo) => {
    const overdue = !t.done && !!t.dueDate && t.dueDate < today
    const urgent = overdue || (!t.done && t.dueDate === today)
    return (
      <div
        key={t.id}
        className={[
          'task',
          t.done ? 'is-done' : '',
          urgent ? 'urgent' : '',
          dragId === t.id ? 'dragging' : '',
          dropHint?.id === t.id ? `drop-${dropHint.pos}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
        draggable={editingId !== t.id && !sortByDue}
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
          aria-label={t.done ? '取消完成' : '标记完成'}
        >
          {t.done && <IconCheck />}
        </button>
        <div className="task-body">
          {editingId === t.id ? (
            <div className="task-editing">
              <input
                className="edit-input"
                autoFocus
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit()
                  if (e.key === 'Escape') cancelEdit()
                }}
              />
              <div className="edit-row2">
                <input
                  className="field date-field"
                  type="date"
                  value={editingDue}
                  onChange={(e) => setEditingDue(e.target.value)}
                  title="截止日期(留空清除)"
                />
                <span className="spacer" />
                <button className="btn ghost" onClick={cancelEdit}>
                  取消
                </button>
                <button className="btn solid" onClick={saveEdit}>
                  保存
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="task-tt" onDoubleClick={() => startEdit(t)}>
                {t.title}
              </div>
              <div className="task-mt">
                {t.dueDate && (
                  <span className="due">
                    截止{' '}
                    <b className={`chip ${overdue ? 'overdue' : t.dueDate === today ? 'hot' : ''}`}>
                      {dueText(t.dueDate, today)}
                    </b>
                  </span>
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
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="panel panel-todo">
      <header className="p-head">
        <h2>
          <span className="tag">TODO</span>
          <i>/</i>待办任务
        </h2>
        <span className="p-meta">
          {todayTotal > 0 && (
            <>
              今日 {doneToday}/{todayTotal} ·{' '}
            </>
          )}
          {activeCount} 项进行中
        </span>
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
        <span className="tabs-tail">
          <button
            className={`tab-sort${sortByDue ? ' on' : ''}`}
            onClick={() => setSortByDue((v) => !v)}
            title={sortByDue ? '切回手动排序(可拖拽)' : '未完成任务按截止日升序'}
          >
            按截止日
          </button>
          {doneCount > 0 && (
            <button className="tab-clear" onClick={clearDone} title="删除全部已完成任务">
              清空已完成
            </button>
          )}
        </span>
      </div>

      {todayTotal > 0 && (
        <div className="today-bar" title={`今日进度 ${doneToday}/${todayTotal}`}>
          <i style={{ width: `${todayPct}%` }} />
        </div>
      )}

      {/* 添加表单上移到列表上方(高频动作不再隔整屏空白);移动端整页滚动时
          列表自然高度,表单天然落在列表后的拇指区 */}
      <div className="todo-add">
        <input
          ref={addInputRef}
          className="in"
          value={text}
          placeholder="添加任务,回车确认"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <div className="add-row2">
          <button
            type="button"
            className={`add-chip${dueDate === today ? ' on' : ''}`}
            onClick={() => setDueDate((d) => (d === today ? '' : today))}
          >
            今天
          </button>
          <button
            type="button"
            className={`add-chip${dueDate === addDays(today, 1) ? ' on' : ''}`}
            onClick={() => setDueDate((d) => (d === addDays(today, 1) ? '' : addDays(today, 1)))}
          >
            明天
          </button>
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

      <div className={`task-list${sortByDue ? ' sorted' : ''}`}>
        {doneGroups.map((g) => (
          <div key={g.key} className="task-group">
            {g.label && <div className="task-group-head">{g.label}</div>}
            {g.items.map(renderTask)}
          </div>
        ))}
        {visible.length === 0 && (
          <div className="empty-hint todo-empty">
            <span className="todo-empty-art" aria-hidden="true">
              ♪
            </span>
            <p className="todo-empty-main">{emptyMain[filter]}</p>
            {filter === 'active' && <p className="todo-empty-sub">去摸摸 Miku 也可以哦</p>}
          </div>
        )}
      </div>

      {undo && (
        <div key={undo.id} className="todo-undo" role="status">
          <span className="todo-undo-text">{undo.label}</span>
          <button onClick={applyUndo}>撤销</button>
        </div>
      )}
    </div>
  )
}
