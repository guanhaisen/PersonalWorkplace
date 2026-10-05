// 总览页的随手记卡片:只放快速输入框与一行状态;日报/周报的整理与展示都在「随手记」页。
// 编排器(org)由 App 统一持有,与随手记页共享同一条整理队列,避免两份实例重复触发。
import { useRef, useState } from 'react'
import type { AppData } from '../types'
import { todayStr } from '../api'
import type { NotesOrg } from '../notesOrg'

interface Props {
  data: AppData
  org: NotesOrg
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtLocal = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export default function QuickNoteCard({ data, org }: Props) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const today = todayStr()

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    org.submitNote(text)
    setDraft('')
  }

  const todayCount = data.notes.filter((n) => n.date === today).length
  const todayReport = data.reports.find((r) => r.kind === 'daily' && r.id === today)
  const pending = todayReport?.ai ? (todayReport.pendingIds?.length ?? 0) : 0

  return (
    <div className="panel panel-quicknote">
      <header className="p-head">
        <h2>
          <span className="tag">NOTES</span>
          <i>/</i>随手记
        </h2>
        {org.merging[today] ? (
          <span className="note-busy">Miku 正在整理…</span>
        ) : (
          <span className="p-meta">
            今日 {todayCount} 条
            {pending > 0 && ` · ${pending} 条待整理`}
          </span>
        )}
      </header>
      <div className="note-capture">
        <textarea
          ref={inputRef}
          className="note-input"
          rows={3}
          value={draft}
          maxLength={2000}
          placeholder="记点什么…(Enter 提交,AI 自动整理进今日日报)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="note-capture-foot">
          <span className="note-hint">想法、进展、待跟进的事,随手记下就好</span>
          <button className="btn solid note-send" onClick={submit} disabled={!draft.trim()}>
            记一笔
          </button>
        </div>
      </div>
      <div className="quicknote-foot">
        {todayReport?.ai ? (
          <span>日报已整理 · {fmtLocal(todayReport.updatedAt)}</span>
        ) : todayReport ? (
          <span>日报本地备份 · 未整理</span>
        ) : (
          <span>日报与周报在「随手记」页查看</span>
        )}
      </div>
    </div>
  )
}
