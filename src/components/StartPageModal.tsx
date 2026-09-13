import { useEffect, useMemo, useState } from 'react'

// 检测当前浏览器,返回对应的设置步骤
function detectBrowser(): 'edge' | 'chrome' | 'firefox' | 'safari' | 'other' {
  const ua = navigator.userAgent
  if (/Edg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

const STEPS: Record<string, { name: string; steps: string[] }> = {
  edge: {
    name: 'Microsoft Edge',
    steps: [
      '打开浏览器右上角「…」→「设置」',
      '左侧选择「开始、主页和新建标签页」',
      '「启动时」选择「打开这些页面」→「添加新页面」',
      '粘贴下方地址并确认;也可把「主页」按钮设为同一地址',
    ],
  },
  chrome: {
    name: 'Google Chrome',
    steps: [
      '打开右上角「⋮」→「设置」',
      '左侧选择「启动时」',
      '选择「打开特定网页或一组网页」→「添加新网页」',
      '粘贴下方地址并确认',
    ],
  },
  firefox: {
    name: 'Firefox',
    steps: [
      '打开「设置」(选项)',
      '左侧选择「主页」',
      '「主页和新窗口」改为「自定义网址…」',
      '粘贴下方地址即可',
    ],
  },
  safari: {
    name: 'Safari',
    steps: [
      '先在本页停留,菜单「Safari 浏览器」→「通用设置」',
      '「新建窗口时打开方式」选择「以此页面打开」',
    ],
  },
  other: {
    name: '你的浏览器',
    steps: ['打开浏览器设置,找到「启动 / 主页 / 开始页」相关选项', '选择「打开特定网页」,粘贴下方地址'],
  },
}

export default function StartPageModal({ onClose }: { onClose: () => void }) {
  // 两种部署模式地址不同,取当前访问的源
  const url = window.location.origin
  const browserKey = useMemo(detectBrowser, [])
  const guide = STEPS[browserKey]
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板权限受限时的兜底:选中文本让用户手动 Ctrl+C
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="sp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="p-head">
          <h2>
            <span className="tag">HOME</span>
            <i>/</i>设为浏览器开始页
          </h2>
          <span className="p-meta">{guide.name}</span>
        </header>

        <div className="sp-url-row">
          <code className="sp-url">{url}</code>
          <button className="btn ghost" onClick={copy}>
            {copied ? '已复制 ✓' : '复制地址'}
          </button>
        </div>

        <p className="sp-note">
          浏览器出于安全考虑不允许网页自动修改启动设置,按下面步骤手动设置一次即可(永久生效):
        </p>

        <ol className="sp-steps">
          {guide.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>

        <div className="sp-foot">
          <button className="btn solid" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
