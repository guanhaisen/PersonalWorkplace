import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COLLECTIONS,
  backupDatabase,
  cleanExpiredSessions,
  createSession,
  createUser,
  deleteSession,
  findUserByUsername,
  getSessionUser,
  readAiConfig,
  readUserCollections,
  readUserSettings,
  verifyPassword,
  writeAiConfig,
  writeUserCollection,
  writeUserSettings,
} from './db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = process.env.PORT || 3001
// 云端部署经反向代理访问,必须监听所有网卡;本地如需限制,启动前设 HOST=127.0.0.1
const HOST = process.env.HOST || '0.0.0.0'

const COOKIE_NAME = 'wb_session'
const SESSION_TTL_S = 30 * 24 * 3600
// 用户名:2-24 位中文、字母、数字或下划线
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,24}$/

const app = express()
app.use(express.json({ limit: '5mb' }))

// async 处理器的异常统一转到错误中间件,避免进程崩溃
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)

// ---------- 会话:手工解析 Cookie,不引 cookie-parser ----------

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

const setSessionCookie = (res, token) =>
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`
  )
const clearSessionCookie = (res) =>
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)

function requireUser(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME]
  const user = token ? getSessionUser(token) : null
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录' })
    return
  }
  req.user = user
  req.sessionToken = token
  next()
}

// ---------- 认证:开放注册,密码 scrypt 加盐哈希存库 ----------

app.post('/api/auth/register', h(async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: 'BAD_USERNAME', message: '用户名需为 2-24 位中文、字母、数字或下划线' })
    return
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'BAD_PASSWORD', message: '密码至少 6 位' })
    return
  }
  const user = createUser(username, password) // 重名抛 USERNAME_TAKEN → 错误中间件
  const token = createSession(user.id)
  setSessionCookie(res, token)
  res.json({ username: user.username })
}))

app.post('/api/auth/login', h(async (req, res) => {
  const user = findUserByUsername(String(req.body?.username || '').trim())
  const ok = user && verifyPassword(user, String(req.body?.password || ''))
  if (!ok) {
    res.status(401).json({ error: 'BAD_CREDENTIALS', message: '用户名或密码错误' })
    return
  }
  const token = createSession(user.id)
  setSessionCookie(res, token)
  res.json({ username: user.username })
}))

app.post('/api/auth/logout', h(async (req, res) => {
  const token = parseCookies(req)[COOKIE_NAME]
  if (token) deleteSession(token)
  clearSessionCookie(res)
  res.json({ ok: true })
}))

app.get('/api/auth/me', h(async (req, res) => {
  const token = parseCookies(req)[COOKIE_NAME]
  const user = token ? getSessionUser(token) : null
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' })
    return
  }
  res.json({ username: user.username })
}))

// ---------- 集合数据:全部按当前用户隔离 ----------

app.get('/api/data', requireUser, h(async (req, res) => {
  res.json(readUserCollections(req.user.id, COLLECTIONS))
}))

for (const name of COLLECTIONS) {
  app.put(`/api/${name}`, requireUser, h(async (req, res) => {
    const payload = Array.isArray(req.body) ? req.body : req.body?.[name]
    if (!Array.isArray(payload)) {
      res.status(400).json({ error: `expected a JSON array for ${name}` })
      return
    }
    writeUserCollection(req.user.id, name, payload)
    res.json({ ok: true })
  }))
}

// 导出当前用户全部数据(JSON 下载)
app.get('/api/export', requireUser, h(async (req, res) => {
  const data = readUserCollections(req.user.id, COLLECTIONS)
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Disposition', `attachment; filename="workbench-${stamp}.json"`)
  res.json(data)
}))

// 导入:覆盖文件中给出的集合,只作用于当前用户。
// 缺失的集合(如旧备份文件没有 chats)保持原样,不强制全量。
app.post('/api/import', requireUser, h(async (req, res) => {
  const body = req.body || {}
  const provided = COLLECTIONS.filter((name) => body[name] !== undefined)
  if (provided.length === 0) {
    res.status(400).json({ error: 'no recognized collections in payload' })
    return
  }
  for (const name of provided) {
    if (!Array.isArray(body[name])) {
      res.status(400).json({ error: `missing or invalid array: ${name}` })
      return
    }
  }
  for (const name of provided) writeUserCollection(req.user.id, name, body[name])
  res.json({ ok: true })
}))

// ---------- 通用设置:学期开始等,按用户存储 ----------

app.get('/api/settings', requireUser, h(async (req, res) => {
  res.json(readUserSettings(req.user.id))
}))

app.put('/api/settings', requireUser, h(async (req, res) => {
  const body = req.body || {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'expected a JSON object' })
    return
  }
  res.json(writeUserSettings(req.user.id, body))
}))

// ---------- AI 助手:配置每用户独立,密钥永不下发到浏览器 ----------

// 对外只暴露 hasKey,密钥本身永不下发
const publicAiConfig = (cfg) => ({
  baseUrl: cfg.baseUrl || '',
  model: cfg.model || '',
  hasKey: Boolean(cfg.apiKey),
})

app.get('/api/ai/config', requireUser, h(async (req, res) => {
  res.json(publicAiConfig(readAiConfig(req.user.id)))
}))

app.put('/api/ai/config', requireUser, h(async (req, res) => {
  const body = req.body || {}
  const prev = readAiConfig(req.user.id)
  const next = {
    baseUrl: String(body.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(body.model || '').trim(),
    // apiKey 留空表示保持不变;要清除必须显式传 clearKey: true
    apiKey:
      body.clearKey === true
        ? ''
        : String(body.apiKey || '').trim() || prev.apiKey || '',
  }
  writeAiConfig(req.user.id, next)
  res.json(publicAiConfig(next))
}))

// 调用 OpenAI 兼容的 chat/completions:注入当前用户的密钥,60 秒超时;
// 传入 clientSignal 时,客户端断开可提前中断,不空等超时
async function callUpstream(cfg, payload, clientSignal) {
  const signals = [AbortSignal.timeout(60_000)]
  if (clientSignal) signals.push(clientSignal)
  return fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, ...payload }),
    signal: AbortSignal.any(signals),
  })
}

async function upstreamError(res, upstream) {
  const text = await upstream.text().catch(() => '')
  let message = text
  try {
    const err = JSON.parse(text)
    message = err.error?.message || err.message || text
  } catch {
    // 保留原始文本
  }
  res.status(502).json({ error: 'AI_UPSTREAM', message: `上游服务返回 ${upstream.status}:${message || '无详情'}` })
}

// 聊天代理:前端传 messages(含 system 快照)与 tools,返回模型的一条 message
// (文本或 tool_calls);工具执行与多轮编排都在前端完成。
app.post('/api/ai/chat', requireUser, h(async (req, res) => {
  const cfg = readAiConfig(req.user.id)
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    res.status(400).json({ error: 'AI_NOT_CONFIGURED', message: '尚未配置 AI 服务,请先在 Miku 页填写接口配置' })
    return
  }
  const body = req.body || {}
  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: 'AI_BAD_REQUEST', message: 'messages 必须是数组' })
    return
  }
  const payload = { messages: body.messages }
  if (Array.isArray(body.tools) && body.tools.length > 0) payload.tools = body.tools
  // 客户端断开(如前端点了「停止」)时同步中断上游请求;
  // res 的 close 明确覆盖「连接提前终止」,req 的 close 在部分 Node 版本上不可靠
  const clientGone = new AbortController()
  res.on('close', () => clientGone.abort())
  try {
    const upstream = await callUpstream(cfg, payload, clientGone.signal)
    if (!upstream.ok) {
      await upstreamError(res, upstream)
      return
    }
    const data = await upstream.json()
    res.json({ message: data.choices?.[0]?.message ?? null, usage: data.usage ?? null })
  } catch (err) {
    if (clientGone.signal.aborted) return // 客户端已离开,响应无人接收
    res.status(502).json({ error: 'AI_NETWORK', message: `无法连接 AI 服务:${err?.message || err}` })
  }
}))

// 连通性测试:发一条极小请求验证配置是否可用
app.post('/api/ai/test', requireUser, h(async (req, res) => {
  const cfg = readAiConfig(req.user.id)
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    res.json({ ok: false, message: '请先填写接口地址、模型名和 API Key' })
    return
  }
  try {
    const upstream = await callUpstream(cfg, {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    })
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      let message = text
      try {
        const err = JSON.parse(text)
        message = err.error?.message || err.message || text
      } catch {
        // 保留原始文本
      }
      res.json({ ok: false, message: `上游服务返回 ${upstream.status}:${message || '无详情'}` })
      return
    }
    res.json({ ok: true, model: cfg.model })
  } catch (err) {
    res.json({ ok: false, message: `无法连接:${err?.message || err}` })
  }
}))

// 生产模式:托管 dist 下的构建产物;开发模式页面由 Vite(5173)提供
app.use(express.static(DIST_DIR))
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => err && next())
})

// 请求级错误兜底:记录并返回 500,不让进程退出
// (重名注册是预期业务错误,静默转 400,不刷堆栈)
app.use((err, _req, res, _next) => {
  if (err?.code === 'USERNAME_TAKEN') {
    if (!res.headersSent) res.status(400).json({ error: 'USERNAME_TAKEN', message: err.message })
    return
  }
  console.error('[server] request error:', err)
  if (!res.headersSent) res.status(500).json({ error: 'server error' })
})

// 进程级兜底:个人工具宁可带病运行,也不静默退出
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err)
})

// 端口被占(如已有 dev server 在跑)必须立刻失败退出,不能带病空转
cleanExpiredSessions()
backupDatabase()
app.listen(PORT, HOST, () => {
  console.log(`[server] API ready on http://localhost:${PORT}`)
}).on('error', (err) => {
  console.error(`[server] 监听 ${PORT} 失败:`, err.message)
  process.exit(1)
})
