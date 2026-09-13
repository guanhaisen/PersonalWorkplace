import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const DIST_DIR = path.join(ROOT, 'dist')
const PORT = process.env.PORT || 3001

const COLLECTIONS = ['todos', 'notes', 'habits', 'pomodoros']
const DEFAULTS = { todos: [], notes: [], habits: [], pomodoros: [] }
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

// 先写临时文件再 rename,避免写一半时崩溃损坏数据
async function writeCollection(name, items) {
  await backupCollection(name)
  const file = path.join(DATA_DIR, `${name}.json`)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

const app = express()
app.use(express.json({ limit: '5mb' }))

app.get('/api/data', async (_req, res) => {
  const data = {}
  for (const name of COLLECTIONS) data[name] = await readCollection(name)
  res.json(data)
})

for (const name of COLLECTIONS) {
  app.put(`/api/${name}`, async (req, res) => {
    const payload = Array.isArray(req.body) ? req.body : req.body?.[name]
    if (!Array.isArray(payload)) {
      res.status(400).json({ error: `expected a JSON array for ${name}` })
      return
    }
    await writeCollection(name, payload)
    res.json({ ok: true })
  })
}

// 导出全部数据(JSON 下载)
app.get('/api/export', async (_req, res) => {
  const data = {}
  for (const name of COLLECTIONS) data[name] = await readCollection(name)
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Disposition', `attachment; filename="workbench-${stamp}.json"`)
  res.json(data)
})

// 导入:覆盖全部集合(写入前会逐集合备份当前数据)
app.post('/api/import', async (req, res) => {
  const body = req.body || {}
  for (const name of COLLECTIONS) {
    if (!Array.isArray(body[name])) {
      res.status(400).json({ error: `missing or invalid array: ${name}` })
      return
    }
  }
  for (const name of COLLECTIONS) await writeCollection(name, body[name])
  res.json({ ok: true })
})

// 生产模式:托管 dist 下的构建产物;开发模式页面由 Vite(5173)提供
app.use(express.static(DIST_DIR))
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => err && next())
})

app.listen(PORT, () => {
  console.log(`[server] API ready on http://localhost:${PORT}`)
})
