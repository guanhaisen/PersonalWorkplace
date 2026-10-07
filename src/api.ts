import type { AppData, ChatSession } from './types'

export type CollectionKey =
  | 'todos'
  | 'courses'
  | 'habits'
  | 'chats'
  | 'chatSessions'
  | 'links'
  | 'reminders'
  | 'notes'
  | 'reports'
  | 'memories'

// 精确指针(鼠标)设备才启用 HTML5 拖拽;触屏设备长按行为怪异,统一走长按指针拖动
// (useLongPressDrag)。放这里而不是 App,供各面板组件共用且不产生对 App 的循环依赖。
export const HTML_DRAG =
  typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches

// 跨组件拖放的私有 MIME:待办行 → 日历格(设截止日)。不用 text/plain 是为了带类型
// 信息,日历格据此拒绝课表等其他拖拽源。
export const TODO_DND_MIME = 'application/x-workbench-todo'

// 课表课程卡拖动换格用的私有 MIME(只在课表面板内部消化,也用于桌面拖拽的类型判定)
export const COURSE_DND_MIME = 'application/x-workbench-course'

/** 带 HTTP 状态码的错误:401 表示未登录/会话过期,调用方据此回到登录页 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/** 取错误响应里的中文 message(认证端点用) */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json()
    return data?.message || fallback
  } catch {
    return fallback
  }
}

// ---------- 认证 ----------

/** 启动时问一下当前会话;未登录返回 null(不抛错) */
export async function me(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/me')
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.username === 'string' && data.username ? data.username : null
  } catch {
    return null
  }
}

export async function login(username: string, password: string): Promise<string> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, '登录失败,请稍后再试'))
  const data = await res.json()
  return data.username as string
}

export async function register(username: string, password: string): Promise<string> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, '注册失败,请稍后再试'))
  const data = await res.json()
  return data.username as string
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
}

/** 按账号的通用设置(学期开始、显示名等) */
export async function getSettings(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/settings')
  if (!res.ok) return {}
  return res.json()
}

export async function saveSettings(patch: Record<string, unknown>, keepalive = false): Promise<void> {
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    // 关页兜底用:unload 期间的请求需要 keepalive 才不会被浏览器掐掉
    keepalive,
  })
}

export function loadAll(): Promise<AppData> {
  return req('/api/data')
    .then((data) => normalizeAppData(data as Partial<AppData>))
    .then(migrateLegacyChats)
}

/** 老备份/旧服务端可能缺新集合,统一补齐空数组,下游不用判空 */
function normalizeAppData(data: Partial<AppData>): AppData {
  const keys: CollectionKey[] = [
    'todos',
    'courses',
    'habits',
    'chats',
    'chatSessions',
    'links',
    'reminders',
    'notes',
    'reports',
    'memories',
  ]
  const out = {} as AppData
  const target = out as unknown as Record<CollectionKey, unknown[]>
  for (const k of keys) {
    const v = data?.[k]
    target[k] = Array.isArray(v) ? v : []
  }
  return out
}

/** 一次性迁移:多会话上线前的旧聊天没有 sessionId,归入一个「历史对话」会话(幂等) */
export function migrateLegacyChats(data: AppData): AppData {
  if (!data.chats.some((m) => !m.sessionId)) return data
  const sid = uid()
  const legacy = data.chats.filter((m) => !m.sessionId)
  const session: ChatSession = {
    id: sid,
    title: '历史对话',
    createdAt: legacy[0]?.ts ?? new Date().toISOString(),
    updatedAt: legacy[legacy.length - 1]?.ts ?? new Date().toISOString(),
  }
  return {
    ...data,
    chatSessions: [session, ...data.chatSessions],
    chats: data.chats.map((m) => (m.sessionId ? m : { ...m, sessionId: sid })),
  }
}

export function saveCollection<K extends CollectionKey>(
  key: K,
  items: AppData[K],
): Promise<{ ok: boolean }> {
  return req(`/api/${key}`, { method: 'PUT', body: JSON.stringify(items) })
}

export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export function todayStr(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 提醒触发时间的格式:本地时间 "YYYY-MM-DD HH:mm",字典序即时间序 */
export const DUE_AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

/** Date → "YYYY-MM-DD HH:mm" 本地时间(与提醒 dueAt 同格式) */
export function formatLocal(d: Date): string {
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${todayStr(d)} ${hm}`
}

/** 当前本地时间,与提醒 dueAt 同格式,可直接字符串比较判断是否到点 */
export function nowLocalStr(d = new Date()): string {
  return formatLocal(d)
}

/** 连续打卡天数:从今天(或今天未打卡时从昨天)往前数 */
export function streak(records: Record<string, true>): number {
  let n = 0
  const d = new Date()
  if (!records[todayStr(d)]) d.setDate(d.getDate() - 1)
  while (records[todayStr(d)]) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}
