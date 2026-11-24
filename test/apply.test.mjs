// apply() 冒烟：注册不崩，/dsh-reading.state 真的带 study 字段
// 跑法：cd test && ELECTRON_RUN_AS_NODE=1 "D:/deepseek/DeepSeek Harness.exe" --test apply.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'halfpage-apply-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')

const mod = await import('../index.js')

test('apply 注册路由与工具，state 接口带 study', async () => {
  const routes = new Map()
  const toolNames = []
  const cleanups = []
  const ctx = {
    webServer: { register: (r) => { routes.set(r.path, r); return () => {} } },
    tools: { register: (t) => { toolNames.push(t.name); return () => {} } },
    systemPrompt: { section: () => () => {} },
    agents: { get: () => null },
    sessions: { flush: async () => true },
    effect: (fn) => {
      const out = fn()
      if (typeof out === 'function') cleanups.push(out)
      return out
    },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.ok(routes.has('/dsh-reading.state'))
  assert.ok(toolNames.includes('reading_next'))
  assert.ok(toolNames.includes('reading_mark'))

  const route = routes.get('/dsh-reading.state')
  let body = ''
  const res = {
    setHeader: () => {},
    end: (s) => { body = s },
  }
  await route.handler({}, res)
  const data = JSON.parse(body)
  assert.equal(data.ok, true)
  assert.ok(data.study, '要有 study 段')
  assert.equal(data.study.enabled, false, '默认关')
  assert.equal(data.study.perWeek, 3)
  assert.equal(data.study.weekCount, 0)
  assert.equal(data.study.lastAt, 0)
  assert.ok(Array.isArray(data.books))

  for (const fn of cleanups) assert.doesNotThrow(() => fn())
})
