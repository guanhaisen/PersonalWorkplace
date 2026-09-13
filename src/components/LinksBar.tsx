import { useEffect, useRef, useState } from 'react'
import type { LinkItem } from '../types'
import type { UpdateFn } from '../App'
import { uid } from '../api'

interface Props {
  links: LinkItem[]
  update: UpdateFn
}

// 补全协议,避免 "github.com" 被当成相对路径打开
const normalizeUrl = (raw: string) => (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)

// 标题留空时按域名生成展示名
const titleFromUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function LinksBar({ links, update }: Props) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) requestAnimationFrame(() => firstInputRef.current?.focus())
  }, [adding])

  const submit = () => {
    const raw = url.trim()
    if (!raw) return
    const finalUrl = normalizeUrl(raw)
    const finalTitle = title.trim() || titleFromUrl(finalUrl)
    update('links', (items) => [...items, { id: uid(), title: finalTitle, url: finalUrl }])
    setTitle('')
    setUrl('')
    setAdding(false)
  }

  const remove = (l: LinkItem) => {
    if (window.confirm(`确定删除收藏的「${l.title}」吗?`)) {
      update('links', (items) => items.filter((i) => i.id !== l.id))
    }
  }

  return (
    <div className="head-links">
      <div className="head-links-inner">
        {links.map((l) => (
          <span key={l.id} className="head-link">
            <a href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              {l.title}
            </a>
            <button
              className="head-link-x"
              title="删除"
              onClick={() => remove(l)}
            >
              ✕
            </button>
          </span>
        ))}
        {adding ? (
          <span className="head-link-form">
            <input
              ref={firstInputRef}
              className="in"
              value={title}
              placeholder="名称(可选)"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <input
              className="in"
              value={url}
              placeholder="网址,如 github.com"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <button className="btn solid" onClick={submit} disabled={!url.trim()}>
              添加
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              取消
            </button>
          </span>
        ) : (
          <button className="head-link-add" title="收藏一个网页地址" onClick={() => setAdding(true)}>
            ＋ 收藏网页
          </button>
        )}
      </div>
    </div>
  )
}
