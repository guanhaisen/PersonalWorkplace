import { useEffect, useState } from 'react'

// ---------- Miku 右键菜单:纯展示组件 ----------
// 菜单树与回调由 App 组装传入;支持二级子菜单(悬停展开,贴右缘时向左翻转)、
// ✓ 勾选(开关类条目)、右键说明(快捷键/时间)、分隔线与置灰说明行。
// 关闭方式:点任意条目 / Esc / 点菜单外任意处。
// 悬停模型:子菜单挂在自己父条目下,enter 父条目展开、leave 父条目(含子菜单)收起;
// 子菜单与主菜单零间隙拼接,鼠标横向移入子菜单时不会离开父条目子树,子菜单不闪关。

export interface MikuMenuItem {
  key: string
  label: string
  /** 右侧说明(快捷键 / 时间) */
  hint?: string
  /** 有子菜单,悬停展开 */
  children?: MikuMenuItem[]
  /** 显示 ✓ 勾选(开关类条目) */
  checked?: boolean
  /** 说明性行:置灰不可点 */
  dim?: boolean
  /** 分隔线 */
  divider?: boolean
  onClick?: () => void
}

interface Props {
  x: number
  y: number
  items: MikuMenuItem[]
  onClose: () => void
}

export default function MikuMenu({ x, y, items, onClose }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Miku 常贴屏幕右缘:右侧放不下子菜单时向左展开
  const flip = x + 400 > window.innerWidth
  const left = Math.max(8, Math.min(x, window.innerWidth - 200))
  const top = Math.max(8, Math.min(y, window.innerHeight - 330))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const renderItems = (list: MikuMenuItem[]) => (
    <>
      {list.map((it) =>
        it.divider ? (
          <div key={it.key} className="miku-menu-sep" />
        ) : (
          <div
            key={it.key}
            className={`miku-menu-item${it.dim ? ' dim' : ''}`}
            onMouseEnter={() => it.children && setOpenKey(it.key)}
            onMouseLeave={() => it.children && openKey === it.key && setOpenKey(null)}
            onClick={(e) => {
              e.stopPropagation()
              if (it.dim) return
              if (it.children) {
                setOpenKey(openKey === it.key ? null : it.key)
                return
              }
              it.onClick?.()
              onClose()
            }}
          >
            <span className="chk">{it.checked !== undefined && it.checked ? '✓' : ''}</span>
            <span className="lbl">{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
            {it.children && <span className="arr">›</span>}
            {it.children && openKey === it.key && (
              <div className={`miku-menu sub${flip ? ' flip' : ''}`}>{renderItems(it.children)}</div>
            )}
          </div>
        ),
      )}
    </>
  )

  return (
    <div
      className="miku-menu-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        className="miku-menu"
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseLeave={() => setOpenKey(null)}
      >
        {renderItems(items)}
      </div>
    </div>
  )
}
