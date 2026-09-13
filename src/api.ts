import type { AppData } from './types'

export type CollectionKey = 'todos' | 'notes' | 'habits' | 'pomodoros'

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
