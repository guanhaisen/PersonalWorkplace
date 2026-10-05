// 轻量 Markdown 渲染器:只为随手记的 AI 日报/周报服务。
// 支持块级:标题 #~####、无序/有序列表、引用、代码围栏、分隔线、段落;
// 行内:**粗体**、`行内代码`、[文本](链接)。全部渲染为 React 元素,不用 dangerouslySetInnerHTML。
import type { ReactNode } from 'react'

/** 行内标记 → React 节点数组(**bold**、`code`、[text](url)) */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 依次匹配行内代码 / 粗体 / 链接;正则按优先级从左到右扫一遍
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyPrefix}-i${i++}`
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export default function MiniMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] | null = null
  let code: { lang: string; body: string[] } | null = null
  let para: string[] = []
  let k = 0
  const key = () => `b${k++}`

  const flushList = () => {
    if (!list) return
    const items = list.items.map((t, i) => <li key={i}>{inline(t, `${key()}-li${i}`)}</li>)
    blocks.push(list.ordered ? <ol key={key()}>{items}</ol> : <ul key={key()}>{items}</ul>)
    list = null
  }
  const flushQuote = () => {
    if (!quote) return
    blocks.push(
      <blockquote key={key()}>
        {quote.map((t, i) => (
          <p key={i}>{inline(t, `q${i}`)}</p>
        ))}
      </blockquote>,
    )
    quote = null
  }
  const flushPara = () => {
    if (!para.length) return
    blocks.push(<p key={key()}>{inline(para.join(' '), `p${k}`)}</p>)
    para = []
  }
  const flushAll = () => {
    flushList()
    flushQuote()
    flushPara()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    // 代码围栏:``` 开关
    if (code) {
      if (/^```/.test(line.trim())) {
        blocks.push(
          <pre key={key()}>
            <code>{code.body.join('\n')}</code>
          </pre>,
        )
        code = null
      } else {
        code.body.push(raw)
      }
      continue
    }
    if (/^```/.test(line.trim())) {
      flushAll()
      code = { lang: line.trim().slice(3).trim(), body: [] }
      continue
    }
    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushAll()
      const level = h[1].length
      const content = inline(h[2], `h${k}`)
      if (level === 1) blocks.push(<h1 key={key()}>{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={key()}>{content}</h2>)
      else if (level === 3) blocks.push(<h3 key={key()}>{content}</h3>)
      else blocks.push(<h4 key={key()}>{content}</h4>)
      continue
    }
    // 分隔线
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      flushAll()
      blocks.push(<hr key={key()} />)
      continue
    }
    // 引用(可多行)
    if (/^>\s?/.test(line)) {
      flushList()
      flushPara()
      ;(quote ??= []).push(line.replace(/^>\s?/, ''))
      continue
    }
    // 列表(-/* 无序,1. 有序)
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.、]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushQuote()
      flushPara()
      const ordered = !!ol
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((ul || ol)![1])
      continue
    }
    // 空行分段
    if (!line.trim()) {
      flushAll()
      continue
    }
    flushList()
    flushQuote()
    para.push(line.trim())
  }
  // 收尾:未闭合的代码围栏也按 pre 输出
  if (code) {
    blocks.push(
      <pre key={key()}>
        <code>{code.body.join('\n')}</code>
      </pre>,
    )
  }
  flushAll()

  return <div className="md-body">{blocks}</div>
}
