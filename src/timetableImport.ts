// 课表导入解析:支持两种来源
// 1. parseCoursesText —— 粘贴的自由文本(每行一门课)
// 2. parseTimetableFile —— 教务系统导出的 xls/xlsx 课表(SheetJS 解析,按需动态加载)

export interface ParsedCourse {
  name: string
  teacher?: string
  location?: string
  weekday: number
  start: string
  end: string
  /** 起始周(含),缺省 = 每周都上 */
  weekStart?: number
  /** 结束周(含) */
  weekEnd?: number
  /** 单双周限制 */
  parity?: 'odd' | 'even'
}

export interface ParseError {
  line: string
  reason: string
}

export const WD_MAP: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
}

const WD_RE = /(星期|周|礼拜)\s*([一二三四五六日天1-7])/
const TIME_RE = /([01]?\d|2[0-3])[:：]([0-5]\d)\s*(?:[-~～—–]|至|到)\s*([01]?\d|2[0-3])[:：]([0-5]\d)/
// 周次,如 第3周 / 3-18周 / 1-16周单
const WEEKS_RE = /第?\s*(\d+)\s*(?:[-~]\s*(\d+))?\s*周\s*([单双])?/

/** 每小节的上下课时间(45 分钟制,午休/晚间大休拉长)。各校作息有差异,导入后可在课表里逐个微调 */
export const PERIOD_TIMES: Record<number, [string, string]> = {
  1: ['08:00', '08:45'], 2: ['08:55', '09:40'],
  3: ['10:00', '10:45'], 4: ['10:55', '11:40'], 5: ['11:50', '12:35'],
  6: ['14:00', '14:45'], 7: ['14:55', '15:40'],
  8: ['16:00', '16:45'], 9: ['16:55', '17:40'], 10: ['17:50', '18:35'],
  11: ['19:00', '19:45'], 12: ['19:55', '20:40'], 13: ['20:50', '21:35'],
}

/** 解析粘贴的课表文本:每行一门课,星期与时间按关键字提取,其余词依次是课程名/@地点/老师 */
export function parseCoursesText(text: string): { list: ParsedCourse[]; errors: ParseError[] } {
  const list: ParsedCourse[] = []
  const errors: ParseError[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const wd = line.match(WD_RE)
    const weekday = wd ? WD_MAP[wd[2]] : 0
    const tm = line.match(TIME_RE)
    if (!weekday) {
      errors.push({ line, reason: '没识别到星期(如 周一)' })
      continue
    }
    if (!tm) {
      errors.push({ line, reason: '没识别到时间(如 08:00-09:40)' })
      continue
    }
    const start = `${tm[1].padStart(2, '0')}:${tm[2]}`
    const end = `${tm[3].padStart(2, '0')}:${tm[4]}`
    if (end <= start) {
      errors.push({ line, reason: '结束时间需晚于开始时间' })
      continue
    }
    let rest = line.replace(WD_RE, ' ').replace(TIME_RE, ' ')
    // 可选周次:第3周 / 3-18周 / 1-16周单
    const wk = rest.match(WEEKS_RE)
    const weekStart = wk ? Number(wk[1]) : undefined
    const weekEnd = wk && wk[2] ? Number(wk[2]) : weekStart
    const parity = wk?.[3] === '单' ? 'odd' : wk?.[3] === '双' ? 'even' : undefined
    if (wk) rest = rest.replace(WEEKS_RE, ' ')
    const tokens = rest.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) {
      errors.push({ line, reason: '没识别到课程名' })
      continue
    }
    // 首词是课程名;@开头或含「教/楼/室…」的词归为地点,其余归为老师
    const locTokens: string[] = []
    const teaTokens: string[] = []
    for (const t of tokens.slice(1)) {
      if (t.startsWith('@')) locTokens.push(t.slice(1))
      else if (/教|楼|室|馆|栋|层|区|座|[A-Za-z]\d|\d/.test(t)) locTokens.push(t)
      else teaTokens.push(t)
    }
    list.push({
      name: tokens[0],
      location: locTokens.length ? locTokens.join(' ') : undefined,
      teacher: teaTokens.length ? teaTokens.join(' ') : undefined,
      weekday,
      start,
      end,
      weekStart,
      weekEnd,
      parity,
    })
  }
  return { list, errors }
}

// ---------- 教务系统 xls/xlsx 课表 ----------

// 「周次(单双周)[节次]」模式,如 3-18([周])[01-02节]、4([周])[06-07-08-09-10节]
const PATTERN_RE = /(\d+)\s*(?:-\s*(\d+))?\s*(?:\(([^)]*)\))?\s*\[([^\]]*?)节\]/

type WorkbookEntry = ParsedCourse

/** 解析教务系统课表文件,返回课程与备注(表格下方没有节次模式的文字行) */
export async function parseTimetableFile(
  data: ArrayBuffer,
): Promise<{ courses: ParsedCourse[]; remark: string }> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(data, { type: 'array' })
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
      header: 1,
      defval: '',
      blankrows: true,
    })
    const parsed = parseGrid(grid)
    if (parsed.courses.length > 0) return parsed
  }
  return { courses: [], remark: '' }
}

function parseGrid(grid: string[][]): { courses: ParsedCourse[]; remark: string } {
  // 定位表头行:一行里出现多个「星期X」单元格,并记下每列对应的星期
  let headerRow = -1
  const dayCols: { col: number; weekday: number }[] = []
  grid.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      const m = String(cell).trim().match(/^星期([一二三四五六日天])$/)
      if (m) {
        dayCols.push({ col: ci, weekday: WD_MAP[m[1]] })
        if (headerRow < 0) headerRow = ri
      }
    })
  })
  if (headerRow < 0) return { courses: [], remark: '' }

  const entries: WorkbookEntry[] = []
  const remarks: string[] = []
  for (let ri = headerRow + 1; ri < grid.length; ri++) {
    const row = grid[ri] ?? []
    for (const { col, weekday } of dayCols) {
      const cell = row[col]
      const text = String(cell ?? '').trim()
      if (!text) continue
      const entriesInCell = parseCellEntries(text)
      for (const entry of entriesInCell) {
        entries.push({ ...entry, weekday })
      }
      // 有文字但没有课程记录的格子(页脚备注等)收集为备注
      if (entriesInCell.length === 0) remarks.push(text.replace(/^[：:、,，.\s]+/, ''))
    }
  }

  // 同一门课常按周次分段(如 2周 A老师、7-13周 B老师),且同一格在不同节次行重复出现:
  // 按「星期+课名+周次+节次时间+地点+老师」完整签名去重,各周次分段全部保留,
  // 供按周查看时还原每周的真实安排
  const seen = new Set<string>()
  const list: ParsedCourse[] = []
  for (const c of entries) {
    const key = [
      c.weekday, c.name, c.start, c.end,
      c.weekStart ?? '', c.weekEnd ?? '', c.parity ?? '',
      c.location ?? '', c.teacher ?? '',
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    list.push(c)
  }
  return { courses: list, remark: remarks.join('\n') }
}

/** 一个单元格里以空行分隔的多条课程记录;没有「周次+节次」行的块(页脚备注等)跳过 */
function parseCellEntries(cell: string): Omit<WorkbookEntry, 'weekday'>[] {
  const out: Omit<WorkbookEntry, 'weekday'>[] = []
  for (const block of cell.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (lines.length === 0) continue
    const pi = lines.findIndex((l) => /\[[^\]]*节\]/.test(l))
    if (pi < 1) continue
    const pm = lines[pi].match(PATTERN_RE)
    if (!pm) continue
    const name = lines[0]
    const teacher = pi > 1 ? lines.slice(1, pi).join(',') : undefined
    const location = lines.slice(pi + 1).join(' ') || undefined
    const weekStart = Number(pm[1])
    const weekEnd = pm[2] ? Number(pm[2]) : weekStart
    if (!Number.isFinite(weekStart)) continue
    const parity = pm[3]?.includes('单') ? 'odd' : pm[3]?.includes('双') ? 'even' : undefined
    const periods = pm[4]
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => n > 0)
    const first = Math.min(...periods)
    const last = Math.max(...periods)
    const t1 = PERIOD_TIMES[first]
    const t2 = PERIOD_TIMES[last]
    if (!t1 || !t2) continue
    out.push({
      name,
      teacher,
      location,
      start: t1[0],
      end: t2[1],
      weekStart,
      weekEnd,
      parity,
    })
  }
  return out
}
