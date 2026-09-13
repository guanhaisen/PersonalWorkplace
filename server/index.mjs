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

await fs.mkdir(DATA_DIR, { recursive: true })

async function readCollection(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, `${name}.json`), 'utf-8'))
  } catch {
    return structuredClone(DEFAULTS[name])
  }
}

// 先写临时文件再 rename,避免写一半时崩溃损坏数据
async function writeCollection(name, items) {
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

// 生产模式:托管 dist 下的构建产物;开发模式页面由 Vite(5173)提供
app.use(express.static(DIST_DIR))
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => err && next())
})

app.listen(PORT, () => {
  console.log(`[server] API ready on http://localhost:${PORT}`)
})
