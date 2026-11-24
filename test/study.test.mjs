// 书房时间：纯逻辑 + 会话日志读数
// 跑法：cd test && ELECTRON_RUN_AS_NODE=1 "D:/deepseek/DeepSeek Harness.exe" --test study.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  studyWindowOf, inStudyWindow, weekKeyOf, studyStateOf, readSomethingToday,
  studyPerWeekOf, studyPerDayOf, studyModeOf, decideStudy, STUDY_TEXT,
} from '../index.js'
import { readTimeline } from '../lib/session-probe.js'

const at = (h, m = 0) => new Date(2026, 10, 24, h, m, 0).getTime() // 2026-11-24 本地

function cfgOf(extra = {}) {
  return { studyEnabled: true, studyFrom: '22:00', studyTo: '23:00', studyPerWeek: 3, ...extra }
}

function studyOf(extra = {}) {
  return { lastAt: 0, week: weekKeyOf(at(12)), weekCount: 0, ...extra }
}

function timelineOf(extra = {}) {
  return { ok: true, lastUserAt: at(21, 0), lastAssistantAt: at(21, 1), lastNoticeAt: 0, ...extra }
}

test('时段：合法/非法/跨夜', () => {
  assert.deepEqual(studyWindowOf(cfgOf()), { from: 22 * 60, to: 23 * 60 })
  assert.equal(studyWindowOf(cfgOf({ studyFrom: '' })), null)
  assert.equal(studyWindowOf(cfgOf({ studyFrom: 'abc' })), null)
  assert.equal(studyWindowOf(cfgOf({ studyFrom: '25:00' })), null)
  assert.equal(studyWindowOf(cfgOf({ studyFrom: '22:60' })), null)
  assert.equal(studyWindowOf(cfgOf({ studyFrom: '22:00', studyTo: '22:00' })), null)
  assert.equal(studyWindowOf(null), null)
})

test('跨夜：23:30 在、01:00 在、12:00 不在、边界', () => {
  const w = studyWindowOf(cfgOf({ studyFrom: '23:00', studyTo: '02:00' }))
  assert.equal(inStudyWindow(w, new Date(at(23, 30))), true)
  assert.equal(inStudyWindow(w, new Date(at(1, 0))), true)
  assert.equal(inStudyWindow(w, new Date(at(12, 0))), false)
  assert.equal(inStudyWindow(w, new Date(at(23, 0))), true)
  assert.equal(inStudyWindow(w, new Date(at(2, 0))), false)
})

test('普通时段 [from,to)', () => {
  const w = studyWindowOf(cfgOf({ studyFrom: '22:00', studyTo: '23:00' }))
  assert.equal(inStudyWindow(w, new Date(at(22, 0))), true)
  assert.equal(inStudyWindow(w, new Date(at(22, 59))), true)
  assert.equal(inStudyWindow(w, new Date(at(23, 0))), false)
  assert.equal(inStudyWindow(w, new Date(at(12, 0))), false)
  assert.equal(inStudyWindow(null, new Date(at(22, 30))), false)
})

test('每周次数：默认 3、夹在 1–7', () => {
  assert.equal(studyPerWeekOf({}), 3)
  assert.equal(studyPerWeekOf({ studyPerWeek: 0 }), 1)
  assert.equal(studyPerWeekOf({ studyPerWeek: 9 }), 7)
  assert.equal(studyPerWeekOf({ studyPerWeek: 'x' }), 3)
  assert.equal(studyPerWeekOf({ studyPerWeek: 5 }), 5)
})

test('计数：同周保留、跨周归零', () => {
  const week = weekKeyOf(at(12))
  const same = studyStateOf({ study: { lastAt: at(22, 30), week, weekCount: 2 } }, at(12))
  assert.equal(same.weekCount, 2)
  assert.equal(same.lastAt, at(22, 30))
  const next = studyStateOf({ study: { lastAt: at(22, 30), week: '2020-W01', weekCount: 5 } }, at(12))
  assert.equal(next.weekCount, 0)
})

test('今天读过没有：看 lastReadAt 的本地日期', () => {
  assert.equal(readSomethingToday({ books: { a: { lastReadAt: new Date(at(9, 5)).toISOString() } } }, at(22, 0)), true)
  assert.equal(readSomethingToday({ books: { a: { lastReadAt: new Date(at(9, 5) - 86400000).toISOString() } } }, at(22, 0)), false)
  assert.equal(readSomethingToday({ books: {} }, at(22, 0)), false)
  assert.equal(readSomethingToday({}, at(22, 0)), false)
  assert.equal(readSomethingToday({ books: { a: { lastReadAt: '坏的' } } }, at(22, 0)), false)
})

test('判定：默认关，永不投', () => {
  const v = decideStudy({ cfg: { studyEnabled: false }, study: studyOf(), now: at(22, 30), timeline: timelineOf() })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'off')
})

test('判定：全满足才投', () => {
  const v = decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(22, 30), timeline: timelineOf() })
  assert.deepEqual(v, { ok: true, reason: 'ok' })
})

test('判定：当天已叫过 / 本周用完 / 不在时段', () => {
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf({ lastAt: at(22, 10) }), now: at(22, 30), timeline: timelineOf() }).reason, 'today-called')
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf({ weekCount: 3 }), now: at(22, 30), timeline: timelineOf() }).reason, 'week-budget')
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(12, 0), timeline: timelineOf() }).reason, 'outside')
  assert.equal(decideStudy({ cfg: cfgOf({ studyFrom: 'x', studyTo: 'y' }), study: studyOf(), now: at(22, 30), timeline: timelineOf() }).reason, 'no-window')
})

test('判定：他刚说话 / 还没回 / 10 分钟内有 notice / 读不到日志', () => {
  const soon = { ok: true, lastUserAt: at(22, 28), lastAssistantAt: at(22, 29), lastNoticeAt: 0 }
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(22, 30), timeline: soon }).reason, 'too-soon')
  const unanswered = { ok: true, lastUserAt: at(21, 50), lastAssistantAt: at(21, 40), lastNoticeAt: 0 }
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(22, 30), timeline: unanswered }).reason, 'unanswered')
  const noticed = { ok: true, lastUserAt: at(21, 0), lastAssistantAt: at(21, 1), lastNoticeAt: at(22, 25) }
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(22, 30), timeline: noticed }).reason, 'recent-notice')
  const oldNotice = { ok: true, lastUserAt: at(21, 0), lastAssistantAt: at(21, 1), lastNoticeAt: at(22, 0) }
  assert.equal(decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(22, 30), timeline: oldNotice }).ok, true)
  assert.match(decideStudy({ cfg: cfgOf(), study: studyOf(), now: at(22, 30), timeline: { ok: false, error: 'no_log' } }).reason, /no-log/)
})

test('判定：脏输入不崩', () => {
  assert.doesNotThrow(() => decideStudy({ cfg: null, study: {}, now: at(22, 30), timeline: null }))
  assert.equal(decideStudy({ cfg: {}, study: null, now: at(22, 30), timeline: null }).ok, false)
  assert.equal(decideStudy({ cfg: cfgOf(), study: { weekCount: 'x' }, now: at(22, 30), timeline: {} }).ok, false)
})

test('话术：只有那一句', () => {
  assert.equal(STUDY_TEXT, '书房时间到了。读不读随你。')
})

/* ---------------- 会话日志读数 ---------------- */

function writeLog(root, sessionId, events, project = '--D-dsh~0020work--') {
  mkdirSync(join(root, project, sessionId), { recursive: true })
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  // 故意切成两帧，模拟真实的多帧 zstd
  const mid = Math.floor(events.length / 2)
  const a = events.slice(0, mid).map((e) => JSON.stringify(e)).join('\n') + '\n'
  const b = events.slice(mid).map((e) => JSON.stringify(e)).join('\n')
  writeFileSync(join(root, project, sessionId, 'session.v4.jsonl.zstd'), Buffer.concat([zstdCompressSync(Buffer.from(a)), zstdCompressSync(Buffer.from(b))]))
  return text
}

test('日志：读出最后一条 user / assistant / notice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'halfpage-study-'))
  const sid = 'session-test-1'
  writeLog(root, sid, [
    { type: 'session', time: at(20, 0) },
    { type: 'user/message', time: at(21, 0), data: { content: [{ type: 'text', text: '在吗' }] } },
    { type: 'assistant/message', time: at(21, 1), data: { message: { content: [] } } },
    { type: 'agent/inbox/spliced', time: at(21, 30), data: { inserted: [{ content: [{ type: 'text', text: '到点了。' }], source: { kind: 'heartbeat', form: 'notice' } }] } },
    { type: 'user/message', time: at(21, 40), data: { content: [{ type: 'text', text: '收到' }] } },
    { type: 'assistant/message', time: at(21, 45), data: { message: { content: [] } } },
  ])
  const tl = await readTimeline(root, sid)
  assert.equal(tl.ok, true)
  assert.equal(tl.lastUserAt, at(21, 40))
  assert.equal(tl.lastAssistantAt, at(21, 45))
  assert.equal(tl.lastNoticeAt, at(21, 30))
})

test('日志：没有日志/坏帧不崩', async () => {
  const root = mkdtempSync(join(tmpdir(), 'halfpage-study2-'))
  const none = await readTimeline(root, 'session-missing')
  assert.equal(none.ok, false)
  assert.equal(none.error, 'no_log')
  mkdirSync(join(root, 'p', 'session-bad'), { recursive: true })
  writeFileSync(join(root, 'p', 'session-bad', 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'))
  const bad = await readTimeline(root, 'session-bad')
  assert.equal(bad.ok, true)
  assert.equal(bad.lastUserAt, null)
})

test('每天模式：按今天次数算，跨天归零', () => {
  const cfg = cfgOf({ studyMode: 'day', studyPerDay: 2 })
  assert.equal(studyModeOf(cfg), 'day')
  assert.equal(studyPerWeekOf(cfg), 3)
  assert.equal(studyPerDayOf(cfg), 2)
  assert.equal(studyPerDayOf({}), 1)
  assert.equal(studyPerDayOf({ studyPerDay: 99 }), 7)

  const day = (n) => ({ lastAt: 0, week: weekKeyOf(at(12)), weekCount: 99, day: '2026-11-24', dayCount: n })
  assert.equal(decideStudy({ cfg, study: day(0), now: at(22, 10), timeline: timelineOf() }).ok, true)
  assert.equal(decideStudy({ cfg, study: day(1), now: at(22, 10), timeline: timelineOf() }).ok, true)
  const full = decideStudy({ cfg, study: day(2), now: at(22, 10), timeline: timelineOf() })
  assert.equal(full.ok, false)
  assert.equal(full.reason, 'day-budget')

  // 昨天的计数不算今天的
  const st = studyStateOf({ study: { week: weekKeyOf(at(12)), weekCount: 5, day: '2026-11-23', dayCount: 5 } }, at(22, 10))
  assert.equal(st.dayCount, 0)
  assert.equal(st.weekCount, 5)
  assert.equal(decideStudy({ cfg, study: st, now: at(22, 10), timeline: timelineOf() }).ok, true)

  // 周模式不受 dayCount 影响
  const weekCfg = cfgOf({ studyPerWeek: 1 })
  const w = { lastAt: 0, week: weekKeyOf(at(12)), weekCount: 1, day: '2026-11-24', dayCount: 0 }
  assert.equal(decideStudy({ cfg: weekCfg, study: w, now: at(22, 10), timeline: timelineOf() }).reason, 'week-budget')
})