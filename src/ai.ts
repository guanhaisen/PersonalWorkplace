// AI 助手:配置接口封装、OpenAI 兼容请求、工具 Schema 与数据快照构建。
// 密钥只存在服务端(data/ai-config.json),前端只传消息与工具定义。
import type { AppData } from './types'
import { streak, todayStr } from './api'

// ---------- 配置 ----------

export interface AiConfigInfo {
  baseUrl: string
  model: string
  hasKey: boolean
}

export async function loadAiConfig(): Promise<AiConfigInfo> {
  const res = await fetch('/api/ai/config')
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export function saveAiConfig(cfg: {
  baseUrl: string
  model: string
  apiKey: string
  /** 传 true 清除已保存的 Key;apiKey 留空只是「不修改」 */
  clearKey?: boolean
}): Promise<AiConfigInfo> {
  return aiReq('/api/ai/config', cfg, 'PUT')
}

export function testAiConfig(): Promise<{ ok: boolean; model?: string; message?: string }> {
  return aiReq('/api/ai/test', {})
}

// ---------- 模型消息 ----------

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI 兼容的消息结构;tool 消息携带 tool_call_id 回传执行结果 */
export interface UpstreamMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

async function aiReq<T>(url: string, body: unknown, method: 'POST' | 'PUT' = 'POST', signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  // 服务端把上游/网络错误翻译成 message 字段,优先透传给界面
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message || `${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  return data as T
}

export function aiChat(
  body: { messages: UpstreamMessage[]; tools?: unknown[] },
  signal?: AbortSignal,
): Promise<{
  message: UpstreamMessage | null
  /** OpenAI 兼容接口返回的 token 用量,部分服务商可能不给 */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
}> {
  return aiReq('/api/ai/chat', body, 'POST', signal)
}

// ---------- 工具定义(前端执行) ----------

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ name, description, parameters: { type: 'object', properties, required } })

export const AI_TOOLS = [
  {
    type: 'function',
    function: fn('add_todo', '新建一条待办任务', {
      title: { type: 'string', description: '任务内容' },
      priority: { type: 'string', enum: ['high', 'mid', 'low'], description: '优先级,默认 low' },
      dueDate: { type: 'string', description: '截止日期 YYYY-MM-DD,可选' },
    }, ['title']),
  },
  {
    type: 'function',
    function: fn('complete_todo', '把一条待办标记为完成', {
      id: { type: 'string', description: '待办 id,来自数据快照' },
    }, ['id']),
  },
  {
    type: 'function',
    function: fn('delete_todo', '删除一条待办', {
      id: { type: 'string', description: '待办 id,来自数据快照' },
    }, ['id']),
  },
  {
    type: 'function',
    function: fn('add_note', '新建一条笔记(置于笔记列表最前)', {
      content: { type: 'string', description: '笔记正文' },
    }, ['content']),
  },
  {
    type: 'function',
    function: fn('create_habit', '创建一个习惯(用于每日打卡)', {
      name: { type: 'string', description: '习惯名称' },
    }, ['name']),
  },
  {
    type: 'function',
    function: fn('check_habit', '给一个习惯打卡今天', {
      id: { type: 'string', description: '习惯 id,来自数据快照' },
    }, ['id']),
  },
  {
    type: 'function',
    function: fn('switch_view', '切换到某个页面展示给用户', {
      view: { type: 'string', enum: ['overview', 'todos', 'notes', 'focus', 'habits', 'ai'], description: '目标页面' },
    }, ['view']),
  },
]

// ---------- System Prompt 与数据快照 ----------

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 把当前全部数据摘要成紧凑文本,供模型读取(id 均为工具可引用的真实 id) */
export function buildDataSnapshot(data: AppData): string {
  const now = new Date()
  const today = todayStr(now)
  const lines: string[] = []

  const undone = data.todos.filter((t) => !t.done).length
  lines.push(`[待办] 共 ${data.todos.length} 条,未完成 ${undone} 条`)
  for (const t of data.todos.slice(0, 80)) {
    const marks = [
      t.done ? '已完成' : `优先级${t.priority}`,
      t.dueDate ? `截止 ${t.dueDate}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    lines.push(`- id:${t.id} ${cut(t.title, 60)}${marks ? `(${marks})` : ''}`)
  }

  lines.push('')
  lines.push(`[习惯] 共 ${data.habits.length} 个`)
  for (const h of data.habits) {
    const done = h.records[today] ? '今日已打卡' : '今日未打卡'
    const s = streak(h.records)
    lines.push(`- id:${h.id} ${cut(h.name, 40)}(${done},连续 ${s} 天)`)
  }

  lines.push('')
  lines.push(`[笔记] 共 ${data.notes.length} 条(按更新时间,仅展示前 30 条)`)
  const notes = [...data.notes]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30)
  for (const n of notes) lines.push(`- id:${n.id}${n.pinned ? '[置顶]' : ''} ${cut(n.content.replace(/\s+/g, ' '), 120)}`)

  lines.push('')
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)) // 本周一
  let todayMin = 0
  let weekMin = 0
  for (const p of data.pomodoros) {
    if (p.date === today) todayMin += p.minutes
    if (p.date >= todayStr(weekStart)) weekMin += p.minutes
  }
  lines.push(`[番茄钟] 今日 ${todayMin} 分钟,本周(周一起) ${weekMin} 分钟`)

  return lines.join('\n')
}

export function buildSystemPrompt(data: AppData): string {
  const now = new Date()
  const today = todayStr(now)
  return [
    `你是「个人工作台」(一个本地个人效率工具,含待办/笔记/习惯打卡/番茄钟)里的 AI 助手。今天是 ${today} 星期${WEEKDAYS[now.getDay()]}。`,
    '下面是用户的实时数据快照。回答数据相关问题时以快照为准;用户要求修改数据时调用工具完成,不要编造 id,只用快照里出现的 id。',
    '修改完成后用一句话向用户确认;闲聊与问答保持简洁,全程使用中文。',
    '',
    buildDataSnapshot(data),
  ].join('\n')
}

// ---------- 周报点评 ----------

/** 把周报统计摘要组装成一次性分析消息(无工具调用) */
export function buildReportMessages(week: { label: string; start: string; end: string; lines: string[] }): UpstreamMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是个人效率周报的点评助手。基于用户的周统计数据写一段点评:先用一句话肯定本周亮点,再给一条具体可执行的建议。不要罗列数字,直接给洞察;语气友好自然,全程中文,150 字以内。',
    },
    {
      role: 'user',
      content: `以下是「${week.label}」(${week.start} ~ ${week.end})的统计数据:\n${week.lines.join('\n')}\n\n请写周报点评。`,
    },
  ]
}
