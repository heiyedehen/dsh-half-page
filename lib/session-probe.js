/**
 * session-probe —— 只回答三个时间：他最后说话、我最后回话、最后一条 notice。
 *
 * 为什么不用会话文件的 mtime：日志每轮都在写（系统注入、汇报都算），mtime 永远是新的。
 * 为什么事件里没有 source：真正落盘的 `user/message` 不带 source，来源只活在
 * `agent/inbox/spliced` 的 inserted[].source 里 —— notice 就是靠这个认的。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME = [0x28, 0xb5, 0x2f, 0xfd]
const NOTICE_KINDS = new Set(['heartbeat', 'dsh-half-page', 'schedule', 'dsh-heartbeat'])

/** 多帧 zstd：按魔数切开逐帧解，再拼起来。只解第一帧会漏掉 99% 的内容。 */
export function decodeLog(buffer, options = {}) {
  const frames = []
  let start = -1
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === FRAME[0] && buffer[i + 1] === FRAME[1] && buffer[i + 2] === FRAME[2] && buffer[i + 3] === FRAME[3]) {
      if (start >= 0) frames.push(buffer.subarray(start, i))
      start = i
    }
  }
  if (start >= 0) frames.push(buffer.subarray(start))
  if (frames.length === 0) return ''
  const limit = Number.isInteger(options.maxFrames) && options.maxFrames > 0 ? options.maxFrames : frames.length
  const parts = []
  for (const frame of frames.slice(-limit)) {
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // 坏帧跳过，别整份报废
    }
  }
  return parts.join('')
}

export function parseEvents(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object') out.push(event)
    } catch {
      // 半行/坏行跳过
    }
  }
  return out
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/** 会话目录名跟 cwd 编码有关，不猜：直接按 <sid>/session.v4.jsonl.zstd 找。 */
export async function findSessionLog(sessionsRoot, sessionId) {
  let dirs
  try {
    dirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue
    const candidate = join(sessionsRoot, dirent.name, String(sessionId), 'session.v4.jsonl.zstd')
    try {
      await stat(candidate)
      return candidate
    } catch {
      // 下一个
    }
  }
  return null
}

/** 最近被人写过日志的会话（不猜目录名，按文件 mtime 取最新） */
export async function newestSessionId(sessionsRoot) {
  let dirs
  try {
    dirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return ''
  }
  let best = null
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue
    const project = join(sessionsRoot, dirent.name)
    let subs
    try {
      subs = await readdir(project, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const file = join(project, sub.name, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(file)
        if (!best || info.mtimeMs > best.mtimeMs) best = { sessionId: sub.name, mtimeMs: info.mtimeMs }
      } catch {
        // 没日志的会话跳过
      }
    }
  }
  return best ? best.sessionId : ''
}

function noticeAt(event) {
  if (event?.type !== 'agent/inbox/spliced') return null
  const inserted = event.data?.inserted
  if (!Array.isArray(inserted)) return null
  for (const item of inserted) {
    const source = item?.source
    if (!source) continue
    if (source.form === 'notice') return Number(event.time) || null
    if (typeof source.kind === 'string' && NOTICE_KINDS.has(source.kind)) return Number(event.time) || null
  }
  return null
}

export function pickTimeline(events) {
  let lastUserAt = null
  let lastAssistantAt = null
  let lastNoticeAt = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (lastUserAt !== null && lastAssistantAt !== null && lastNoticeAt !== null) break
    const event = events[i]
    const at = Number(event?.time) || null
    if (!at) continue
    if (lastNoticeAt === null) {
      const notice = noticeAt(event)
      if (notice) lastNoticeAt = notice
    }
    if (lastAssistantAt === null && event.type === 'assistant/message') lastAssistantAt = at
    if (lastUserAt === null && event.type === 'user/message' && textOfContent(event.data?.content).trim()) lastUserAt = at
  }
  return { lastUserAt, lastAssistantAt, lastNoticeAt }
}

/** 大日志先只解最后几百帧；什么都没读到再全量解一次 */
export async function readTimeline(sessionsRoot, sessionId, options = {}) {
  const file = await findSessionLog(sessionsRoot, sessionId)
  if (!file) return { ok: false, error: 'no_log' }
  let buffer
  try {
    buffer = await readFile(file)
  } catch (error) {
    return { ok: false, error: String(error?.code || error?.message || error) }
  }
  const tail = Number.isInteger(options.tailFrames) ? options.tailFrames : 400
  let events = parseEvents(decodeLog(buffer, { maxFrames: tail }))
  let timeline = pickTimeline(events)
  if (timeline.lastUserAt === null && timeline.lastAssistantAt === null) {
    events = parseEvents(decodeLog(buffer))
    timeline = pickTimeline(events)
  }
  return { ok: true, sessionFile: file, events: events.length, ...timeline }
}
