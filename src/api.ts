import type { AppData } from './types'

export type CollectionKey = 'todos' | 'courses' | 'habits' | 'chats' | 'links' | 'reminders'

async function req<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export function loadAll(): Promise<AppData> {
  return req('/api/data')
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
