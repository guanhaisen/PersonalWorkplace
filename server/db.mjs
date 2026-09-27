// 数据层：SQLite(better-sqlite3) 单文件库 data/workbench.db
// 六个业务集合统一存 items 表,按 (用户, 集合, 条目id) 主键隔离
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const DB_FILE = path.join(DATA_DIR, 'workbench.db')
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const BACKUP_KEEP = 10 // 保留的最近启动备份数

export const COLLECTIONS = ['todos', 'courses', 'habits', 'chats', 'links', 'reminders']
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    pass_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    user_id INTEGER NOT NULL,
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, collection, id)
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_configs (
    user_id INTEGER PRIMARY KEY,
    base_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT ''
  );
`)

// ---------- 密码:node:crypto scrypt 加盐哈希,格式 "scrypt$saltHex$hashHex" ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  })
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(user, password) {
  const [scheme, saltHex, hashHex] = String(user.pass_hash).split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  })
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

// ---------- 用户 ----------

const insertUser = db.prepare(
  'INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)'
)

export function createUser(username, password) {
  try {
    const info = insertUser.run(username, hashPassword(password), new Date().toISOString())
    return { id: Number(info.lastInsertRowid), username }
  } catch (err) {
    if (String(err?.code).startsWith('SQLITE_CONSTRAINT')) {
      const e = new Error('用户名已存在')
      e.code = 'USERNAME_TAKEN'
      throw e
    }
    throw err
  }
}

const selectUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?')

export function findUserByUsername(username) {
  return selectUserByUsername.get(username) || null
}

// ---------- 会话 ----------

const insertSession = db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
const selectSession = db.prepare(`
  SELECT s.user_id, s.expires_at, u.username
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = ?
`)
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?')
const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?')

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  insertSession.run(token, userId, Date.now() + SESSION_TTL_MS)
  return token
}

export function getSessionUser(token) {
  const row = selectSession.get(token)
  if (!row || row.expires_at <= Date.now()) return null
  return { id: row.user_id, username: row.username }
}

export function deleteSession(token) {
  deleteSessionStmt.run(token)
}

export function cleanExpiredSessions() {
  deleteExpiredSessions.run(Date.now())
}

// ---------- 集合数据:整集合覆盖写(与前端防抖 PUT 模型一致) ----------

const selectItems = db.prepare(
  'SELECT data FROM items WHERE user_id = ? AND collection = ? ORDER BY ord'
)
const deleteItems = db.prepare('DELETE FROM items WHERE user_id = ? AND collection = ?')
const insertItem = db.prepare(
  'INSERT OR REPLACE INTO items (user_id, collection, id, ord, data) VALUES (?, ?, ?, ?, ?)'
)

const writeCollectionTx = db.transaction((userId, name, items) => {
  deleteItems.run(userId, name)
  items.forEach((item, ord) => {
    const id = typeof item?.id === 'string' && item.id ? item.id : crypto.randomUUID()
    insertItem.run(userId, name, id, ord, JSON.stringify(item))
  })
})

export function readUserCollection(userId, name) {
  return selectItems.all(userId, name).map((row) => JSON.parse(row.data))
}

export function readUserCollections(userId, names) {
  const out = {}
  for (const name of names) out[name] = readUserCollection(userId, name)
  return out
}

export function writeUserCollection(userId, name, items) {
  writeCollectionTx(userId, name, items)
}

// ---------- 用户设置(浅合并,保留原 /api/settings 语义) ----------

const selectSettings = db.prepare('SELECT data FROM user_settings WHERE user_id = ?')
const upsertSettings = db.prepare(`
  INSERT INTO user_settings (user_id, data) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET data = excluded.data
`)

export function readUserSettings(userId) {
  const row = selectSettings.get(userId)
  try {
    return row ? JSON.parse(row.data) : {}
  } catch {
    return {}
  }
}

export function writeUserSettings(userId, patch) {
  const merged = { ...readUserSettings(userId), ...patch }
  upsertSettings.run(userId, JSON.stringify(merged))
  return merged
}

// ---------- AI 配置(每用户一份,apiKey 永不出数据层) ----------

const selectAiConfig = db.prepare('SELECT * FROM ai_configs WHERE user_id = ?')
const upsertAiConfig = db.prepare(`
  INSERT INTO ai_configs (user_id, base_url, model, api_key) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, api_key = excluded.api_key
`)

export function readAiConfig(userId) {
  const row = selectAiConfig.get(userId)
  return { baseUrl: row?.base_url || '', model: row?.model || '', apiKey: row?.api_key || '' }
}

export function writeAiConfig(userId, cfg) {
  upsertAiConfig.run(userId, cfg.baseUrl || '', cfg.model || '', cfg.apiKey || '')
}

// ---------- 启动维护:备份数据库文件 ----------

// 复制前先 checkpoint,把 WAL 里的事务落盘,保证备份文件完整
export function backupDatabase() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `workbench-${stamp}.db`))
    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('workbench-') && f.endsWith('.db'))
      .sort()
    for (const old of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
      fs.rmSync(path.join(BACKUP_DIR, old), { force: true })
    }
  } catch (err) {
    console.error('[server] database backup failed:', err?.message || err)
  }
}
