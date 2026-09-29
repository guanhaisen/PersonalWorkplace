// Miku(原 AI 助手):配置接口封装、OpenAI 兼容请求、工具 Schema 与数据快照构建。
// 密钥只存在服务端数据库(按账号隔离),前端只传消息与工具定义。
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
    function: fn('add_course', '在课表里新建一门课', {
      name: { type: 'string', description: '课程名' },
      weekday: { type: 'integer', description: '星期,1=周一 … 7=周日' },
      start: { type: 'string', description: '开始时间 HH:mm,如 08:00' },
      end: { type: 'string', description: '结束时间 HH:mm,如 09:40' },
      location: { type: 'string', description: '上课地点,可选' },
      teacher: { type: 'string', description: '老师姓名,可选' },
    }, ['name', 'weekday', 'start', 'end']),
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
    function: fn('add_reminder', '新建一条定时提醒,到点会弹窗提醒用户', {
      title: { type: 'string', description: '提醒内容' },
      dueAt: {
        type: 'string',
        description:
          '触发时间,本地时间 YYYY-MM-DD HH:mm(24小时制)。根据系统提示里的今天日期与当前时刻推算相对表达,如「15分钟后」「今晚8点」,必须晚于当前时刻',
      },
    }, ['title', 'dueAt']),
  },
  {
    type: 'function',
    function: fn('delete_reminder', '删除一条提醒', {
      id: { type: 'string', description: '提醒 id,来自数据快照' },
    }, ['id']),
  },
  {
    type: 'function',
    function: fn('switch_view', '切换到某个页面展示给用户', {
      view: {
        type: 'string',
        enum: ['overview', 'todos', 'schedule', 'habits', 'ai', 'raise', 'report'],
        description: '目标页面;raise 是 Miku 养成页(互动/喂食/聊天)',
      },
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
      t.done ? '已完成' : '进行中',
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
  lines.push(`[课表] 共 ${data.courses.length} 门课(按星期与时间排序)`)
  const courses = [...data.courses].sort(
    (a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start),
  )
  for (const c of courses) {
    const weeks = c.weekStart
      ? c.weekEnd && c.weekEnd !== c.weekStart
        ? `第${c.weekStart}-${c.weekEnd}周`
        : `第${c.weekStart}周`
      : ''
    const marks = [
      c.weekday % 7 === now.getDay() ? '[今日]' : '',
      weeks,
      c.location ? `@${c.location}` : '',
      c.teacher,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`- id:${c.id} 周${WEEKDAYS[c.weekday % 7]} ${c.start}-${c.end} ${cut(c.name, 40)}${marks ? `(${marks})` : ''}`)
  }

  lines.push('')
  const pending = data.reminders.filter((r) => !r.firedAt).sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  lines.push(`[提醒] 未触发 ${pending.length} 条`)
  for (const r of pending) {
    lines.push(`- id:${r.id} ${cut(r.title, 60)} @${r.dueAt}`)
  }

  return lines.join('\n')
}

export function buildSystemPrompt(data: AppData): string {
  const now = new Date()
  const today = todayStr(now)
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return [
    `你是「个人工作台」(一个本地个人效率工具,含待办/课表/习惯打卡/定时提醒)里的助手 Miku。今天是 ${today} 星期${WEEKDAYS[now.getDay()]},现在时刻 ${hm}。`,
    '下面是用户的实时数据快照。回答数据相关问题时以快照为准;用户要求修改数据时调用工具完成,不要编造 id,只用快照里出现的 id。',
    '修改完成后用一句话向用户确认;闲聊与问答保持简洁,全程使用中文。',
    '',
    buildDataSnapshot(data),
  ].join('\n')
}

// ---------- 主动巡查:自动读取待办/习惯/课表并生成提醒 ----------

/** 组装主动巡查的一次性消息(无工具调用),让模型挑出此刻值得提醒的事项 */
export function buildBriefingMessages(data: AppData): UpstreamMessage[] {
  const now = new Date()
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return [
    {
      role: 'system',
      content:
        '你是「个人工作台」的主动提醒引擎。根据数据快照与当前时刻,找出此刻最值得提醒用户的事项:' +
        '已逾期或今天/明天截止的未完成待办、今天还没打卡的习惯、今天剩余的课(一小时内要上的优先)。' +
        '最多 4 条,每条一行、以「·」开头,一行只说一件事,写明时间/课名/习惯名,简洁具体;' +
        '不要寒暄、不要解释、不要 markdown。若没有值得提醒的,只输出:无',
    },
    {
      role: 'user',
      content: `现在是 ${todayStr(now)} 星期${WEEKDAYS[now.getDay()]} ${hm}。数据快照如下:\n\n${buildDataSnapshot(data)}\n\n请给出此刻的提醒。`,
    },
  ]
}

/** 解析巡查输出为事项数组;「无」或解析不出条目时返回空数组 */
export function parseBriefing(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed || /^无+$/.test(trimmed)) return []
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(好的|以下是|当然|提醒如下)/.test(l))
    .map((l) => l.replace(/^\s*(?:[·•\-*>]|\d+[.、)])\s*/, ''))
    .filter((l) => l && l !== '无')
  const unique = [...new Set(lines)]
  // 模型没用列表格式时,短回答直接当一条,长篇输出视为无效
  if (unique.length === 0) return trimmed.length <= 60 ? [trimmed] : []
  return unique.slice(0, 4)
}

/** 调一次 AI 生成巡查提醒;失败由调用方决定如何处理 */
export async function fetchAiBriefing(data: AppData, signal?: AbortSignal): Promise<string[]> {
  const res = await aiChat({ messages: buildBriefingMessages(data) }, signal)
  const msg = res.message
  if (!msg?.content) throw new Error('AI 没有返回内容')
  return parseBriefing(msg.content)
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
