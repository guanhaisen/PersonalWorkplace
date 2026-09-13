import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppData, ChatUsage } from '../types'
import type { UpdateFn, ViewKey } from '../App'
import { todayStr, uid } from '../api'
import {
  AI_TOOLS,
  aiChat,
  buildSystemPrompt,
  loadAiConfig,
  saveAiConfig,
  testAiConfig,
  type AiConfigInfo,
  type ToolCall,
  type UpstreamMessage,
} from '../ai'

interface Props {
  data: AppData
  update: UpdateFn
  onNavigate: (view: ViewKey) => void
  /** 提供时在头部显示 ✕(悬浮聊天窗用),点击回调关闭 */
  onClose?: () => void
  /** 挂载后自动聚焦输入框(悬浮聊天窗用) */
  autoFocus?: boolean
}

// 预置服务商:点击即把地址与推荐模型填入表单
const PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
]

const VIEWS: ViewKey[] = ['overview', 'todos', 'notes', 'focus', 'habits', 'ai']
const nowIso = () => new Date().toISOString()

export default function AiPanel({ data, update, onNavigate, onClose, autoFocus }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolNote, setToolNote] = useState('')
  const [error, setError] = useState('')
  const [cfg, setCfg] = useState<AiConfigInfo | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  // 工具循环内同步累积数据变更:React 状态要等渲染才更新,循环里读 dataRef
  // 拿到的是旧值,AI 会看不到本轮已执行的操作(快照在 runTurn 开始时重置)
  const toolSnapshotRef = useRef<AppData | null>(null)

  // executeTool 内用它代替 update:先把 updater 应用到快照,再走正常的防抖保存
  const applyToolUpdate: UpdateFn = (key, updater) => {
    const base = toolSnapshotRef.current
    if (base) toolSnapshotRef.current = { ...base, [key]: updater(base[key]) }
    update(key, updater)
  }

  // 配置状态决定空态引导与头部元信息;打开设置后重新拉取
  useEffect(() => {
    loadAiConfig()
      .then(setCfg)
      .catch(() => setCfg(null))
  }, [settingsOpen])

  // 命令面板「询问 AI 助手」:切到本页并聚焦输入框
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('workbench:ai-focus', focus)
    return () => window.removeEventListener('workbench:ai-focus', focus)
  }, [])

  // 悬浮聊天窗:挂载后聚焦输入框
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新消息 / 忙碌状态变化时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data.chats.length, busy, toolNote])

  // 执行模型请求的工具调用,返回给模型的结果对象
  const executeTool = (call: ToolCall): unknown => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      return { ok: false, error: '参数不是有效 JSON' }
    }
    const d = toolSnapshotRef.current ?? dataRef.current
    const str = (v: unknown) => String(v ?? '').trim()
    switch (call.function.name) {
      case 'add_todo': {
        const title = str(args.title)
        if (!title) return { ok: false, error: 'title 为空' }
        const rawPriority = str(args.priority)
        const priority = (['high', 'mid', 'low'].includes(rawPriority) ? rawPriority : 'low') as
          | 'high'
          | 'mid'
          | 'low'
        const todoId = uid()
        applyToolUpdate('todos', (items) => [
          ...items,
          {
            id: todoId,
            title,
            done: false,
            priority,
            dueDate: str(args.dueDate) || undefined,
            createdAt: nowIso(),
          },
        ])
        return { ok: true, todoId }
      }
      case 'complete_todo': {
        const id = str(args.id)
        if (!d.todos.some((t) => t.id === id)) return { ok: false, error: `未找到待办 ${id}` }
        applyToolUpdate('todos', (items) =>
          items.map((t) => (t.id === id && !t.done ? { ...t, done: true, completedAt: nowIso() } : t)),
        )
        return { ok: true }
      }
      case 'delete_todo': {
        const id = str(args.id)
        if (!d.todos.some((t) => t.id === id)) return { ok: false, error: `未找到待办 ${id}` }
        applyToolUpdate('todos', (items) => items.filter((t) => t.id !== id))
        return { ok: true }
      }
      case 'add_note': {
        const content = str(args.content)
        if (!content) return { ok: false, error: 'content 为空' }
        applyToolUpdate('notes', (items) => [{ id: uid(), content, pinned: false, updatedAt: nowIso() }, ...items])
        return { ok: true }
      }
      case 'create_habit': {
        const name = str(args.name)
        if (!name) return { ok: false, error: 'name 为空' }
        if (d.habits.some((h) => h.name === name)) return { ok: false, error: '同名习惯已存在' }
        applyToolUpdate('habits', (items) => [...items, { id: uid(), name, createdAt: nowIso(), records: {} }])
        return { ok: true }
      }
      case 'check_habit': {
        const id = str(args.id)
        const habit = d.habits.find((h) => h.id === id)
        if (!habit) return { ok: false, error: `未找到习惯 ${id}` }
        const today = todayStr()
        if (habit.records[today]) return { ok: true, note: '今天已打过卡' }
        applyToolUpdate('habits', (items) =>
          items.map((h) => (h.id === id ? { ...h, records: { ...h.records, [today]: true } } : h)),
        )
        return { ok: true }
      }
      case 'switch_view': {
        const view = str(args.view) as ViewKey
        if (!VIEWS.includes(view)) return { ok: false, error: `未知页面 ${view}` }
        onNavigate(view)
        return { ok: true }
      }
      default:
        return { ok: false, error: `未知工具 ${call.function.name}` }
    }
  }

  // 一轮完整对话:请求 → (工具调用 → 本地执行 → 回传结果 → 再请求)×≤5 → 最终文本。
  // 返回文本与整轮各次请求的 token 用量合计。
  const runTurn = async (
    userText: string,
    signal: AbortSignal,
  ): Promise<{ text: string; usage: ChatUsage | null }> => {
    // 历史取已持久化的最近 12 条(此刻还不含刚发送的这条,稍后显式 push);
    // 末尾若挂着没有回复的 user 消息(上一轮失败或中止留下的),先去掉,
    // 避免与本次新消息连成两条 user,部分严格的上游会拒绝
    const persisted = dataRef.current.chats.slice(-12)
    while (persisted.length > 0 && persisted[persisted.length - 1].role === 'user') persisted.pop()
    const history: UpstreamMessage[] = persisted.map((m) => ({ role: m.role, content: m.content }))
    // 工具快照从当前数据出发,本轮工具执行期间的变更会同步累积进去
    toolSnapshotRef.current = dataRef.current
    const messages: UpstreamMessage[] = [
      { role: 'system', content: buildSystemPrompt(toolSnapshotRef.current) },
      ...history,
      { role: 'user', content: userText },
    ]
    let usage: ChatUsage | null = null
    const addUsage = (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
      usage = usage
        ? {
            prompt: usage.prompt + u.prompt_tokens,
            completion: usage.completion + u.completion_tokens,
            total: usage.total + u.total_tokens,
          }
        : { prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens }
    }
    for (let round = 0; round < 5; round++) {
      const res = await aiChat({ messages, tools: AI_TOOLS }, signal)
      if (res.usage) addUsage(res.usage)
      const msg = res.message
      if (!msg) throw new Error('AI 没有返回内容')
      if (msg.tool_calls?.length) {
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })
        for (const call of msg.tool_calls) {
          setToolNote(`正在执行工具 ${call.function.name}…`)
          let result: unknown
          try {
            result = executeTool(call)
          } catch (err) {
            result = { ok: false, error: String(err) }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
        }
        // 本地数据已变,用最新快照重建 system,便于模型准确确认结果
        messages[0] = { role: 'system', content: buildSystemPrompt(toolSnapshotRef.current ?? dataRef.current) }
        setToolNote('正在整理结果…')
        continue
      }
      return { text: (msg.content || '').trim() || '(AI 没有返回内容)', usage }
    }
    throw new Error('工具调用超过 5 轮,已中止')
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setError('')
    update('chats', (items) => [...items, { id: uid(), role: 'user', content: text, ts: nowIso() }])
    setBusy(true)
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const { text: reply, usage } = await runTurn(text, abort.signal)
      update('chats', (items) => [
        ...items,
        { id: uid(), role: 'assistant', content: reply, ts: nowIso(), usage: usage ?? undefined },
      ])
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setError((err as Error)?.message || '请求失败,请重试')
    } finally {
      abortRef.current = null
      setBusy(false)
      setToolNote('')
    }
  }

  const clear = () => {
    if (data.chats.length === 0) return
    if (window.confirm('清空全部对话记录?')) update('chats', () => [])
  }

  const chats = data.chats
  const configured = !!cfg && !!cfg.baseUrl && !!cfg.model && cfg.hasKey

  // 对话累计 token:所有持久化回复的 usage 之和
  const usageTotal = useMemo(
    () =>
      data.chats.reduce(
        (acc, m) =>
          m.usage
            ? {
                prompt: acc.prompt + m.usage.prompt,
                completion: acc.completion + m.usage.completion,
                total: acc.total + m.usage.total,
              }
            : acc,
        { prompt: 0, completion: 0, total: 0 },
      ),
    [data.chats],
  )
  const lastUsage = useMemo(() => [...data.chats].reverse().find((m) => m.usage)?.usage, [data.chats])

  // 点胶囊外其他位置时收起用量下拉
  useEffect(() => {
    if (!usageOpen) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ai-model-wrap')) setUsageOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [usageOpen])

  return (
    <div className="panel panel-ai">
      <header className="p-head">
        <h2>
          <span className="tag">AI</span>
          <i>/</i>AI 助手
        </h2>
        <div className="ai-head-actions">
          {configured && (
            <div className="ai-model-wrap">
              <button
                className="ai-model-pill"
                title="模型与 Token 用量"
                onClick={() => setUsageOpen((v) => !v)}
              >
                <span className={`ai-model-dot ${busy ? 'busy' : ''} ${error ? 'err' : ''}`} />
                <span className="ai-model-name">{cfg!.model}</span>
                <svg className="ai-model-chev" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path
                    d="M1.5 3l2.5 2.5L6.5 3"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {usageOpen && (
                <div className="ai-usage-pop">
                  <div className="ai-usage-row">
                    <span>对话累计</span>
                    <b>{usageTotal.total.toLocaleString()}</b>
                  </div>
                  <div className="ai-usage-row">
                    <span>提示 / 生成</span>
                    <span>
                      {usageTotal.prompt.toLocaleString()} / {usageTotal.completion.toLocaleString()}
                    </span>
                  </div>
                  {lastUsage && (
                    <div className="ai-usage-row">
                      <span>最近一轮</span>
                      <span>{lastUsage.total.toLocaleString()}</span>
                    </div>
                  )}
                  {usageTotal.total === 0 && <div className="ai-usage-empty">发送消息后显示用量</div>}
                </div>
              )}
            </div>
          )}
          <button className="ai-head-btn" onClick={clear} title="清空对话记录">
            清空
          </button>
          <button className="ai-head-btn" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
          {onClose && (
            <button className="ai-head-btn" onClick={onClose} title="关闭">
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="ai-msgs" ref={listRef}>
        {chats.length === 0 && !busy && (
          <div className="ai-welcome">
            <p>问数据、记待办、写笔记、打卡习惯,交给 AI 完成。</p>
            <p className="ai-welcome-eg">试试「我这周效率怎么样」,或「帮我加一条明天交周报的待办」。</p>
            {cfg && !configured && (
              <button className="btn solid" onClick={() => setSettingsOpen(true)}>
                先去配置 AI 服务
              </button>
            )}
          </div>
        )}
        {chats.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <div className="ai-bubble">{m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="ai-msg assistant">
            <div className="ai-bubble ai-typing">
              <span className="ai-dots">
                <i />
                <i />
                <i />
              </span>
              {toolNote || '思考中…'}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="ai-error">
          <span>{error}</span>
          <button onClick={() => setError('')}>知道了</button>
        </div>
      )}

      <div className="ai-input-row">
        <input
          ref={inputRef}
          className="in"
          value={input}
          placeholder={configured ? '问点什么,或让 AI 帮你记一笔…' : '先在「设置」里配置 AI 服务'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
          }}
          disabled={busy}
        />
        {busy ? (
          <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button className="btn solid" onClick={send} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>

      {settingsOpen && <AiSettings onClose={() => setSettingsOpen(false)} onSaved={setCfg} />}
    </div>
  )
}

// ---------- 设置弹窗 ----------

function AiSettings({ onClose, onSaved }: { onClose: () => void; onSaved: (c: AiConfigInfo) => void }) {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const baseUrlRef = useRef<HTMLInputElement>(null)

  // 当前接口地址命中的预置;都不匹配则「自定义」高亮
  const activePreset = PRESETS.findIndex((p) => p.baseUrl === baseUrl)
  const isCustom = baseUrl.trim() !== '' && activePreset === -1

  useEffect(() => {
    loadAiConfig()
      .then((c) => {
        setBaseUrl(c.baseUrl)
        setModel(c.model)
        setHasKey(c.hasKey)
      })
      .catch(() => undefined)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickCustom = () => {
    setBaseUrl('')
    setModel('')
    requestAnimationFrame(() => baseUrlRef.current?.focus())
  }

  const persist = async () => {
    const saved = await saveAiConfig({ baseUrl, model, apiKey })
    onSaved(saved)
    setHasKey(saved.hasKey)
    setApiKey('')
    return saved
  }

  const save = async () => {
    setSaving(true)
    try {
      await persist()
      onClose()
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    // 测试前先保存,保证测的就是表单里的配置
    setTesting(true)
    setTestResult(null)
    try {
      await persist()
      const r = await testAiConfig()
      setTestResult({ ok: !!r.ok, message: r.ok ? `连接成功(${r.model})` : r.message || '连接失败' })
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  // 立即清除服务端已保存的 Key(表单其余字段不动)
  const clearKey = async () => {
    setSaving(true)
    setTestResult(null)
    try {
      const saved = await saveAiConfig({ baseUrl, model, apiKey: '', clearKey: true })
      onSaved(saved)
      setHasKey(saved.hasKey)
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div className="ai-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="p-head">
          <h2>
            <span className="tag">AI</span>
            <i>/</i>服务配置
          </h2>
          <span className="p-meta">OpenAI 兼容</span>
        </header>

        <div className="ai-presets">
          {PRESETS.map((p, i) => (
            <button
              key={p.label}
              className={`ai-preset ${i === activePreset ? 'active' : ''}`}
              title={`填入 ${p.baseUrl} · ${p.model}`}
              onClick={() => {
                setBaseUrl(p.baseUrl)
                setModel(p.model)
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            className={`ai-preset ${isCustom ? 'active' : ''}`}
            title="手动填写任意 OpenAI 兼容服务(如 Ollama、OneAPI、中转站)"
            onClick={pickCustom}
          >
            自定义
          </button>
        </div>

        <label className="ai-field">
          <span>接口地址</span>
          <input
            ref={baseUrlRef}
            className="in"
            value={baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label className="ai-field">
          <span>模型名</span>
          <input className="in" value={model} placeholder="gpt-4o-mini" onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="ai-field">
          <span className="ai-field-head">
            API Key
            {hasKey && (
              <button
                type="button"
                className="ai-key-clear"
                disabled={saving || testing}
                title="删除服务端已保存的 Key"
                onClick={(e) => {
                  e.preventDefault() // 在 label 内,别触发聚焦输入框
                  clearKey()
                }}
              >
                清除
              </button>
            )}
          </span>
          <input
            className="in"
            type="password"
            value={apiKey}
            placeholder={hasKey ? '已保存,留空则不修改' : 'sk-…'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        {testResult && <div className={`ai-test ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.message}</div>}

        <p className="ai-privacy">Key 只保存在本机 data/ai-config.json;对话时你的数据摘要会发送给你配置的服务商。</p>

        <div className="ai-modal-foot">
          <button className="btn ghost" onClick={test} disabled={testing || saving}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn solid" onClick={save} disabled={saving || testing}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
