export interface Todo {
  id: string
  title: string
  done: boolean
  /** 截止日期,格式 YYYY-MM-DD,可选 */
  dueDate?: string
  createdAt: string
  completedAt?: string
}

/** 课表里的一门课:weekday 1~7 表示周一~周日,时间用 HH:mm */
export interface Course {
  id: string
  name: string
  teacher?: string
  location?: string
  weekday: number
  start: string
  end: string
  /** 课程块配色,预设色板索引 */
  color: number
  /** 起始周(含),缺省表示每周都上 */
  weekStart?: number
  /** 结束周(含) */
  weekEnd?: number
  /** 单双周限制,缺省每周 */
  parity?: 'odd' | 'even'
}

export interface Habit {
  id: string
  name: string
  createdAt: string
  /** 打卡记录:日期(YYYY-MM-DD)→ true */
  records: Record<string, true>
}

export interface ChatUsage {
  prompt: number
  completion: number
  total: number
}

export interface ChatMsg {
  id: string
  /** user = 用户发送,assistant = AI 回复;工具调用过程不落库,只存最终文本 */
  role: 'user' | 'assistant'
  content: string
  /** 创建时间 ISO 字符串 */
  ts: string
  /** 该轮回复消耗的 token(工具多轮时为各次请求合计);服务商未返回时不存 */
  usage?: ChatUsage
  /** 所属会话;旧数据的裸消息由前端迁移时补齐 */
  sessionId?: string
}

/** Miku 的一个对话会话:消息本体在 chats 集合(带 sessionId),滚动摘要存在这里 */
export interface ChatSession {
  id: string
  /** 标题:首轮提问截断占位,随后由 AI 后台起名;空 = 未命名对话 */
  title: string
  createdAt: string
  updatedAt: string
  /** 更早消息的滚动摘要(≤300 字,注入 system 供模型延续语境) */
  summary?: string
  /** 摘要已覆盖到的时间点(该 ts 及更早的旧消息已计入摘要) */
  summaryUntil?: string
}

/** 总览头部收藏的网页快捷方式 */
export interface LinkItem {
  id: string
  /** 展示名,留空时前端按域名自动生成 */
  title: string
  url: string
}

export interface Reminder {
  id: string
  title: string
  /** 触发时间,本地时间 "YYYY-MM-DD HH:mm"(该格式字典序即时间序) */
  dueAt: string
  createdAt: string
  /** 已触发(弹过提醒)的时间 ISO 字符串;缺省 = 还没到点 */
  firedAt?: string
}

/** 随手记的一条原始记录(「AI 智能整理」的原料) */
export interface NoteEntry {
  id: string
  /** 用户原文 */
  content: string
  /** 归属日 YYYY-MM-DD(按提交时刻的本地日期) */
  date: string
  /** 创建时间 ISO 字符串 */
  ts: string
}

/** AI 整理出的日报/周报/月报(markdown 全文) */
export interface GenReport {
  /** 日报 = YYYY-MM-DD,周报 = ISO 周标识 YYYY-Www,月报 = YYYY-MM */
  id: string
  kind: 'daily' | 'weekly' | 'monthly'
  /** 当前展示用 markdown 正文(AI 失败时为本地兜底合并版) */
  content: string
  /** true = 内容出自 AI 整理;false = 本地兜底合并(可在界面重试 AI) */
  ai: boolean
  /** 已触发整理但尚未被 AI 成文吸收的随手记 id(仅 ai:true 时有意义) */
  pendingIds?: string[]
  updatedAt: string
  /** 最近一次整理的 token 用量(服务商未返回时不存) */
  usage?: ChatUsage
  /** AI 周报点评(报告页生成后写回,刷新不丢;仅 kind:'weekly') */
  comment?: string
}

/** Miku 的长期记忆:模型经 remember/forget_memory 工具维护,跨会话注入系统提示 */
export interface MemoryItem {
  id: string
  content: string
  createdAt: string
}

export interface AppData {
  todos: Todo[]
  courses: Course[]
  habits: Habit[]
  chats: ChatMsg[]
  chatSessions: ChatSession[]
  links: LinkItem[]
  reminders: Reminder[]
  notes: NoteEntry[]
  reports: GenReport[]
  memories: MemoryItem[]
}
