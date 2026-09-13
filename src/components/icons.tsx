// 细线 SVG 图标(与方向 A 初稿一致的 16px 网格)

export function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="15" r="10" stroke="#1D2622" strokeWidth="1.6" />
      <path d="M14 15V8.6" stroke="#0F766E" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M14 15l4 2.6" stroke="#1D2622" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14" cy="3" r="1.8" fill="#0F766E" />
    </svg>
  )
}

export function IconOverview() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" fill="currentColor" />
    </svg>
  )
}

export function IconTodo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.4 8.1l2 2.1 3.4-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconNote() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.6 2.2h6l2.8 2.8v8.8H3.6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9.6 2.4V5h2.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 8.4h4M6 10.8h2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function IconTimer() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="9.2" r="5.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 9.2l2.3-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.4 2h3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 2v1.8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function IconHabit() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3.2" cy="3.2" r="1.5" fill="currentColor" />
      <circle cx="8" cy="3.2" r="1.5" fill="currentColor" />
      <circle cx="12.8" cy="3.2" r="1.5" fill="currentColor" />
      <circle cx="3.2" cy="8" r="1.5" fill="currentColor" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.5" fill="currentColor" opacity=".28" />
      <circle cx="3.2" cy="12.8" r="1.5" fill="currentColor" opacity=".28" />
      <circle cx="8" cy="12.8" r="1.5" fill="currentColor" opacity=".28" />
      <circle cx="12.8" cy="12.8" r="1.5" fill="currentColor" opacity=".28" />
    </svg>
  )
}

/** 优先级三格信号条:高=全亮,中=两格,低=一格 */
export function IconFlag({ level }: { level: 'high' | 'mid' | 'low' }) {
  const color = level === 'high' ? '#0F766E' : level === 'mid' ? '#7C8883' : '#B4BCB6'
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" fill={color} aria-hidden="true">
      <rect x="0" y="7.5" width="2.4" height="4.5" rx="1" opacity={level === 'low' ? 0.35 : 1} />
      <rect x="4.3" y="4" width="2.4" height="8" rx="1" opacity={level === 'low' ? 0.35 : 1} />
      <rect x="8.6" y="0.5" width="2.4" height="11.5" rx="1" />
    </svg>
  )
}

export function IconCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.2 6.4l2.6 2.7 5-5.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 卡片拖拽手柄:两列圆点 */
export function IconGrip() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="2.5" r="1.3" />
      <circle cx="8" cy="2.5" r="1.3" />
      <circle cx="4" cy="6" r="1.3" />
      <circle cx="8" cy="6" r="1.3" />
      <circle cx="4" cy="9.5" r="1.3" />
      <circle cx="8" cy="9.5" r="1.3" />
    </svg>
  )
}

export function IconSearch() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="5.2" cy="5.2" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.2 8.2L11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
