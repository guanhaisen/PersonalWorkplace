export type Priority = 'high' | 'mid' | 'low'

export interface Todo {
  id: string
  title: string
  done: boolean
  priority: Priority
  /** 截止日期,格式 YYYY-MM-DD,可选 */
  dueDate?: string
  createdAt: string
  completedAt?: string
}

export interface Note {
  id: string
  content: string
  pinned: boolean
  updatedAt: string
}

export interface Habit {
  id: string
  name: string
  createdAt: string
  /** 打卡记录:日期(YYYY-MM-DD)→ true */
  records: Record<string, true>
}

export interface PomodoroSession {
  id: string
  /** 完成日期 YYYY-MM-DD */
  date: string
  minutes: number
  completedAt: string
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

export interface AppData {
  todos: Todo[]
  notes: Note[]
  habits: Habit[]
  pomodoros: PomodoroSession[]
  chats: ChatMsg[]
  links: LinkItem[]
}
