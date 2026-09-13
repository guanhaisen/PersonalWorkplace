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

export interface AppData {
  todos: Todo[]
  notes: Note[]
  habits: Habit[]
  pomodoros: PomodoroSession[]
}
