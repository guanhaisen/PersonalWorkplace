import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppData, ChatMsg, ChatSession, ChatUsage, Course, NoteEntry, Todo } from '../types'
import type { UpdateFn, ViewKey } from '../App'
import { todayStr, uid, nowLocalStr, DUE_AT_RE } from '../api'
import { readDailyReport, readWeeklyReport, searchNotes } from '../notesOrg'
import { queryStats, type StatsRange, type StatsScope } from '../aiStats'
import {
  AI_TOOLS,
  aiChat,
  aiChatStream,
  buildSystemPrompt,
  loadAiConfig,
  saveAiConfig,
  testAiConfig,
  type AiConfigInfo,
  type ToolCall,
  type UpstreamMessage,
} from '../ai'
import { MIKU_CELEBRATE_EVENT, MIKU_EXPRESS_EVENT, MIKU_SPEAK_EVENT, MIKU_THINKING_EVENT } from './MikuStage'
import MiniMarkdown from './MiniMarkdown'

interface Props {
  data: AppData
  update: UpdateFn
  onNavigate: (view: ViewKey) => void
  /** 提供时在头部显示 ✕(悬浮聊天窗用),点击回调关闭 */
  onClose?: () => void
  /** 挂载后自动聚焦输入框(悬浮聊天窗用) */
  autoFocus?: boolean
  /** bubble:悬浮球轻量模式——不显示历史,只显示输入框和最新一条回复的气泡 */
  variant?: 'panel' | 'bubble'
  /** bubble 模式气泡限高(px):手机键盘顶起后可见高度有限,不设则走 CSS 的 45vh */
  bubbleMaxHeight?: number
}

// 预置服务商:点击即把地址与推荐模型填入表单
const PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
]

const VIEWS: ViewKey[] = ['overview', 'todos', 'schedule', 'habits', 'notes', 'ai', 'raise', 'report']
const nowIso = () => new Date().toISOString()
// 上下文窗口:每次带最近 N 条会话消息;更早的压成滚动摘要
const CHAT_WINDOW = 12
const cutTitle = (s: string) => (s.length > 18 ? `${s.slice(0, 18)}…` : s)

export default function AiPanel({
  data,
  update,
  onNavigate,
  onClose,
  autoFocus,
  variant = 'panel',
  bubbleMaxHeight,
}: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolNote, setToolNote] = useState('')
  // 流式回复的实时增量:非空时气泡直接展示(面板与悬浮气泡共用)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState('')
  // 气泡模式:本次快速提问已收到过回复(打开时只显示输入条,不翻旧回复)
  const [quickReplied, setQuickReplied] = useState(false)
  const [cfg, setCfg] = useState<AiConfigInfo | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [memOpen, setMemOpen] = useState(false)
  const [sessOpen, setSessOpen] = useState(false)
  // 当前会话:空 = 跟随最近活跃的会话
  const [sessionId, setSessionId] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  // 工具循环内同步累积数据变更:React 状态要等渲染才更新,循环里读 dataRef
  // 拿到的是旧值,AI 会看不到本轮已执行的操作(快照在 runTurn 开始时重置)
  const toolSnapshotRef = useRef<AppData | null>(null)

  // executeTool 内用它代替 update:先把 updater 应用到快照,再走正常的防抖保存
  const applyToolUpdate: UpdateFn = (key, updater) => {
    const base = toolSnapshotRef.current
    if (base) toolSnapshotRef.current = { ...base, [key]: updater(base[key]) }
    update(key, updater)
  }

  // 配置状态决定空态引导与头部元信息;打开设置后重新拉取
  useEffect(() => {
    loadAiConfig()
      .then(setCfg)
      .catch(() => setCfg(null))
  }, [settingsOpen])

  // 命令面板「询问 Miku」:切到本页并聚焦输入框
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('workbench:ai-focus', focus)
    return () => window.removeEventListener('workbench:ai-focus', focus)
  }, [])

  // 悬浮聊天窗:挂载后聚焦输入框
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新消息 / 忙碌状态 / 流式增量变化时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data.chats.length, busy, toolNote, streamText])

  // 执行模型请求的工具调用,返回给模型的结果对象
  const executeTool = (call: ToolCall): unknown => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      return { ok: false, error: '参数不是有效 JSON' }
    }
    const d = toolSnapshotRef.current ?? dataRef.current
    const str = (v: unknown) => String(v ?? '').trim()
    switch (call.function.name) {
      case 'add_todo': {
        const title = str(args.title)
        if (!title) return { ok: false, error: 'title 为空' }
        const todoId = uid()
        applyToolUpdate('todos', (items) => [
          ...items,
          {
            id: todoId,
            title,
            done: false,
            dueDate: str(args.dueDate) || undefined,
            createdAt: nowIso(),
          },
        ])
        return { ok: true, todoId }
      }
      case 'complete_todo': {
        const id = str(args.id)
        if (!d.todos.some((t) => t.id === id)) return { ok: false, error: `未找到待办 ${id}` }
        applyToolUpdate('todos', (items) =>
          items.map((t) => (t.id === id && !t.done ? { ...t, done: true, completedAt: nowIso() } : t)),
        )
        // Miku 自己帮忙做完也庆祝一下(未启用 Live2D 时无监听方,无副作用)
        window.dispatchEvent(
          new CustomEvent(MIKU_CELEBRATE_EVENT, {
            detail: { label: `「${d.todos.find((t) => t.id === id)?.title ?? ''}」` },
          }),
        )
        return { ok: true }
      }
      case 'add_todos': {
        const items = Array.isArray(args.items) ? args.items : []
        const valid = items
          .map((it) => {
            const o = it as Record<string, unknown>
            return { title: str(o?.title), dueDate: str(o?.dueDate) || undefined }
          })
          .filter((it) => it.title)
        if (!valid.length) return { ok: false, error: 'items 为空或缺少 title' }
        // 上限保护:一次拆解 20 条足够,再多说明模型跑偏了
        const created = valid.slice(0, 20)
        applyToolUpdate('todos', (list) => [
          ...list,
          ...created.map((it) => ({
            id: uid(),
            title: it.title,
            done: false,
            dueDate: it.dueDate,
            createdAt: nowIso(),
          })),
        ])
        return { ok: true, count: created.length, note: valid.length > 20 ? '仅创建前 20 条' : undefined }
      }
      case 'update_todo': {
        const id = str(args.id)
        const todo = d.todos.find((t) => t.id === id)
        if (!todo) return { ok: false, error: `未找到待办 ${id}` }
        const patch: Partial<Todo> = {}
        const title = str(args.title)
        if (title) patch.title = title
        if (args.dueDate !== undefined) {
          const due = str(args.dueDate)
          if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: 'dueDate 需为 YYYY-MM-DD 或空字符串' }
          patch.dueDate = due || undefined
        }
        if (typeof args.done === 'boolean') {
          patch.done = args.done
          patch.completedAt = args.done ? nowIso() : undefined
        }
        if (!Object.keys(patch).length) return { ok: false, error: '没有给出任何要修改的字段' }
        applyToolUpdate('todos', (items) => items.map((t) => (t.id === id ? { ...t, ...patch } : t)))
        return { ok: true }
      }
      case 'delete_todo': {
        const id = str(args.id)
        if (!d.todos.some((t) => t.id === id)) return { ok: false, error: `未找到待办 ${id}` }
        applyToolUpdate('todos', (items) => items.filter((t) => t.id !== id))
        return { ok: true }
      }
      case 'add_course': {
        const name = str(args.name)
        const weekday = Math.round(Number(args.weekday))
        const start = str(args.start)
        const end = str(args.end)
        if (!name) return { ok: false, error: 'name 为空' }
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)
          return { ok: false, error: 'weekday 需为 1(周一)~7(周日)' }
        const valid = /^([01]?\d|2[0-3]):[0-5]\d$/.test(start) && /^([01]?\d|2[0-3]):[0-5]\d$/.test(end)
        if (!valid) return { ok: false, error: '时间格式需为 HH:mm,如 08:00' }
        // 补零到 HH:mm 再比较,避免 "9:00" 这类输入按字符串比错
        const s = start.padStart(5, '0')
        const e = end.padStart(5, '0')
        if (e <= s) return { ok: false, error: '结束时间需晚于开始时间' }
        applyToolUpdate('courses', (items) => [
          ...items,
          {
            id: uid(),
            name,
            weekday,
            start: s,
            end: e,
            location: str(args.location) || undefined,
            teacher: str(args.teacher) || undefined,
            color: items.length % 8,
          },
        ])
        return { ok: true }
      }
      case 'update_course': {
        const id = str(args.id)
        const course = d.courses.find((c) => c.id === id)
        if (!course) return { ok: false, error: `未找到课程 ${id}` }
        const patch: Partial<Course> = {}
        const name = str(args.name)
        if (name) patch.name = name
        if (args.weekday !== undefined) {
          const wd = Math.round(Number(args.weekday))
          if (!Number.isInteger(wd) || wd < 1 || wd > 7)
            return { ok: false, error: 'weekday 需为 1(周一)~7(周日)' }
          patch.weekday = wd
        }
        const start = str(args.start)
        const end = str(args.end)
        if (start && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(start)) return { ok: false, error: 'start 格式需为 HH:mm' }
        if (end && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(end)) return { ok: false, error: 'end 格式需为 HH:mm' }
        if (start) patch.start = start.padStart(5, '0')
        if (end) patch.end = end.padStart(5, '0')
        // 改了时间要保证改完后仍是合法区间(与 add_course 同样校验)
        const ns = patch.start ?? course.start
        const ne = patch.end ?? course.end
        if (ne <= ns) return { ok: false, error: '结束时间需晚于开始时间' }
        if (args.location !== undefined) patch.location = str(args.location) || undefined
        if (args.teacher !== undefined) patch.teacher = str(args.teacher) || undefined
        if (!Object.keys(patch).length) return { ok: false, error: '没有给出任何要修改的字段' }
        applyToolUpdate('courses', (items) => items.map((c) => (c.id === id ? { ...c, ...patch } : c)))
        return { ok: true }
      }
      case 'delete_course': {
        const id = str(args.id)
        if (!d.courses.some((c) => c.id === id)) return { ok: false, error: `未找到课程 ${id}` }
        applyToolUpdate('courses', (items) => items.filter((c) => c.id !== id))
        return { ok: true }
      }
      case 'create_habit': {
        const name = str(args.name)
        if (!name) return { ok: false, error: 'name 为空' }
        if (d.habits.some((h) => h.name === name)) return { ok: false, error: '同名习惯已存在' }
        applyToolUpdate('habits', (items) => [...items, { id: uid(), name, createdAt: nowIso(), records: {} }])
        return { ok: true }
      }
      case 'check_habit': {
        const id = str(args.id)
        const habit = d.habits.find((h) => h.id === id)
        if (!habit) return { ok: false, error: `未找到习惯 ${id}` }
        const today = todayStr()
        if (habit.records[today]) return { ok: true, note: '今天已打过卡' }
        applyToolUpdate('habits', (items) =>
          items.map((h) => (h.id === id ? { ...h, records: { ...h.records, [today]: true } } : h)),
        )
        window.dispatchEvent(
          new CustomEvent(MIKU_CELEBRATE_EVENT, { detail: { label: `「${habit.name}」` } }),
        )
        return { ok: true }
      }
      case 'add_reminder': {
        const title = str(args.title)
        const dueAt = str(args.dueAt)
        if (!title) return { ok: false, error: 'title 为空' }
        if (!DUE_AT_RE.test(dueAt)) return { ok: false, error: 'dueAt 需为 YYYY-MM-DD HH:mm 格式(24小时制)' }
        if (dueAt <= nowLocalStr()) return { ok: false, error: 'dueAt 必须晚于当前时刻,请按系统提示里的现在时刻推算' }
        applyToolUpdate('reminders', (items) => [...items, { id: uid(), title, dueAt, createdAt: nowIso() }])
        return { ok: true }
      }
      case 'delete_reminder': {
        const id = str(args.id)
        if (!d.reminders.some((r) => r.id === id)) return { ok: false, error: `未找到提醒 ${id}` }
        applyToolUpdate('reminders', (items) => items.filter((r) => r.id !== id))
        return { ok: true }
      }
      case 'add_note': {
        const content = str(args.content)
        if (!content) return { ok: false, error: 'content 为空' }
        const entry: NoteEntry = { id: uid(), content, date: todayStr(), ts: nowIso() }
        applyToolUpdate('notes', (items) => [...items, entry])
        // 通知随手记视图触发 AI 整理(带原始条目,补偿数据尚未回流到该视图 ref 的竞态)
        window.dispatchEvent(new CustomEvent('workbench:note-added', { detail: entry }))
        return { ok: true, noteId: entry.id, note: '已记入随手记,正在整理进今日日报' }
      }
      case 'search_notes': {
        const keyword = str(args.keyword)
        if (!keyword) return { ok: false, error: 'keyword 为空' }
        const { hits, total } = searchNotes(d, {
          keyword,
          dateFrom: str(args.dateFrom) || undefined,
          dateTo: str(args.dateTo) || undefined,
        })
        if (!total) return { ok: true, results: [], note: '没有匹配的随手记' }
        return {
          ok: true,
          total,
          results: hits,
          note: total > hits.length ? `共 ${total} 条,仅返回最早的 ${hits.length} 条` : undefined,
        }
      }
      case 'read_daily_report': {
        const date = str(args.date)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date 需为 YYYY-MM-DD' }
        return readDailyReport(d, date)
      }
      case 'read_weekly_report': {
        const week = str(args.week)
        if (!week) return { ok: false, error: 'week 为空' }
        return readWeeklyReport(d, week)
      }
      case 'switch_view': {
        const view = str(args.view) as ViewKey
        if (!VIEWS.includes(view)) return { ok: false, error: `未知页面 ${view}` }
        onNavigate(view)
        return { ok: true }
      }
      case 'query_stats': {
        const scope = str(args.scope) as StatsScope
        if (!['todos', 'habits', 'overview'].includes(scope))
          return { ok: false, error: 'scope 需为 todos / habits / overview' }
        const range = (str(args.range) || 'thisWeek') as StatsRange
        if (!['today', 'thisWeek', 'lastWeek', 'last7d', 'month', 'all'].includes(range))
          return { ok: false, error: 'range 需为 today/thisWeek/lastWeek/last7d/month/all' }
        return { ok: true, ...queryStats(d, { scope, range }) }
      }
      case 'remember': {
        const content = str(args.content)
        if (!content) return { ok: false, error: 'content 为空' }
        if (d.memories.some((m) => m.content === content)) return { ok: true, note: '这条已经在记忆里了' }
        applyToolUpdate('memories', (items) => [
          ...items,
          { id: uid(), content: content.slice(0, 200), createdAt: nowIso() },
        ])
        return { ok: true }
      }
      case 'forget_memory': {
        const id = str(args.id)
        if (!d.memories.some((m) => m.id === id)) return { ok: false, error: `未找到记忆 ${id}` }
        applyToolUpdate('memories', (items) => items.filter((m) => m.id !== id))
        return { ok: true }
      }
      default:
        return { ok: false, error: `未知工具 ${call.function.name}` }
    }
  }

  // 一轮完整对话:请求 → (工具调用 → 本地执行 → 回传结果 → 再请求)×≤8 → 最终文本。
  // 返回文本与整轮各次请求的 token 用量合计。
  const runTurn = async (
    userText: string,
    sid: string,
    signal: AbortSignal,
  ): Promise<{ text: string; usage: ChatUsage | null }> => {
    // 历史取当前会话已持久化的最近 12 条(此刻刚发送的这条已在镜像里,靠去尾兜掉);
    // 末尾若挂着没有回复的 user 消息(刚发送/上一轮失败留下的),先去掉,
    // 避免与本次新消息连成两条 user,部分严格的上游会拒绝
    const sessionMsgs = dataRef.current.chats.filter((m) => m.sessionId === sid)
    const persisted = sessionMsgs.slice(-CHAT_WINDOW)
    while (persisted.length > 0 && persisted[persisted.length - 1].role === 'user') persisted.pop()
    const history: UpstreamMessage[] = persisted.map((m) => ({ role: m.role, content: m.content }))
    // 窗口外的更早消息已压缩成滚动摘要(存在会话上),拼在 system 后延续语境
    const summaryBlock = dataRef.current.chatSessions.find((s) => s.id === sid)?.summary
      ? `\n\n【此前对话摘要】\n${dataRef.current.chatSessions.find((s) => s.id === sid)!.summary}`
      : ''
    // 工具快照从当前数据出发,本轮工具执行期间的变更会同步累积进去
    toolSnapshotRef.current = dataRef.current
    const messages: UpstreamMessage[] = [
      { role: 'system', content: buildSystemPrompt(toolSnapshotRef.current) + summaryBlock },
      ...history,
      { role: 'user', content: userText },
    ]
    let usage: ChatUsage | null = null
    const addUsage = (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
      usage = usage
        ? {
            prompt: usage.prompt + u.prompt_tokens,
            completion: usage.completion + u.completion_tokens,
            total: usage.total + u.total_tokens,
          }
        : { prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens }
    }
    for (let round = 0; round < 8; round++) {
      // 每轮开始清空流式缓冲;本轮的正文增量实时显示在气泡里
      setStreamText('')
      const res = await aiChatStream(
        { messages, tools: AI_TOOLS },
        { signal, onDelta: (d) => setStreamText((prev) => prev + d) },
      )
      if (res.usage) addUsage(res.usage)
      const msg = res.message
      if (!msg) throw new Error('AI 没有返回内容')
      if (msg.tool_calls?.length) {
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })
        for (const call of msg.tool_calls) {
          setToolNote(`正在执行工具 ${call.function.name}…`)
          let result: unknown
          try {
            result = executeTool(call)
          } catch (err) {
            result = { ok: false, error: String(err) }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
        }
        // 本地数据已变,用最新快照重建 system,便于模型准确确认结果
        messages[0] = {
          role: 'system',
          content: buildSystemPrompt(toolSnapshotRef.current ?? dataRef.current) + summaryBlock,
        }
        setToolNote('正在整理结果…')
        continue
      }
      return { text: (msg.content || '').trim() || '(AI 没有返回内容)', usage }
    }
    throw new Error('工具调用超过 8 轮,已中止')
  }

  // 没有活跃会话时建一个;同步写进 dataRef 镜像,保证紧随其后的 runTurn 能读到
  const ensureSession = (): string => {
    if (activeSessionId) return activeSessionId
    const s: ChatSession = { id: uid(), title: '', createdAt: nowIso(), updatedAt: nowIso() }
    update('chatSessions', (items) => [...items, s])
    dataRef.current = { ...dataRef.current, chatSessions: [...dataRef.current.chatSessions, s] }
    setSessionId(s.id)
    return s.id
  }

  // 新建会话(会话弹层入口):无论当前是否已有会话,都另起一个空会话并切过去
  const newSession = () => {
    if (busy) return
    const s: ChatSession = { id: uid(), title: '', createdAt: nowIso(), updatedAt: nowIso() }
    update('chatSessions', (items) => [...items, s])
    dataRef.current = { ...dataRef.current, chatSessions: [...dataRef.current.chatSessions, s] }
    setSessionId(s.id)
    setSessOpen(false)
  }

  // 后台给无标题会话起名:用首轮问答生成短标题;失败静默保留占位标题
  const autoTitle = (sid: string) => {
    const d = dataRef.current
    const s = d.chatSessions.find((x) => x.id === sid)
    if (!s || s.title) return
    const msgs = d.chats.filter((m) => m.sessionId === sid).slice(0, 4)
    if (!msgs.length) return
    void aiChat({
      messages: [
        {
          role: 'system',
          content:
            '给下面这段对话起一个不超过 12 个字的标题,概括用户的核心意图。只输出标题本身,不要标点、引号或任何解释。',
        },
        {
          role: 'user',
          content: msgs.map((m) => `${m.role === 'user' ? '用户' : 'Miku'}:${m.content.slice(0, 200)}`).join('\n'),
        },
      ],
    })
      .then((res) => {
        const t = res.message?.content
          ?.trim()
          .replace(/^["'「『#*\s]+|["'」』。.!!\s]+$/g, '')
          .slice(0, 16)
        if (!t) return
        // 只在标题仍为空时写入,不覆盖用户手动改名
        update('chatSessions', (items) => items.map((x) => (x.id === sid && !x.title ? { ...x, title: t } : x)))
      })
      .catch(() => {})
  }

  // 上下文压缩:窗口外未摘要的旧消息攒够 8 条时,后台把旧摘要与新消息滚动合并
  const maybeSummarize = (sid: string) => {
    const d = dataRef.current
    const s = d.chatSessions.find((x) => x.id === sid)
    const msgs = d.chats.filter((m) => m.sessionId === sid)
    const older = msgs.slice(0, Math.max(msgs.length - CHAT_WINDOW, 0))
    const unsummarized = older.filter((m) => !s?.summaryUntil || m.ts > s.summaryUntil)
    if (unsummarized.length < 8) return
    void (async () => {
      try {
        const res = await aiChat({
          messages: [
            {
              role: 'system',
              content:
                '你在维护一段长期对话的滚动摘要。把已有摘要与新消息合并成一份不超过 300 字的摘要:保留用户的稳定偏好、目标、决定与重要事实,去掉寒暄和琐碎细节。只输出摘要正文,不要解释。',
            },
            {
              role: 'user',
              content: [
                s?.summary ? `【已有摘要】\n${s.summary}\n` : '',
                '【新消息】',
                unsummarized
                  .map((m) => `${m.role === 'user' ? '用户' : 'Miku'}:${m.content.slice(0, 300)}`)
                  .join('\n'),
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        })
        const text = res.message?.content?.trim()
        if (!text) return
        update('chatSessions', (items) =>
          items.map((x) =>
            x.id === sid
              ? { ...x, summary: text.slice(0, 600), summaryUntil: unsummarized[unsummarized.length - 1].ts }
              : x,
          ),
        )
      } catch {
        // 摘要失败保持安静,下轮满足条件时再试
      }
    })()
  }

  // 发送与「重新生成/重试」共用的一轮回复;persistUser=false 用于重跑已有提问
  const runReply = async (userText: string, sid: string, persistUser: boolean) => {
    setError('')
    if (persistUser) {
      const userMsg: ChatMsg = { id: uid(), role: 'user', content: userText, ts: nowIso(), sessionId: sid }
      update('chats', (items) => [...items, userMsg])
      // 镜像同步:紧随其后的 runTurn/autoTitle 都同步读 dataRef
      dataRef.current = { ...dataRef.current, chats: [...dataRef.current.chats, userMsg] }
    }
    // 会话置为活跃;新会话还没有标题时,用首条提问截断占位
    update('chatSessions', (items) =>
      items.map((s) =>
        s.id === sid
          ? { ...s, updatedAt: nowIso(), title: s.title || (persistUser ? cutTitle(userText) : s.title) }
          : s,
      ),
    )
    setBusy(true)
    // Miku 进入思考状态:慢速轻晃直到回复回来(未启用 Live2D 时无监听方,无副作用)
    window.dispatchEvent(new CustomEvent(MIKU_THINKING_EVENT, { detail: { on: true } }))
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const { text: reply, usage } = await runTurn(userText, sid, abort.signal)
      const replyMsg: ChatMsg = {
        id: uid(),
        role: 'assistant',
        content: reply,
        ts: nowIso(),
        usage: usage ?? undefined,
        sessionId: sid,
      }
      update('chats', (items) => [...items, replyMsg])
      dataRef.current = { ...dataRef.current, chats: [...dataRef.current.chats, replyMsg] }
      // 让 Miku 悬浮球做个表情,并按回复长度开口念一会儿(未启用 Live2D 时无监听方,无副作用)
      window.dispatchEvent(new CustomEvent(MIKU_EXPRESS_EVENT))
      window.dispatchEvent(
        new CustomEvent(MIKU_SPEAK_EVENT, { detail: { ms: Math.min(Math.max(reply.length * 60, 1500), 4500) } }),
      )
      // 气泡模式:回复已到,弹出气泡
      setQuickReplied(true)
      autoTitle(sid)
      maybeSummarize(sid)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setError((err as Error)?.message || '请求失败,请重试')
    } finally {
      abortRef.current = null
      setBusy(false)
      setToolNote('')
      setStreamText('')
      window.dispatchEvent(new CustomEvent(MIKU_THINKING_EVENT, { detail: { on: false } }))
    }
  }

  const send = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    void runReply(text, ensureSession(), true)
  }

  // 重新生成:撤掉最后一条 AI 回复,用同一句提问重跑
  const regenerate = () => {
    if (busy) return
    const chatsNow = dataRef.current.chats
    if (chatsNow.length === 0 || chatsNow[chatsNow.length - 1].role !== 'assistant') return
    const lastUser = [...chatsNow].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    const sid = lastUser.sessionId ?? activeSessionId
    const nextChats = chatsNow.slice(0, -1)
    update('chats', () => nextChats)
    // runTurn 同步读 dataRef:先把删除落进镜像,避免旧回复仍留在本轮历史里
    dataRef.current = { ...dataRef.current, chats: nextChats }
    setSessionId(sid)
    void runReply(lastUser.content, sid, false)
  }

  // 失败重试:末尾挂着没得到回复的 user 消息时,重跑同一轮
  const retry = () => {
    if (busy) return
    const chatsNow = dataRef.current.chats
    const lastUser = [...chatsNow].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    const sid = lastUser.sessionId ?? activeSessionId
    setSessionId(sid)
    void runReply(lastUser.content, sid, false)
  }

  // 清空当前会话的消息(会话保留,摘要一并清除)
  const clear = () => {
    if (!activeSessionId) return
    const cur = data.chats.filter((m) => m.sessionId === activeSessionId)
    if (cur.length === 0) return
    if (window.confirm('清空当前会话的对话记录?(会话保留)')) {
      update('chats', (items) => items.filter((m) => m.sessionId !== activeSessionId))
      update('chatSessions', (items) =>
        items.map((s) => (s.id === activeSessionId ? { ...s, summary: undefined, summaryUntil: undefined } : s)),
      )
      dataRef.current = {
        ...dataRef.current,
        chats: dataRef.current.chats.filter((m) => m.sessionId !== activeSessionId),
        chatSessions: dataRef.current.chatSessions.map((s) =>
          s.id === activeSessionId ? { ...s, summary: undefined, summaryUntil: undefined } : s,
        ),
      }
    }
  }

  // 删除整个会话(连同其消息)
  const deleteSession = (sid: string) => {
    if (busy) return
    const count = data.chats.filter((m) => m.sessionId === sid).length
    if (!window.confirm(`删除这个会话?(含 ${count} 条消息)`)) return
    update('chatSessions', (items) => items.filter((s) => s.id !== sid))
    update('chats', (items) => items.filter((m) => m.sessionId !== sid))
    dataRef.current = {
      ...dataRef.current,
      chatSessions: dataRef.current.chatSessions.filter((s) => s.id !== sid),
      chats: dataRef.current.chats.filter((m) => m.sessionId !== sid),
    }
    if (sid === activeSessionId) setSessionId('')
  }

  // 会话:sessionId 为空表示「跟随最近活跃」;列表按最近活跃在前
  const sessionsSorted = useMemo(
    () => [...data.chatSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.chatSessions],
  )
  const activeSessionId = useMemo(
    () => (sessionId && data.chatSessions.some((s) => s.id === sessionId) ? sessionId : (sessionsSorted[0]?.id ?? '')),
    [sessionId, data.chatSessions, sessionsSorted],
  )
  const chats = useMemo(
    () => data.chats.filter((m) => m.sessionId === activeSessionId),
    [data.chats, activeSessionId],
  )
  const configured = !!cfg && !!cfg.baseUrl && !!cfg.model && cfg.hasKey

  // 对话累计 token:所有持久化回复的 usage 之和
  const usageTotal = useMemo(
    () =>
      data.chats.reduce(
        (acc, m) =>
          m.usage
            ? {
                prompt: acc.prompt + m.usage.prompt,
                completion: acc.completion + m.usage.completion,
                total: acc.total + m.usage.total,
              }
            : acc,
        { prompt: 0, completion: 0, total: 0 },
      ),
    [data.chats],
  )
  const lastUsage = useMemo(() => [...data.chats].reverse().find((m) => m.usage)?.usage, [data.chats])

  // 点弹层外其他位置时收起用量/记忆/会话下拉
  useEffect(() => {
    if (!usageOpen && !memOpen && !sessOpen) return
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.ai-model-wrap')) setUsageOpen(false)
      if (!t.closest('.ai-mem-wrap')) setMemOpen(false)
      if (!t.closest('.ai-sess-wrap')) setSessOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [usageOpen, memOpen, sessOpen])

  // 轻量气泡模式:悬浮球点击后的快速提问——不显示历史,只显示输入条,
  // 最新回复/工具进度/错误都以气泡形式浮在输入条上方,指向 Miku。
  // 对话仍走同一套持久化 chats(完整面板里可见上下文),工具调用逻辑完全复用。
  if (variant === 'bubble') {
    const lastAssistant = [...chats].reverse().find((m) => m.role === 'assistant')
    return (
      <div className="miku-quick" onMouseDown={(e) => e.stopPropagation()}>
        {(busy || error || quickReplied) && (
          <div
            className={`miku-bubble${error ? ' err' : ''}`}
            style={bubbleMaxHeight !== undefined ? { maxHeight: bubbleMaxHeight } : undefined}
          >
            {busy ? (
              streamText ? (
                <MiniMarkdown text={streamText} />
              ) : (
                toolNote || '思考中…'
              )
            ) : error ? (
              error
            ) : lastAssistant ? (
              <MiniMarkdown text={lastAssistant.content} />
            ) : (
              ''
            )}
          </div>
        )}
        {!configured && (
          <div className="miku-quick-cfg">
            还没配置 AI 服务,
            <button className="miku-quick-cfg-btn" onClick={() => setSettingsOpen(true)}>
              去配置
            </button>
          </div>
        )}
        <div className="miku-quick-bar">
          <input
            ref={inputRef}
            className="miku-quick-in"
            value={input}
            placeholder={configured ? '问 Miku 点什么…' : '先配置 AI 服务'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
            }}
            disabled={busy}
          />
          {busy ? (
            <button className="miku-quick-btn stop" onClick={() => abortRef.current?.abort()} title="停止">
              ■
            </button>
          ) : (
            <button className="miku-quick-btn" onClick={send} disabled={!input.trim()} title="发送">
              ↑
            </button>
          )}
        </div>
        {settingsOpen && <AiSettings onClose={() => setSettingsOpen(false)} onSaved={setCfg} />}
      </div>
    )
  }

  return (
    <div className="panel panel-ai">
      <header className="p-head">
        <h2>
          <span className="tag">AI</span>
          <i>/</i>Miku
        </h2>
        <div className="ai-head-actions">
          {configured && (
            <div className="ai-model-wrap">
              <button
                className="ai-model-pill"
                title="模型与 Token 用量"
                onClick={() => setUsageOpen((v) => !v)}
              >
                <span className={`ai-model-dot ${busy ? 'busy' : ''} ${error ? 'err' : ''}`} />
                <span className="ai-model-name">{cfg!.model}</span>
                <svg className="ai-model-chev" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path
                    d="M1.5 3l2.5 2.5L6.5 3"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {usageOpen && (
                <div className="ai-usage-pop">
                  <div className="ai-usage-row">
                    <span>对话累计</span>
                    <b>{usageTotal.total.toLocaleString()}</b>
                  </div>
                  <div className="ai-usage-row">
                    <span>提示 / 生成</span>
                    <span>
                      {usageTotal.prompt.toLocaleString()} / {usageTotal.completion.toLocaleString()}
                    </span>
                  </div>
                  {lastUsage && (
                    <div className="ai-usage-row">
                      <span>最近一轮</span>
                      <span>{lastUsage.total.toLocaleString()}</span>
                    </div>
                  )}
                  {usageTotal.total === 0 && <div className="ai-usage-empty">发送消息后显示用量</div>}
                </div>
              )}
            </div>
          )}
          <div className="ai-sess-wrap">
            <button
              className="ai-head-btn"
              onClick={() => setSessOpen((v) => !v)}
              title="历史会话"
            >
              会话{sessionsSorted.length > 0 ? ` ${sessionsSorted.length}` : ''}
            </button>
            {sessOpen && (
              <div className="ai-sess-pop">
                <button className="ai-sess-new" onClick={newSession} disabled={busy}>
                  ＋ 新对话
                </button>
                <div className="ai-sess-list">
                  {sessionsSorted.map((s) => {
                    const count = data.chats.filter((m) => m.sessionId === s.id).length
                    return (
                      <div key={s.id} className={`ai-sess-row ${s.id === activeSessionId ? 'on' : ''}`}>
                        <button
                          className="ai-sess-main"
                          disabled={busy}
                          onClick={() => {
                            setSessionId(s.id)
                            setSessOpen(false)
                          }}
                        >
                          <span className="ai-sess-title">{s.title || '未命名对话'}</span>
                          <span className="ai-sess-meta">{count > 0 ? `${count} 条` : '空'}</span>
                        </button>
                        <button
                          className="ai-sess-del"
                          title="删除此会话"
                          disabled={busy}
                          onClick={() => deleteSession(s.id)}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                  {sessionsSorted.length === 0 && <div className="ai-sess-empty">还没有对话</div>}
                </div>
              </div>
            )}
          </div>
          <div className="ai-mem-wrap">
            <button className="ai-head-btn" onClick={() => setMemOpen((v) => !v)}>
              记忆{data.memories.length > 0 ? ` ${data.memories.length}` : ''}
            </button>
            {memOpen && (
              <div className="ai-mem-pop">
                <div className="ai-mem-title">长期记忆</div>
                {data.memories.length === 0 ? (
                  <div className="ai-mem-empty">还没有记忆。聊天时告诉 Miku 你的偏好、目标或背景,它会记在这里。</div>
                ) : (
                  data.memories.map((m) => (
                    <div key={m.id} className="ai-mem-row">
                      <span className="ai-mem-text">{m.content}</span>
                      <button
                        className="ai-mem-del"
                        title="删除这条记忆"
                        onClick={() => update('memories', (items) => items.filter((x) => x.id !== m.id))}
                      >
                        删
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button className="ai-head-btn" onClick={clear} title="清空对话记录">
            清空
          </button>
          <button className="ai-head-btn" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
          {onClose && (
            <button className="ai-head-btn" onClick={onClose} title="关闭">
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="ai-msgs" ref={listRef}>
        {chats.length === 0 && !busy && (
          <div className="ai-welcome">
            <p>问数据、记待办、排课表、打卡习惯,交给 AI 完成。</p>
            <p className="ai-welcome-eg">试试「我这周效率怎么样」,或「帮我加一条明天交周报的待办」。</p>
            {cfg && !configured && (
              <button className="btn solid" onClick={() => setSettingsOpen(true)}>
                先去配置 AI 服务
              </button>
            )}
          </div>
        )}
        {chats.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <div className="ai-bubble">{m.role === 'assistant' ? <MiniMarkdown text={m.content} /> : m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="ai-msg assistant">
            <div className="ai-bubble ai-typing">
              {streamText ? (
                <MiniMarkdown text={streamText} />
              ) : (
                <>
                  <span className="ai-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {toolNote || '思考中…'}
                </>
              )}
            </div>
          </div>
        )}
        {!busy && chats.length > 0 && chats[chats.length - 1].role === 'assistant' && (
          <div className="ai-msg assistant">
            <button className="ai-regen" onClick={regenerate} title="撤掉这条回复,重新作答">
              ↺ 重新生成
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="ai-error">
          <span>{error}</span>
          {chats.length > 0 && chats[chats.length - 1].role === 'user' && (
            <button onClick={retry}>重试</button>
          )}
          <button onClick={() => setError('')}>知道了</button>
        </div>
      )}

      <div className="ai-input-row">
        <input
          ref={inputRef}
          className="in"
          value={input}
          placeholder={configured ? '问点什么,或让 AI 帮你记一笔…' : '先在「设置」里配置 AI 服务'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
          }}
          disabled={busy}
        />
        {busy ? (
          <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button className="btn solid" onClick={send} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>

      {settingsOpen && <AiSettings onClose={() => setSettingsOpen(false)} onSaved={setCfg} />}
    </div>
  )
}

// ---------- 设置弹窗 ----------

function AiSettings({ onClose, onSaved }: { onClose: () => void; onSaved: (c: AiConfigInfo) => void }) {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const baseUrlRef = useRef<HTMLInputElement>(null)

  // 当前接口地址命中的预置;都不匹配则「自定义」高亮
  const activePreset = PRESETS.findIndex((p) => p.baseUrl === baseUrl)
  const isCustom = baseUrl.trim() !== '' && activePreset === -1

  useEffect(() => {
    loadAiConfig()
      .then((c) => {
        setBaseUrl(c.baseUrl)
        setModel(c.model)
        setHasKey(c.hasKey)
      })
      .catch(() => undefined)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickCustom = () => {
    setBaseUrl('')
    setModel('')
    requestAnimationFrame(() => baseUrlRef.current?.focus())
  }

  const persist = async () => {
    const saved = await saveAiConfig({ baseUrl, model, apiKey })
    onSaved(saved)
    setHasKey(saved.hasKey)
    setApiKey('')
    return saved
  }

  const save = async () => {
    setSaving(true)
    try {
      await persist()
      onClose()
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    // 测试前先保存,保证测的就是表单里的配置
    setTesting(true)
    setTestResult(null)
    try {
      await persist()
      const r = await testAiConfig()
      setTestResult({ ok: !!r.ok, message: r.ok ? `连接成功(${r.model})` : r.message || '连接失败' })
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  // 立即清除服务端已保存的 Key(表单其余字段不动)
  const clearKey = async () => {
    setSaving(true)
    setTestResult(null)
    try {
      const saved = await saveAiConfig({ baseUrl, model, apiKey: '', clearKey: true })
      onSaved(saved)
      setHasKey(saved.hasKey)
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="ai-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="p-head">
          <h2>
            <span className="tag">AI</span>
            <i>/</i>服务配置
          </h2>
          <span className="p-meta">OpenAI 兼容</span>
        </header>

        <div className="ai-presets">
          {PRESETS.map((p, i) => (
            <button
              key={p.label}
              className={`ai-preset ${i === activePreset ? 'active' : ''}`}
              title={`填入 ${p.baseUrl} · ${p.model}`}
              onClick={() => {
                setBaseUrl(p.baseUrl)
                setModel(p.model)
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            className={`ai-preset ${isCustom ? 'active' : ''}`}
            title="手动填写任意 OpenAI 兼容服务(如 Ollama、OneAPI、中转站)"
            onClick={pickCustom}
          >
            自定义
          </button>
        </div>

        <label className="ai-field">
          <span>接口地址</span>
          <input
            ref={baseUrlRef}
            className="in"
            value={baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label className="ai-field">
          <span>模型名</span>
          <input className="in" value={model} placeholder="gpt-4o-mini" onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="ai-field">
          <span className="ai-field-head">
            API Key
            {hasKey && (
              <button
                type="button"
                className="ai-key-clear"
                disabled={saving || testing}
                title="删除服务端已保存的 Key"
                onClick={(e) => {
                  e.preventDefault() // 在 label 内,别触发聚焦输入框
                  clearKey()
                }}
              >
                清除
              </button>
            )}
          </span>
          <input
            className="in"
            type="password"
            value={apiKey}
            placeholder={hasKey ? '已保存,留空则不修改' : 'sk-…'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        {testResult && <div className={`ai-test ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.message}</div>}

        <p className="ai-privacy">Key 只保存在本机服务端数据库(按账号隔离);对话时你的数据摘要会发送给你配置的服务商。</p>

        <div className="ai-modal-foot">
          <button className="btn ghost" onClick={test} disabled={testing || saving}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn solid" onClick={save} disabled={saving || testing}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
