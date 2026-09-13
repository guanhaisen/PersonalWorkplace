import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = process.env.PORT || 3001
// 默认只监听本机,局域网设备不可达;确需开放时启动前设 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1'

const COLLECTIONS = ['todos', 'notes', 'habits', 'pomodoros', 'chats', 'links']
const DEFAULTS = { todos: [], notes: [], habits: [], pomodoros: [], chats: [], links: [] }
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const BACKUP_KEEP = 10 // 每个集合保留的最近备份数
const BACKUP_MIN_GAP_MS = 60_000 // 距上次备份不足 1 分钟则跳过(防抖动写入刷屏)

await fs.mkdir(DATA_DIR, { recursive: true })

async function readCollection(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, `${name}.json`), 'utf-8'))
  } catch {
    return structuredClone(DEFAULTS[name])
  }
}

// 写入前把当前文件滚动备份到 data/backups/,防误写/误清
async function backupCollection(name) {
  const file = path.join(DATA_DIR, `${name}.json`)
  try {
    await fs.access(file)
  } catch {
    return // 首次写入,没有旧文件
  }
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  const existing = (await fs.readdir(BACKUP_DIR)).filter((f) => f.startsWith(`${name}.`)).sort()
  if (existing.length > 0) {
    const newest = existing[existing.length - 1]
    const stat = await fs.stat(path.join(BACKUP_DIR, newest))
    if (Date.now() - stat.mtimeMs < BACKUP_MIN_GAP_MS) return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await fs.copyFile(file, path.join(BACKUP_DIR, `${name}.${stamp}.json`))
  for (const old of existing.slice(0, Math.max(0, existing.length + 1 - BACKUP_KEEP))) {
    await fs.rm(path.join(BACKUP_DIR, old), { force: true })
  }
}

// Windows 下目标文件偶发被占用(EPERM),重试后再放弃
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'ENOENT'].includes(err.code)) throw err
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
  }
}

// 先写临时文件再 rename,避免写一半时崩溃损坏数据
async function writeCollection(name, items) {
  await backupCollection(name)
  const file = path.join(DATA_DIR, `${name}.json`)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8')
  await renameWithRetry(tmp, file)
}

const app = express()
app.use(express.json({ limit: '5mb' }))

// async 处理器的异常统一转到错误中间件,避免进程崩溃
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)

app.get('/api/data', h(async (_req, res) => {
  const data = {}
  for (const name of COLLECTIONS) data[name] = await readCollection(name)
  res.json(data)
}))

for (const name of COLLECTIONS) {
  app.put(`/api/${name}`, h(async (req, res) => {
    const payload = Array.isArray(req.body) ? req.body : req.body?.[name]
    if (!Array.isArray(payload)) {
      res.status(400).json({ error: `expected a JSON array for ${name}` })
      return
    }
    await writeCollection(name, payload)
    res.json({ ok: true })
  }))
}

// 导出全部数据(JSON 下载)
app.get('/api/export', h(async (_req, res) => {
  const data = {}
  for (const name of COLLECTIONS) data[name] = await readCollection(name)
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Disposition', `attachment; filename="workbench-${stamp}.json"`)
  res.json(data)
}))

// 导入:覆盖文件中给出的集合(写入前会逐集合备份当前数据)。
// 缺失的集合(如旧备份文件没有 chats)保持原样,不强制全量。
app.post('/api/import', h(async (req, res) => {
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
  for (const name of provided) await writeCollection(name, body[name])
  res.json({ ok: true })
}))

// ---------- AI 助手:配置存 data/ai-config.json(gitignore,含密钥) ----------

const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json')

async function readAiConfig() {
  try {
    return JSON.parse(await fs.readFile(AI_CONFIG_FILE, 'utf-8'))
  } catch {
    return { baseUrl: '', model: '', apiKey: '' }
  }
}

async function writeAiConfig(cfg) {
  const tmp = `${AI_CONFIG_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf-8')
  await renameWithRetry(tmp, AI_CONFIG_FILE)
}

// 对外只暴露 hasKey,密钥本身永不下发到浏览器
const publicAiConfig = (cfg) => ({
  baseUrl: cfg.baseUrl || '',
  model: cfg.model || '',
  hasKey: Boolean(cfg.apiKey),
})

app.get('/api/ai/config', h(async (_req, res) => {
  res.json(publicAiConfig(await readAiConfig()))
}))

app.put('/api/ai/config', h(async (req, res) => {
  const body = req.body || {}
  const prev = await readAiConfig()
  const next = {
    baseUrl: String(body.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(body.model || '').trim(),
    // apiKey 留空表示保持不变;要清除必须显式传 clearKey: true
    apiKey:
      body.clearKey === true
        ? ''
        : String(body.apiKey || '').trim() || prev.apiKey || '',
  }
  await writeAiConfig(next)
  res.json(publicAiConfig(next))
}))

// 调用 OpenAI 兼容的 chat/completions:注入服务端密钥,60 秒超时;
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
app.post('/api/ai/chat', h(async (req, res) => {
  const cfg = await readAiConfig()
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    res.status(400).json({ error: 'AI_NOT_CONFIGURED', message: '尚未配置 AI 服务,请先在 AI 助手页填写接口配置' })
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
app.post('/api/ai/test', h(async (_req, res) => {
  const cfg = await readAiConfig()
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
app.use((err, _req, res, _next) => {
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
app.listen(PORT, HOST, () => {
  console.log(`[server] API ready on http://localhost:${PORT}`)
}).on('error', (err) => {
  console.error(`[server] 监听 ${PORT} 失败:`, err.message)
  process.exit(1)
})
