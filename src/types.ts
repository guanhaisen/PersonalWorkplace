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

export interface AppData {
  todos: Todo[]
  courses: Course[]
  habits: Habit[]
  chats: ChatMsg[]
  links: LinkItem[]
  reminders: Reminder[]
}
