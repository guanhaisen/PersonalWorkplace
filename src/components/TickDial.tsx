// 番茄钟 60 格刻度环(方向 A):灰色刻度为底,已消耗的整分钟刻度点亮为强调色

const R = 80
const CIRC = 2 * Math.PI * R
const PERIOD = 8.38 // 单格周期 = 1.4(点) + 6.98(空隙)

export default function TickDial({ progress }: { progress: number }) {
  const clamped = Math.min(1, Math.max(0, progress))
  const ticks = Math.floor(clamped * 60 + 1e-6)
  const accentLen = ticks > 0 ? ticks * PERIOD - (PERIOD - 1.4) : 0

  return (
    <svg viewBox="0 0 186 186" aria-hidden="true">
      <g transform="rotate(-90 93 93)">
        <circle cx="93" cy="93" r={R} fill="none" stroke="#E0DFD5" strokeWidth="9" strokeDasharray="1.4 6.98" />
        {accentLen > 0 && (
          <circle
            cx="93"
            cy="93"
            r={R}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="9"
            strokeDasharray={`${accentLen} ${CIRC}`}
          />
        )}
      </g>
      <circle cx="93" cy="93" r="64" fill="none" stroke="var(--line-soft)" strokeWidth="1.2" />
      <circle cx="93" cy="13" r="3.4" fill="var(--accent)" />
    </svg>
  )
}
