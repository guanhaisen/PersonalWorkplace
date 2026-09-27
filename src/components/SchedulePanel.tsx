import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { Course } from '../types'
import { todayStr, uid } from '../api'
import type { UpdateFn } from '../App'
import { parseCoursesText, parseTimetableFile, PERIOD_TIMES, type ParsedCourse } from '../timetableImport'

interface Props {
  courses: Course[]
  update: UpdateFn
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // 周一开头,与日历面板一致
const COLOR_COUNT = 8

const pad = (n: number) => String(n).padStart(2, '0')
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const fmtMin = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

interface Draft {
  id: string | null
  name: string
  teacher: string
  location: string
  weekday: number
  start: string
  end: string
  color: number
  weekStart: string
  weekEnd: string
  parity: 'all' | 'odd' | 'even'
}

const TERM_KEY = 'schedule.termStart'
const MAX_WEEK = 30

// 新建课程时的默认起始时间:8:00
const DEFAULT_START = 8 * 60

/** 由学期开始日期(第一周周一)推算当前周;未设置或无效时返回 1 */
function computeCurrentWeek(termStart: string, now = new Date()): number {
  if (!termStart) return 1
  const start = new Date(`${termStart}T00:00:00`)
  if (Number.isNaN(start.getTime())) return 1
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)) // 归到所在周的周一
  const diff = Math.floor((now.getTime() - start.getTime()) / (7 * 86400000))
  return Math.min(Math.max(diff + 1, 1), MAX_WEEK)
}

// 五个大节(与教务系统课表一致):行 = 大节,列 = 星期
const BLOCKS = [
  { label: '第一大节', periods: [1, 2] },
  { label: '第二大节', periods: [3, 4, 5] },
  { label: '第三大节', periods: [6, 7] },
  { label: '第四大节', periods: [8, 9, 10] },
  { label: '第五大节', periods: [11, 12, 13] },
].map((b) => ({
  ...b,
  start: PERIOD_TIMES[b.periods[0]][0],
  end: PERIOD_TIMES[b.periods[b.periods.length - 1]][1],
  startMin: toMin(PERIOD_TIMES[b.periods[0]][0]),
  endMin: toMin(PERIOD_TIMES[b.periods[b.periods.length - 1]][1]),
}))

export default function SchedulePanel({ courses, update }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  // 文本导入弹层
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReplace, setImportReplace] = useState(false)
  // 教务系统课表文件解析结果(null = 还没选文件)
  const [fileCourses, setFileCourses] = useState<ParsedCourse[] | null>(null)
  const [fileRemark, setFileRemark] = useState('')
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  // 课表备注(如「数学思维实践 1-2周」这类整学期信息),存服务端设置
  const [remark, setRemark] = useState('')
  const [remarkEditing, setRemarkEditing] = useState(false)
  const [remarkDraft, setRemarkDraft] = useState('')
  // 周次:学期开始日期(第一周周一)存 localStorage,当前周自动推算,可手动切换查看
  const [termStart, setTermStart] = useState(() => localStorage.getItem(TERM_KEY) ?? '')
  const [week, setWeek] = useState(() => computeCurrentWeek(localStorage.getItem(TERM_KEY) ?? ''))
  // 当前时间每 30 秒刷新一次,驱动今日高亮与时间指示线
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const todayIdx = (now.getDay() + 6) % 7 // 0 = 周一

  // 由学期开始日期推算当前是第几周;没设置则视为第 1 周
  const currentWeek = useMemo(() => computeCurrentWeek(termStart, now), [termStart, now])

  // 改学期开始日期后自动跳到推算出的当前周;同时同步到服务端,跨浏览器/设备一致
  const changeTermStart = (v: string) => {
    setTermStart(v)
    localStorage.setItem(TERM_KEY, v)
    setWeek(computeCurrentWeek(v))
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termStart: v }),
    }).catch(() => {})
  }

  // 把正在查看的周设为本周:反推锚点日期(本周一 − (week−1) 周)作为学期开始,
  // 之后的周次随日期自然推进;复用 changeTermStart 的保存与服务端同步
  const pinCurrentWeek = () => {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - (week - 1) * 7)
    changeTermStart(todayStr(monday))
  }

  // 挂载时从服务端取学期开始日期与备注(localStorage 只在本浏览器有效,服务端为跨设备准绳)
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (typeof s?.termStart === 'string' && s.termStart && s.termStart !== termStart) {
          setTermStart(s.termStart)
          setWeek(computeCurrentWeek(s.termStart))
        }
        if (typeof s?.remark === 'string') setRemark(s.remark)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 选中周有课的课程:无周次信息的(手动添加)每周都上
  const weekCourses = useMemo(
    () =>
      courses.filter((c) => {
        if (!c.weekStart) return true
        if (week < c.weekStart || week > (c.weekEnd ?? c.weekStart)) return false
        if (c.parity === 'odd') return week % 2 === 1
        if (c.parity === 'even') return week % 2 === 0
        return true
      }),
    [courses, week],
  )

  // 课程 → 大节×星期 的归属:与该大节时间有交集即归入(跨节次的课会同时出现在多行,与教务系统一致)
  const cellMap = useMemo(() => {
    const map = new Map<string, Course[]>()
    const others: Course[] = []
    for (const c of weekCourses) {
      const s = toMin(c.start)
      const e = toMin(c.end)
      let placed = false
      for (const b of BLOCKS) {
        if (e > b.startMin && s < b.endMin) {
          const key = `${b.label}|${c.weekday}`
          const arr = map.get(key) ?? []
          arr.push(c)
          map.set(key, arr)
          placed = true
        }
      }
      if (!placed) others.push(c) // 完全落在五大节之外的时间(如清晨),归入「其他时间」行
    }
    return { map, others }
  }, [weekCourses])

  // 课程覆盖的小节范围,如「06~08小节」
  const periodsOf = (c: Course) => {
    const s = toMin(c.start)
    const e = toMin(c.end)
    const ps = Object.entries(PERIOD_TIMES)
      .filter(([, [a, b]]) => toMin(b) > s && toMin(a) < e)
      .map(([n]) => Number(n))
    if (ps.length === 0) return ''
    return `${pad(Math.min(...ps))}~${pad(Math.max(...ps))}小节`
  }

  // 周次描述,如「第3-18周」「第5周(单)」;无周次信息返回空
  const weeksOf = (c: { weekStart?: number; weekEnd?: number; parity?: 'odd' | 'even' }) => {
    if (!c.weekStart) return ''
    const end = c.weekEnd ?? c.weekStart
    const range = end > c.weekStart ? `${c.weekStart}-${end}` : `${c.weekStart}`
    const p = c.parity === 'odd' ? '(单)' : c.parity === 'even' ? '(双)' : ''
    return `第${range}周${p}`
  }

  const todayCount = weekCourses.filter((c) => c.weekday === todayIdx + 1).length

  // 全局快捷键/命令面板:新建课程(延迟一拍,等视图切换渲染完成)
  useEffect(() => {
    const onNew = () => setTimeout(() => openNew(), 60)
    window.addEventListener('workbench:new-course', onNew)
    return () => window.removeEventListener('workbench:new-course', onNew)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc 关闭课程编辑/导入弹层(与习惯详情卡一致)
  useEffect(() => {
    if (!draft && !importOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setDraft(null)
      setImportOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, importOpen])

  const openNew = (weekday?: number, start?: number, end?: number) => {
    const s = start ?? DEFAULT_START
    setError('')
    setDraft({
      id: null,
      name: '',
      teacher: '',
      location: '',
      weekday: weekday ?? todayIdx + 1,
      start: fmtMin(s),
      end: fmtMin(end ?? s + 45),
      color: courses.length % COLOR_COUNT,
      weekStart: '',
      weekEnd: '',
      parity: 'all',
    })
  }

  const openEdit = (c: Course) => {
    setError('')
    setDraft({
      id: c.id,
      name: c.name,
      teacher: c.teacher ?? '',
      location: c.location ?? '',
      weekday: c.weekday,
      start: c.start,
      end: c.end,
      color: c.color,
      weekStart: c.weekStart != null ? String(c.weekStart) : '',
      weekEnd: c.weekEnd != null ? String(c.weekEnd) : '',
      parity: c.parity ?? 'all',
    })
  }

  const save = () => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setError('请填写课程名')
      return
    }
    if (toMin(draft.end) <= toMin(draft.start)) {
      setError('结束时间需晚于开始时间')
      return
    }
    const ws = draft.weekStart.trim() ? Number(draft.weekStart) : undefined
    const we = draft.weekEnd.trim() ? Number(draft.weekEnd) : ws
    if (ws !== undefined && (!Number.isInteger(ws) || ws < 1)) {
      setError('周次需为正整数')
      return
    }
    if (ws !== undefined && we !== undefined && we < ws) {
      setError('结束周需不早于起始周')
      return
    }
    const course: Course = {
      id: draft.id ?? uid(),
      name,
      teacher: draft.teacher.trim() || undefined,
      location: draft.location.trim() || undefined,
      weekday: draft.weekday,
      start: draft.start,
      end: draft.end,
      color: draft.color,
      weekStart: ws,
      weekEnd: we,
      parity: draft.parity === 'all' ? undefined : draft.parity,
    }
    update('courses', (items) =>
      draft.id ? items.map((c) => (c.id === draft.id ? course : c)) : [...items, course],
    )
    setDraft(null)
  }

  const remove = () => {
    if (!draft?.id) return
    update('courses', (items) => items.filter((c) => c.id !== draft.id))
    setDraft(null)
  }

  // 导入预览:文件解析结果与粘贴文本合并,随输入实时更新
  const preview = useMemo(() => {
    const text = parseCoursesText(importText)
    return { list: [...(fileCourses ?? []), ...text.list], errors: text.errors }
  }, [importText, fileCourses])

  const openImport = () => {
    setImportText('')
    setImportReplace(false)
    setFileCourses(null)
    setFileRemark('')
    setFileError('')
    setImportOpen(true)
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!f) return
    setFileBusy(true)
    setFileError('')
    try {
      const { courses, remark } = await parseTimetableFile(await f.arrayBuffer())
      if (courses.length === 0) {
        setFileCourses(null)
        setFileRemark('')
        setFileError('没从这个文件里解析出课程,请确认是教务系统导出的课表文件')
      } else {
        setFileCourses(courses)
        setFileRemark(remark)
      }
    } catch (err) {
      setFileCourses(null)
      setFileRemark('')
      setFileError(`解析失败:${(err as Error)?.message || err}`)
    } finally {
      setFileBusy(false)
    }
  }

  const doImport = () => {
    if (preview.list.length === 0) return
    update('courses', (items) => {
      const base = importReplace ? [] : items
      const courses: Course[] = preview.list.map((c, i) => ({
        ...c,
        id: uid(),
        color: (base.length + i) % COLOR_COUNT,
      }))
      return [...base, ...courses]
    })
    // 文件里带了备注(如「数学思维实践 1-2周」)时一并写入
    if (fileRemark) {
      setRemark(fileRemark)
      saveRemark(fileRemark)
    }
    setImportOpen(false)
    setImportText('')
    setImportReplace(false)
  }

  // 备注存服务端设置,跨浏览器同步
  const saveRemark = (v: string) => {
    setRemark(v)
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remark: v }),
    }).catch(() => {})
  }

  // 点击某天某大节的空白格:预填该大节的完整时间段
  const onCellClick = (weekday: number, block: (typeof BLOCKS)[number], e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return // 点在课程块上交给它们自己
    openNew(weekday, block.startMin, block.endMin)
  }

  const renderCard = (c: Course) => (
    <button
      key={c.id}
      className={`crs c${((c.color % COLOR_COUNT) + COLOR_COUNT) % COLOR_COUNT}`}
      title={`${c.name}${c.teacher ? `\n教师:${c.teacher}` : ''}${c.location ? `\n上课地点:${c.location}` : ''}\n${periodsOf(c)} ${c.start}-${c.end}${weeksOf(c) ? ` · ${weeksOf(c)}` : ''}\n点击编辑`}
      onClick={(ev) => {
        ev.stopPropagation()
        openEdit(c)
      }}
    >
      <span className="crs-name">{c.name}</span>
      {c.teacher && <span className="crs-meta">教师:{c.teacher}</span>}
      <span className="crs-meta">
        {periodsOf(c)} {weeksOf(c) || `${c.start}-${c.end}`}
      </span>
      {c.location && <span className="crs-meta">上课地点:{c.location}</span>}
    </button>
  )

  return (
    <div className="panel panel-schedule">
      <header className="p-head">
        <h2>
          <span className="tag">SCHEDULE</span>
          <i>/</i>课表
        </h2>
        <div className="sch-head-right">
          <span className="p-meta">
            共 {courses.length} 门 · 今日 {todayCount} 节
          </span>
          <button className="btn ghost sch-add" onClick={openImport} title="粘贴文本批量导入课程">
            导入
          </button>
          <button className="btn solid sch-add" onClick={() => openNew()}>
            ＋ 课程
          </button>
        </div>
      </header>

      <div className="sch-toolbar">
        <label className="sch-week-pick">
          第
          <select value={week} onChange={(e) => setWeek(Number(e.target.value))}>
            {Array.from({ length: MAX_WEEK }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} 周{n === currentWeek ? ' · 本周' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="sch-pin-week"
          onClick={pinCurrentWeek}
          disabled={week === currentWeek}
          title="把正在查看的周设为本周(自动推算学期开始日期)"
        >
          设为本周
        </button>
        <label className="sch-term-start" title="第一周的周一日期;设置后自动定位到当前周">
          学期开始
          <input type="date" value={termStart} onChange={(e) => changeTermStart(e.target.value)} />
        </label>
        <span className="sch-week-hint">
          {week === currentWeek ? '本周课表' : week > currentWeek ? `未来 ${week - currentWeek} 周` : `回看 ${currentWeek - week} 周前`}
        </span>
      </div>

      <div className="sch-scroll">
        <div className="sch-table">
          <div className="sch-corner">周/节次</div>
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`sch-th ${i === todayIdx ? 'today' : ''}`}>
              星期{w}
            </div>
          ))}

          {BLOCKS.map((b) => (
            <Fragment key={b.label}>
              <div className="sch-rowhead">
                <b>{b.label}</b>
                <span>
                  {b.start}~{b.end}
                </span>
              </div>
              {WEEKDAYS.map((w, i) => {
                const list = cellMap.map.get(`${b.label}|${i + 1}`) ?? []
                return (
                  <div
                    key={`${b.label}|${w}`}
                    className={`sch-td ${i === todayIdx ? 'today' : ''}`}
                    onClick={(e) => onCellClick(i + 1, b, e)}
                  >
                    {list.map(renderCard)}
                  </div>
                )
              })}
            </Fragment>
          ))}

          {cellMap.others.length > 0 && (
            <Fragment>
              <div className="sch-rowhead">
                <b>其他时间</b>
              </div>
              {WEEKDAYS.map((w, i) => (
                <div key={`other|${w}`} className={`sch-td ${i === todayIdx ? 'today' : ''}`}>
                  {cellMap.others.filter((c) => c.weekday === i + 1).map(renderCard)}
                </div>
              ))}
            </Fragment>
          )}

          <div className="sch-rowhead sch-remark-head">
            <b>备注</b>
          </div>
          <div className="sch-remark">
            {remarkEditing ? (
              <input
                className="sch-remark-input"
                autoFocus
                value={remarkDraft}
                placeholder="选课备注,如:数学思维实践 1-2周(陈夏铭)"
                onChange={(e) => setRemarkDraft(e.target.value)}
                onBlur={() => {
                  saveRemark(remarkDraft.trim())
                  setRemarkEditing(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    saveRemark(remarkDraft.trim())
                    setRemarkEditing(false)
                  }
                  if (e.key === 'Escape') setRemarkEditing(false)
                }}
              />
            ) : (
              <button
                className={`sch-remark-text ${remark ? '' : 'empty'}`}
                title="点击编辑备注"
                onClick={() => {
                  setRemarkDraft(remark)
                  setRemarkEditing(true)
                }}
              >
                {remark || '点击填写备注'}
              </button>
            )}
          </div>
        </div>
      </div>

      {draft && (
        <div className="cmd-overlay" onMouseDown={() => setDraft(null)}>
          <div className="course-modal hb-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="p-head">
              <h2>
                <span className="tag">COURSE</span>
                <i>/</i>
                {draft.id ? '编辑课程' : '新建课程'}
              </h2>
            </header>

            <div className="cm-form">
              <input
                className="in"
                autoFocus
                value={draft.name}
                placeholder="课程名(必填)"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && save()}
              />
              <div className="cm-row3">
                <input
                  className="in"
                  value={draft.teacher}
                  placeholder="老师"
                  onChange={(e) => setDraft({ ...draft, teacher: e.target.value })}
                />
                <input
                  className="in"
                  value={draft.location}
                  placeholder="地点"
                  onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                />
              </div>
              <div className="cm-row3">
                <select
                  className="in"
                  value={draft.weekday}
                  onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}
                  title="星期"
                >
                  {WEEKDAYS.map((w, i) => (
                    <option key={w} value={i + 1}>
                      周{w}
                    </option>
                  ))}
                </select>
                <input
                  className="in"
                  type="time"
                  value={draft.start}
                  onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                  title="开始时间"
                />
                <input
                  className="in"
                  type="time"
                  value={draft.end}
                  onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                  title="结束时间"
                />
              </div>
              <div className="cm-row3">
                <input
                  className="in"
                  type="number"
                  min={1}
                  value={draft.weekStart}
                  placeholder="起始周"
                  onChange={(e) => setDraft({ ...draft, weekStart: e.target.value })}
                  title="起始周(留空 = 每周都上)"
                />
                <input
                  className="in"
                  type="number"
                  min={1}
                  value={draft.weekEnd}
                  placeholder="结束周"
                  onChange={(e) => setDraft({ ...draft, weekEnd: e.target.value })}
                  title="结束周"
                />
                <select
                  className="in"
                  value={draft.parity}
                  onChange={(e) => setDraft({ ...draft, parity: e.target.value as Draft['parity'] })}
                  title="单双周"
                >
                  <option value="all">每周</option>
                  <option value="odd">单周</option>
                  <option value="even">双周</option>
                </select>
              </div>
              <div className="cm-colors">
                {Array.from({ length: COLOR_COUNT }, (_, i) => (
                  <button
                    key={i}
                    className={`swatch c${i} ${draft.color === i ? 'on' : ''}`}
                    title={`配色 ${i + 1}`}
                    onClick={() => setDraft({ ...draft, color: i })}
                  />
                ))}
              </div>
              {error && <div className="cm-err">{error}</div>}
            </div>

            <footer className="hb-foot">
              {draft.id && (
                <button className="btn ghost danger" onClick={remove}>
                  删除课程
                </button>
              )}
              <button className="btn solid" onClick={save}>
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="cmd-overlay" onMouseDown={() => setImportOpen(false)}>
          <div className="import-modal hb-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header className="p-head">
              <h2>
                <span className="tag">IMPORT</span>
                <i>/</i>导入课表
              </h2>
            </header>

            <p className="sch-import-hint">
              支持直接导入教务系统导出的课表文件;或每行一门粘贴文本,格式:<b>星期 + 时间 + 课程名</b>,地点用 @ 开头(可省),其余作为老师(可省)。星期支持 周一/星期一/周1,时间如 08:00-09:40。
            </p>
            <div className="sch-import-file">
              <button className="btn ghost" onClick={() => fileRef.current?.click()}>
                选择课表文件(.xls / .xlsx)
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".xls,.xlsx,.csv,.html,.htm"
                hidden
                onChange={onPickFile}
              />
            </div>
            {fileBusy && <div className="sch-import-fileok">正在解析文件…</div>}
            {fileCourses && (
              <div className="sch-import-fileok">
                <span>
                  已从文件解析出 {fileCourses.length} 门课(按标准作息折算时间,可导入后在课表里微调)
                  {fileRemark && `;备注:「${fileRemark}」`}
                </span>
                <button title="不使用文件里的课程" onClick={() => setFileCourses(null)}>
                  ✕
                </button>
              </div>
            )}
            {fileError && <div className="cm-err sip-err">{fileError}</div>}
            <textarea
              className="sch-import-text"
              rows={7}
              value={importText}
              placeholder={'周一 08:00-09:40 高等数学 @教一A101 王老师\n周二 14:00-15:40 大学物理 @教二B202\n周三 10:00-11:50 数据结构'}
              onChange={(e) => setImportText(e.target.value)}
              autoFocus
            />
            <label className="sch-import-replace">
              <input
                type="checkbox"
                checked={importReplace}
                onChange={(e) => setImportReplace(e.target.checked)}
              />
              清空现有课程后导入
            </label>

            {preview.list.length > 0 && (
              <div className="sch-import-preview">
                {preview.list.map((c, i) => (
                  <div key={i} className="sip-row">
                    <span className="sip-wd">周{WEEKDAYS[c.weekday - 1]}</span>
                    <span className="sip-time">
                      {c.start}-{c.end}
                    </span>
                    <span className="sip-name">{c.name}</span>
                    {c.weekStart && <span className="sip-sub">{weeksOf(c)}</span>}
                    {c.location && <span className="sip-sub">@{c.location}</span>}
                    {c.teacher && <span className="sip-sub">{c.teacher}</span>}
                  </div>
                ))}
              </div>
            )}
            {preview.errors.map((e, i) => (
              <div key={i} className="cm-err sip-err">
                无法识别「{e.line.length > 24 ? `${e.line.slice(0, 24)}…` : e.line}」:{e.reason}
              </div>
            ))}

            <footer className="hb-foot">
              <button className="btn ghost" onClick={() => setImportOpen(false)}>
                取消
              </button>
              <button className="btn solid" disabled={preview.list.length === 0} onClick={doImport}>
                导入 {preview.list.length} 门课
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
