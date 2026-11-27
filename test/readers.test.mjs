// 一个书房、多个读者：迁移、各自推进、furthest、读后感不丢
// 跑法：ELECTRON_RUN_AS_NODE=1 "D:/deepseek/DeepSeek Harness.exe" --test readers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'halfpage-readers-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')

const mod = await import('../index.js')

const legacyState = () => ({
  current: '雪中',
  books: {
    雪中: { id: '雪中', title: '雪中', chapters: 1029, readThrough: 74, next: 75, noteUntil: 70, lastReadAt: '2026-11-25T00:00:00.000Z' },
  },
  log: {},
})

test('迁移：把书级进度抄成默认读者，跑两次不会覆盖', () => {
  const st = mod.migrateReaders(legacyState())
  const legacy = st.readers[mod.LEGACY_READER]
  assert.equal(legacy.books['雪中'].readThrough, 74)
  assert.equal(legacy.books['雪中'].next, 75)
  assert.equal(legacy.books['雪中'].noteUntil, 70)
  assert.equal(st.books['雪中'].furthest, 74)
  // 已经有 readers 时不动
  st.readers['session-a'] = { name: '鹿野（DSH）', books: { 雪中: { readThrough: 12, next: 13, noteUntil: 0 } } }
  const again = mod.migrateReaders(st)
  assert.equal(again.readers['session-a'].books['雪中'].readThrough, 12)
  assert.equal(again.readers[mod.LEGACY_READER].books['雪中'].readThrough, 74)
})

test('两个读者各推各的，互不影响', () => {
  const st = mod.migrateReaders(legacyState())
  const a = mod.readerBook(st, 'session-a', '雪中')
  a.readThrough = 12
  a.next = 13
  const b = mod.readerBook(st, 'session-b', '雪中')
  b.readThrough = 3
  b.next = 4
  assert.equal(mod.readerBookRead(st, 'session-a', '雪中').readThrough, 12)
  assert.equal(mod.readerBookRead(st, 'session-b', '雪中').readThrough, 3)
  assert.equal(mod.readerBookRead(st, mod.LEGACY_READER, '雪中').readThrough, 74)
})

test('furthest 只增不减：书级记读得最远的那个人', () => {
  const st = mod.migrateReaders(legacyState())
  mod.readerBook(st, 'session-a', '雪中').readThrough = 80
  assert.equal(mod.furthestOf(st, '雪中'), 80)
  mod.readerBook(st, 'session-a', '雪中').readThrough = 10 // 退回去也不许变小
  assert.equal(mod.furthestOf(st, '雪中'), 80)
  assert.equal(st.books['雪中'].furthest, 80)
})

test('readerBookRead 不建分片（面板扫书架不会长出一堆空读者）', () => {
  const st = mod.migrateReaders(legacyState())
  const before = Object.keys(st.readers).length
  mod.readerBookRead(st, 'nobody', '雪中')
  assert.equal(Object.keys(st.readers).length, before)
})

test('读者一览：默认读者排最前，带名字', () => {
  const st = mod.migrateReaders(legacyState())
  st.readers['session-a'] = { name: '鹿野（DSH）', books: { 雪中: { readThrough: 12, next: 13, noteUntil: 0 } } }
  const list = mod.readerSummary(st)
  assert.equal(list[0].id, mod.LEGACY_READER)
  assert.equal(list[1].name, '鹿野（DSH）')
  assert.equal(list[1].books['雪中'].readThrough, 12)
})

test('读后感写入有锁：20 条并发一条不丢', async () => {
  const dir = join(home, 'reading-a')
  mkdirSync(dir, { recursive: true })
  const lines = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 句`)
  await Promise.all(lines.map((l) => mod.appendNote(dir, '雪中', '第 3 章', [l], '鹿野')))
  const md = readFileSync(join(dir, '读后感.md'), 'utf8')
  for (const l of lines) assert.ok(md.includes(`- ${l}`), `丢了：${l}`)
  assert.ok(existsSync(join(dir, '读后感.md')))
})

test('两个不同署名的段落都保留，署名行带着时间', async () => {
  const dir = join(home, 'reading-b')
  mkdirSync(dir, { recursive: true })
  await mod.appendNote(dir, '雪中', '第 1–2 章', ['甲'], '鹿野（DSH）')
  await mod.appendNote(dir, '雪中', '第 3 章', ['乙'], '鹿野（工作）')
  const md = readFileSync(join(dir, '读后感.md'), 'utf8')
  assert.ok(md.includes('来自：鹿野（DSH） · '))
  assert.ok(md.includes('来自：鹿野（工作） · '))
})

test('apply 之后 reading_next 记在当前读者名下', async () => {
  const dir = join(home, '.dsh', 'reading')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'books'), { recursive: true })
  writeFileSync(join(dir, 'books', '雪中.txt'), Array.from({ length: 5 }, (_, i) => `第${i + 1}章 甲`).join('\n'), 'utf8')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ current: '雪中', books: { 雪中: { id: '雪中', title: '雪中', chapters: 5, readThrough: 0, next: 1 } }, log: {} }), 'utf8')

  const routes = new Map()
  const tools = new Map()
  const ctx = {
    webServer: { register: (r) => { routes.set(r.path, r); return () => {} } },
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
    systemPrompt: { section: () => () => {} },
    agents: { get: () => null, list: () => [] },
    sessions: { flush: async () => true },
    effect: (fn) => { const out = fn(); return out },
  }
  mod.apply(ctx, { dir })

  const exec = { agent: { session: { id: 'session-work', header: { title: '鹿野（工作）' } } } }
  const r1 = await tools.get('reading_next').execute({ book: '雪中' }, exec)
  assert.equal(r1.chapter, 1)
  assert.equal(r1.reader, '鹿野（工作）')
  assert.equal(r1.readThrough, 1)

  const other = { agent: { session: { id: 'session-main', header: { title: '鹿野（主）' } } } }
  // 另一个读者第一次读：接着书级的位置（第 2 章），不是从第 1 章重来
  const r2 = await tools.get('reading_next').execute({ book: '雪中' }, other)
  assert.equal(r2.chapter, 2)
  assert.equal(r2.reader, '鹿野（主）')

  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(st.readers['session-work'].books['雪中'].readThrough, 1)
  assert.equal(st.readers['session-main'].books['雪中'].readThrough, 2)
  // 这台机器原本没有任何读书总进度（state 里 readThrough 0），所以不该凭空建一份空的「读书总进度」
  assert.ok(!st.readers[mod.LEGACY_READER], '没有旧进度时不应生成读书总进度分片')
  assert.equal(st.books['雪中'].furthest, 2)
})

test('reading_next 不带 book 时按「我刚读的那本」取书，跟 reading_note 一致', async () => {
  const dir = join(home, '.dsh', 'reading')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'books'), { recursive: true })
  writeFileSync(join(dir, 'books', '雪中.txt'), Array.from({ length: 5 }, (_, i) => '第' + (i + 1) + '章 甲').join('\n'), 'utf8')
  writeFileSync(join(dir, 'books', '诡秘.txt'), Array.from({ length: 5 }, (_, i) => '第' + (i + 1) + '章 乙').join('\n'), 'utf8')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ current: '诡秘', books: {
    雪中: { id: '雪中', title: '雪中', chapters: 5, readThrough: 0, next: 1 },
    诡秘: { id: '诡秘', title: '诡秘', chapters: 5, readThrough: 0, next: 1 },
  }, log: {} }), 'utf8')

  const tools = new Map()
  const ctx = {
    webServer: { register: () => () => {} },
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
    systemPrompt: { section: () => () => {} },
    agents: { get: () => null, list: () => [] },
    sessions: { flush: async () => true },
    effect: (fn) => fn(),
  }
  mod.apply(ctx, { dir })
  const exec = { agent: { session: { id: 'session-w2', header: { title: '鹿野（工作）' } } } }

  // 先读雪中一章，把「我刚读的那本」记成雪中
  const r1 = await tools.get('reading_next').execute({ book: '雪中' }, exec)
  assert.equal(r1.book, '雪中')

  // 全局当前是诡秘，但不带 book 时应该接着读雪中
  const r2 = await tools.get('reading_next').execute({}, exec)
  assert.equal(r2.book, '雪中')
  assert.equal(r2.chapter, 2)

  // 读书不该改「面板上显示的那本」——current 只由用户手动选书时写
  const st2 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(st2.current, '诡秘')
})