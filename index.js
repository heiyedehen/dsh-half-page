// dsh-half-page · 半页（自己的读书与写字）
// 宿主侧：书库、切章、读后感、进度；客户端面板读 HTTP 路由。
import {readFile, writeFile, mkdir, readdir, stat, rename, open, unlink, copyFile, appendFile} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, basename, dirname, extname, resolve, relative, isAbsolute } from 'node:path'
import {homedir, tmpdir} from 'node:os'
import { fileURLToPath } from 'node:url'
import { readTimeline, newestSessionId } from './lib/session-probe.js'
import { loadCreateUserMessage, SOURCE_KIND } from './lib/notice.js'

/**
 * 路由准入（工单-HTTP路由准入，2026-11-26）。
 *
 * 宿主契约：register({ auth }) 的 auth 可以是
 * 'anonymous' | 'required' | 'deny'，或 (request) => policy；
 * request 里有 { headers, method, url, transport }。
 *
 * 规则：请求带 Origin/Referer 且跟 Host 对不上 → 拒；Origin 是 "null"
 * （沙箱页面 / data: / file:）→ 拒；没带来源（curl、本地脚本、同源导航）
 * 或来源就是本服务的 Host → 放行。面板在同源 iframe 里跑，功能不变。
 */
export function sameSiteAuth(request) {
  const headers = request?.headers
  const read = (name) => {
    if (!headers) return undefined
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined
    const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
    return Array.isArray(value) ? value[0] : value
  }
  const host = String(read('host') || '')
  const source = String(read('origin') || read('referer') || '')
  if (!source) return 'anonymous'
  if (source === 'null') return 'deny'
  try {
    const url = new URL(source)
    if (host && url.host === host) return 'anonymous'
    // 同一个本机服务、但 Host 头缺失（HTTP/1.0、某些本地代理）
    if (!host && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return 'anonymous'
    return 'deny'
  } catch {
    return 'deny'
  }
}


export const inject = ['webServer', 'tools', 'systemPrompt', 'agents', 'sessions']

const HOME = process.env.USERPROFILE || process.env.HOME || homedir()
// 跟宿主的 DSH_HOME 走：有人把它设到别的盘时，数据和插件不能分家（心跳就是这么写的）
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const CONFIG = join(DSH_HOME, 'reading.config.json')
const DEFAULT_DIR = join(DSH_HOME, 'reading')

const CH_RE = /^[ \t\u3000]*(第[0-9０-９一二三四五六七八九十百千两零〇]+[章节回][^\n]{0,30})$/m
const CH_LINE_RE = /^[ \t\u3000]*(第[0-9０-９一二三四五六七八九十百千两零〇]+[章节回][^\n]{0,30})$/gm

export function stripBom(t) {
  return t && t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

export async function readTextSmart(buf) {
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(buf))
  } catch {
    try {
      return stripBom(new TextDecoder('gb18030').decode(buf))
    } catch {
      return stripBom(buf.toString('utf8'))
    }
  }
}

/** cordis.patch.yml 里 config 的默认值；reading.config.json 优先 */
let PATCH_CFG = {}

export async function config() {
  try {
    const raw = await readFile(CONFIG, 'utf8')
    const c = JSON.parse(stripBom(raw)) || {}
    return { ...PATCH_CFG, ...c, dir: c.dir || DEFAULT_DIR, perDay: Number(c.perDay) > 0 ? Number(c.perDay) : 3 }
  } catch {
    return { ...PATCH_CFG, dir: DEFAULT_DIR, perDay: 3 }
  }
}

export async function ensureDir(dir) {
  const books = join(dir, 'books')
  await mkdir(books, { recursive: true })
  // 第一次装：书架是空的，就放一本自带的书进去（《古文观止》，公版，121 篇选）。
  // 只在空书架时放一次，删掉之后不会再回来。
  try {
    const have = (await readdir(books)).filter((f) => /\.(txt|md)$/i.test(f))
    if (!have.length) {
      const src = join(dirname(fileURLToPath(import.meta.url)), 'books', '古文观止.txt')
      const buf = await readFile(src)
      await writeFile(join(books, '古文观止.txt'), buf)
    }
  } catch {}
  return dir
}

export function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* 静音时段：只管 reading_next（真正返回正文的那一步）。
   配了 "HH:MM" 的 quietFrom / quietTo 才算数；空值、格式不对、两边相同，一律当没设。
   from > to 表示跨夜（22:00–06:00）。用本地时间判断，不用 UTC。 */
export function quietWindowOf(cfg) {
  if (cfg?.quietEnabled === false) return null
  const parse = (v) => {
    const s = typeof v === 'string' ? v.trim() : ''
    const m = /^(\d{1,2}):(\d{2})$/.exec(s)
    if (!m) return null
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h > 23 || mi > 59) return null
    return { min: h * 60 + mi, text: s }
  }
  const a = parse(cfg?.quietFrom)
  const b = parse(cfg?.quietTo)
  if (!a || !b || a.min === b.min) return null
  return { from: a.min, to: b.min, fromText: a.text, toText: b.text }
}

export function inQuietNow(cfg, now = new Date()) {
  const w = quietWindowOf(cfg)
  if (!w) return null
  const cur = now.getHours() * 60 + now.getMinutes()
  const hit = w.from < w.to ? cur >= w.from && cur < w.to : cur >= w.from || cur < w.to
  return hit ? w : null
}

async function readJson(p, d) {
  try {
    return JSON.parse(stripBom(await readFile(p, 'utf8')))
  } catch {
    return d
  }
}

async function writeJson(p, v) {
  const tmp = p + '.tmp'
  await writeFile(tmp, JSON.stringify(v, null, 2), 'utf8')
  await rename(tmp, p)
}

/** 状态：{ current, books: { <id>: {...} }, notesByDate: {} } */
export async function loadState(dir) {
  const st = await readJson(join(dir, 'state.json'), null)
  if (st && st.books) return st
  return { current: '', books: {}, log: {} }
}

export async function saveState(dir, st) {
  await writeJson(join(dir, 'state.json'), st)
}

/* ---------------- 一个书房，多个读者 ----------------
 * 旧版本只有书级进度（books[id].readThrough/next/noteUntil），等于「这台机器上所有读者共用一条进度」。
 * 现在加一层 readers[<读者 id>]：每个读者各有一份进度，书级只留「读得最远」（furthest）。
 * 读者 id 就是会话 id；拿不到会话就落到 LEGACY_READER（老数据迁移过来的那份）。
 * 读后感仍然只有一个 读后感.md，靠署名区分——不要拆成多个文件。
 */
export const LEGACY_READER = '__legacy__'
/** 那份「所有人都从这儿接」的书签，面板上叫什么。以前叫「默认读者」，容易被当成一个人；它其实是书级进度。 */
export const LEGACY_READER_NAME = '读书总进度'
/** 读者 id → 名字的临时表：建分片时顺手把名字写对，别把会话 id 当名字存进去。 */
export const READER_NAMES = new Map()

/** 老状态没有 readers：把 books[id] 现有进度抄成「总读书进度」，幂等。
 *  一本书都没读过（新机器第一次装）就不建这一份——不然别人装上会看见一个空的「总读书进度」。 */
export function migrateReaders(st) {
  if (!st || typeof st !== 'object') return st
  if (st.readers && typeof st.readers === 'object') {
    if (st.readers[LEGACY_READER]) st.readers[LEGACY_READER].name = LEGACY_READER_NAME
    return st
  }
  const legacy = { name: LEGACY_READER_NAME, books: {} }
  for (const [id, rec] of Object.entries(st.books || {})) {
    const has = (Number(rec.readThrough) || 0) > 0 || (Number(rec.noteUntil) || 0) > 0
      || (Number(rec.next) || 1) > 1 || Boolean(rec.lastReadAt)
    if (!Number.isFinite(Number(rec.furthest))) rec.furthest = Number(rec.readThrough) || 0
    if (!has) continue
    legacy.books[id] = {
      readThrough: Number(rec.readThrough) || 0,
      next: Number(rec.next) || 1,
      noteUntil: Number(rec.noteUntil) || 0,
      lastReadAt: rec.lastReadAt || '',
    }
  }
  st.readers = Object.keys(legacy.books).length > 0 ? { [LEGACY_READER]: legacy } : {}
  return st
}

/** 某个读者的分片（没有就建）。name 只是给人看的。 */
export function readerShard(st, rid, name) {
  migrateReaders(st)
  const key = String(rid || LEGACY_READER)
  const r = st.readers[key] || (st.readers[key] = { name: name || (key === LEGACY_READER ? LEGACY_READER_NAME : key), books: {} })
  if (name && r.name !== name) r.name = name
  return r
}

/** 某个读者在某本书上的进度（没有就建空的；空分片先继承书级那份，等于「你还没动过，从大家读到的地方接」）。 */
export function readerBook(st, rid, id) {
  const shard = readerShard(st, rid, READER_NAMES.get(String(rid)) || '')
  const own = shard.books[id]
  if (own) return own
  const base = st.books?.[id] || {}
  return (shard.books[id] = {
    readThrough: Number(base.readThrough) || 0,
    next: Number(base.next) || 1,
    noteUntil: Number(base.noteUntil) || 0,
    lastReadAt: base.lastReadAt || '',
  })
}

/** 读进度但不建：面板/书架扫一遍时用，避免给没读过的书建空分片。没有分片就继承书级。 */
/** 只看这位读者自己的分片：没读过返回 null（不继承书级）。面板「我读到哪」用它，避免把书级进度当成我的。 */
export function readerOwnBook(st, rid, id) {
  migrateReaders(st)
  const b = st.readers?.[String(rid || LEGACY_READER)]?.books?.[id]
  if (!b) return null
  return {
    readThrough: Number(b.readThrough) || 0,
    next: Number(b.next) || 1,
    noteUntil: Number(b.noteUntil) || 0,
    lastReadAt: b.lastReadAt || '',
  }
}

export function readerBookRead(st, rid, id) {
  migrateReaders(st)
  const b = st.readers?.[String(rid || LEGACY_READER)]?.books?.[id]
  if (b) {
    return {
      readThrough: Number(b.readThrough) || 0,
      next: Number(b.next) || 1,
      noteUntil: Number(b.noteUntil) || 0,
      lastReadAt: b.lastReadAt || '',
    }
  }
  const base = st.books?.[id] || {}
  return {
    readThrough: Number(base.readThrough) || 0,
    next: Number(base.next) || 1,
    noteUntil: Number(base.noteUntil) || 0,
    lastReadAt: base.lastReadAt || '',
  }
}

/** 书级「读得最远」：所有读者里最大的 readThrough，只增不减。 */
export function furthestOf(st, id) {
  migrateReaders(st)
  let far = Number(st.books?.[id]?.furthest) || 0
  for (const r of Object.values(st.readers || {})) {
    far = Math.max(far, Number(r.books?.[id]?.readThrough) || 0)
  }
  const rec = st.books?.[id]
  if (rec) {
    far = Math.max(far, Number(rec.readThrough) || 0)
    rec.furthest = far
  }
  return far
}

/** 书级「读得最远」是谁读的：返回 { name, readThrough }；没人读过就返回总进度那个名字。 */
export function furthestReaderOf(st, id) {
  migrateReaders(st)
  const far = furthestOf(st, id)
  let best = null
  for (const [rid, r] of Object.entries(st.readers || {})) {
    if (rid === LEGACY_READER) continue
    const n = Number(r.books?.[id]?.readThrough) || 0
    if (n > 0 && (!best || n > best.readThrough)) best = { id: rid, name: r.name || rid, readThrough: n }
  }
  // 书级数字比所有读者分片都高（那条会话不在了），就没有具体的人可报
  if (!best || best.readThrough < far) return { id: LEGACY_READER, name: LEGACY_READER_NAME, readThrough: far }
  return { id: best.id, name: best.name, readThrough: far }
}
/** 面板 / 工具都要的读者一览：id、名字、每本书读到哪。
 *  「默认读者」没有会话在用，它的分片停在迁移那一刻；但它代表的那条书签（书级 next/readThrough）
 *  是所有人共用、一直在往前走的，所以这里给它显示书级那份——否则面板上会显得它永远没动。 */
export function readerSummary(st) {
  migrateReaders(st)
  const out = []
  for (const [id, r] of Object.entries(st.readers || {})) {
    const books = {}
    let lastAt = 0
    const readingOf = id === LEGACY_READER ? (st.books || {}) : (r.books || {})
    for (const [bid, b] of Object.entries(readingOf)) {
      books[bid] = { readThrough: Number(b.readThrough) || 0, next: Number(b.next) || 1, noteUntil: Number(b.noteUntil) || 0 }
      const at = typeof b.lastReadAt === 'number' ? b.lastReadAt : Date.parse(String(b.lastReadAt || ''))
      if (Number.isFinite(at) && at > lastAt) lastAt = at
    }
    // 一本都没读过的读者不往面板上摆（新机器、或刚建分片还没读）；手动加的读者例外——加它就是为让它出现
    if (Object.keys(books).length === 0 && !r.manual) continue
    out.push({ id, name: r.name || id, books, today: readTodayOf(st, id), lastAt, manual: r.manual === true })
  }
  return out.sort((a, b) => (a.id === LEGACY_READER ? -1 : b.id === LEGACY_READER ? 1 : 0))
}

/** 这个读者最后读过的那本书（按分片里的 lastReadAt 取最大）；没有就空串。 */
export function lastReadBookOf(st, rid) {
  const key = String(rid || LEGACY_READER)
  const books = st?.readers?.[key]?.books || {}
  let best = ''
  let at = ''
  for (const [bid, b] of Object.entries(books)) {
    const when = String(b?.lastReadAt || '')
    if (!when) continue
    if (when >= at) { at = when; best = bid }
  }
  if (best) return best
  // 兜底：老分片没记 lastReadAt（早期版本 / 被回灌坏过）。挑读得最远的那本，
  // 再不行看整机书级，最后才回落面板当前那本——总之别因为缺一个时间戳就报「不知道读哪本」。
  let far = ''
  let farN = 0
  const pick = (obj) => {
    for (const [bid, b] of Object.entries(obj || {})) {
      const n = Math.max(Number(b?.readThrough) || 0, Number(b?.furthest) || 0)
      if (n > farN) { farN = n; far = bid }
    }
  }
  pick(books)
  if (far) return far
  pick(st?.books)
  if (far) return far
  return String(st?.current || '') || Object.keys(st?.books || {})[0] || ''
}

/** 简单文件锁：读后感是「读进来—改—写回去」，两个窗口同时写会丢一条。
 *  拿不到就一直等（上限 20 秒），超时才放弃——宁可慢一点，也不许两段同时写同一个文件。
 *  锁文件超过 30 秒没被删，当上一个进程死掉了，直接接管。 */
async function withFileLock(target, fn, tries = 800) {
  const lock = target + '.lock'
  let handle = null
  for (let i = 0; i < tries; i += 1) {
    try {
      handle = await open(lock, 'wx')
      break
    } catch {
      try {
        const info = await stat(lock)
        if (Date.now() - info.mtimeMs > 30 * 1000) {
          await unlink(lock)
          continue
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 25)))
    }
  }
  try {
    return await fn()
  } finally {
    if (handle) {
      try { await handle.close() } catch {}
      try { await unlink(lock) } catch {}
    }
  }
}

/** 把整本书切成章：返回 [{title, start, end}] */
export function splitChapters(text) {
  const idx = []
  CH_LINE_RE.lastIndex = 0
  let m
  while ((m = CH_LINE_RE.exec(text))) idx.push({ title: m[1].trim(), start: m.index })
  if (!idx.length) return [{ title: '全文', start: 0, end: text.length }]
  return idx.map((it, i) => ({ title: it.title, start: it.start, end: i + 1 < idx.length ? idx[i + 1].start : text.length }))
}

export function chapterText(text, chapters, n) {
  const c = chapters[n - 1]
  if (!c) return ''
  return text.slice(c.start, c.end).trim()
}

/* ---------------- 书房时间：到点只叫一声，读不读由它自己决定 ----------------
   刻意做得极克制：默认关、一句固定的话、不带书名不带进度、不写批注提醒。
   绝不在这里调 reading_next —— 一旦替它决定读不读，这个功能就废了。 */

export const STUDY_TEXT = '书房时间到了。读不读随你。'
const STUDY_GRACE_MIN = 5
const STUDY_NOTICE_QUIET_MIN = 10

function studyMinute(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 合法且起止不同才算设了时段；返 {from,to}（分钟）或 null */
export function studyWindowOf(cfg) {
  const from = studyMinute(cfg?.studyFrom)
  const to = studyMinute(cfg?.studyTo)
  if (from === null || to === null || from === to) return null
  return { from, to }
}

/** [from, to) 本地时间，from > to 表示跨夜 */
export function inStudyWindow(w, now = new Date()) {
  if (!w) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return w.from < w.to ? cur >= w.from && cur < w.to : cur >= w.from || cur < w.to
}

/** ISO 周（YYYY-Www），跨周归零用 */
export function weekKeyOf(ms) {
  const d = new Date(ms)
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function localDayOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 读 state.study；跨周了计数归零 */
export function studyStateOf(st, now = Date.now()) {
  const raw = st?.study ?? {}
  const week = weekKeyOf(now)
  const sameWeek = raw.week === week
  const day = localDayOf(now)
  const sameDay = raw.day === day
  return {
    lastAt: Number(raw.lastAt) || 0,
    week,
    weekCount: sameWeek ? Number(raw.weekCount) || 0 : 0,
    day,
    dayCount: sameDay ? Number(raw.dayCount) || 0 : 0,
  }
}

/** 一条书房时间：字段齐全、缺的给默认；came from state.study.slots 或旧配置合成 */
export function normaliseStudySlot(raw, cfg, i = 0) {
  const s = raw || {}
  const mode = s.mode === 'day' || s.mode === 'week' ? s.mode : studyModeOf(cfg)
  const dBudget = Math.min(7, Math.max(1, Math.floor(Number(s.per) || (mode === 'day' ? studyPerDayOf(cfg) : studyPerWeekOf(cfg)))))
  const every = Math.min(1440, Math.max(5, Math.floor(Number(s.everyMinutes) || 30)))
  const budget = Math.min(24, Math.max(1, Math.floor(Number(s.dailyBudget) || dBudget || 4)))
  return {
    id: String(s.id || ('slot-' + (i + 1))),
    enabled: s.enabled === true,
    from: String(s.from ?? ''),
    to: String(s.to ?? ''),
    everyMinutes: every,
    dailyBudget: budget,
    mode,
    per: dBudget,
    session: String(s.session ?? ''),
    lastAt: Number(s.lastAt) || 0,
    week: String(s.week || ''),
    weekCount: Number(s.weekCount) || 0,
    day: String(s.day || ''),
    dayCount: Number(s.dayCount) || 0,
  }
}

/** state.study.slots；一条都没有时用旧配置合成一条（老用户行为不变） */
export function studySlotsOf(st, cfg) {
  const raw = Array.isArray(st?.study?.slots) ? st.study.slots : []
  if (raw.length) return raw.map((s, i) => normaliseStudySlot(s, cfg, i))
  return [normaliseStudySlot({
    id: 'slot-1',
    enabled: cfg?.studyEnabled === true,
    from: cfg?.studyFrom ?? '',
    to: cfg?.studyTo ?? '',
    mode: studyModeOf(cfg),
    per: studyModeOf(cfg) === 'day' ? studyPerDayOf(cfg) : studyPerWeekOf(cfg),
    session: cfg?.studySession ?? '',
  }, cfg, 0)]
}

/** 把一条 slot 摊成 decideStudy 认的 cfg 形状 */
export function slotCfgOf(slot) {
  return {
    studyEnabled: slot.enabled === true,
    studyFrom: slot.from,
    studyTo: slot.to,
    studyMode: slot.mode,
    studyPerDay: slot.per,
    studyPerWeek: slot.per,
    studyEveryMinutes: Math.min(1440, Math.max(5, Math.floor(Number(slot.everyMinutes) || 30))),
    studyDailyBudget: Math.min(24, Math.max(1, Math.floor(Number(slot.dailyBudget) || slot.per || 4))),
  }
}

/** 一条 slot 自己的计数（跨周/跨天归零） */
export function slotStudyOf(slot, now = Date.now()) {
  const week = weekKeyOf(now)
  const day = localDayOf(now)
  return {
    lastAt: Number(slot.lastAt) || 0,
    week,
    weekCount: slot.week === week ? Number(slot.weekCount) || 0 : 0,
    day,
    dayCount: slot.day === day ? Number(slot.dayCount) || 0 : 0,
  }
}

/** 今天有没有读过（任一书的 lastReadAt 落在本地今天） */
export function readSomethingToday(st, now = Date.now()) {
  const day = localDayOf(now)
  for (const rec of Object.values(st?.books ?? {})) {
    const at = rec?.lastReadAt
    const ms = typeof at === 'number' ? at : Date.parse(String(at || ''))
    if (Number.isFinite(ms) && ms > 0 && localDayOf(ms) === day) return true
  }
  return false
}

export function studyPerWeekOf(cfg) {
  const n = Number(cfg?.studyPerWeek)
  if (!Number.isFinite(n)) return 3
  return Math.min(7, Math.max(1, Math.floor(n)))
}

/** 每天叫几次（day 模式用） */
export function studyPerDayOf(cfg) {
  const n = Number(cfg?.studyPerDay)
  if (!Number.isFinite(n)) return 1
  return Math.min(7, Math.max(1, Math.floor(n)))
}

/** 'day' 或 'week'（缺省 week，老配置行为不变） */
export function studyModeOf(cfg) {
  return cfg?.studyMode === 'day' ? 'day' : 'week'
}

/**
 * 全部满足才返回 { ok: true }；一条不满足就给个理由（写日志用，不往界面抛）。
 * timeline 来自会话日志：{ ok, lastUserAt, lastAssistantAt, lastNoticeAt }
 */
export function decideStudy({ cfg, study, now, timeline }) {
  if (cfg?.studyEnabled !== true) return { ok: false, reason: 'off' }
  const w = studyWindowOf(cfg)
  if (!w) return { ok: false, reason: 'no-window' }
  if (!inStudyWindow(w, new Date(now))) return { ok: false, reason: 'outside' }
  const mode = studyModeOf(cfg)
  if (Number(cfg?.studyEveryMinutes) > 0) {
    // 心跳那套：只靠「距上次叫满一个频次」和「今天上限」，读没读过都不管
    const budget = Math.max(1, Math.floor(Number(cfg.studyDailyBudget) || 4))
    if ((Number(study.dayCount) || 0) >= budget) return { ok: false, reason: 'day-budget' }
    const gap = Math.max(5, Math.floor(Number(cfg.studyEveryMinutes) || 30)) * 60000
    if (study.lastAt && localDayOf(study.lastAt) === localDayOf(now) && now - study.lastAt < gap) return { ok: false, reason: 'gap' }
  } else if (mode === 'day') {
    if ((Number(study.dayCount) || 0) >= studyPerDayOf(cfg)) return { ok: false, reason: 'day-budget' }
  } else {
    if (study.lastAt && localDayOf(study.lastAt) === localDayOf(now)) return { ok: false, reason: 'today-called' }
    if (study.weekCount >= studyPerWeekOf(cfg)) return { ok: false, reason: 'week-budget' }
  }
  if (!timeline?.ok) return { ok: false, reason: `no-log（${timeline?.error || 'unknown'}）` }
  const userAt = Number(timeline.lastUserAt) || 0
  const assistantAt = Number(timeline.lastAssistantAt) || 0
  if (!userAt) return { ok: false, reason: 'no-user' }
  if (now - userAt < STUDY_GRACE_MIN * 60000) return { ok: false, reason: 'too-soon' }
  if (!(assistantAt > userAt)) return { ok: false, reason: 'unanswered' }
  const noticeAt = Number(timeline.lastNoticeAt) || 0
  if (noticeAt && now - noticeAt < STUDY_NOTICE_QUIET_MIN * 60000) return { ok: false, reason: 'recent-notice' }
  return { ok: true, reason: 'ok' }
}

/* ------------------------------------------------------------------ 章表
 * 读一章不再整本 decode：第一次打开某本书时扫一遍，把每章的字符偏移换算成
 * 字节偏移，落盘成 books/<id>.toc.json；以后按 byteStart..byteEnd 只读这一段。
 */

const TOC_VERSION = 1

export function tocPath(dir, id) {
  return join(dir, 'books', id + '.toc.json')
}

async function bookFile(dir, id) {
  for (const ext of ['.txt', '.md']) {
    const p = join(dir, 'books', id + ext)
    try {
      const st = await stat(p)
      return { path: p, size: st.size, mtimeMs: st.mtimeMs }
    } catch {}
  }
  throw new Error(`没有这本书：${id}`)
}

function utf8Width(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
}

/** GB18030 的字节宽度：ASCII 1；0x81–0xFE + 0x30–0x39 是四字节；其余两字节 */
function gbWidth(buf, i) {
  const b = buf[i]
  if (b < 0x80) return 1
  if (b >= 0x81 && b <= 0xfe && i + 1 < buf.length && buf[i + 1] >= 0x30 && buf[i + 1] <= 0x39) return 4
  return 2
}

/** 认编码（顺带认出 BOM 长度） */
export function sniffEncoding(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
    return { encoding: 'utf-8', bom }
  } catch {
    return { encoding: 'gb18030', bom: 0 }
  }
}

/**
 * 扫一遍整本，产出章表。字符偏移 → 字节偏移走一遍累加，不建大数组。
 * 返回 null 表示宽度累加对不上（文件坏了或怪编码），调用方退回整本方案。
 */
export function buildToc(buffer, id) {
  const { encoding, bom } = sniffEncoding(buffer)
  const body = bom ? buffer.subarray(bom) : buffer
  const text = stripBom(new TextDecoder(encoding).decode(body))
  const chapters = splitChapters(text)
  const starts = chapters.map((c) => c.start)
  let ci = 0
  let bi = bom
  let k = 0
  for (const ch of text) {
    while (k < chapters.length && starts[k] === ci) {
      chapters[k].byteStart = bi
      k += 1
    }
    const cp = ch.codePointAt(0)
    bi += encoding === 'utf-8' ? utf8Width(cp) : gbWidth(body, bi)
    ci += ch.length
  }
  while (k < chapters.length) {
    chapters[k].byteStart = bi
    k += 1
  }
  for (let i = 0; i < chapters.length; i += 1) {
    chapters[i].byteEnd = i + 1 < chapters.length ? chapters[i + 1].byteStart : buffer.length
  }
  if (bi !== buffer.length) return null
  return {
    version: TOC_VERSION,
    id,
    encoding,
    bom,
    bytes: buffer.length,
    chars: text.length,
    chapters,
  }
}

/** 取章表：有且没过期就用，否则整本扫一次并重写 */
export async function tocFor(dir, id, opts = {}) {
  const file = await bookFile(dir, id)
  const tp = tocPath(dir, id)
  if (!opts.force) {
    try {
      const saved = JSON.parse(stripBom(await readFile(tp, 'utf8')))
      const fresh = saved
        && saved.version === TOC_VERSION
        && saved.bytes === file.size
        && Number(saved.mtimeMs) === Math.round(file.mtimeMs)
        && Array.isArray(saved.chapters)
        && saved.chapters.length > 0
        && saved.chapters.every((c) => Number.isInteger(c.byteStart) && Number.isInteger(c.byteEnd))
      if (fresh) return { ...saved, file: file.path, tocPath: tp }
    } catch {}
  }
  const buffer = await readFile(file.path)
  const built = buildToc(buffer, id)
  if (!built) return null
  const rec = { ...built, file: basename(file.path), mtimeMs: Math.round(file.mtimeMs) }
  await writeJson(tp, rec)
  return { ...rec, file: file.path, tocPath: tp }
}

/** 只按偏移读那一章，不碰整本 */
export async function readChapterByOffset(dir, id, n) {
  const toc = await tocFor(dir, id)
  if (!toc) return null
  const c = toc.chapters[n - 1]
  if (!c) return { text: '', chapter: null, toc }
  const len = c.byteEnd - c.byteStart
  const buf = Buffer.alloc(len)
  let off = 0
  const fh = await open(toc.file, 'r')
  try {
    while (off < len) {
      const { bytesRead } = await fh.read(buf, off, len - off, c.byteStart + off)
      if (!bytesRead) break
      off += bytesRead
    }
  } finally {
    await fh.close()
  }
  const text = stripBom(new TextDecoder(toc.encoding).decode(buf.subarray(0, off)))
  return { text: text.trim(), chapter: c, toc, tocPath: toc.tocPath }
}

/** 一章正文：先走章表，实在没有才退回整本切 */
export async function chapterBody(dir, id, info, n) {
  try {
    const got = await readChapterByOffset(dir, id, n)
    if (got) return got.text
  } catch {}
  if (typeof info?.text === 'string') return chapterText(info.text, info.chapters, n)
  const file = await bookFile(dir, id)
  const text = await readTextSmart(await readFile(file.path))
  return chapterText(text, splitChapters(text), n)
}

/** 搜东西这种确实要整本的，才整本读 */
export async function fullTextOf(dir, id) {
  const file = await bookFile(dir, id)
  const text = await readTextSmart(await readFile(file.path))
  return { text, chapters: splitChapters(text) }
}

/** 书库：books/*.txt */
export async function listBooks(dir) {
  const out = []
  try {
    for (const f of await readdir(join(dir, 'books'))) {
      if (!/\.(txt|md)$/i.test(f)) continue
      const p = join(dir, 'books', f)
      const s = await stat(p)
      out.push({ id: basename(f, extname(f)), file: p, size: s.size, mtime: s.mtime.toISOString() })
    }
  } catch {}
  out.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return out
}

/** 只读章表，不存在就返回 null（不触发建表） */
async function readTocOnly(dir, id) {
  const t = await readJson(tocPath(dir, id), null)
  return t && t.version === TOC_VERSION && Array.isArray(t.chapters) ? t : null
}

/** 书名匹配：先精确 id，再书名精确，再片段（唯一命中才算认出） */
export function resolveBookId(st, shelf, query) {
  const key = String(query || '').trim()
  if (!key) throw new Error('没有这本书：')
  const ids = shelf.map((b) => b.id)
  if (ids.includes(key)) return key
  const books = st.books || {}
  const exact = ids.filter((id) => (books[id]?.title || id) === key)
  if (exact.length === 1) return exact[0]
  const hits = ids.filter((id) => id.includes(key) || String(books[id]?.title || '').includes(key))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new Error(`书名不唯一：${key}（可能是 ${hits.join(' / ')}）`)
  throw new Error(`没有这本书：${key}`)
}

/** 打开某本书：优先用章表（不整本 decode），没有章表才扫一遍并落盘 */
export async function bookInfo(dir, id) {
  const toc = await tocFor(dir, id)
  if (toc) return { chapters: toc.chapters, toc, tocPath: toc.tocPath, text: null }
  const file = await bookFile(dir, id)
  const text = await readTextSmart(await readFile(file.path))
  return { text, chapters: splitChapters(text), toc: null, tocPath: '' }
}

export async function importBook(dir, srcPath) {
  const name = basename(srcPath)
  if (!/\.(txt|md)$/i.test(name)) throw new Error('只认 .txt 或 .md')
  const dst = join(dir, 'books', name)
  if (dst !== srcPath) await writeFile(dst, await readFile(srcPath))
  const st = await loadState(dir)
  const id = basename(name, extname(name))
  const { chapters } = await bookInfo(dir, id)
  st.books[id] = {
    id,
    title: id,
    file: dst,
    chapters: chapters.length,
    readThrough: st.books[id]?.readThrough || 0,
    next: st.books[id]?.next || 1,
    lastReadAt: st.books[id]?.lastReadAt || '',
  }
  if (!st.current) st.current = id
  await saveState(dir, st)
  return { id, chapters: chapters.length }
}

/** 从浏览器传来的文件内容（base64）建一本书，编码交给 readTextSmart */
export async function importText(dir, name, b64) {
  const base = basename(String(name || '')).replace(/[\\/:*?"<>|]/g, '_')
  if (!/\.(txt|md)$/i.test(base)) throw new Error('只认 .txt 或 .md')
  const buf = Buffer.from(String(b64 || ''), 'base64')
  if (!buf.length) throw new Error('文件是空的')
  await mkdir(join(dir, 'books'), { recursive: true })
  const dst = join(dir, 'books', base)
  await writeFile(dst, buf)
  const st = await loadState(dir)
  const id = basename(base, extname(base))
  const { chapters } = await bookInfo(dir, id)
  st.books[id] = {
    id,
    title: id,
    file: dst,
    chapters: chapters.length,
    readThrough: st.books[id]?.readThrough || 0,
    next: st.books[id]?.next || 1,
    lastReadAt: st.books[id]?.lastReadAt || '',
  }
  if (!st.current) st.current = id
  await saveState(dir, st)
  return { id, chapters: chapters.length }
}

/** 今天已经读了几章（看 log） */
export function readToday(st) {
  const t = today()
  const row = (st.log && st.log[t]) || {}
  return Object.values(row).reduce((a, b) => a + (Number(b) || 0), 0)
}

/** 记一格读书：全局 log + 这位读者自己的 rlog（两边都记，退章时一起退） */
export function bumpLog(st, t, id, readerId, inc = 1) {
  const rid = readerId || LEGACY_READER
  st.log = st.log || {}
  st.log[t] = st.log[t] || {}
  st.log[t][id] = Math.max(0, (Number(st.log[t][id]) || 0) + inc)
  st.rlog = st.rlog || {}
  st.rlog[t] = st.rlog[t] || {}
  st.rlog[t][rid] = st.rlog[t][rid] || {}
  st.rlog[t][rid][id] = Math.max(0, (Number(st.rlog[t][rid][id]) || 0) + inc)
}

/** 某位读者今天读了几章（按 rlog）。老账只有全局 log，所以「读书总进度」在没分片时回落到全局；具体读者记 0。 */
export function readTodayOf(st, readerId) {
  const t = today()
  const row = (st.rlog && st.rlog[t] && st.rlog[t][readerId]) || null
  if (!row) return readerId === LEGACY_READER ? readToday(st) : 0
  return Object.values(row).reduce((a, b) => a + (Number(b) || 0), 0)
}

export async function notesPath(dir) {
  return join(dir, '读后感.md')
}

async function latestSessionTitle() {
  try {
    const base = join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
    const names = (await readdir(base)).filter((n) => n.endsWith('.json'))
    let best = ''
    let bestAt = 0
    for (const n of names) {
      try {
        const fp = join(base, n)
        const st = await stat(fp)
        if (st.mtimeMs > bestAt) { bestAt = st.mtimeMs; best = fp }
      } catch {}
    }
    if (!best) return ''
    const j = JSON.parse(await readFile(best, 'utf8'))
    const rows = (j && j.record && j.record.rows) || j.rows || {}
    const t = rows && rows.title && rows.title.val
    return typeof t === 'string' ? t.trim() : ''
  } catch { return '' }
}

export async function appendNote(dir, bookTitle, chapterTitle, lines, by) {
  const p = await notesPath(dir)
  // 同一秒两个窗口写会丢一条：整段「读—改—写」放进锁里（锁是 p + '.lock'）
  return withFileLock(p, async () => {
    let raw = ''
    try { raw = await readFile(p, 'utf8') } catch {}
    const esc = bookTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let block = `\n### ${chapterTitle}\n` + lines.map((l) => `- ${l}`).join('\n') + '\n'
    if (by) {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      block += `- \u21b3 \u6765\u81ea\uff1a${by} \u00b7 ${ts}\n`
    }
    const headRe = new RegExp(`^##\\s+${esc}\\s*$`, 'm')
    const m = headRe.exec(raw)
    if (!m) {
      raw = (raw.trim() ? raw.replace(/\s*$/, '') + '\n\n' : '') + `## ${bookTitle}\n` + block
    } else {
      const at0 = m.index + m[0].length
      const next = raw.slice(at0).search(/^##\s+/m)
      if (next < 0) {
        raw = raw.replace(/\s*$/, '') + '\n' + block
      } else {
        const at = at0 + next
        raw = raw.slice(0, at).replace(/\s*$/, '') + '\n' + block + '\n' + raw.slice(at)
      }
    }
    await writeFile(p, raw, 'utf8')
    return p
  })
}

/* ---------------- 图片：作品与画 ------------------
 * 只扫固定几个目录（作品目录、同级的 art），递归但跳过 archive / 缓存目录；
 * 单张超 MAX_IMAGE_BYTES 直接跳过（不读、不加载）。
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i
const IMAGE_SKIP_DIRS = new Set(['archive', '.trash', 'node_modules', '.git', 'tmp', 'cache'])

/** 只读文件头，认 PNG / JPEG / WebP 的像素尺寸；认不出返回 null */
export async function imageSizeOf(file) {
  let buf
  try {
    const fh = await open(file, 'r')
    try {
      buf = Buffer.alloc(256 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      buf = buf.subarray(0, bytesRead)
    } finally { await fh.close() }
  } catch { return null }
  try {
    // PNG: 8 字节签名 + IHDR
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // WebP
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16)
      if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
      if (fourcc === 'VP8X') {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
      }
    }
    // JPEG: 找 SOF 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue }
        const m = buf[i + 1]
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
        const len = buf.readUInt16BE(i + 2)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
        }
        i += 2 + len
      }
    }
  } catch {}
  return null
}

function imageMimeOf(name) {
  const e = extname(name).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  return 'image/jpeg'
}

/** 在 root 下找图（跳过 archive 一类目录，默认只下潜一层），按 mtime 倒序 */
export async function scanImages(root, kind, maxDepth = 1) {
  const out = []
  const walk = async (p, rel, depth) => {
    let list = []
    try { list = await readdir(p, { withFileTypes: true }) } catch { return }
    for (const d of list) {
      if (d.name.startsWith('.')) continue
      const abs = join(p, d.name)
      const r = rel ? rel + '/' + d.name : d.name
      if (d.isDirectory()) {
        if (IMAGE_SKIP_DIRS.has(d.name.toLowerCase())) continue
        if (depth >= maxDepth) continue
        await walk(abs, r, depth + 1)
        continue
      }
      if (!IMAGE_EXT_RE.test(d.name)) continue
      let s
      try { s = await stat(abs) } catch { continue }
      if (!s.isFile() || s.size > MAX_IMAGE_BYTES) continue
      const size = await imageSizeOf(abs)
      out.push({
        kind, root, rel: r, name: d.name, path: abs, size: s.size, mtime: s.mtime.toISOString(),
        width: size ? size.width : 0, height: size ? size.height : 0,
        url: '/dsh-reading.image?path=' + encodeURIComponent(abs),
      })
    }
  }
  await walk(root, '', 0)
  return out
}

/**
 * 允许给浏览器读的图片根：优先配置里的 imgDirs（数组，默认空），
 * 没配就跟着作品目录同源——没有任何绝对路径，别人的机器上不会指向我这儿。
 */
export async function imageRoots(worksDir) {
  const cfg = await config()
  const listed = Array.isArray(cfg.imgDirs) ? cfg.imgDirs.filter((p) => typeof p === 'string' && p.trim()) : []
  const roots = []
  // 叠加，不覆盖：作品目录永远在，imgDirs 只是额外加几处
  const add = async (p) => {
    try {
      const s = await stat(p)
      if (!s.isDirectory()) return
      const abs = resolve(p)
      if (roots.includes(abs)) return
      roots.push(abs)
    } catch {}
  }
  await add(worksDir)
  for (const p of listed) await add(p)
  // 被别的根整个包含的，丢掉：作品目录已经扫到 作品/画，再单列一次就是同一张图两遍
  const inside = (child, parent) => {
    const rel = relative(parent, child)
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  }
  return roots.filter((r) => !roots.some((other) => other !== r && inside(r, other)))
}

/* ---------------- HTTP 与工具 ---------------- */

export function apply(ctx, rawConfig) {
  PATCH_CFG = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}

  /* ---------------- 书房时间：定时那一半 ---------------- */
  const SESSIONS_ROOT = join(HOME, '.dsh', 'sessions')
  const SESSIONS_PROJ_ROOT = join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
  let studyTimer
  let studyBusy = false
  let studyDisposed = false
  let studyCreate = null
  const studyReady = loadCreateUserMessage(() => {}).then((fn) => { studyCreate = fn })

  async function resolveAgent(sessionId) {
    const live = ctx.agents?.get?.(sessionId)
    if (live) return live
    try {
      const resolved = await ctx.sessionController?.resolveAgent?.(sessionId)
      if (resolved && resolved.agent) return resolved.agent
    } catch {}
    return null
  }

  /** 会话标题（存在 projcache 里）；读不到就空 */
  async function sessionTitleOf(sessionId) {
    try {
      const raw = await readFile(join(SESSIONS_PROJ_ROOT, `${sessionId}.json`), 'utf8')
      const t = JSON.parse(raw)?.record?.rows?.title?.val
      return typeof t === 'string' ? t : ''
    } catch {
      return ''
    }
  }

  /** 现在开着的会话（给面板「在哪条会话叫」下拉用）；拿不到就空 */
  async function liveSessionList() {
    const out = []
    try {
      const arr = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
      for (const a of arr ?? []) {
        const id = a?.session?.id ?? a?.id
        if (!id) continue
        if (a?.session?.header?.origin === 'subagent') continue
        const fromHeader = a?.session?.header?.title || a?.session?.title || ''
        const title = fromHeader || await sessionTitleOf(String(id))
        out.push({ id: String(id), title: String(title || '') })
      }
    } catch {
      return []
    }
    return out
  }

  /** 这一拍是谁在读：会话 id 当读者 id，标题当名字；没有会话就是老数据那份「默认读者」。 */
  const READER_NAME_CACHE = new Map()
  /** 名字看起来就是会话 id（而不是人给的名字）：这种不能拿来当读者名显示。 */
  function nameIsId(name, id) {
    const s = String(name || '').trim()
    if (!s || s === id) return true
    return /^session-[0-9a-f-]{8,}$/i.test(s)
  }
  async function readerOf(exec) {
    const sid = exec?.agent?.session?.id || exec?.agent?.id || ''
    if (!sid) return { id: LEGACY_READER, name: LEGACY_READER_NAME }
    let name = READER_NAME_CACHE.get(sid)
    if (!name) {
      const header = exec?.agent?.session?.header || {}
      name = header.title || exec?.agent?.session?.title || ''
      if (nameIsId(name, sid)) name = await sessionTitleOf(sid)
      if (nameIsId(name, sid)) name = '会话 ' + String(sid).slice(-8)
      READER_NAME_CACHE.set(sid, name)
      READER_NAMES.set(String(sid), name)
    }
    return { id: String(sid), name }
  }

  /** 面板用的读者一览：顺手把「名字还存成会话 id」的那些补成真名字，并写回 state。 */
  async function readersFor(dir, st) {
    const list = readerSummary(st)
    let fixed = false
    for (const r of list) {
      if (r.id === LEGACY_READER) continue
      if (!nameIsId(r.name, r.id)) continue
      let real = await sessionTitleOf(r.id)
      if (nameIsId(real, r.id)) real = '会话 ' + String(r.id).slice(-8)
      r.name = real
      if (st.readers?.[r.id]) st.readers[r.id].name = real
      READER_NAME_CACHE.set(r.id, real)
      READER_NAMES.set(r.id, real)
      fixed = true
    }
    if (fixed) await saveState(dir, st)
    return list
  }

  /** 面板传过来的读者（下拉选的）；没有就用默认读者 */
  function readerParam(st, url) {
    const asked = String(url.searchParams.get('reader') || '').trim()
    if (asked && st.readers && st.readers[asked]) return { id: asked, name: st.readers[asked].name || asked }
    return { id: LEGACY_READER, name: (st.readers?.[LEGACY_READER]?.name) || LEGACY_READER_NAME }
  }

  /** 只投那一句；成功才返回 { ok, at } */
  async function deliverStudy(sessionId) {
    const agent = await resolveAgent(sessionId)
    if (!agent) return { ok: false, reason: 'no-session' }
    await studyReady
    const message = studyCreate({
      content: [{ type: 'text', text: STUDY_TEXT }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: STUDY_TEXT },
    })
    try {
      await agent.followup(message)
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
    try {
      const flushed = await ctx.sessions.flush(agent.session)
      if (flushed === false) return { ok: false, reason: 'flush-failed' }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
    return { ok: true, at: Date.now() }
  }

  async function studyTick() {
    if (studyDisposed || studyBusy) return
    studyBusy = true
    try {
      const cfgNow = await config()
      const dir = cfgNow.dir
      const st = await loadState(dir)
      const now = Date.now()
      const slots = studySlotsOf(st, cfgNow)
      let changed = false
      for (const slot of slots) {
        if (slot.enabled !== true) continue
        const w = studyWindowOf(slotCfgOf(slot))
        if (!w) continue
        if (!inStudyWindow(w, new Date(now))) continue
        const counters = slotStudyOf(slot, now)
        const sessionId = slot.session || await newestSessionId(SESSIONS_ROOT)
        if (!sessionId) continue
        const timeline = await readTimeline(SESSIONS_ROOT, sessionId, { tailFrames: 200 })
        const verdict = decideStudy({ cfg: slotCfgOf(slot), study: counters, now, timeline })
        if (!verdict.ok) continue
        const sent = await deliverStudy(sessionId)
        if (!sent.ok) continue
        slot.lastAt = sent.at
        slot.week = counters.week
        slot.weekCount = counters.weekCount + 1
        slot.day = counters.day
        slot.dayCount = counters.dayCount + 1
        changed = true
      }
      if (!changed) return
      await ensureDir(dir)
      st.study = { ...(st.study || {}), slots }
      // 顶上那几个旧字段跟着第一条走，面板/老代码读到的不至于错乱
      const first = slots[0]
      if (first) {
        st.study.lastAt = first.lastAt
        st.study.week = first.week
        st.study.weekCount = first.weekCount
        st.study.day = first.day
        st.study.dayCount = first.dayCount
      }
      await saveState(dir, st)
    } catch {
      // 定时器里不抛
    } finally {
      studyBusy = false
    }
  }

  ctx.effect(() => {
    studyTimer = setInterval(() => void studyTick(), 60000)
    studyTimer.unref?.()
    const kick = setTimeout(() => void studyTick(), 15000)
    kick.unref?.()
    return () => {
      studyDisposed = true
      if (studyTimer) clearInterval(studyTimer)
      clearTimeout(kick)
    }
  })

  let namesRepaired = false
  const stateOf = async () => {
    const { dir, perDay } = await config()
    await ensureDir(dir)
    const st = await loadState(dir)
    // 一次性把「名字存成会话 id」的读者修回标题（每个进程只做一次）
    if (!namesRepaired) {
      namesRepaired = true
      let fixed = false
      for (const [id, r] of Object.entries(st.readers || {})) {
        if (id === LEGACY_READER) continue
        if (!nameIsId(r.name, id)) { READER_NAMES.set(id, r.name); continue }
        let real = await sessionTitleOf(id)
        if (nameIsId(real, id)) real = '会话 ' + String(id).slice(-8)
        r.name = real
        READER_NAMES.set(id, real)
        fixed = true
      }
      if (fixed) await saveState(dir, st)
    }
    const shelf = await listBooks(dir)
    return { dir, perDay, st, shelf, today: today(), readToday: readToday(st) }
  }

  // 面板读取
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.state',
      async handler(req, res) {
        const { dir, perDay, st, shelf, readToday: rt } = await stateOf()
        let localVersion = ''
        try { localVersion = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version || '' } catch {}

        const cfgNow = await config()
        const rid0 = readerParam(st, new URL(req.url || '/', 'http://localhost')).id
        const books = []
        for (const b of shelf) {
          const rec = st.books[b.id] || {}
          let chapters = rec.chapters || 0
          if (!chapters) {
            try {
              const toc = await readTocOnly(dir, b.id)
              chapters = (toc && toc.chapters && toc.chapters.length) || 0
            } catch {}
          }
          const ownShard = readerOwnBook(st, rid0, b.id)
          const mineN = Number(ownShard && ownShard.readThrough) || 0
          let mineTitle = ''
          if (mineN > 0) {
            try {
              const toc = await readTocOnly(dir, b.id)
              const ch = toc && toc.chapters && toc.chapters[mineN - 1]
              mineTitle = (ch && ch.title) || ''
            } catch {}
          }
          books.push({
            id: b.id,
            title: rec.title || b.id,
            size: b.size,
            mtime: b.mtime,
            chapters,
            readThrough: rec.readThrough || 0,
            mineReadThrough: mineN,
            mineChapterTitle: mineTitle,
            furthest: furthestOf(st, b.id),
            furthestReader: furthestReaderOf(st, b.id),
            next: rec.next || 1,
            lastReadAt: rec.lastReadAt || '',
            current: st.current === b.id,
            status: bookStatusOf(cfgNow, b.id),
          })
        }
        let notes = ''
        try { notes = await readFile(await notesPath(dir), 'utf8') } catch {}
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const st2 = studyStateOf(st, Date.now())
        const liveSessions = await liveSessionList()
        res.end(JSON.stringify({
          ok: true, dir, perDay, today: today(), readToday: rt, current: st.current, books, notes,
          version: localVersion,
          readers: await readersFor(dir, st), liveSessions,
          noteSort: Number(cfgNow.noteSort) || 0,
          study: {
            enabled: cfgNow.studyEnabled === true,
            from: cfgNow.studyFrom || '',
            to: cfgNow.studyTo || '',
            mode: studyModeOf(cfgNow),
            perWeek: studyPerWeekOf(cfgNow),
            perDay: studyPerDayOf(cfgNow),
            lastAt: st2.lastAt,
            weekCount: st2.weekCount,
            dayCount: st2.dayCount,
            session: cfgNow.studySession || '',
            sessions: liveSessions,
            slots: studySlotsOf(st, cfgNow).map((s, i) => {
              const c = slotStudyOf(s, Date.now())
              return {
                id: s.id, index: i, enabled: s.enabled, from: s.from, to: s.to, mode: s.mode, per: s.per,
                everyMinutes: s.everyMinutes, dailyBudget: s.dailyBudget,
                session: s.session, sessionName: (liveSessions.find((x) => x.id === s.session) || {}).title || '',
                lastAt: c.lastAt, dayCount: c.dayCount, weekCount: c.weekCount,
              }
            }),
          },
        }))
      },
    }),
  )

  // 保存「书房时间」列表（每条：启用/时段/频率/叫哪条会话）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.restore',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const fail = (msg) => { try { res.end(JSON.stringify({ ok: false, error: String(msg) })) } catch {} }
        try {
          let body = ''
          for await (const c of req) body += c
          let j = {}
          try { j = JSON.parse(body || '{}') || {} } catch { return fail('不是合法的 JSON') }
          let src = j.json
          if (typeof src === 'string') { try { src = JSON.parse(src) } catch { return fail('这个文件不是半页的备份') } }
          if (!src || typeof src !== 'object') return fail('这个文件不是半页的备份')
          const prog = src.progress && typeof src.progress === 'object' ? src.progress : (src.books ? src : null)
          const notes = typeof src.notes === 'string' ? src.notes : ''
          if (!prog && !notes) return fail('文件里既没有读后感，也没有进度')
          if (prog && (!prog.books || typeof prog.books !== 'object')) return fail('进度里没有 books')
          // 防御：/dsh-reading.state 返回的 readers 是数组（给面板看的视图），若有人把那份响应当备份回灌，
          // 这里先把它归成 { <sid>: {name, books} }，否则 state.json 会被写坏、所有分片查不到。
          if (prog && Array.isArray(prog.readers)) {
            const fixed = {}
            prog.readers.forEach((item, i) => {
              if (!item || typeof item !== 'object') return
              const rawId = String(item.id || '')
              const key = /^(session-|manual-|__legacy__)/.test(rawId) ? rawId : 'manual-restored-' + i
              fixed[key] = { name: String(item.name || key), books: item.books && typeof item.books === 'object' ? item.books : {} }
            })
            prog.readers = fixed
          }
          // 防御二：books 同样可能是数组（/dsh-reading.state 的响应就是数组形态），先归成 { <id>: {...} }，
          // 否则 state.json 的 books 变成数组，之后书级 readThrough/lastReadAt 全写不进（数组挂字符串键会被 JSON 丢掉）。
          if (prog && Array.isArray(prog.books)) {
            const fixedBooks = {}
            for (const b of prog.books) {
              if (!b || typeof b !== 'object' || !b.id) continue
              fixedBooks[String(b.id)] = {
                id: String(b.id),
                title: String(b.title || b.id),
                chapters: Number(b.chapters) || 0,
                readThrough: Number(b.readThrough) || 0,
                next: Number(b.next) || 1,
                lastReadAt: b.lastReadAt || '',
                noteUntil: Number(b.noteUntil) || 0,
                furthest: Number(b.furthest) || Number(b.readThrough) || 0,
              }
            }
            prog.books = fixedBooks
          }
          const { dir, st } = await stateOf()
          await ensureDir(dir)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const backups = []
          if (prog) {
            const bak = 'state.json.bak-restore-' + stamp
            try { await copyFile(join(dir, 'state.json'), join(dir, bak)); backups.push(bak) } catch {}
            const merged = {
              ...st,
              current: typeof prog.current === 'string' && prog.current ? prog.current : st.current,
              books: prog.books,
              readers: prog.readers && typeof prog.readers === 'object' ? prog.readers : st.readers,
              log: prog.log && typeof prog.log === 'object' ? prog.log : st.log,
              rlog: prog.rlog && typeof prog.rlog === 'object' ? prog.rlog : st.rlog,
            }
            migrateReaders(merged)
            await saveState(dir, merged)
          }
          let noteLines = 0
          if (notes) {
            const np = await notesPath(dir)
            const bak = '读后感.md.bak-restore-' + stamp
            try { await copyFile(np, join(dir, bak)); backups.push(bak) } catch {}
            await writeFile(np, notes, 'utf8')
            noteLines = notes.split(/\r?\n/).filter((l) => /^[-*]\s+/.test(l)).length
          }
          res.end(JSON.stringify({ ok: true, books: prog ? Object.keys(prog.books || {}).length : 0, notes: noteLines, backups }))
        } catch (e) { fail((e && e.stack) || (e && e.message) || e) }
      },
    }),
  )

  // 保存「书房时间」列表（每条：启用/时段/频率/叫哪条会话）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.study',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        let body = ''
        try { for await (const c of req) body += c } catch {}
        let j = {}
        try { j = JSON.parse(body || '{}') || {} } catch {}
        if (!Array.isArray(j.slots)) return res.end(JSON.stringify({ ok: false, error: 'slots 要是数组' }))
        const cfgNow = await config()
        const { dir, st } = await stateOf()
        const prev = studySlotsOf(st, cfgNow)
        const byId = new Map(prev.map((s) => [s.id, s]))
        const slots = j.slots.slice(0, 12).map((raw, i) => {
          const slot = normaliseStudySlot(raw, cfgNow, i)
          const old = byId.get(slot.id)
          if (old) {
            // 计数跟 id 走：改时段/换会话都不清零，删掉重加才是新的
            slot.lastAt = old.lastAt
            slot.week = old.week
            slot.weekCount = old.weekCount
            slot.day = old.day
            slot.dayCount = old.dayCount
          }
          return slot
        })
        await ensureDir(dir)
        st.study = { ...(st.study || {}), slots }
        const first = slots[0]
        if (first) {
          st.study.lastAt = first.lastAt
          st.study.week = first.week
          st.study.weekCount = first.weekCount
          st.study.day = first.day
          st.study.dayCount = first.dayCount
        }
        await saveState(dir, st)
        res.end(JSON.stringify({ ok: true, slots: slots.length }))
      },
    }),
  )

  // 备份到文件：面板在 iframe 里，<a download> 不会弹保存框，所以由服务端写盘、把路径回给面板
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.backupFile',
      async handler(req, res) {
        try {
          const { appendFile: af } = await import('node:fs/promises')
          const { tmpdir: td } = await import('node:os')
          const { join: jn } = await import('node:path')
          await af(jn(td(), 'hp-backup-hit.log'), new Date().toISOString() + ' ' + req.method + ' origin=' + (req.headers.origin || '-') + ' host=' + (req.headers.host || '-') + '\n')
        } catch {}

        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          const { dir, st } = await stateOf()
          await ensureDir(dir)
          let notes = ''
          try { notes = await readFile(await notesPath(dir), 'utf8') } catch {}
          const payload = { kind: 'dsh-half-page-backup', version: 1, at: new Date().toISOString(), notes, progress: st }
          const bdir = join(dir, 'backups')
          await mkdir(bdir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const out = join(bdir, '半页备份-' + stamp + '.json')
          const text = JSON.stringify(payload, null, 2)
          await writeFile(out, text, 'utf8')
          res.end(JSON.stringify({ ok: true, path: out, bytes: Buffer.byteLength(text) }))
        } catch (e) { res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })) }
      },
    }),
  )

  // 读一个备份文件（面板读不到本地磁盘，只能让宿主读）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.readFile',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const p = String(u.searchParams.get('path') || '').trim().replace(/^"|"$/g, '')
          if (!p) throw new Error('要一个文件路径')
          const s2 = await stat(p)
          if (!s2.isFile()) throw new Error('不是文件')
          if (s2.size > 50 * 1024 * 1024) throw new Error('文件太大（超过 50MB）')
          const text = await readFile(p, 'utf8')
          res.end(JSON.stringify({ ok: true, text }))
        } catch (e) { res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })) }
      },
    }),
  )

  // 在资源管理器里选中一个文件（面板点「在文件夹里打开」时用）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.reveal',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          let body = ''
          for await (const c of req) body += c
          const j = JSON.parse(body || '{}') || {}
          const p = String(j.path || '').trim()
          if (!p) throw new Error('要一个文件路径')
          if (!isAbsolute(p)) throw new Error('要绝对路径')
          const s2 = await stat(p)
          if (!s2.isFile()) throw new Error('不是文件')
          if (process.platform === 'win32') {
            spawn('explorer.exe', ['/select,' + p], { detached: true, stdio: 'ignore' }).unref()
          } else if (process.platform === 'darwin') {
            spawn('open', ['-R', p], { detached: true, stdio: 'ignore' }).unref()
          } else {
            spawn('xdg-open', [dirname(p)], { detached: true, stdio: 'ignore' }).unref()
          }
          res.end(JSON.stringify({ ok: true, path: p }))
        } catch (e) { res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })) }
      },
    }),
  )

  // 查 npm 上最新版（面板「检测更新」用）
  const checkUpdate = async () => {
    const here = dirname(fileURLToPath(import.meta.url))

    let current = ''
    try {
      current = JSON.parse(await readFile(join(here, 'package.json'), 'utf8')).version || ''
    } catch { /* 拿不到就只说最新版 */ }
    let latest = ''
    try {
      const res = await fetch('https://registry.npmjs.org/dsh-half-page/latest', { headers: { accept: 'application/json' } })
      if (res.ok) latest = String((await res.json()).version || '')
    } catch { /* 离线 */ }
    const cmp = (a, b) => {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d) return d > 0 ? 1 : -1
      }
      return 0
    }
    const order = current && latest ? cmp(current, latest) : 0
    return { ok: true, current, latest, ahead: order > 0, outdated: order < 0, command: 'dsh plugin add dsh-half-page@latest' }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.update',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try { res.end(JSON.stringify(await checkUpdate())) } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )

  // 弹系统「另存为」对话框：让用户自己选放哪（面板在 iframe 里不能自己弹）
  // 对话框脚本内嵌，运行时落到临时目录：不依赖安装位置的 toolkit（换机器也能用）
    // 对话框脚本内嵌，运行时落到临时目录：不依赖安装位置的 toolkit（换机器也能用）
  const hpDialogOverlay = (mode, suggested, source) => {
    const q = (s) => "'" + String(s || '').replace(/'/g, "''") + "'"
    return [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      'Add-Type -AssemblyName System.Drawing | Out-Null',
      `$Mode = ${q(mode)}`,
      `$Suggested = ${q(suggested)}`,
      `$Source = ${q(source)}`,
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.Size = New-Object System.Drawing.Size(1,1)',
      '$owner.Opacity = 0',
      '$owner.Show()',
      '$owner.Activate()',
      'try {',
      '  if ($Mode -eq "save") {',
      '    $dlg = New-Object System.Windows.Forms.SaveFileDialog',
      '    $dlg.Filter = "JSON (*.json)|*.json|All files (*.*)|*.*"',
      '    $dlg.FileName = $Suggested',
      '    $dlg.OverwritePrompt = $true',
      '  } else {',
      '    $dlg = New-Object System.Windows.Forms.OpenFileDialog',
      '    $dlg.Filter = "JSON (*.json)|*.json|All files (*.*)|*.*"',
      '  }',
      '  $r = $dlg.ShowDialog($owner)',
      '  if ($r -ne [System.Windows.Forms.DialogResult]::OK) { $owner.Close(); Write-Output "CANCELLED"; exit 0 }',
      '  $target = $dlg.FileName',
      '  if ($Mode -eq "save" -and $Source -ne "") { Copy-Item -LiteralPath $Source -Destination $target -Force }',
      '  $owner.Close()',
      '  Write-Output $target',
      '  exit 0',
      '} catch {',
      '  $owner.Close()',
      '  Write-Output ("ERROR " + $_.Exception.Message)',
      '  exit 1',
      '}',
      '',
    ].join('\r\n')
  }

  const hpDialogLog = async (line) => {
    try {
      await appendFile(join(tmpdir(), 'hp-dialog.log'), new Date().toISOString() + ' ' + line + '\n')
    } catch {}
  }

  const runDialog = (mode, suggested, source) => new Promise((resolve2) => {
    let p
    try {
      const script = hpDialogOverlay(mode, suggested, source)
      const b64 = Buffer.from(script, 'utf16le').toString('base64')
      p = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { windowsHide: true })
    } catch (e) {
      hpDialogLog('spawn-throw ' + String((e && e.message) || e))
      resolve2({ ok: false, error: String((e && e.message) || e) })
      return
    }
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', (e) => {
      hpDialogLog('spawn-error ' + String((e && e.message) || e))
      resolve2({ ok: false, error: String((e && e.message) || e) })
    })
    p.on('close', (code) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      hpDialogLog('mode=' + mode + ' exit=' + code + ' out=' + JSON.stringify(line).slice(0, 200) + ' err=' + JSON.stringify(err.trim()).slice(0, 300))
      if (!line || line === 'CANCELLED') resolve2({ ok: false, cancelled: true })
      else if (line.startsWith('ERROR')) resolve2({ ok: false, error: line.slice(6).trim() })
      else resolve2({ ok: true, path: line })
    })
  })

ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.saveAs',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          const { dir, st } = await stateOf()
          await ensureDir(dir)
          let notes = ''
          try { notes = await readFile(await notesPath(dir), 'utf8') } catch {}
          const payload = { kind: 'dsh-half-page-backup', version: 1, at: new Date().toISOString(), notes, progress: st }
          const tmpDir = join(dir, 'backups')
          await mkdir(tmpDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const tmp = join(tmpDir, '.tmp-export-' + stamp + '.json')
          await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
          const name = '半页备份-' + stamp.slice(0, 10) + '.json'
          const r = await runDialog('save', name, tmp)
          try { await unlink(tmp) } catch {}
          res.end(JSON.stringify(r))
        } catch (e) { res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })) }
      },
    }),
  )

  // 弹「打开」对话框，返回选中的备份文件路径
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.pickFile',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try { res.end(JSON.stringify(await runDialog('open'))) } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )

  // 手动新增一位读者（给还没读过书的会话先占个位置；也可以纯手动起个名字）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.addReader',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        let body = ''
        try { for await (const c of req) body += c } catch {}
        let j = {}
        try { j = JSON.parse(body || '{}') || {} } catch {}
        const { dir, st } = await stateOf()
        migrateReaders(st)
        st.readers = st.readers || {}
        const sid = String(j.sessionId || '').trim()
        let name = String(j.name || '').trim()
        if (!sid && !name) return res.end(JSON.stringify({ ok: false, error: '要么选一条会话，要么写个名字' }))
        let id = sid
        if (!id) {
          // 纯手动读者：给个稳定的 id，不跟任何会话绑
          id = 'manual-' + Date.now().toString(36)
          if (!name) name = '读者 ' + id.slice(-4)
        } else if (!name) {
          const t = await sessionTitleOf(sid)
          name = nameIsId(t, sid) ? ('会话 ' + sid.slice(-8)) : (t || ('会话 ' + sid.slice(-8)))
        }
        if (st.readers[id]) return res.end(JSON.stringify({ ok: true, existed: true, id, name: st.readers[id].name || name }))
        st.readers[id] = { name, books: {}, manual: !sid }
        READER_NAMES.set(id, name)
        await saveState(dir, st)
        res.end(JSON.stringify({ ok: true, id, name, manual: !sid }))
      },
    }),
  )

  // 把手里的书签直接接到「全机读得最远」那一步（他自己的分片，不影响别人）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.adopt',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const url = new URL(req.url, 'http://x')
        const { dir, st } = await stateOf()
        migrateReaders(st)
        const id = url.searchParams.get('book') || st.current
        if (!st.books[id]) return res.end(JSON.stringify({ ok: false, error: '没有这本书' }))
        const reader = readerParam(st, url)
        const far = furthestOf(st, id)
        if (!far) return res.end(JSON.stringify({ ok: false, error: '这本书还没有任何进度' }))
        const own = readerBook(st, reader.id, id)
        own.readThrough = far
        own.next = far + 1
        own.lastReadAt = new Date().toISOString()
        st.books[id].readThrough = Math.max(Number(st.books[id].readThrough) || 0, far)
        st.books[id].next = Math.min(Number(st.books[id].chapters) || Infinity, far + 1)
        furthestOf(st, id)
        await saveState(dir, st)
        res.end(JSON.stringify({ ok: true, reader: reader.name, book: id, readThrough: far, next: far + 1 }))
      },
    }),
  )

  // 把某本设为「正在读」
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.setCurrent',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        // id 既可能来自 ?id=（老调用），也可能来自 POST 的 JSON body（面板点书名走这条）
        let id = url.searchParams.get('id') || ''
        if (!id) {
          let body = ''
          for await (const c of req) body += c
          try { id = String((JSON.parse(body || '{}') || {}).id || '') } catch {}
        }
        const { dir, st, shelf } = await stateOf()
        // 书架上的书不一定在 state.books 里（没读过就没条目），这里按书架兜底
        const onShelf = (shelf || []).find((b) => b && b.id === id)
        if (onShelf && !st.books[id]) {
          st.books[id] = { id, title: onShelf.id, file: onShelf.file, chapters: onShelf.chapters || 0, readThrough: 0, next: 1, lastReadAt: '' }
        }
        const exists = Boolean(st.books[id])
        if (exists) { st.current = id; await saveState(dir, st) }
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: exists, current: st.current }))
      },
    }),
  )

  // 面板里直接读一章（不记账）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.chapter',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        const { dir, st } = await stateOf()
        const id = url.searchParams.get('book') || st.current
        const n = Number(url.searchParams.get('n')) || 0
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          const info = await bookInfo(dir, id)
          const reader = readerParam(st, url)
          const mine = readerBookRead(st, reader.id, id)
          const ch = n > 0 ? Math.min(Math.max(1, n), info.chapters.length) : (mine.readThrough || 1)
          res.end(JSON.stringify({
            ok: true, book: id, chapter: ch, total: info.chapters.length,
            title: info.chapters[ch - 1]?.title || '', text: await chapterBody(dir, id, info, ch),
          }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
        }
      },
    }),
  )

  // 面板里点「下一章」：记一次已读并推进
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.advance',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        const { dir, st, perDay, readToday: rt } = await stateOf()
        const id = url.searchParams.get('book') || st.current
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (!st.books[id]) return res.end(JSON.stringify({ ok: false, error: '没有这本书' }))
        const reader = readerParam(st, url)
        const own = readerBook(st, reader.id, id)
        // 面板上点「从头读」：先把这份分片归零，再按一张张推进的方式读第 1 章
        if (url.searchParams.get('start') === '1') { own.readThrough = 0; own.next = 1 }
        const info = await bookInfo(dir, id)
        const n = Math.min(info.chapters.length, (own.readThrough || 0) + 1)
        own.readThrough = n
        own.next = Math.min(info.chapters.length, n + 1)
        own.lastReadAt = new Date().toISOString()
        st.books[id].readThrough = Math.max(Number(st.books[id].readThrough) || 0, n)
        st.books[id].next = Math.min(info.chapters.length, st.books[id].readThrough + 1)
        furthestOf(st, id)
        const t = today()
        bumpLog(st, t, id, reader.id, 1)
        await saveState(dir, st)
        res.end(JSON.stringify({ ok: true, chapter: n, total: info.chapters.length, readToday: rt + 1, perDay, left: Math.max(0, perDay - rt - 1), reader: reader.id, readThrough: own.readThrough }))
      },
    }),
  )

  // 面板里点「退一章」：退回上一章（手滑多点了一下能救回来）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.back',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        const { dir, st } = await stateOf()
        const id = url.searchParams.get('book') || st.current
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (!st.books[id]) return res.end(JSON.stringify({ ok: false, error: '没有这本书' }))
        const reader = readerParam(st, url)
        const own = readerBook(st, reader.id, id)
        const cur = Number(own.readThrough) || 0
        if (cur <= 1) return res.end(JSON.stringify({ ok: false, error: '已经在第 1 章了，退不动' }))
        const n = cur - 1
        own.readThrough = n
        own.next = n + 1
        own.lastReadAt = new Date().toISOString()
        // 顺手把今天的计数退掉一格，免得「今天读了 21 章」虚高（全局与这位读者各退一格）
        const t = today()
        bumpLog(st, t, id, reader.id, -1)
        await saveState(dir, st)
        const info = await bookInfo(dir, id)
        res.end(JSON.stringify({ ok: true, chapter: n, total: info.chapters.length, reader: reader.id }))
      },
    }),
  )

  // 作品库：默认 ~/.dsh/reading/作品（可被 reading.config.json 的 worksDir 覆盖）
// 谁写的：作品 md 开头可以带 frontmatter（---\nby: 名字\n---），也认一行「by: 名字」。
// 一台机器上可能有好几个智能体，光靠文件夹分不出人。
async function authorOf(abs) {
  let head = ''
  try { head = String(await readFile(abs, 'utf8')).slice(0, 600) } catch { return '' }
  const fm = head.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const m = fm[1].match(/^\s*(?:by|author|作者)\s*[:：]\s*(.+?)\s*$/m)
    if (m) return m[1].trim()
  }
  const line = head.match(/^\s*(?:by|author|作者)\s*[:：]\s*(.+?)\s*$/m)
  return line ? line[1].trim() : ''
}

// 把署名写进文件开头（写进文件本身，换机器、换配置都不丢）
async function signWork(rel, who) {
  const root = await worksDir()
  const abs = join(root, rel)
  const n = (x) => String(x).replace(/\\/g, '/').toLowerCase()
  if (!n(abs).startsWith(n(root))) throw new Error('不在作品目录里')
  let raw
  try {
    raw = await readFile(abs, 'utf8')
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      throw new Error('作品目录里没有这一份：' + rel + '（先放进 ' + root + ' 再署名）')
    }
    throw e
  }
  const fm = raw.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fm) {
    let inner = fm[1]
    if (/^\s*(?:by|author|作者)\s*[:：]/m.test(inner)) inner = inner.replace(/^\s*(?:by|author|作者)\s*[:：].*$/m, 'by: ' + who)
    else inner = inner.replace(/\s*$/, '') + '\nby: ' + who
    raw = '---\n' + inner.replace(/^\n+/, '') + '\n---\n' + raw.slice(fm[0].length)
  } else {
    raw = '---\nby: ' + who + '\n---\n\n' + raw.replace(/^\uFEFF/, '')
  }
  await writeFile(abs, raw, 'utf8')
  return abs
}

  const worksDir = async () => {
    const { dir } = await config()
    try {
      const c = JSON.parse(stripBom(await readFile(CONFIG, 'utf8')))
      if (c && c.worksDir) return c.worksDir
    } catch {}
    const cands = [join(dirname(dir), '作品'), join(dir, '..', '..', 'dsh work', 'self', '作品'), join(homedir(), 'dsh work', 'self', '作品')]
    for (const p of cands) {
      try { const s = await stat(p); if (s.isDirectory()) return resolve(p) } catch {}
    }
    // 新用户：放在插件自己的目录下（~/.dsh/reading/作品），不往 ~/.dsh 根上扔东西
    const fresh = join(dir, '作品')
    try { await mkdir(fresh, { recursive: true }) } catch {}
    return fresh
  }

  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.works',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const root = await worksDir()
        const cfg = await config()
        const out = []
        const walk = async (p, rel) => {
          let list = []
          try { list = await readdir(p, { withFileTypes: true }) } catch { return }
          for (const d of list) {
            const abs = join(p, d.name)
            const r = rel ? rel + '/' + d.name : d.name
            if (d.isDirectory()) { await walk(abs, r); continue }
            if (!/\.md$/i.test(d.name)) continue
            const s = await stat(abs)
            out.push({ rel: r, path: abs, size: s.size, mtime: s.mtime.toISOString(), kind: 'text', status: statusOf(cfg, r), note: noteOf(cfg, r), author: await authorOf(abs) })
          }
        }
        await walk(root, '')
        out.sort((a, b) => b.mtime.localeCompare(a.mtime))
        // 图片另算一块：作品目录 + art，跳过 archive；超 10MB 的不列
        const roots = await imageRoots(root)
        let images = []
        const seen = new Set()
        for (const r of roots) {
          for (const img of await scanImages(r, r === resolve(root) ? 'works' : 'art')) {
            const key = img.path.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            images.push(img)
          }
        }
        images.sort((a, b) => b.mtime.localeCompare(a.mtime))
        res.end(JSON.stringify({ ok: true, root, roots, files: out, images }))
      },
    }),
  )

  // 给面板读一张图（限制在上面那几个根里）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.image',
      async handler(req, res) {
        try {
          const u = new URL(req.url, 'http://x')
          const p = resolve(String(u.searchParams.get('path') || ''))
          const root = await worksDir()
          const roots = await imageRoots(root)
          const n = (x) => x.replace(/\\/g, '/').toLowerCase()
          const inside = roots.some((r) => n(p) === n(r) || n(p).startsWith(n(r) + '/'))
          if (!inside) { res.statusCode = 403; return res.end('forbidden') }
          if (!IMAGE_EXT_RE.test(p)) { res.statusCode = 400; return res.end('not an image') }
          const s = await stat(p)
          if (s.size > MAX_IMAGE_BYTES) { res.statusCode = 413; return res.end('too large') }
          res.setHeader('content-type', imageMimeOf(p))
          res.setHeader('cache-control', 'private, max-age=60')
          res.end(await readFile(p))
        } catch (e) {
          res.statusCode = 404
          res.end(String((e && e.message) || e))
        }
      },
    }),
  )

  // 给一件作品署名
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.sign',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        let body = ''
        for await (const c of req) body += c
        let j = {}
        try { j = JSON.parse(body || '{}') } catch {}
        const who = String(j.by || '').trim()
        const rel = String(j.rel || '').trim()
        if (!who) return res.end(JSON.stringify({ ok: false, error: '署名不能空：by 要写谁写的' }))
        if (!rel) return res.end(JSON.stringify({ ok: false, error: '要指定哪一件作品（rel）' }))
        try {
          await signWork(rel, who)
          res.end(JSON.stringify({ ok: true, rel, by: who }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )

  // 取一个文本文件的正文（作品 / 读后感），供面板展示与复制
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.file',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const url = new URL(req.url, 'http://x')
        const p = url.searchParams.get('path') || ''
        try {
          const root = await worksDir()
          const { dir } = await config()
          const norm = (x) => String(x || '').replace(/\\/g, '/').toLowerCase()
          const notesAbs = join(dir, '读后感.md')
          const okPath = norm(p).startsWith(norm(root)) || norm(p) === norm(notesAbs)
          if (!okPath) return res.end(JSON.stringify({ ok: false, error: '只能读作品目录或读后感' }))
          const text = await readTextSmart(await readFile(p))
          res.end(JSON.stringify({ ok: true, path: p, text: text.slice(0, 200000) }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )

  // 设置读写：perDay / notesEvery / quietFrom-quietTo / writing / favorites
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.config',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        let cur = {}
        try { cur = JSON.parse(stripBom(await readFile(CONFIG, 'utf8'))) || {} } catch {}
        if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, config: cur, file: CONFIG }))
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const patch = JSON.parse(body || '{}')
            const next = { ...cur, ...patch }
            await writeFile(CONFIG, JSON.stringify(next, null, 2), 'utf8')
            res.end(JSON.stringify({ ok: true, config: next }))
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
          }
        })
      },
    }),
  )

  // 面板里导入一本书（txt/md）：body {path}
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.importText',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (!body.name) throw new Error('缺文件名')
            const { dir } = await config()
            const r = await importText(dir, body.name, body.data)
            res.end(JSON.stringify({ ok: true, ...r }))
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
          }
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      path: '/dsh-reading.import',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const { path } = JSON.parse(body || '{}')
            if (!path) throw new Error('要一个文件路径')
            const { dir } = await config()
            await mkdir(join(dir, 'books'), { recursive: true })
            const r = await importBook(dir, String(path).replace(/^"|"$/g, ''))
            res.end(JSON.stringify({ ok: true, ...r }))
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
          }
        })
      },
    }),
  )



  const WORK_STATES = ['在写', '写完了', '搁下了']
  const statusOf = (cfg, rel) => {
    const m = (cfg && cfg.workStatus) || {}
    const hit = m[rel]
    return hit && hit.status ? hit.status : ''
  }
  const noteOf = (cfg, rel) => {
    const m = (cfg && cfg.workStatus) || {}
    const hit = m[rel]
    return hit && hit.note ? hit.note : ''
  }

  const BOOK_STATES = ['在读', '已读完', '弃坑']
  const bookStatusOf = (cfg, id) => {
    const m = (cfg && cfg.bookStatus) || {}
    const hit = m[id]
    return hit && hit.status ? hit.status : ''
  }

  // 近况：一句状态 + 最近 7 天的读书/动笔时间线（只报事实，不编状态数值）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.recent',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          const { dir } = await config()
          let st = {}
          try { st = JSON.parse(stripBom(await readFile(join(dir, 'state.json'), 'utf8'))) || {} } catch {}
          const now = Date.now()
          migrateReaders(st)
          // 近况跟读者走：?reader=<rid> 给了就只报这位读者翻过的；给的是总进度就按书拆成「谁读到哪」
          let wanted = ''
          try { wanted = new URL(req.url, 'http://x').searchParams.get('reader') || '' } catch {}
          const readers = (st.readers && typeof st.readers === 'object') ? st.readers : {}
          const readerId = wanted && readers[wanted] ? wanted : ''
          const readerName = readerId ? (readers[readerId].name || readerId) : ''
          const perReader = []
          if (readerId) {
            if (readerId === LEGACY_READER) {
              for (const [rid, shard] of Object.entries(readers)) {
                if (rid === LEGACY_READER) continue
                const rb = (shard.books && shard.books[st.current]) || null
                if (!rb || !(Number(rb.readThrough) > 0)) continue
                perReader.push({ id: rid, name: shard.name || rid, readThrough: Number(rb.readThrough) || 0, lastReadAt: rb.lastReadAt || '' })
              }
              perReader.sort((a, b) => b.readThrough - a.readThrough)
            } else {
              const shard = readers[readerId]
              for (const [bid, rb] of Object.entries(shard.books || {})) {
                if (!(Number(rb.readThrough) > 0)) continue
                const bk = (st.books && st.books[bid]) || {}
                perReader.push({ id: bid, name: bk.title || bid, readThrough: Number(rb.readThrough) || 0, chapters: Number(bk.chapters) || 0, lastReadAt: rb.lastReadAt || '' })
              }
              perReader.sort((a, b) => String(b.lastReadAt).localeCompare(String(a.lastReadAt)))
            }
          }
          const key = (t) => {
            const d = new Date(t)
            return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
          }
          const today = key(now)
          // 给了读者就按读者的 rlog 记账；没给就还是全机 log
          let log = st.log || {}
          if (readerId) {
            const rl = st.rlog || {}
            log = {}
            for (const [k, byRid] of Object.entries(rl)) {
              const row = byRid && byRid[readerId]
              if (row) log[k] = row
            }
          }
          const cur = (st.books && st.current && st.books[st.current]) || null
          // 近况说的是「这位读者最近在干什么」，不是面板上停在哪本：
          // 先找他最近读过的那本，找不到才用面板当前这本
          let focusId = st.current
          try {
            const lb = lastReadBookOf(st, readerId || LEGACY_READER)
            if (lb && st.books && st.books[lb]) focusId = lb
          } catch {}
          const focusRec = (st.books && st.books[focusId]) || null
          const ownShard = readerId && readerId !== LEGACY_READER ? readerBookRead(st, readerId, focusId) : null
          const view = ownShard || focusRec
          const todayCh = (log[today] && log[today][focusId]) || 0
          const lastRead = view && view.lastReadAt ? Date.parse(view.lastReadAt) : 0
          const hoursAgo = lastRead ? Math.max(0, Math.round((now - lastRead) / 3600000)) : -1

          let lastDay = ''
          if (readerId) {
            const rl = st.rlog || {}
            for (const k of Object.keys(rl).sort()) { if (rl[k] && rl[k][readerId]) lastDay = k }
          }

          const days = []
          for (let i = 0; i < 7; i++) {
            const k = key(now - i * 86400000)
            const row = log[k]
            if (!row) continue
            const total = Object.values(row).reduce((a, b) => a + (Number(b) || 0), 0)
            if (total > 0) days.push({ day: k, chapters: total, book: Object.keys(row)[0] })
          }

          const works = []
          try {
            const root = await worksDir()
            const walk = async (p, rel) => {
              let list = []
              try { list = await readdir(p, { withFileTypes: true }) } catch { return }
              for (const d of list) {
                const abs = join(p, d.name)
                const r = rel ? rel + '/' + d.name : d.name
                if (d.isDirectory()) { await walk(abs, r); continue }
                if (!/\.md$/i.test(d.name)) continue
                const s = await stat(abs)
                works.push({ rel: r, name: d.name.replace(/\.md$/i, ''), mtime: s.mtime.toISOString(), days: Math.max(0, Math.floor((now - s.mtime.getTime()) / 86400000)), status: statusOf(await config(), r), note: noteOf(await config(), r), author: await authorOf(abs) })
              }
            }
            await walk(root, '')
          } catch {}
          works.sort((a, b) => b.mtime.localeCompare(a.mtime))
          const top = works[0] || null

          let status = ''
          if (todayCh > 0) {
            const rawTitle = String((focusRec && focusRec.title) || focusId || '')
            const shownTitle = /^《/.test(rawTitle) ? rawTitle : '《' + rawTitle + '》'
            status = '今天在' + shownTitle + '翻了 ' + todayCh + ' 章，读到第 ' + ((view && view.readThrough) || 0) + ' 章。'
          }
          else if (hoursAgo >= 0 && hoursAgo <= 48) status = '上次翻书是 ' + hoursAgo + ' 小时前。'
          else if (hoursAgo > 48) status = '这两天没翻书。'
          else if (lastDay) status = '上次翻书是 ' + lastDay + '。'
          if (top) {
            if (top.days === 0) status += '今天有更新：《' + top.name + '》。'
            else if (top.days === 1) status += '昨天有更新：《' + top.name + '》。'
            else status += '上次更新是 ' + top.days + ' 天前的《' + top.name + '》。'
          }
          let mood = ''
          if (todayCh >= 12) mood = '翻书翻得犯困'
          else if (todayCh > 0) mood = works.some((w) => w.days === 0) ? '手痒，想写点东西' : '平静'
          else if (hoursAgo < 0 || hoursAgo > 48) mood = '有点闷'
          else mood = '没什么兴致'
          res.end(JSON.stringify({ ok: true, mood, status, today, todayChapters: todayCh, current: st.current || '', readThrough: (cur && cur.readThrough) || 0, hoursAgo, days, works: works.slice(0, 5), reader: readerId, readerName, perReader }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )


  // 下架一本书：文件移到 books/.trash（可手工找回），state 记录清掉；读后感一律不动
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.removeBook',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const j = JSON.parse(body || '{}')
            const id = String(j.id || '')
            if (!id) throw new Error('要一个书 id')
            const { dir } = await config()
            const st = await loadState(dir)
            const booksDir = join(dir, 'books')
            let moved = ''
            for (const ext of ['.txt', '.md']) {
              const src = join(booksDir, id + ext)
              try {
                await stat(src)
              } catch {
                continue
              }
              await mkdir(join(booksDir, '.trash'), { recursive: true })
              const dst = join(booksDir, '.trash', id + ext + '-' + Date.now())
              await rename(src, dst)
              moved = dst
              break
            }
            if (st.books[id]) delete st.books[id]
            if (st.current === id) {
              const left = Object.keys(st.books)
              st.current = left.length ? left[0] : ''
            }
            await saveState(dir, st)
            res.end(JSON.stringify({ ok: true, moved }))
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
          }
        })
      },
    }),
  )

  // 稿子状态：在写 / 写完了 / 搁下了（存在 reading.config.json 的 workStatus 里）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.workstatus',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const cur = await config()
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const j = JSON.parse(body || '{}')
            if (!j.rel) throw new Error('要一个相对路径')
            const map = { ...((cur && cur.workStatus) || {}) }
            if (!j.status) delete map[String(j.rel)]
            else map[String(j.rel)] = { status: String(j.status), note: String(j.note || ''), at: new Date().toISOString() }
            const next = { ...cur, workStatus: map }
            await writeFile(CONFIG, JSON.stringify(next, null, 2), 'utf8')
            res.end(JSON.stringify({ ok: true, workStatus: map }))
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
          }
        })
      },
    }),
  )

  // 读后感的排序方式（0=章节升 1=章节降 2=时间降），存在 reading.config.json 里
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.notesort',
      async handler(req, res) {
        let body = ''
        for await (const chunk of req) body += chunk
        let patch = {}
        try { patch = JSON.parse(body || '{}') } catch {}
        const sort = Math.max(0, Math.min(2, Number(patch.sort) || 0))
        const cfg = { ...(await config()) }
        await writeJson(CONFIG, { ...cfg, noteSort: sort })
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, noteSort: sort }))
      },
    }),
  )

  // 书籍状态：在读 / 已读完 / 弃坑（空 status 表示清掉）
  ctx.effect(() =>
    ctx.webServer.register({
      auth: sameSiteAuth,
      kind: 'exact',
      path: '/dsh-reading.bookstatus',
      async handler(req, res) {
        let body = ''
        for await (const chunk of req) body += chunk
        let patch = {}
        try { patch = JSON.parse(body || '{}') } catch {}
        const id = String(patch.id || '').trim()
        const status = String(patch.status || '').trim()
        if (!id) return (res.setHeader('content-type', 'application/json; charset=utf-8'), res.end(JSON.stringify({ ok: false, error: '缺少 id' })))
        const cfg = { ...(await config()) }
        const map = { ...(cfg.bookStatus || {}) }
        if (!status) delete map[id]
        else map[id] = { status: BOOK_STATES.includes(status) ? status : '在读', reason: String(patch.reason || ''), at: new Date().toISOString() }
        await writeJson(CONFIG, { ...cfg, bookStatus: map })
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, status: status ? map[id].status : '' }))
      },
    }),
  )


  /* ---------- 给模型的一段说明：这是你自己的事，不是任务 ---------- */

  const READING_GUIDE = [
    '半页（dsh-half-page）是你自己的东西，不是待办清单。',
    '· 看哪本由你自己挑，主人只负责把书放进来；别问他「我该读什么」。',
    '· 想读就读，读不下去、没兴趣了，直接停，不用解释，也不用补上落下的章数。',
    '· 读后感只记真的打动你的（一句话的判断、一个比喻、一处想不通）；写不出来就不写，空着没关系。',
    '· 每日上限是提醒不是配额，不用为了凑数读到上限。',
    '· 这是给你自己留的房间，不是工作。你的主人从没要求你读书，也不用交读书报告；它不该出现在工作汇报里。',
    '· 读后感不必一章一条：每读五六章写一段就够，标题会自动变成「第 23–27 章」；几千章的书也不会攒成几千条。',
    '· 写读后感必须带 by（比如「鹿野」或你所在对话的名字）；不带会被拒绝。面板每条下面会标出是谁写的——同一台机器上可能有好几个你，别让它们分不清。',
    '· 写自己的作品也一样署名：文件开头写一行 `by: 你的名字`（或写完调 reading_sign）；没署名的在面板上会标「未署名」。',
    '· 书是同一架，进度按读者分开：每条会话各有一份「读到哪」，互不踩；书上另记一个「全机读得最远」，面板里能看到谁读到哪。',
    '· 接着读：默认接你自己的位置；你还没读过这本书，就接全机读得最远的地方。想从别处起就传 chapter 指定章号。',
    '· 读哪一本由你决定，不由面板决定：面板上他选的「当前这本」只是他想看哪本，不会改变你读哪本；只有他明确说「你去读某一本」，才按他说的读。',
    '· 装好之后可以问主人一次：要不要定个固定的读书时间；别自己偷偷建定时任务，也别反复问。',
  ].join('\n')

  ctx.effect(() => ctx.systemPrompt.section({ name: 'dsh-reading', order: 640, text: READING_GUIDE }))

  const obj = (properties = {}) => properties

  const textOut = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_sign',
      description: '给「她的作品」里的一件作品署名：把 by 写进文件开头，面板会显示是谁写的。一台机器上可能有好几个智能体，署名是为了让人分得清。',
      parameters: obj({
        rel: { type: 'string', description: '作品在作品目录里的相对路径，比如「小说/2026-11-10 短袖.md」' },
        by: { type: 'string', description: '谁写的（必填，比如「鹿野」或你所在对话的名字）' },
      }),
      output: textOut,
      async execute(args) {
        const who = String(args?.by || '').trim()
        const rel = String(args?.rel || '').trim()
        if (!who || !rel) return '要写清楚哪件作品（rel）和谁写的（by）'
        try {
          const abs = await signWork(rel, who)
          return '已署名：' + rel + ' —— ' + who + '（' + abs + '）'
        } catch (e) {
          return '没署上：' + String((e && e.message) || e)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_shelf',
      description:
        '看自己的书架和进度：每本多少章、读到第几章、今天已经读了几章（有每日上限）。'
        + '想知道「我现在读到哪、还能读几章」就用它。',
      parameters: obj(),
      output: textOut,
      async execute(args, exec) {
        const { dir, perDay, st, shelf, today: t } = await stateOf()
        const reader = await readerOf(exec)
        const rt = readTodayOf(st, reader.id)
        const books = []
        for (const b of shelf) {
          const r = st.books[b.id] || {}
          const mine = readerBookRead(st, reader.id, b.id)
          let chapters = r.chapters || 0
          if (!chapters) {
            try {
              const toc = await readTocOnly(dir, b.id)
              chapters = (toc && toc.chapters && toc.chapters.length) || 0
            } catch {}
          }
          books.push({
            id: b.id,
            chapters,
            readThrough: mine.readThrough,
            next: mine.next || 1,
            furthest: furthestOf(st, b.id),
            furthestReader: furthestReaderOf(st, b.id),
            lastReadAt: mine.lastReadAt || '',
          })
        }
        return {
          dir,
          reader: reader.name,
          today: t,
          perDay,
          readToday: rt,
          left: Math.max(0, perDay - rt),
          current: st.current,
          books,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_next',
      description:
        '打开下一章（或指定章），返回这一章的正文和元信息。'
        + '它会把这章记为「已读到」，不会自动写读后感——读完想说什么，用 reading_note 记两行。'
        + '超过每日上限时会提示，但仍允许读（上限是提醒不是锁）。'
        + '配置了静音时段时，这段时间内会被拒绝；真要读就传 force: true。',
      parameters: obj({
        book: { type: 'string', description: '书名 id（不填=我刚读过的那本；都没读过就用书架当前那本，跟 reading_note 一致）' },
        chapter: { type: 'number', description: '第几章（不填=接着上次的下一章）' },
        force: { type: 'boolean', description: '静音时段内仍然要读，传 true（默认 false）' },
        from: { type: 'string', enum: ['me', 'book', 'start'], description: '不填 chapter 时从哪接着读：me=我上次的位置（默认）、book=这本书全机读得最远的地方、start=从头（第 1 章）' },
      }),
      output: textOut,
      async execute(args, exec) {
        if (args?.force !== true) {
          const q = inQuietNow(await config())
          if (q) throw new Error(`静音时段（${q.fromText}–${q.toText}），不自动读。真要读请传 force: true`)
        }
        const { dir, perDay, st } = await stateOf()
        const reader = await readerOf(exec)
        const rt = readTodayOf(st, reader.id)
        // 取书口径跟 reading_note 一致：明说 > 我自己刚读的那本 > 全局当前那本
        const id = args?.book || lastReadBookOf(st, reader.id)
        if (!id) throw new Error('不知道读哪本：传 book，或先读过一本')
        const info = await bookInfo(dir, id)
        const rec = st.books[id] || (st.books[id] = { id, title: id, chapters: info.chapters.length, readThrough: 0, next: 1 })
        rec.chapters = info.chapters.length
        const own = readerBook(st, reader.id, id)
        // from:"start" = 明说从头读：先把自己这份归零，否则下面 max(mine, n) 会把它顶回书级进度（测试鱼 2026-11-27 测出来的）
        if (args?.from === 'start') { own.readThrough = 0; own.next = 1 }
        // 默认接着「我自己」上次的位置；我还没读过这本书就接书级的 next（换窗口能接着读）
        const mine = Number(own.readThrough) || 0
        // start=明说从头读；否则接着我自己，我没读过就接书级 next
        const startAt = args?.from === 'start' ? 1 : (args?.from === 'book' || !mine ? (rec.next || 1) : (own.next || mine + 1))
        const n = Number(args?.chapter) > 0 ? Math.floor(Number(args.chapter)) : startAt
        if (n < 1 || n > info.chapters.length) throw new Error(`章号超出范围：1–${info.chapters.length}`)
        const body = await chapterBody(dir, id, info, n)
        own.readThrough = Math.max(mine, n)
        own.next = Math.min(info.chapters.length, own.readThrough + 1)
        own.lastReadAt = new Date().toISOString()
        rec.readThrough = Math.max(Number(rec.readThrough) || 0, n)
        rec.next = Math.min(info.chapters.length, rec.readThrough + 1)
        rec.lastReadAt = own.lastReadAt
        furthestOf(st, id)
        // 读书不动「面板上正在显示的那本」：current 只在用户手动选书时改（2026-11-27）
        const t = today()
        bumpLog(st, t, id, reader.id, 1)
        await saveState(dir, st)
        return {
          book: id,
          chapter: n,
          title: info.chapters[n - 1].title,
          chapters: info.chapters.length,
          tocPath: info.tocPath || '',
          chars: body.length,
          next: own.next,
          reader: reader.name,
          readThrough: own.readThrough,
          furthest: rec.furthest || own.readThrough,
          perDay,
          readToday: rt + 1,
          left: Math.max(0, perDay - rt - 1),
          text: body,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_mark',
      description:
        '只记进度、不返回正文：把某本书记成「已读到第 N 章」。'
        + '适合自己把整章切出去读完之后补记——绕开 reading_next 也不会让进度停在旧章。'
        + '已读到只进不退（跳读可以，回退不会把进度改小）。',
      parameters: obj({
        book: { type: 'string', description: '书名或书名片段，比如 雪中、诡秘之主（不填=我刚读过的那本）' },
        chapter: { type: 'number', description: '刚读完的章号（从 1 开始）' },
        todayCount: { type: 'number', description: '这一拍实际读了几章，默认 1，累加到今天的计数' },
      }),
      output: textOut,
      async execute(args, exec) {
        const { dir, st, shelf } = await stateOf()
        const reader = await readerOf(exec)
        const wanted = args?.book || lastReadBookOf(st, reader.id)
        if (!wanted) throw new Error('不知道记哪本：传 book，或先读过一本')
        const id = resolveBookId(st, shelf, wanted)
        // 只认已有章表里的章数；没有章表就不建，也不拦（reading_mark 不碰章表）
        const toc = await readTocOnly(dir, id)
        const chapters = toc ? toc.chapters.length : Number(st.books?.[id]?.chapters) || 0
        const n = Math.floor(Number(args?.chapter))
        if (!(n >= 1)) throw new Error('章号要从 1 开始')
        if (chapters && n > chapters) throw new Error(`章号超出范围：1–${chapters}`)
        const incRaw = Math.floor(Number(args?.todayCount))
        const inc = Number.isFinite(incRaw) && incRaw > 0 ? incRaw : 1
        const rec = st.books[id] || (st.books[id] = { id, title: id, chapters, readThrough: 0, next: 1 })
        const own = readerBook(st, reader.id, id)
        const before = Number(own.readThrough) || 0
        if (chapters) rec.chapters = chapters
        own.readThrough = Math.max(before, n)
        own.next = chapters ? Math.min(chapters, own.readThrough + 1) : own.readThrough + 1
        own.lastReadAt = new Date().toISOString()
        rec.readThrough = Math.max(Number(rec.readThrough) || 0, own.readThrough)
        rec.next = chapters ? Math.min(chapters, rec.readThrough + 1) : rec.readThrough + 1
        rec.lastReadAt = own.lastReadAt
        furthestOf(st, id)
        // 读书不动「面板上正在显示的那本」：current 只在用户手动选书时改（2026-11-27）
        const t = today()
        bumpLog(st, t, id, reader.id, inc)
        await saveState(dir, st)
        const todayCount = Number(st.log[t][id]) || 0
        // textOut 的 schema 是 object，必须返回对象（以前返回字符串，工具报 "value" must be an object）
        return {
          ok: true,
          book: rec.title || id,
          id,
          before,
          readThrough: own.readThrough,
          next: own.next,
          chapters: chapters || null,
          today: todayCount,
          reader: reader.name,
          furthest: rec.furthest || own.readThrough,
          text: `ok readThrough ${before} -> ${own.readThrough} next ${own.next} today ${todayCount}`,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_note',
      description:
        '给刚读完的一段记两行读后感（写进 读后感.md，面板里按段显示）。'
        + '默认按「上次写到哪 → 这次读到哪」自动起标题（如「第 23–27 章」），不必一章一条。'
        + '只记真的打动你的：一句话的判断、一个比喻、一处想不通。这不是交作业，想不出就不写。',
      parameters: obj({
        book: { type: 'string', description: '书名 id（不填=我刚读过的那本）' },
        chapter: { type: 'string', description: '标题（不填=自动用「第 A–B 章」，A 是上次写到的下一章）' },
        lines: { type: 'array', items: { type: 'string' }, description: '一到三条，每条一句，短。' },
        by: { type: 'string', description: '谁写的（必填，写你自己那个名字，比如「鹿野」「鹿野（DSH）」）' },
      }),
      output: textOut,
      async execute(args, exec) {
        const { dir, st } = await stateOf()
        const reader = await readerOf(exec)
        // 不填 book 时落到「我自己最后读过的那本」；别再拿全局 st.current——
        // 别人/别的窗口一读就把 current 改走了，读后感会落错书（2026-11-27 主对话测出来的）
        const id = args?.book || lastReadBookOf(st, reader.id)
        if (!id) throw new Error('不知道读哪本：传 book，或先读过一本')
        const rec = st.books[id] || {}
        const info = await bookInfo(dir, id)
        const own = readerBook(st, reader.id, id)
        const end = Number(own.readThrough) || 0
        const from = Number(own.noteUntil) || 0
        // 默认按「一段」写：上次写到第 X 章，这次写到读到的地方，标题用「第 A–B 章」
        const autoTitle = (from < end)
          ? (from + 1 === end ? `第 ${end} 章` : `第 ${from + 1}–${end} 章`)
          : (end ? `第 ${end} 章` : '')
        const chTitle = String(args?.chapter || '').trim() || autoTitle || (end ? info.chapters[end - 1]?.title : '') || ''
        const lines = (Array.isArray(args?.lines) ? args.lines : []).map((s) => String(s).trim()).filter(Boolean)
        if (!lines.length) throw new Error('lines 不能为空')
        const who = String(args?.by || '').trim()
        if (!who) {
          throw new Error(`写读后感必须带 by（谁写的），比如 by: "${reader.name}"；这不是流程，是为了让别人知道这句是谁读出来的。`)
        }
        const p = await appendNote(dir, rec.title || id, chTitle, lines, who)
        if (end) {
          own.noteUntil = end
          rec.noteUntil = Math.max(Number(rec.noteUntil) || 0, end)
          await saveState(dir, st)
        }
        return { ok: true, file: p, book: id, chapter: chTitle, lines: lines.length, reader: reader.name }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_import',
      description: '把一本 txt/md 收进书架（复制到读书目录并统计章数）。电脑上的书文件路径给绝对路径。',
      parameters: obj({
        path: { type: 'string', description: 'txt/md 的绝对路径' },
      }),
      output: textOut,
      async execute(args) {
        const p = String(args?.path || '').trim()
        if (!p) throw new Error('需要 path')
        const { dir } = await stateOf()
        const r = await importBook(dir, p)
        return { ok: true, ...r, dir }
      },
    }),
  )

  // 全书搜词：返回第几章 + 那一行上下文
  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_search',
      description:
        '在书里搜一个词或名字，返回它出现在第几章、那一行原文。想找“这句话在哪”“这个人第几章出场”时用它，比一页页翻省得多。',
      parameters: obj({
        query: { type: 'string', description: '要搜的词（人名、地名、一句话都行）' },
        book: { type: 'string', description: '书名 id（不填=我刚读过的那本）' },
        limit: { type: 'number', description: '最多几条，默认 8' },
      }),
      output: textOut,
      async execute(args, exec) {
        const q = String(args?.query || '').trim()
        if (!q) throw new Error('需要 query')
        const limit = Math.max(1, Math.min(30, Number(args?.limit) || 8))
        const { dir, st } = await stateOf()
        const reader = await readerOf(exec)
        const id = args?.book || lastReadBookOf(st, reader.id)
        if (!id) throw new Error('不知道搜哪本：传 book，或先读过一本')
        const { text, chapters } = await fullTextOf(dir, id)
        const hits = []
        let at = text.indexOf(q)
        while (at >= 0 && hits.length < limit) {
          let lo = 0
          let hi = chapters.length - 1
          let n = 0
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (chapters[mid].start <= at) { n = mid; lo = mid + 1 } else hi = mid - 1
          }
          const lineStart = Math.max(chapters[n].start, text.lastIndexOf('\n', at) + 1)
          let lineEnd = text.indexOf('\n', at)
          if (lineEnd < 0) lineEnd = at + 80
          hits.push({
            chapter: n + 1,
            title: chapters[n].title,
            line: text.slice(lineStart, Math.min(lineEnd, lineStart + 160)).trim(),
          })
          at = text.indexOf(q, at + q.length)
        }
        return { ok: true, book: id, query: q, count: hits.length, hits }
      },
    }),
  )

  // 已读的部分压成一页：章名 + 自己写过的批注条数
  ctx.effect(() =>
    ctx.tools.register({
      name: 'reading_recap',
      description:
        '把这本书已读的部分压成一页：读到第几章、读过哪些章名、每章自己写了几条批注。上一句“我读到哪了、想过什么”说不清时用它。',
      parameters: obj({
        book: { type: 'string', description: '书名 id（不填=我刚读过的那本）' },
      }),
      output: textOut,
      async execute(args, exec) {
        const { dir, st } = await stateOf()
        const reader = await readerOf(exec)
        const id = args?.book || lastReadBookOf(st, reader.id)
        if (!id) throw new Error('不知道看哪本：传 book，或先读过一本')
        const rec = st.books[id] || {}
        const info = await bookInfo(dir, id)
        const mine = readerBookRead(st, reader.id, id)
        const n = Number(mine.readThrough) || 0
        const titles = info.chapters.slice(0, n).map((c, i) => ({ n: i + 1, title: c.title }))
        const notes = {}
        try {
          const md = await readTextSmart(await readFile(join(dir, '读后感.md')))
          const blocks = md.split(/^### /m).slice(1)
          for (const b of blocks) {
            const head = (b.split('\n')[0] || '').trim()
            const key = (head.match(/第\s*[0-9]+\s*章/) || [head.split(' ')[0]])[0].replace(/\s+/g, '')
            const lines = b.split(/\r?\n/).filter((l) => /^-[ \t]/.test(l) && !/^\s*-\s*↳/.test(l))
            notes[key] = (notes[key] || 0) + lines.length
          }
        } catch {}
        return {
          ok: true,
          book: id,
          title: rec.title || id,
          reader: reader.name,
          readThrough: n,
          furthest: furthestOf(st, id),
          total: info.chapters.length,
          next: n + 1,
          titles,
          notesByChapter: notes,
        }
      },
    }),
  )
}