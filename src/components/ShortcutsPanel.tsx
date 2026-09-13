interface Props {
  onOpenPalette: () => void
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '⌘K', label: '命令面板' },
  { keys: '1-5', label: '切换视图' },
  { keys: 'N', label: '新建笔记' },
  { keys: 'T', label: '新建待办' },
  { keys: '/', label: '搜索笔记' },
  { keys: 'P', label: '跳转专注 · 开始/暂停' },
]

export default function ShortcutsPanel({ onOpenPalette }: Props) {
  return (
    <div className="panel panel-keys">
      <header className="p-head">
        <h2>
          <span className="tag">KEYS</span>
          <i>/</i>快捷键
        </h2>
        <span className="p-meta">非输入时生效</span>
      </header>

      <div className="keys-grid">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="key-row">
            <kbd>{s.keys}</kbd>
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      <button className="btn ghost keys-open" onClick={onOpenPalette}>
        打开命令面板
      </button>
    </div>
  )
}
