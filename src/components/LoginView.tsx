import { useRef, useState, type FormEvent } from 'react'
import { ApiError, login, register } from '../api'
import { BrandMark } from './icons'

// 用户名规则与后端一致:2-24 位中文、字母、数字或下划线
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,24}$/

/** 登录/注册页:会话用 httpOnly Cookie,成功后由 onAuthed 通知 App 加载数据 */
export default function LoginView({ onAuthed }: { onAuthed: (username: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  const switchMode = (next: 'login' | 'register') => {
    setMode(next)
    setError('')
    setConfirm('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const name = username.trim()
    if (!USERNAME_RE.test(name)) {
      setError('用户名需为 2-24 位中文、字母、数字或下划线')
      return
    }
    if (password.length < 6) {
      setError('密码至少 6 位')
      return
    }
    if (mode === 'register' && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    setError('')
    try {
      const authed = mode === 'login' ? await login(name, password) : await register(name, password)
      onAuthed(authed)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络异常,请稍后再试')
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <BrandMark />
          <div>
            <div className="brand-name">个人工作台</div>
            <div className="brand-sub">WORKBENCH</div>
          </div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        <label className="auth-field">
          <span>用户名</span>
          <input
            className="in"
            value={username}
            placeholder="2-24 位中文、字母、数字或下划线"
            autoComplete="username"
            maxLength={24}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && mode === 'register' && !password) {
                e.preventDefault()
                passwordRef.current?.focus()
              }
            }}
          />
        </label>

        <label className="auth-field">
          <span>密码</span>
          <input
            className="in"
            ref={passwordRef}
            type="password"
            value={password}
            placeholder={mode === 'register' ? '至少 6 位' : '输入密码'}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {mode === 'register' && (
          <label className="auth-field">
            <span>确认密码</span>
            <input
              className="in"
              type="password"
              value={confirm}
              placeholder="再输入一次密码"
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}

        {error && <p className="auth-error">{error}</p>}

        <button className="btn solid auth-submit" disabled={busy}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '创建账号并登录'}
        </button>

        <p className="auth-hint">
          {mode === 'register'
            ? '每个账号拥有独立的待办、课表、习惯与 AI 配置,数据互不相通。'
            : '没有账号?切换到「注册」即可创建,数据保存在本机服务端。'}
        </p>
      </form>
    </div>
  )
}
