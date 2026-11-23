// dsh-half-page · 半页（自己的读书与写字）
// 宿主侧：书库、切章、读后感、进度；客户端面板读 HTTP 路由。
import { readFile, writeFile, mkdir, readdir, stat, rename, open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, basename, dirname, extname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'tools', 'systemPrompt']

const HOME = process.env.USERPROFILE || process.env.HOME || homedir()
const CONFIG = join(HOME, '.dsh', 'reading.config.json')
const DEFAULT_DIR = join(HOME, '.dsh', 'reading')

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

export async function config() {
  try {
    const raw = await readFile(CONFIG, 'utf8')
    const c = JSON.parse(stripBom(raw)) || {}
    return { ...c, dir: c.dir || DEFAULT_DIR, perDay: Number(c.perDay) > 0 ? Number(c.perDay) : 3 }
  } catch {
    return { dir: DEFAULT_DIR, perDay: 3 }
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

/** 在 root 下递归找图（跳过 archive 一类目录），按 mtime 倒序 */
export async function scanImages(root, kind) {
  const out = []
  const walk = async (p, rel) => {
    let list = []
    try { list = await readdir(p, { withFileTypes: true }) } catch { return }
    for (const d of list) {
      if (d.name.startsWith('.')) continue
      const abs = join(p, d.name)
      const r = rel ? rel + '/' + d.name : d.name
      if (d.isDirectory()) {
        if (IMAGE_SKIP_DIRS.has(d.name.toLowerCase())) continue
        await walk(abs, r)
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
  await walk(root, '')
  return out
}

/** 允许给浏览器读的图片根：作品目录 + 同级/配置里的 art */
export async function imageRoots(worksDir) {
  const roots = [resolve(worksDir)]
  const cfg = await config()
  const cands = [cfg.artDir, join(dirname(dirname(resolve(worksDir))), 'art'), join(homedir(), 'dsh work', 'art')]
  for (const p of cands) {
    if (!p) continue
    try {
      const s = await stat(p)
      if (s.isDirectory()) { roots.push(resolve(p)); break }
    } catch {}
  }
  return roots
}

/* ---------------- HTTP 与工具 ---------------- */

export function apply(ctx) {
  const stateOf = async () => {
    const { dir, perDay } = await config()
    await ensureDir(dir)
    const st = await loadState(dir)
    const shelf = await listBooks(dir)
    return { dir, perDay, st, shelf, today: today(), readToday: readToday(st) }
  }

  // 面板读取
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-reading.state',
      async handler(req, res) {
        const { dir, perDay, st, shelf, readToday: rt } = await stateOf()
        const cfgNow = await config()
        const books = shelf.map((b) => {
          const rec = st.books[b.id] || {}
          return {
            id: b.id,
            title: rec.title || b.id,
            size: b.size,
            mtime: b.mtime,
            chapters: rec.chapters || 0,
            readThrough: rec.readThrough || 0,
            next: rec.next || 1,
            lastReadAt: rec.lastReadAt || '',
            current: st.current === b.id,
            status: bookStatusOf(cfgNow, b.id),
          }
        })
        let notes = ''
        try { notes = await readFile(await notesPath(dir), 'utf8') } catch {}
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, dir, perDay, today: today(), readToday: rt, current: st.current, books, notes, noteSort: Number(cfgNow.noteSort) || 0 }))
      },
    }),
  )

  // 把某本设为「正在读」
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-reading.setCurrent',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        const id = url.searchParams.get('id') || ''
        const { dir, st } = await stateOf()
        if (st.books[id]) { st.current = id; await saveState(dir, st) }
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: !!st.books[id], current: st.current }))
      },
    }),
  )

  // 面板里直接读一章（不记账）
  ctx.effect(() =>
    ctx.webServer.register({
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
          const rec = st.books[id] || {}
          const ch = n > 0 ? Math.min(Math.max(1, n), info.chapters.length) : (rec.readThrough || 1)
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
      kind: 'exact',
      path: '/dsh-reading.advance',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        const { dir, st, perDay, readToday: rt } = await stateOf()
        const id = url.searchParams.get('book') || st.current
        const rec = st.books[id]
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (!rec) return res.end(JSON.stringify({ ok: false, error: '没有这本书' }))
        const info = await bookInfo(dir, id)
        const n = Math.min(info.chapters.length, (rec.readThrough || 0) + 1)
        rec.readThrough = n
        rec.next = Math.min(info.chapters.length, n + 1)
        rec.lastReadAt = new Date().toISOString()
        const t = today()
        st.log = st.log || {}
        st.log[t] = st.log[t] || {}
        st.log[t][id] = (Number(st.log[t][id]) || 0) + 1
        await saveState(dir, st)
        res.end(JSON.stringify({ ok: true, chapter: n, total: info.chapters.length, readToday: rt + 1, perDay, left: Math.max(0, perDay - rt - 1) }))
      },
    }),
  )

  // 面板里点「退一章」：退回上一章（手滑多点了一下能救回来）
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-reading.back',
      async handler(req, res) {
        const url = new URL(req.url, 'http://x')
        const { dir, st } = await stateOf()
        const id = url.searchParams.get('book') || st.current
        const rec = st.books[id]
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (!rec) return res.end(JSON.stringify({ ok: false, error: '没有这本书' }))
        const cur = Number(rec.readThrough) || 0
        if (cur <= 1) return res.end(JSON.stringify({ ok: false, error: '已经在第 1 章了，退不动' }))
        const n = cur - 1
        rec.readThrough = n
        rec.next = n + 1
        rec.lastReadAt = new Date().toISOString()
        // 顺手把今天的计数退掉一格，免得「今天读了 21 章」虚高
        const t = today()
        if (st.log && st.log[t] && Number(st.log[t][id]) > 0) st.log[t][id] = Number(st.log[t][id]) - 1
        await saveState(dir, st)
        const info = await bookInfo(dir, id)
        res.end(JSON.stringify({ ok: true, chapter: n, total: info.chapters.length }))
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
  let raw = await readFile(abs, 'utf8')
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
        for (const r of roots) images = images.concat(await scanImages(r, r === resolve(root) ? 'works' : 'art'))
        images.sort((a, b) => b.mtime.localeCompare(a.mtime))
        res.end(JSON.stringify({ ok: true, root, roots, files: out, images }))
      },
    }),
  )

  // 给面板读一张图（限制在上面那几个根里）
  ctx.effect(() =>
    ctx.webServer.register({
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
      kind: 'exact',
      path: '/dsh-reading.recent',
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        try {
          const { dir } = await config()
          let st = {}
          try { st = JSON.parse(stripBom(await readFile(join(dir, 'state.json'), 'utf8'))) || {} } catch {}
          const now = Date.now()
          const key = (t) => {
            const d = new Date(t)
            return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
          }
          const today = key(now)
          const log = st.log || {}
          const cur = (st.books && st.current && st.books[st.current]) || null
          const todayCh = (log[today] && log[today][st.current]) || 0
          const lastRead = cur && cur.lastReadAt ? Date.parse(cur.lastReadAt) : 0
          const hoursAgo = lastRead ? Math.max(0, Math.round((now - lastRead) / 3600000)) : -1

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
          if (todayCh > 0) status = '今天在《' + (st.current || '') + '》翻了 ' + todayCh + ' 章，读到第 ' + ((cur && cur.readThrough) || 0) + ' 章。'
          else if (hoursAgo >= 0 && hoursAgo <= 48) status = '上次翻书是 ' + hoursAgo + ' 小时前。'
          else if (hoursAgo > 48) status = '这两天没翻书。'
          if (top) {
            if (top.days === 0) status += '今天还动过笔，写《' + top.name + '》。'
            else if (top.days === 1) status += '昨天动过笔，写《' + top.name + '》。'
            else status += '上次动笔是 ' + top.days + ' 天前的《' + top.name + '》。'
          }
          let mood = ''
          if (todayCh >= 12) mood = '翻书翻得犯困'
          else if (todayCh > 0) mood = works.some((w) => w.days === 0) ? '手痒，想写点东西' : '平静'
          else if (hoursAgo < 0 || hoursAgo > 48) mood = '有点闷'
          else mood = '没什么兴致'
          res.end(JSON.stringify({ ok: true, mood, status, today, todayChapters: todayCh, current: st.current || '', readThrough: (cur && cur.readThrough) || 0, hoursAgo, days, works: works.slice(0, 5) }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )


  // 下架一本书：文件移到 books/.trash（可手工找回），state 记录清掉；读后感一律不动
  ctx.effect(() =>
    ctx.webServer.register({
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
    '· 书和进度是这台机器共用的（一个家一个书房），不分谁在读；只有读后感会标署名。',
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
        const abs = await signWork(rel, who)
        return '已署名：' + rel + ' —— ' + who + '（' + abs + '）'
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
      async execute() {
        const { dir, perDay, st, shelf, readToday: rt, today: t } = await stateOf()
        return {
          dir,
          today: t,
          perDay,
          readToday: rt,
          left: Math.max(0, perDay - rt),
          current: st.current,
          books: shelf.map((b) => {
            const r = st.books[b.id] || {}
            return { id: b.id, chapters: r.chapters || 0, readThrough: r.readThrough || 0, next: r.next || 1, lastReadAt: r.lastReadAt || '' }
          }),
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
        + '超过每日上限时会提示，但仍允许读（上限是提醒不是锁）。',
      parameters: obj({
        book: { type: 'string', description: '书名 id（不填=当前正在读的那本）' },
        chapter: { type: 'number', description: '第几章（不填=接着上次的下一章）' },
      }),
      output: textOut,
      async execute(args) {
        const { dir, perDay, st, readToday: rt } = await stateOf()
        const id = args?.book || st.current
        if (!id) throw new Error('书架是空的：先用 reading_import 导入一本 txt')
        const info = await bookInfo(dir, id)
        const rec = st.books[id] || (st.books[id] = { id, title: id, chapters: info.chapters.length, readThrough: 0, next: 1 })
        rec.chapters = info.chapters.length
        const n = Number(args?.chapter) > 0 ? Math.floor(Number(args.chapter)) : rec.next || 1
        if (n < 1 || n > info.chapters.length) throw new Error(`章号超出范围：1–${info.chapters.length}`)
        const body = await chapterBody(dir, id, info, n)
        rec.readThrough = Math.max(rec.readThrough || 0, n)
        rec.next = Math.min(info.chapters.length, n + 1)
        rec.lastReadAt = new Date().toISOString()
        st.current = id
        const t = today()
        st.log = st.log || {}
        st.log[t] = st.log[t] || {}
        st.log[t][id] = (Number(st.log[t][id]) || 0) + 1
        await saveState(dir, st)
        return {
          book: id,
          chapter: n,
          title: info.chapters[n - 1].title,
          chapters: info.chapters.length,
          tocPath: info.tocPath || '',
          chars: body.length,
          next: rec.next,
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
        book: { type: 'string', description: '书名或书名片段，比如 雪中、诡秘之主、古文观止' },
        chapter: { type: 'number', description: '刚读完的章号（从 1 开始）' },
        todayCount: { type: 'number', description: '这一拍实际读了几章，默认 1，累加到今天的计数' },
      }),
      output: textOut,
      async execute(args) {
        const { dir, st, shelf } = await stateOf()
        const id = resolveBookId(st, shelf, args?.book)
        // 只认已有章表里的章数；没有章表就不建，也不拦（reading_mark 不碰章表）
        const toc = await readTocOnly(dir, id)
        const chapters = toc ? toc.chapters.length : Number(st.books?.[id]?.chapters) || 0
        const n = Math.floor(Number(args?.chapter))
        if (!(n >= 1)) throw new Error('章号要从 1 开始')
        if (chapters && n > chapters) throw new Error(`章号超出范围：1–${chapters}`)
        const incRaw = Math.floor(Number(args?.todayCount))
        const inc = Number.isFinite(incRaw) && incRaw > 0 ? incRaw : 1
        const rec = st.books[id] || (st.books[id] = { id, title: id, chapters, readThrough: 0, next: 1 })
        const before = Number(rec.readThrough) || 0
        if (chapters) rec.chapters = chapters
        rec.readThrough = Math.max(before, n)
        rec.next = chapters ? Math.min(chapters, rec.readThrough + 1) : rec.readThrough + 1
        rec.lastReadAt = new Date().toISOString()
        st.current = id
        const t = today()
        st.log = st.log || {}
        st.log[t] = st.log[t] || {}
        st.log[t][id] = (Number(st.log[t][id]) || 0) + inc
        await saveState(dir, st)
        return `ok readThrough ${before} -> ${rec.readThrough} next ${rec.next} today ${st.log[t][id] || 0}`
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
        book: { type: 'string', description: '书名 id（不填=当前这本）' },
        chapter: { type: 'string', description: '标题（不填=自动用「第 A–B 章」，A 是上次写到的下一章）' },
        lines: { type: 'array', items: { type: 'string' }, description: '一到三条，每条一句，短。' },
        by: { type: 'string', description: '谁写的（必填，比如「鹿野」或你所在对话的名字）' },
      }),
      output: textOut,
      async execute(args) {
        const { dir, st } = await stateOf()
        const id = args?.book || st.current
        if (!id) throw new Error('还没有正在读的书')
        const rec = st.books[id] || {}
        const info = await bookInfo(dir, id)
        const end = Number(rec.readThrough) || 0
        const from = Number(rec.noteUntil) || 0
        // 默认按「一段」写：上次写到第 X 章，这次写到读到的地方，标题用「第 A–B 章」
        const autoTitle = (from < end)
          ? (from + 1 === end ? `第 ${end} 章` : `第 ${from + 1}–${end} 章`)
          : (end ? `第 ${end} 章` : '')
        const chTitle = String(args?.chapter || '').trim() || autoTitle || (end ? info.chapters[end - 1]?.title : '') || ''
        const lines = (Array.isArray(args?.lines) ? args.lines : []).map((s) => String(s).trim()).filter(Boolean)
        if (!lines.length) throw new Error('lines 不能为空')
        const who = String(args?.by || '').trim()
        if (!who) {
          throw new Error('写读后感必须带 by（谁写的），比如 by: "鹿野"；这不是流程，是为了让别人知道这句是谁读出来的。')
        }
        const p = await appendNote(dir, rec.title || id, chTitle, lines, who)
        if (end) {
          st.books[id] = { ...rec, noteUntil: end }
          await saveState(dir, st)
        }
        return { ok: true, file: p, book: id, chapter: chTitle, lines: lines.length }
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
        book: { type: 'string', description: '书名 id（不填=当前这本）' },
        limit: { type: 'number', description: '最多几条，默认 8' },
      }),
      output: textOut,
      async execute(args) {
        const q = String(args?.query || '').trim()
        if (!q) throw new Error('需要 query')
        const limit = Math.max(1, Math.min(30, Number(args?.limit) || 8))
        const { dir, st } = await stateOf()
        const id = args?.book || st.current
        if (!id) throw new Error('还没有正在读的书')
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
        book: { type: 'string', description: '书名 id（不填=当前这本）' },
      }),
      output: textOut,
      async execute(args) {
        const { dir, st } = await stateOf()
        const id = args?.book || st.current
        if (!id) throw new Error('还没有正在读的书')
        const rec = st.books[id] || {}
        const info = await bookInfo(dir, id)
        const n = Number(rec.readThrough) || 0
        const titles = info.chapters.slice(0, n).map((c, i) => ({ n: i + 1, title: c.title }))
        const notes = {}
        try {
          const md = await readTextSmart(await readFile(join(dir, '读后感.md')))
          const blocks = md.split(/^### /m).slice(1)
          for (const b of blocks) {
            const head = (b.split('\n')[0] || '').trim()
            const key = (head.match(/第[0-9]+章/) || [head.split(' ')[0]])[0]
            notes[key] = (notes[key] || 0) + (b.match(/^-[ \t]/gm) || []).length
          }
        } catch {}
        return {
          ok: true,
          book: id,
          title: rec.title || id,
          readThrough: n,
          total: info.chapters.length,
          next: n + 1,
          titles,
          notesByChapter: notes,
        }
      },
    }),
  )
}
