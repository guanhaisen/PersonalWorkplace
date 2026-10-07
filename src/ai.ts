// Miku(原 AI 助手):配置接口封装、OpenAI 兼容请求、工具 Schema 与数据快照构建。
// 密钥只存在服务端数据库(按账号隔离),前端只传消息与工具定义。
import type { AppData, ChatUsage } from './types'
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

export interface StreamTurnResult {
  message: UpstreamMessage | null
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
}

export interface StreamTurnOptions {
  /** 每来一段正文增量就回调一次(工具调用分片不回调,由聚合器累积) */
  onDelta?: (text: string) => void
  signal?: AbortSignal
}

/**
 * 流式聊天:请求走 SSE,增量解析 OpenAI 兼容的 chunk 流。
 * - 正文分片实时回调 onDelta;
 * - tool_calls 分片按 index 累积(id/name/arguments 拼接),结束时与 aiChat 同构地返回完整 message;
 * - 服务端在 stream 模式下若上游出错,仍返回 JSON(非 200),所以先看 response.ok 再按 SSE 解析;
 * - 不传 stream_options(部分兼容端点不认),usage 可能缺失,调用方需容忍。
 */
export async function aiChatStream(
  body: { messages: UpstreamMessage[]; tools?: unknown[] },
  { onDelta, signal }: StreamTurnOptions = {},
): Promise<StreamTurnResult> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(data?.message || `${res.status} ${res.statusText}`)
  }
  if (!res.body) throw new Error('当前环境不支持流式响应')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let done0 = false
  let usage: StreamTurnResult['usage'] = null
  const toolCalls: ToolCall[] = []

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') done0 = true
      return
    }
    let json: {
      usage?: NonNullable<StreamTurnResult['usage']>
      choices?: { delta?: { content?: string | null; tool_calls?: unknown[] } }[]
    }
    try {
      json = JSON.parse(data)
    } catch {
      return // 心跳/注释行,忽略
    }
    if (json.usage) usage = json.usage
    const delta = json.choices?.[0]?.delta
    if (delta?.content) {
      content += delta.content
      onDelta?.(delta.content)
    }
    const tcd = delta?.tool_calls
    if (Array.isArray(tcd)) {
      for (const raw of tcd) {
        const tc = raw as {
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }
        const i = typeof tc.index === 'number' ? tc.index : toolCalls.length
        while (toolCalls.length <= i) {
          toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
        }
        const slot = toolCalls[i]
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.function.name += tc.function.name
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      handleLine(line)
      if (done0) break
    }
    if (done0) break
  }
  // 流意外截断时冲出解码器余量,残余半行尽量解析
  buf += decoder.decode()
  if (!done0 && buf) handleLine(buf)

  const message: UpstreamMessage | null = toolCalls.length
    ? { role: 'assistant', content: content || null, tool_calls: toolCalls }
    : content
      ? { role: 'assistant', content }
      : null
  return { message, usage }
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
    function: fn('add_todos', '批量新建多条待办:把一个目标拆解成多个步骤时,一次调用建完,不要循环调用 add_todo', {
      items: {
        type: 'array',
        description: '待办列表,按执行顺序排列',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '任务内容' },
            dueDate: { type: 'string', description: '截止日期 YYYY-MM-DD,可选' },
          },
          required: ['title'],
        },
      },
    }, ['items']),
  },
  {
    type: 'function',
    function: fn('update_todo', '编辑一条已有待办(改标题/截止日/完成状态),至少给一个要改的字段', {
      id: { type: 'string', description: '待办 id,来自数据快照' },
      title: { type: 'string', description: '新标题,不改就不传' },
      dueDate: { type: 'string', description: '新截止日期 YYYY-MM-DD;传空字符串表示清除截止日' },
      done: { type: 'boolean', description: '完成状态, true=完成 false=重开' },
    }, ['id']),
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
    function: fn('update_course', '编辑一门已有课程(改课名/时间/地点/老师),至少给一个要改的字段', {
      id: { type: 'string', description: '课程 id,来自数据快照' },
      name: { type: 'string', description: '课程名,不改就不传' },
      weekday: { type: 'integer', description: '星期,1=周一 … 7=周日' },
      start: { type: 'string', description: '开始时间 HH:mm' },
      end: { type: 'string', description: '结束时间 HH:mm' },
      location: { type: 'string', description: '上课地点;传空字符串表示清除' },
      teacher: { type: 'string', description: '老师姓名;传空字符串表示清除' },
    }, ['id']),
  },
  {
    type: 'function',
    function: fn('delete_course', '从课表里删除一门课程', {
      id: { type: 'string', description: '课程 id,来自数据快照' },
    }, ['id']),
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
    function: fn('add_note', '帮用户往随手记里记一笔(会自动触发 AI 整理进当日日报)', {
      content: { type: 'string', description: '要记录的内容,保留用户原意' },
    }, ['content']),
  },
  {
    type: 'function',
    function: fn('search_notes', '按关键词搜索用户的随手记原文(不是 AI 整理后的日报)', {
      keyword: { type: 'string', description: '关键词' },
      dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD(含),可选' },
      dateTo: { type: 'string', description: '结束日期 YYYY-MM-DD(含),可选' },
    }, ['keyword']),
  },
  {
    type: 'function',
    function: fn('read_daily_report', '读取某一天的 AI 日报全文', {
      date: { type: 'string', description: '日期 YYYY-MM-DD' },
    }, ['date']),
  },
  {
    type: 'function',
    function: fn('read_weekly_report', '读取某一周的 AI 周报全文', {
      week: { type: 'string', description: 'ISO 周标识(如 2026-W41)或该周内任一天日期 YYYY-MM-DD' },
    }, ['week']),
  },
  {
    type: 'function',
    function: fn('switch_view', '切换到某个页面展示给用户', {
      view: {
        type: 'string',
        enum: ['overview', 'todos', 'schedule', 'habits', 'notes', 'ai', 'raise', 'report'],
        description: '目标页面;raise 是 Miku 养成页(互动/喂食/聊天),notes 是随手记(AI 日报/周报)',
      },
    }, ['view']),
  },
  {
    type: 'function',
    function: fn(
      'query_stats',
      '查询统计数据:待办完成/新建/逾期明细、习惯打卡次数与按日分布、今日课程与提醒概况。统计类问题必须用它查,不要靠数快照估算',
      {
        scope: {
          type: 'string',
          enum: ['todos', 'habits', 'overview'],
          description: 'todos=待办,habits=习惯打卡,overview=两者加今日课表与提醒概况',
        },
        range: {
          type: 'string',
          enum: ['today', 'thisWeek', 'lastWeek', 'last7d', 'month', 'all'],
          description: '统计范围,缺省 thisWeek(本周)',
        },
      },
      ['scope'],
    ),
  },
  {
    type: 'function',
    function: fn(
      'remember',
      '把用户的长期信息存入记忆:稳定偏好、长期目标、个人背景(如「偏好番茄工作法」「考研目标 12 月」「对花生过敏」)。一次性的临时琐事不要存',
      {
        content: { type: 'string', description: '要记住的内容,一句话,保留用户原意' },
      },
      ['content'],
    ),
  },
  {
    type: 'function',
    function: fn('forget_memory', '删除一条长期记忆(用户要求忘记某事,或该记忆已过时)', {
      id: { type: 'string', description: '记忆 id,来自数据快照' },
    }, ['id']),
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

  lines.push('')
  const noteDates = data.notes.map((n) => n.date).sort()
  const dailyN = data.reports.filter((r) => r.kind === 'daily').length
  const weeklyN = data.reports.filter((r) => r.kind === 'weekly').length
  const monthlyN = data.reports.filter((r) => r.kind === 'monthly').length
  lines.push(
    `[随手记] 共 ${data.notes.length} 条${
      noteDates.length ? `(最早 ${noteDates[0]},最近 ${noteDates[noteDates.length - 1]})` : ''
    };已生成日报 ${dailyN} 篇、周报 ${weeklyN} 篇、月报 ${monthlyN} 篇(正文可用工具读取)`,
  )

  lines.push('')
  lines.push(`[长期记忆] 共 ${data.memories.length} 条`)
  for (const m of data.memories) {
    lines.push(`- id:${m.id} ${cut(m.content, 80)}`)
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
    '快照不含随手记和日报/周报的正文;用户问起过往的记录时,用 search_notes / read_daily_report / read_weekly_report 工具查询后如实回答,查不到就说没有,不要编造。',
    '统计类问题(完成了多少、打卡几次、逾期有哪些)用 query_stats 查询,不要靠数快照估算。',
    '编辑已有待办/课程用 update_todo / update_course;用户给出一个目标时,用 add_todos 一次拆解成多条待办(可带截止日)。',
    '用户表达稳定偏好、长期目标或个人背景时,用 remember 存入长期记忆;一次性的临时琐事不要存。用户要求忘记某事或记忆已过时,用 forget_memory 删除对应条目。',
    '修改完成后用一句话向用户确认;闲聊与问答保持简洁,全程使用中文。',
    '',
    buildDataSnapshot(data),
  ].join('\n')
}

// ---------- 主动巡查:自动读取待办/习惯/课表并生成提醒 ----------

/** 组装主动巡查的一次性消息(无工具调用),让模型挑出此刻值得提醒的事项。
 * dismissed 用于告知用户最近已经知道的内容,避免反复提醒同一件事 */
export function buildBriefingMessages(data: AppData, opts?: { dismissed?: string[] }): UpstreamMessage[] {
  const now = new Date()
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const today = todayStr(now)
  // 近期完成节奏:让模型知道今天是忙是闲,提醒更有分寸
  const doneToday = data.todos.filter((t) => t.done && t.completedAt && todayStr(new Date(t.completedAt)) === today).length
  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 6)
  const weekAgoStr = todayStr(weekAgo)
  const done7d = data.todos.filter(
    (t) => t.done && t.completedAt && todayStr(new Date(t.completedAt)) >= weekAgoStr,
  ).length
  const pace = `近期节奏:今日已完成待办 ${doneToday} 条,近 7 天完成 ${done7d} 条。`
  const dismissedNote = opts?.dismissed?.length
    ? `用户最近已经知晓以下提醒,除非情况有变化(如临近、逾期),否则不要重复:\n${opts.dismissed
        .slice(-10)
        .map((l) => `- ${l}`)
        .join('\n')}\n`
    : ''
  return [
    {
      role: 'system',
      content:
        '你是「个人工作台」的主动提醒引擎。根据数据快照与当前时刻,找出此刻最值得提醒用户的事项:' +
        '已逾期或今天/明天截止的未完成待办、今天还没打卡的习惯、今天剩余的课(一小时内要上的优先)。' +
        '结合用户的长期记忆与近期完成节奏判断轻重,优先提醒新变化和真正要紧的事。' +
        '最多 4 条,每条一行、以「·」开头,一行只说一件事,写明时间/课名/习惯名,简洁具体;' +
        '不要寒暄、不要解释、不要 markdown。若没有值得提醒的,只输出:无',
    },
    {
      role: 'user',
      content: `现在是 ${today} 星期${WEEKDAYS[now.getDay()]} ${hm}。${pace}\n\n${dismissedNote}数据快照如下:\n\n${buildDataSnapshot(data)}\n\n请给出此刻的提醒。`,
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
export async function fetchAiBriefing(
  data: AppData,
  opts?: { signal?: AbortSignal; dismissed?: string[] },
): Promise<string[]> {
  const res = await aiChat({ messages: buildBriefingMessages(data, { dismissed: opts?.dismissed }) }, opts?.signal)
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

// ---------- 随手记整理:AI 日报 / AI 周报 ----------
// 设计原则(借鉴 SpringNote 的思路,prompt 为本项目自写):
// 严格保留事实、像用户自己写的、不套模板;AI 失败时由 notesOrg.ts 降级为本地合并,内容永不丢。

/** 模型偶尔会用 ```markdown 围栏包住正文,剥掉(无围栏时原样返回) */
function stripFence(text: string): string {
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim())
  return (m ? m[1] : text).trim()
}

export interface DailyMergeArgs {
  /** YYYY-MM-DD */
  date: string
  /** '一' ~ '日' */
  weekday: string
  /** 已有日报 markdown;'' 表示当天还没有日报 */
  existing: string
  /** 待整理的随手记录(按时间序) */
  entries: { time: string; content: string }[]
}

export function buildDailyMergeMessages({ date, weekday, existing, entries }: DailyMergeArgs): UpstreamMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是「个人工作台」的日报整理助手。把用户的已有日报与今日随手记录融合成一篇当天最新的日报,输出 markdown 正文。',
        '整理要求:',
        '1. 严格保留事实:不编造不存在的任务、时间、人员、原因、进展、结果、计划、评价或情绪。',
        '2. 已有日报存在时,把新增记录自然融合进去重写全文,优先保留其中仍然有效的内容,重复的内容只保留表达更完整的一份;已有日报为空时,直接依据新增记录整理成日报。',
        '3. 新增记录只是关键词或短语时,整理成通顺完整的表达,但扩展只服务于把已有事实说清楚,不得引入新的事实。',
        '4. 结构自由:内容少就简洁成段,内容多可按主题分段或用列表;不要套固定栏目,不要为了分组而分组。',
        '5. 语气自然克制,像用户自己认真整理的日报;不要 AI 总结腔,不要寒暄,不要解释整理过程。',
        '6. 只输出最终 markdown,不要输出任何说明文字。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `日期:${date}(星期${weekday})`,
        '',
        '【已有日报】',
        existing.trim() || '(空)',
        '',
        '【今日随手记录】',
        entries.map((e) => `- ${e.time} ${e.content}`).join('\n') || '(空)',
        '',
        '请输出整理后的日报。',
      ].join('\n'),
    },
  ]
}

export interface WeeklyReportArgs {
  /** ISO 周标识,如 2026-W41 */
  weekKey: string
  start: string
  end: string
  /** 一周日报拼成的来源 markdown(每天一节) */
  source: string
}

export function buildWeeklyReportMessages({ weekKey, start, end, source }: WeeklyReportArgs): UpstreamMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是「个人工作台」的周报整理助手。基于用户一周的日报,写一篇有重点、可直接留存的周报 markdown。',
        '写作要求:',
        '1. 保留来源中的事实,不编造没有依据的成果、风险或计划。',
        '2. 不套固定栏目,按材料自由组织:可用标题、段落、列表和小结,把这一周做了什么、推进到哪里、卡在哪里、下一步是什么讲清楚。',
        '3. 语气自然克制,像认真复盘的人写的周报,不要 AI 模板腔,不要寒暄和解释。',
        `4. 全文第一行固定为一级标题 \`# ${weekKey} 周报\`,不得自拟、追加或省略。`,
        '5. 只输出最终 markdown。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `周期:${weekKey}(${start} ~ ${end})`,
        '',
        '【本周日报】',
        source,
        '',
        '请写这一周的周报。',
      ].join('\n'),
    },
  ]
}

export interface MonthlyReportArgs {
  /** 月份标识 YYYY-MM */
  monthKey: string
  start: string
  end: string
  /** 该月覆盖的各周周报(缺周报时按日汇总)拼成的来源 markdown */
  source: string
}

export function buildMonthlyReportMessages({ monthKey, start, end, source }: MonthlyReportArgs): UpstreamMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是「个人工作台」的月报整理助手。基于用户一个月的周报,写一篇有重点、可直接留存的月报 markdown。',
        '写作要求:',
        '1. 保留来源中的事实,不编造没有依据的成果、风险或计划。',
        '2. 月报要有月度视角:提炼贯穿整月的主线、阶段性成果、遗留问题与下月展望,不要按周机械罗列。',
        '3. 不套固定栏目,按材料自由组织:可用标题、段落、列表和小结。',
        '4. 语气自然克制,像认真复盘的人写的月报,不要 AI 模板腔,不要寒暄和解释。',
        `5. 全文第一行固定为一级标题 \`# ${monthKey} 月报\`,不得自拟、追加或省略。`,
        '6. 只输出最终 markdown。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `周期:${monthKey}(${start} ~ ${end})`,
        '',
        '【本月周报】',
        source,
        '',
        '请写这个月的月报。',
      ].join('\n'),
    },
  ]
}

async function generateMarkdown(
  messages: UpstreamMessage[],
  signal?: AbortSignal,
): Promise<{ text: string; usage?: ChatUsage }> {
  const res = await aiChat({ messages }, signal)
  const raw = res.message?.content?.trim()
  if (!raw) throw new Error('AI 没有返回内容')
  return {
    text: stripFence(raw),
    usage: res.usage
      ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens, total: res.usage.total_tokens }
      : undefined,
  }
}

/** 调 AI 把随手记录整理进当日日报;失败抛错,由调用方降级为本地合并 */
export function generateDailyReport(args: DailyMergeArgs, signal?: AbortSignal) {
  return generateMarkdown(buildDailyMergeMessages(args), signal)
}

/** 调 AI 依据一周日报写周报;失败抛错 */
export function generateWeeklyReport(args: WeeklyReportArgs, signal?: AbortSignal) {
  return generateMarkdown(buildWeeklyReportMessages(args), signal)
}

/** 调 AI 依据一个月周报写月报;失败抛错 */
export function generateMonthlyReport(args: MonthlyReportArgs, signal?: AbortSignal) {
  return generateMarkdown(buildMonthlyReportMessages(args), signal)
}
