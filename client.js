/**
 * dsh-half-page — 半页（Client 半边）
 * 只做统计面板：读到哪、写了什么、她的作品；不显示正文（点「显示原文」才取）。
 */
// 注意：下面的 id 必须等于 package.json 的 name（DSH 按入口名判重，不一致会白屏报 duplicate factory registration）
window.__ModuleLoader__.load({
  id: 'dsh-half-page',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React
    // 书名自带《》时别再套一层
    const showTitle = (t) => { const s = String(t || ''); return /^《/.test(s) ? s : '《' + s + '》' }

    // 浅色主题，跟 DSH 主界面一致（深底浅字会和白界面不和谐）
    const C = {
      text: '#1c2430', dim: '#5d6878', line: '#e1e6ee',
      bg: '#ffffff', card: '#f7f9fc', accent: '#2f6fed', ok: '#12876b', warn: '#b46a00',
    }
    const S = {
      tag: { fontSize: 11, padding: '1px 7px', borderRadius: 9, border: '1px solid ' + C.line, background: C.card, color: C.dim, cursor: 'pointer' },
      tagOn: { fontSize: 11, padding: '1px 7px', borderRadius: 9, border: '1px solid ' + C.accent, background: '#eaf1ff', color: C.accent, cursor: 'pointer' },

      wrap: { padding: '14px 16px', fontSize: 13, color: C.text, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', boxSizing: 'border-box', overflow: 'auto', background: C.bg },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      dim: { color: C.dim, fontSize: 12 },
      card: { border: '1px solid ' + C.line, borderRadius: 10, padding: '10px 12px', background: C.card },
      btn: { border: '1px solid ' + C.line, background: '#fff', color: C.text, borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
      btnOn: { border: '1px solid ' + C.accent, background: 'rgba(47,111,237,0.10)', color: C.accent, borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
      tab: (on) => ({ padding: '5px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: on ? '#fff' : C.dim, background: on ? C.accent : '#fff', border: '1px solid ' + (on ? C.accent : C.line) }),
      bar: { height: 6, borderRadius: 99, background: '#e8edf5', overflow: 'hidden', flex: 1, minWidth: 100 },
      fill: { height: '100%', background: 'linear-gradient(90deg,#2f6fed,#12876b)' },
      note: { borderLeft: '2px solid rgba(18,135,107,0.45)', paddingLeft: 10, marginBottom: 8, lineHeight: 1.7, whiteSpace: 'pre-wrap' },
      text: { whiteSpace: 'pre-wrap', lineHeight: 1.75, fontSize: 13, maxHeight: 360, overflow: 'auto', background: '#fff', borderRadius: 8, padding: '10px 12px', border: '1px solid ' + C.line },
      item: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, border: '1px solid transparent' },
      input: { background: '#fff', color: C.text, border: '1px solid ' + C.line, borderRadius: 8, padding: '4px 8px', fontSize: 13, width: 72 },
    }

    const fmt = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'M' : n >= 1024 ? Math.round(n / 1024) + 'K' : String(n)

    function studyLine(s) {
      if (!s) return ''
      const last = s.lastAt ? new Date(s.lastAt).toLocaleString('zh-CN', { hour12: false }) : '还没有'
      const byDay = s.mode === 'day'
      const used = byDay ? (s.dayCount || 0) : (s.weekCount || 0)
      const cap = byDay ? (s.perDay || 1) : (s.perWeek || 3)
      return '上次提醒：' + last + ' · ' + (byDay ? '今天' : '本周') + '已叫 ' + used + '/' + cap + ' 次'
    }
    const copy = (t) => { try { navigator.clipboard.writeText(t) } catch {} }

    // 面板在 iframe 里，浏览器不让直接下载/选文件；备份交给宿主写盘，恢复给一个路径让宿主读
    // 备份：由宿主弹「另存为」，用户自己选位置
    async function backupAll() {
      setBusy(true)
      setMsg('正在打包…', 'bak')
      try {
        const r = await getJson('/dsh-reading.backupFile', { method: 'POST' })
        if (r && r.ok) {
          setLastBackup(r.path)
          setMsg('已备份到 ' + r.path, 'bak')
          try {
            await getJson('/dsh-reading.reveal', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: r.path }),
            })
          } catch {}
        } else setMsg('备份失败：' + ((r && r.error) || '未知'), 'bak')
      } catch (e) {
        setMsg('备份失败：' + String(e), 'bak')
      } finally { setBusy(false) }
    }
    async function reveal(p) {
      try {
        const r = await getJson('/dsh-reading.reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
        if (!r || !r.ok) setMsg('打不开文件夹：' + ((r && r.error) || '未知'), 'bak')
      } catch (e) { setMsg('打不开文件夹：' + String((e && e.message) || e), 'bak') }
    }

    async function checkUpd() {
      setBusy(true)
      try {
        const r = await getJson('/dsh-reading.update')
        if (r && r.ok) {
          const d = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          setUpd({ ...r, at: pad(d.getHours()) + ':' + pad(d.getMinutes()) })
          setMsg(r.outdated ? ('发现新版本 ' + r.latest + '：可以点「复制更新命令」，在终端里跑') : (r.latest ? ('已是最新版 ' + r.current + '，不用更新') : '查不到 npm（可能离线），稍后再试'), 'upd')
        } else setMsg('检测失败：' + ((r && r.error) || '未知'), 'upd')
      } catch (e) { setMsg('检测失败：' + String((e && e.message) || e), 'upd') } finally { setBusy(false) }
    }

    // 恢复：由宿主弹「打开」，选完直接恢复
    async function restoreFromPath() {
      setBusy(true)
      setMsg('正在读取备份…', 'bak')
      try {
        let path = (restorePath || '').trim()
        if (!path) {
          const pick = await getJson('/dsh-reading.pickFile', { method: 'POST' })
          if (!pick || !pick.ok) {
            setMsg((pick && pick.cancelled) ? '取消了，没恢复' : ('没选到文件：' + ((pick && pick.error) || '窗口没起来，可以直接把路径填在下面')), 'bak')
            return
          }
          path = pick.path
          setRestorePath(path)
        }
        const f = await getJson('/dsh-reading.readFile?path=' + encodeURIComponent(path))
        if (!f || !f.ok) { setMsg('读不到那个文件：' + ((f && f.error) || '未知'), 'bak'); return }
        const r = await getJson('/dsh-reading.restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ json: f.text }),
        })
        if (r && r.ok) { setMsg('已恢复：' + (r.books || 0) + ' 本 · ' + (r.chapters || 0) + ' 段读后感', 'bak'); await load() }
        else setMsg('恢复失败：' + ((r && r.error) || '未知'), 'bak')
      } catch (e) {
        setMsg('恢复失败：' + String(e), 'bak')
      } finally { setBusy(false) }
    }
    async function getJson(url, opt) {
      const r = await fetch(url, opt)
      return r.json()
    }

    // 把读后感 md 拆成 [{book, chapters:[{title, lines:[]}], raw}]
    function parseNotes(md) {
      const out = []
      let book = null, ch = null
      for (const line of String(md || '').split(/\r?\n/)) {
        if (/^##\s+/.test(line)) {
          book = { book: line.replace(/^##\s+/, '').trim(), chapters: [] }
          out.push(book); ch = null
        } else if (/^###\s+/.test(line)) {
          ch = { title: line.replace(/^###\s+/, '').trim(), lines: [] }
          if (book) book.chapters.push(ch)
        } else if (/^[-*]\s+/.test(line)) {
          if (ch) {
            const t = line.replace(/^[-*]\s+/, '')
            ch.lines.push(t)
            // 署名行里带着时间：- ↳ 来自：鹿野 · 2026-11-10 20:31
            if (/^↳/.test(t)) {
              const m = t.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
              if (m) ch.at = m[1] + ' ' + m[2]
              const b = t.replace(/^\u21b3\s*\u6765\u81ea\uff1a/, '').split('\u00b7')[0].trim()
              if (b) ch.by = b
            }
          }
        }
      }
      return out
    }

    const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const cnNum = (s) => {
    const t = String(s || '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 65248))
    if (/^[0-9]+$/.test(t)) return Number(t)
    let n = 0
    let cur = 0
    for (const ch of t) {
      if (ch === '十') { n += (cur || 1) * 10; cur = 0 }
      else if (ch === '百') { n += (cur || 1) * 100; cur = 0 }
      else if (ch === '千') { n += (cur || 1) * 1000; cur = 0 }
      else if (CN_DIGIT[ch] !== undefined) cur = CN_DIGIT[ch]
      else return NaN
    }
    return n + cur
  }
  const chapterNo = (title) => {
    // 标题可能是「第 3–7 章」（带空格与范围），所以先去空格再取第一个数字
    const t = String(title || '').replace(/\s+/g, '')
    const m = t.match(/第([0-9０-９零〇一二三四五六七八九十百千两]+)/)
    return m ? cnNum(m[1]) : NaN
  }
  // 有几章、从第几章到第几章（章名认不出数字就不显示范围）
  const chapterRange = (chapters) => {
    const nos = (chapters || []).map((c) => chapterNo(c && c.title)).filter((n) => Number.isFinite(n))
    if (!nos.length) return ''
    const a = Math.min.apply(null, nos)
    const b = Math.max.apply(null, nos)
    return a === b ? ('第 ' + a + ' 章') : ('第 ' + a + '–' + b + ' 章')
  }

  function Panel() {
      const [state, setState] = useState(null)
      const [confirmId, setConfirmId] = useState('')
      const [pendingAdopt, setPendingAdopt] = useState('')
      const [tab, setTab] = useState('read')
      const [raw, setRaw] = useState('')
      const [showRaw, setShowRaw] = useState(false)
      const [works, setWorks] = useState(null)
      const [opened, setOpened] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [msg, setMsgRaw] = useState('')
      const [msgAt, setMsgAt] = useState('')
      const [restorePath, setRestorePath] = useState('')
      const [lastBackup, setLastBackup] = useState('')
      const [upd, setUpd] = useState(null)
      const setMsg = (text, at = '') => { setMsgRaw(text); setMsgAt(at || '') }
      const [busy, setBusy] = useState(false)
      const [recent, setRecent] = useState(null)
      const [noteView, setNoteView] = useState({})
      const [bookAct, setBookAct] = useState(0)
      const [shownBook, setShownBook] = useState('')
      const [picking, setPicking] = useState(false)
      const [picked, setPicked] = useState([])
      // 读者：'' = 还没选；'__legacy__' = 总进度（全机），其余是会话 id
      const TOTAL_READER = '__legacy__'
      const [readerId, setReaderId] = useState('')
      const [authorFilter, setAuthorFilter] = useState('')
      // 大图查看器：面板跑在 iframe 里，window.open 会被拦，所以自己在面板内弹一层
      const [viewer, setViewer] = useState(null)
      useEffect(() => {
        if (!viewer) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setViewer(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [viewer])
      const NOTE_PAGE = 10
      let importPath = ''

      const load = async (rid) => {
        try {
          const st = await getJson('/dsh-reading.state' + (rid ? '?reader=' + encodeURIComponent(rid) : ''))
          setState(st)
          if (st && st.notes) setRaw(st.notes)
          const c = await getJson('/dsh-reading.config')
          if (c && c.ok) setCfg(c.config || {})
        } catch (e) { setMsg('读不到状态：' + String(e && e.message || e)) }
      }
      useEffect(() => { load(); fetch('/dsh-reading.update').then((r) => r.json()).then((r) => { if (r && r.ok) setUpd(r) }).catch(() => {}) }, [])

      const notes = useMemo(() => parseNotes(raw), [raw])
      // 打开面板默认显示「最近读过的那本」；手点书名只在本页临时切换（不写盘、不动进度）
      const recentId = (state && state.books && state.books.filter((b) => b.lastReadAt).sort((a, b) => String(b.lastReadAt).localeCompare(String(a.lastReadAt)))[0] || {}).id || ''
      const shownId = shownBook || recentId || (state && state.current) || ''
      const cur = state && state.books && state.books.find((b) => b.id === shownId)
      const favs = (cfg && cfg.favorites) || []
      const readers = (state && state.readers) || []
      // 下拉里只列真读者；「总进度」是下拉旁边那个按钮，不占选项
      const realReaders = readers.filter((r) => r.id !== TOTAL_READER)
      // 默认跟着「最近读过的那位读者」；要点总进度才切过去
      const recentReader = realReaders.slice().sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0))[0]
      const activeRid = readerId || (recentReader && recentReader.id) || TOTAL_READER
      const isTotal = activeRid === TOTAL_READER
      // 读者换了就按那位读者重拉一次：书级的「我读到第几章 / 那章叫什么」是按读者算的
      useEffect(() => { if (activeRid) load(activeRid === TOTAL_READER ? '__legacy__' : activeRid) }, [activeRid])
      const me = readers.find((r) => r.id === activeRid) || null

      // 近况跟着当前读者走：切读者就重拉一次（服务端只报这位读者翻过的）
      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const rc = await getJson('/dsh-reading.recent?reader=' + encodeURIComponent(activeRid))
            if (alive && rc && rc.ok) setRecent(rc)
          } catch {}
        })()
        return () => { alive = false }
      }, [activeRid, state])

      const mineOf = (bid) => {
        if (isTotal) {
          const b = state && state.books && state.books.find((x) => x.id === bid)
          return b ? (Number(b.readThrough) || 0) : 0
        }
        const r = readers.find((x) => x.id === activeRid)
        const b = r && r.books && r.books[bid]
        return b ? (Number(b.readThrough) || 0) : 0
      }
      const withReader = (p) => p + (p.indexOf('?') >= 0 ? '&' : '?') + 'reader=' + encodeURIComponent(activeRid)

      // 进度只由鱼读书时写（reading_next / reading_mark）；面板不提供"推进/退回/从头读"按钮，
      // 免得用户点一下就替某位读者记了一章。这里只保留 reading 的入口。


      const STATES = ['在写', '写完了', '搁下了']
      const cycleStatus = async (f) => {
        const i = STATES.indexOf(f.status || '')
        const next = i < 0 ? STATES[0] : (i === STATES.length - 1 ? '' : STATES[i + 1])
        await fetch('/dsh-reading.workstatus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel: f.rel, status: next }) })
        await loadWorks()
      }

      const removeBook = async (id) => {
        setConfirmId('')
        await getJson('/dsh-reading.removeBook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
        const j = await getJson('/dsh-reading.state')
        if (j && j.ok) setState(j)
      }

      const loadWorks = async () => {
        const r = await getJson('/dsh-reading.works')
        if (r && r.ok) setWorks(r) ; else setMsg('作品目录读不到：' + (r && r.error))
      }
      const openFile = async (f) => {
        if (opened && opened.path === f.path) return setOpened(null)
        if (f.kind !== 'text') return setOpened({ ...f, text: '（' + f.kind + '，路径：' + f.path + '）' })
        const r = await getJson('/dsh-reading.file?path=' + encodeURIComponent(f.path))
        setOpened({ ...f, text: r && r.ok ? r.text : '读不到：' + (r && r.error) })
      }

      const toggleFav = async (key) => {
        const next = favs.includes(key) ? favs.filter((x) => x !== key) : favs.concat(key)
        const r = await getJson('/dsh-reading.config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorites: next }) })
        if (r && r.ok) { setCfg(r.config); setMsg(favs.includes(key) ? '已取消收藏' : '已收藏') }
      }

      const copyFav = async (f) => {
        if (String(f).startsWith('file:')) {
          const r = await getJson('/dsh-reading.file?path=' + encodeURIComponent(f.slice(5)))
          if (r && r.ok) { copy(r.text); setMsg('已复制正文') } else setMsg('复制失败：' + (r && r.error))
          return
        }
        const [book, chapter] = String(f).split('|')
        const bk = notes.find((x) => x.book === book)
        const ch = bk && (bk.chapters || []).find((x) => x.title === chapter)
        if (ch) { copy(ch.lines.join('\n')); setMsg('已复制这条读后感') } else setMsg('这条读后感已经不在了')
      }

      // 收藏页点一下就地展开：作品看正文，读后感看那一条
      const openFav = async (f) => {
        const key = 'fav:' + f
        if (opened && opened.path === key) return setOpened(null)
        if (String(f).startsWith('file:')) {
          const p = f.slice(5)
          const r = await getJson('/dsh-reading.file?path=' + encodeURIComponent(p))
          return setOpened({ path: key, title: p, text: r && r.ok ? r.text : '读不到：' + (r && r.error) })
        }
        const parts = String(f).split('|')
        const bk = notes.find((x) => x.book === parts[0])
        const ch = bk && (bk.chapters || []).find((x) => x.title === parts[1])
        setOpened({ path: key, title: parts.join(' · '), text: ch ? ch.lines.join('\n') : '这条读后感已经不在了' })
      }

      // 换「面板上正在显示的那本」，只改展示，不动任何人的阅读进度
      const setCurrentBook = async (id) => {
        const r = await getJson('/dsh-reading.setCurrent?id=' + encodeURIComponent(id))
        if (r && r.ok) { await load(); setMsg('面板切到' + showTitle(id)) } else setMsg('切换失败')
      }

      const [slots, setSlots] = useState([])
      useEffect(() => {
        const s = (state && state.study && state.study.slots) || []
        setSlots(s.map((x) => ({ ...x })))
      }, [state])
      // 整条列表一起存：新增/删/改时段都走这里
      const saveSlots = async (next) => {
        const body = { slots: (next || []).map((s) => ({ id: s.id, enabled: s.enabled === true, from: s.from, to: s.to, mode: s.mode, per: s.per, everyMinutes: s.everyMinutes, dailyBudget: s.dailyBudget, session: s.session })) }
        const r = await fetch('/dsh-reading.study', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then((x) => x.json()).catch(() => null)
        if (r && r.ok) await load()
        else setMsg('书房时间存不下：' + (r && r.error || '未知'), 'study')
      }

      const saveCfg = async (patch) => {
        const r = await getJson('/dsh-reading.config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        if (r && r.ok) { setCfg(r.config); setMsg('已保存', 'set') ; await load() } else setMsg('保存失败：' + (r && r.error), 'set')
      }

      // 读书总进度：全机共用的那条书签——跟着当前这本书走，并标出是谁读到的
      const furthestChip = (cur && cur.furthest > 0)
        ? h('div', {
            style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#eef3fb', color: '#456', whiteSpace: 'nowrap' },
            title: '这本书全机读到最远的地方（所有会话共用，只增不减）',
          }, '最远：第 ' + cur.furthest + ' 章' + (cur.furthestReader ? (' · ' + cur.furthestReader.name) : ''))
        : null

      const head = h('div', { style: S.card },
        h('div', { style: S.row },
          h('div', { style: { fontWeight: 600, fontSize: 14 } }, cur
            ? ((recentId && shownId && shownId !== recentId) ? ('当前显示' + showTitle(cur.id)) : (((recentReader && recentReader.name) ? (recentReader.name + ' ') : '') + '正在读' + showTitle(cur.id)))
            : '还没导入书'),
          furthestChip,

          h('div', {
            style: S.dim,
            title: state ? ('今天已读 ' + (me && typeof me.today === 'number' ? me.today : state.readToday) + ' 章，上限 ' + state.perDay + ' 章') : '',
          }, state ? ('今天还能读 ' + Math.max(0, state.perDay - (me && typeof me.today === 'number' ? me.today : state.readToday)) + ' 章') : ''),
          h('div', { style: { flex: 1 } }),
          readers.length > 1
            ? h('div', { style: S.row },
                cur && Number(cur.furthest) > mineOf(cur.id)
                ? h('button', {
                    style: { ...S.btn, marginRight: 6, ...(pendingAdopt === cur.id ? { color: C.warn, borderColor: C.warn } : {}) },
                    title: '把我在这一本书的书签接到全机读到最远的地方（只动我这份，不影响别人）；点一次变红，再点一次才生效',
                    onClick: async () => {
                      if (pendingAdopt !== cur.id) {
                        setPendingAdopt(cur.id)
                        window.setTimeout(() => setPendingAdopt((x) => (x === cur.id ? '' : x)), 4000)
                        return
                      }
                      setPendingAdopt('')
                      const r = await getJson('/dsh-reading.adopt?book=' + encodeURIComponent(cur.id) + (readerId ? '&reader=' + encodeURIComponent(readerId) : ''), { method: 'POST' })
                      if (r && r.ok) { setMsg('已接到第 ' + r.readThrough + ' 章'); await load() }
                      else setMsg('接不上：' + (r && r.error || '未知'))
                    },
                  }, pendingAdopt === cur.id ? ('再点一次，接到第 ' + cur.furthest + ' 章') : ('接到第 ' + cur.furthest + ' 章'))
                : null,
                h('div', { style: { ...S.dim, fontSize: 11 } }, '读者'),
                h('select', {
                  style: { fontSize: 12, padding: '2px 4px' },
                  value: activeRid,
                  onChange: (e) => { setReaderId(e.target.value); setBookAct(0) },
                },
                  realReaders.map((r) => h('option', { key: r.id, value: r.id }, r.name || r.id)),

                ),
              )
            : null,
          h('button', { style: S.btn, onClick: load }, '刷新'),
        ),
        cur ? h('div', { style: { ...S.row, marginTop: 8 } },
          h('div', { style: S.bar }, h('div', { style: { ...S.fill, width: Math.min(100, ((mineOf(cur.id) || 0) / (cur.chapters || 1)) * 100) + '%' } })),
          h('div', { style: S.dim },
            (Number(mineOf(cur.id)) > 0
              ? ('我读到第 ' + mineOf(cur.id) + ' 章，全书 ' + cur.chapters + ' 章')
              : ('这本我还没读过，全书 ' + cur.chapters + ' 章'))
            + (cur.furthest && cur.furthest > (mineOf(cur.id) || 0) ? ('（最远是第 ' + cur.furthest + ' 章）') : '')),
        ) : null,
      )

      const tabs = h('div', { style: S.row },
        ['read', 'note', 'works', 'fav', 'set'].map((k) => h('div', {
          key: k, style: S.tab(tab === k), onClick: () => { setTab(k); if ((k === 'works' || k === 'fav') && !works) loadWorks() },
        }, k === 'read' ? '读书' : k === 'note' ? '读后感' : k === 'works' ? '她的作品' : k === 'fav' ? '收藏' : '设置')),
        h('div', { style: { flex: 1 } }),
        (msg && !msgAt) ? h('div', { style: { ...S.dim, color: C.ok } }, msg) : null,
      )

      const readTab = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        // 近况卡
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { fontWeight: 600 } }, '近况'),
            h('div', { style: { flex: 1 } }),
            h('div', { style: S.dim }, recent ? (recent.today || '') : ''),
          ),
          h('div', { style: { marginTop: 6, marginBottom: 6 } }, recent && recent.status ? recent.status : '还没什么可报的。'),
          recent && recent.mood
            ? h('div', { style: { marginBottom: 6 } }, h('span', { style: S.tagOn }, recent.mood))
            : null,
          recent && recent.days && recent.days.length
            ? h('div', { style: { marginBottom: 4 } },
                h('div', { style: S.dim }, '这几天翻过的：'),
                recent.days.map((d, i) => h('div', { key: i, style: S.row },
                  h('div', { style: S.dim }, d.day),
                  h('div', { style: { flex: 1 } }, showTitle(d.book) + d.chapters + ' 章'),
                )),
              )
            : null,
          recent && recent.perReader && recent.perReader.length
            ? h('div', { style: { marginTop: 6 } },
                isTotal
                  ? h('div', { style: S.dim }, '这本谁读到哪（按读到最远排）：')
                  : null,
                recent.perReader.slice(0, 8).map((r, i) => h('div', { key: i, style: S.row },
                  h('div', { style: { flex: 1 } }, showTitle(r.name)),
                  h('div', { style: S.dim }, '读到第 ' + r.readThrough + (r.chapters ? (' / ' + r.chapters) : '') + ' 章'),
                )),
              )
            : null,

          recent && recent.works && recent.works.length
            ? h('div', null,
                h('div', { style: S.dim }, '最近碰过的稿子：'),
                recent.works.map((w, i) => h('div', { key: i, style: S.row },
                  h('div', { style: { flex: 1 } },
                    h('div', null, w.rel),
                    w.note ? h('div', { style: { ...S.dim, fontSize: 11 } }, w.note) : null,
                  ),
                  h('div', { style: S.dim }, w.days === 0 ? '今天' : w.days + ' 天前'),
                )),
              )
            : null,
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { fontWeight: 600 } }, '读到哪'),
            h('div', { style: { flex: 1 } }),

            // 只讲「鱼会说的话」；内部怎么选章（第一章还是接总进度）不上界面。
            h('button', { style: showRaw ? S.btnOn : S.btn, onClick: async () => {
              if (!showRaw && cur) {
                const mineN = mineOf(cur.id)
                if (!mineN) return
                const r = await getJson('/dsh-reading.chapter?book=' + encodeURIComponent(cur.id) + '&n=' + mineN)
                if (r && r.ok) setOpened({ path: 'chapter', text: r.text, title: r.title })
                else setMsg('取不到原文：' + (r && r.error || '未知'))
              }
              setShowRaw(!showRaw)
            } }, showRaw ? '收起原文' : '显示原文'),
          ),
          cur && Number(cur.mineReadThrough) > 0
            ? h('div', { style: { ...S.dim, marginTop: 6 } },
                '我读到第 ' + cur.mineReadThrough + ' 章'
                + (cur.mineChapterTitle ? (' · ' + cur.mineChapterTitle) : ''))
            : (cur
                ? h('div', { style: { ...S.dim, marginTop: 6 } },
                    (Number(cur.furthest) > 1 ? ('这本书别人读到第 ' + cur.furthest + ' 章了，我还没读过。') : '这本书我还没读过。'))
                : null),
          showRaw && opened && opened.path === 'chapter'
            ? h('div', { style: { ...S.text, marginTop: 8 } }, (opened.title ? opened.title + '\n\n' : '') + opened.text)
            : null,
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.row, marginBottom: 6 } },
            h('div', { style: { fontWeight: 600 } }, '书架'),
            h('div', { style: { ...S.dim, marginLeft: 8 } }, '点书名，看各人的进度'),
            h('div', { style: { flex: 1 } }),
            picking && picked.length
              ? h('button', {
                  style: { ...S.btn, color: C.warn, borderColor: C.warn },
                  onClick: async () => {
                    for (const id of picked) await removeBook(id)
                    setPicking(false); setPicked([]); setMsg('下架了 ' + picked.length + ' 本')
                  },
                }, '确认下架 ' + picked.length + ' 本')
              : null,
            h('button', {
              style: picking ? S.btnOn : S.btn,
              title: '批量从书架拿下来（文件移到 books/.trash，可手工找回；读后感不动）',
              onClick: () => { setPicking(!picking); setPicked([]) },
            }, picking ? '取消' : '下架'),
          ),
          (state && state.books && state.books.length) ? state.books.map((b, i) => {
            const mineNo = mineOf(b.id)
            const done = (b.readThrough || 0) >= (b.chapters || 1)
            return h('div', { key: i, style: S.row },
              picking
                ? h('input', {
                    type: 'checkbox',
                    checked: picked.includes(b.id),
                    onChange: (e) => setPicked(e.target.checked ? picked.concat([b.id]) : picked.filter((x) => x !== b.id)),
                  })
                : null,
              // 点书名 = 把面板切到这本（只改显示，不动任何人的进度）；当前那本前面带个圆点
              h('div', {
                style: { flex: 1, cursor: 'pointer', color: b.id === shownId ? C.accent : C.text, fontWeight: b.id === shownId ? 600 : 400 },
                title: b.id === shownId
                  ? '面板顶部显示的就是这本（默认是最近读过的那本）'
                  : '点书名把面板临时切到这本（只改显示，不动任何人的阅读进度）',
                onClick: () => setShownBook(b.id),
              }, (b.id === shownId ? '● ' : '') + b.id),
              h('div', { style: S.dim },
                (mineNo || 0) + '/' + b.chapters
                + (b.furthest && b.furthest > mineNo ? ('（最远 ' + b.furthest + '）') : '')),
              h('div', {
                style: b.status === '弃坑' ? { ...S.tag, color: C.warn } : (done || b.status === '已读完' ? { ...S.tag, color: C.ok } : S.tag),
                title: '这本书的状态由鱼自己写（reading_* 工具），面板只显示',
              }, b.status || (done ? '已读完' : (mineNo ? '在读' : '未读'))),

            )
          }) : h('div', { style: S.dim }, '还没有书。'),
        ),
      )

      // 读后感单独一页：不和书架挤在一起
      const noteTab = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.card },
          notes.length ? (() => {
            const act = Math.min(bookAct, notes.length - 1)
            const bk = notes[act]
            const bi = act
            const v = noteView[bi] || {}
            const all = !!v.all
            const total = bk.chapters.length
            const pages = Math.max(1, Math.ceil(total / NOTE_PAGE))
            const page = Math.min(v.page || 0, pages - 1)
            // 排序：章节升 / 章节降 / 时间新在前（没写时间的排在后面）
            const sortLabels = ['章节 \u2191', '章节 \u2193', '时间 \u2193']
            const sortMode = (v.sort === undefined ? ((state && state.noteSort) || 0) : v.sort) % 3
            const sorted = bk.chapters.slice()
            if (sortMode === 1) sorted.sort((a, b) => (chapterNo(b.title) || -1) - (chapterNo(a.title) || -1))
            else if (sortMode === 2) sorted.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
            else sorted.sort((a, b) => (chapterNo(a.title) || 1e9) - (chapterNo(b.title) || 1e9))
            // 按署名筛：同一台机器上有好几个读者，读后记在一个文件里靠 by 分
            const af = authorFilter
            const authors = Array.from(new Set(notes.reduce((acc, n) => acc.concat(n.chapters.map((c) => c.by).filter(Boolean)), [])))
            const seen = af ? sorted.filter((c) => (c.by || '') === af) : sorted
            const list = all ? seen : seen.slice(page * NOTE_PAGE, page * NOTE_PAGE + NOTE_PAGE)
            const setView = (patch) => setNoteView(Object.assign({}, noteView, { [bi]: Object.assign({}, v, patch) }))
            const saveSort = (n) => { try { getJson('/dsh-reading.notesort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sort: n }) }) } catch (e) {} }
            const paged = total > NOTE_PAGE
            const tabs = h('div', { style: { ...S.row, gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
              notes.map((n, ni) => h('button', {
                key: ni,
                style: ni === act ? S.btnOn : S.btn,
                onClick: () => setBookAct(ni),
              }, n.book)),
            )
            return [tabs, h('div', { key: bi, style: { marginBottom: 10 } },
              h('div', { style: { ...S.row, marginBottom: 4 } },
                h('div', { style: { fontWeight: 600 } }, bk.book),
                h('div', { style: S.dim }, total + ' 段'),
                h('div', { style: { flex: 1 } }),
                paged ? h('button', { style: S.btn, disabled: page <= 0, onClick: () => setView({ page: page - 1 }) }, '‹') : null,
                paged ? h('div', { style: { ...S.dim, minWidth: 46, textAlign: 'center' } }, all ? '全部' : ((page + 1) + ' / ' + pages)) : null,
                paged ? h('button', { style: S.btn, disabled: all || page >= pages - 1, onClick: () => setView({ page: page + 1 }) }, '›') : null,
                paged ? h('button', { style: all ? S.btnOn : S.btn, onClick: () => setView({ all: !all, page: 0 }) }, all ? '分页' : '全部') : null,
                h('button', { style: S.btnOn, onClick: () => { const next = (sortMode + 1) % 3; setView({ sort: next, page: 0 }); saveSort(next) } }, sortLabels[sortMode]),
                authors.length > 1
                  ? h('select', {
                      style: { fontSize: 12, padding: '2px 4px' },
                      value: af,
                      onChange: (e) => { setAuthorFilter(e.target.value); setView({ page: 0 }) },
                    },
                    h('option', { value: '' }, '全部署名'),
                    authors.map((a) => h('option', { key: a, value: a }, a)),
                  )
                  : null,
                h('button', { style: S.btn, onClick: () => copy(bk.chapters.map((c) => '## ' + c.title + '\n' + c.lines.join('\n')).join('\n\n')) }, '复制这本读后感'),
              ),
              (sortMode === 2 && bk.chapters.filter((c) => !c.at).length) ? h('div', { style: { ...S.dim, marginBottom: 6 } }, '有 ' + bk.chapters.filter((c) => !c.at).length + ' 段早期笔记当时没记时间，排在最后。') : null,
              list.map((c, ci) => h('div', { key: ci, style: { marginBottom: 6 } },
                h('div', { style: S.row },
                  h('div', { style: { ...S.dim, color: C.warn } }, c.title),
                  h('button', { style: S.btn, onClick: () => toggleFav(bk.book + '|' + c.title) }, favs.includes(bk.book + '|' + c.title) ? '★' : '☆'),
                  h('button', { style: S.btn, onClick: () => copy(c.lines.join('\n')) }, '复制'),
                ),
                c.lines.map((l, li) => h('div', { key: li, style: /^↳/.test(l) ? { ...S.dim, marginTop: 4 } : S.note }, l)),
              )),
            )]
          })() : h('div', { style: S.dim }, '还没写过。读完一段记两句，这里就有了。'),
        ),
      )

      const worksTab = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { fontWeight: 600 } }, '她的作品'),
            h('div', { style: S.dim }, works ? (works.root + ' · ' + works.files.length + ' 个文件' + ((works.images && works.images.length) ? (' · ' + works.images.length + ' 张图') : '')) : ''),
            h('div', { style: { flex: 1 } }),
            h('button', { style: S.btn, onClick: loadWorks }, '重新扫描'),
          ),
          !works ? h('div', { style: { ...S.dim, marginTop: 8 } }, '点「重新扫描」列出作品目录。') :
            (works.files.length ? works.files.map((f, i) => h('div', { key: i, style: { ...S.item, borderTop: '1px solid ' + C.line } },
              h('div', { style: { flex: '0 1 auto', cursor: 'pointer' }, onClick: () => openFile(f) }, f.rel),
              h('div', { style: { ...S.dim, marginLeft: 10 } }, (() => {
                const d = Math.floor((Date.now() - new Date(f.mtime).getTime()) / 86400000)
                return d <= 0 ? '今天改过' : (d === 1 ? '昨天改过' : d + ' 天前改过')
              })()),
              h('div', { style: f.author ? S.dim : { ...S.dim, color: C.warn } }, f.author ? ('署名 · ' + f.author) : '未署名'),
              h('div', { style: { flex: 1 } }),
              h('button', {
                style: f.status === '在写' ? S.tagOn : S.tag,
                title: '点一下换状态：在写 → 写完了 → 搁下了 → 不标',
                onClick: () => cycleStatus(f),
              }, f.status || '—'),
              h('div', { style: S.dim }, f.kind + ' · ' + fmt(f.size)),
              h('button', { style: S.btn, onClick: () => toggleFav('file:' + f.path) }, favs.includes('file:' + f.path) ? '★' : '☆'),
              f.kind === 'text' ? h('button', { style: S.btn, onClick: async () => {
                const r = await getJson('/dsh-reading.file?path=' + encodeURIComponent(f.path))
                if (r && r.ok) { copy(r.text); setMsg('已复制全文') }
              } }, '复制') : h('button', { style: S.btn, onClick: () => { copy(f.path); setMsg('已复制路径') } }, '复制路径'),
            )) : h('div', { style: { ...S.dim, marginTop: 8 } }, '这里还是空的：把 .md 或 .txt 放进 ' + works.root + '，点「重新扫描」就会出现。')),
          opened ? h('div', { style: { ...S.text, marginTop: 10 } }, (opened.title || opened.rel || '') + '\n\n' + opened.text) : null,
        ),
        (works && works.images && works.images.length) ? h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { fontWeight: 600 } }, '画'),
            h('div', { style: S.dim }, '作品目录与 art 里的图 · 新的在前 · 点一张看大图'),
          ),
          h('div', {
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: 10 },
          },
            works.images.map((m, i) => h('div', {
              key: 'img' + i,
              style: { border: '1px solid ' + C.line, borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)' },
            },
              h('div', {
                style: { cursor: 'zoom-in', lineHeight: 0, background: 'rgba(0,0,0,0.15)' },
                title: m.path,
                onClick: () => setViewer(m),
              }, h('img', {
                src: m.url,
                alt: m.name,
                loading: 'lazy',
                style: { width: '100%', height: 120, objectFit: 'cover', display: 'block' },
              })),
              h('div', { style: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                h('div', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: m.rel }, m.name),
                h('div', { style: { ...S.dim, fontSize: 11 } }, (m.width && m.height ? (m.width + '×' + m.height + ' · ') : '') + fmt(m.size)),
                h('div', { style: { ...S.dim, fontSize: 11 } }, new Date(m.mtime).toLocaleString()),
              ),
            )),
          ),
        ) : null,
      )

      const setTabView = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '阅读'),
          h('div', { style: { ...S.row, marginBottom: 6 } },
            h('div', null, '每日章节上限'), h('input', { style: S.input, type: 'number', defaultValue: (cfg && cfg.perDay) || 20, onBlur: (e) => saveCfg({ perDay: Number(e.target.value) || 0 }) }),
          ),
          h('div', { style: { ...S.row, marginBottom: 6 } },
            h('div', null, '每几章写一次读后感'), h('input', { style: S.input, type: 'number', defaultValue: (cfg && cfg.notesEvery) || 1, onBlur: (e) => saveCfg({ notesEvery: Number(e.target.value) || 1 }) }),
          ),
          h('div', { style: S.row },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('input', {
                type: 'checkbox',
                defaultChecked: (cfg ? cfg.quietEnabled !== false : true),
                onChange: (e) => saveCfg({ quietEnabled: e.target.checked }),
              }),
              h('span', null, '启用静音'),
            ),
            h('input', { style: { ...S.input, width: 64 }, defaultValue: (cfg && cfg.quietFrom) || '', placeholder: '03:00', onBlur: (e) => saveCfg({ quietFrom: e.target.value }) }),
            h('div', { style: S.dim }, '至'),
            h('input', { style: { ...S.input, width: 64 }, defaultValue: (cfg && cfg.quietTo) || '', placeholder: '08:00', onBlur: (e) => saveCfg({ quietTo: e.target.value }) }),
            h('div', { style: S.dim }, '静音时段内不会自动读'),
          ),
          msgAt === 'set' ? h('div', { style: { ...S.dim, color: C.ok, marginTop: 6 } }, msg) : null,
          h('div', { style: { ...S.row, marginBottom: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + C.line } },
            h('div', { style: { fontWeight: 600, marginRight: 10 } }, '书房时间'),
            h('button', {
              style: { ...S.btn, fontSize: 11, padding: '2px 8px' },
              title: '可以有多条：不同时段、不同频率、叫进不同会话',
              onClick: () => {
                const next = slots.concat([{ id: 'slot-' + Date.now().toString(36), enabled: false, from: '22:00', to: '23:00', everyMinutes: 30, dailyBudget: 2, session: '' }])
                setSlots(next); saveSlots(next)
              },
            }, '新增书房时间'),
          ),
          msgAt === 'study' ? h('div', { style: { ...S.dim, color: C.ok, marginTop: 4 } }, msg) : null,
          (slots.length ? slots : []).map((s, i) =>
            h('div', { key: s.id || i, style: { ...S.row, marginBottom: 6, flexWrap: 'wrap' } },
              h('input', {
                type: 'checkbox',
                checked: s.enabled === true,
                title: '这条开不开',
                onChange: (e) => { const next = slots.slice(); next[i] = { ...s, enabled: e.target.checked }; setSlots(next); saveSlots(next) },
              }),
              h('input', {
                style: { ...S.input, width: 64 },
                value: s.from || '',
                placeholder: '例 22:00',
                onChange: (e) => { const next = slots.slice(); next[i] = { ...s, from: e.target.value }; setSlots(next) },
                onBlur: () => saveSlots(slots),
              }),
              h('div', { style: S.dim }, '至'),
              h('input', {
                style: { ...S.input, width: 64 },
                value: s.to || '',
                placeholder: '例 23:00',
                onChange: (e) => { const next = slots.slice(); next[i] = { ...s, to: e.target.value }; setSlots(next) },
                onBlur: () => saveSlots(slots),
              }),
              h('div', { style: S.dim }, '这段时间内每'),
              h('select', {
                style: { ...S.input, width: 80 },
                value: s.everyMinutes || 30,
                title: '隔多久叫一次（最小间隔）',
                onChange: (e) => { const next = slots.slice(); next[i] = { ...s, everyMinutes: Number(e.target.value) || 30 }; setSlots(next); saveSlots(next) },
              },
                [15, 30, 60, 120].map((m) => h('option', { key: m, value: m }, m + ' 分')),
              ),
              h('div', { style: S.dim }, '叫一次，最多'),
              h('input', {
                style: { ...S.input, width: 56 },
                type: 'number', min: 1, max: 24,
                value: s.dailyBudget || 2,
                title: '这段里一天最多叫几次',
                onChange: (e) => { const next = slots.slice(); next[i] = { ...s, dailyBudget: Math.min(24, Math.max(1, Number(e.target.value) || 1)) }; setSlots(next) },
                onBlur: () => saveSlots(slots),
              }),
              h('div', { style: S.dim }, '次/天'),
              h('select', {
                style: { ...S.input, width: 160 },
                value: s.session || '',
                onChange: (e) => { const next = slots.slice(); next[i] = { ...s, session: e.target.value }; setSlots(next); saveSlots(next) },
              },
                h('option', { key: '', value: '' }, '最近活跃的会话'),
                ((state && state.study && state.study.sessions) || [])
                  .map((x) => h('option', { key: x.id, value: x.id }, x.title || ('会话 ' + String(x.id).slice(-8)))),
                (s.session && !((state && state.study && state.study.sessions) || []).some((x) => x.id === s.session))
                  ? h('option', { key: 'cur', value: s.session }, '已选（这条会话现在没开着）')
                  : null,
              ),
              h('button', {
                style: { ...S.btn, color: C.warn },
                title: '删掉这一条（计数一起删）',
                onClick: () => { const next = slots.filter((x, k) => k !== i); setSlots(next); saveSlots(next) },
              }, '删'),
            ),
          ),
          h('div', { style: { ...S.dim, marginBottom: 6 } }, '到点只在选中的那条会话里说一句，读不读由它自己决定；默认关闭'),
          h('div', { style: { ...S.dim, marginBottom: 6 } }, '同时装着「鱼的心跳」的话，建议这条别勾——两边各叫各的，不会互相避让'),
          h('div', { style: S.dim }, studyLine(state && state.study)),
        ),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '导入一本书'),
          h('div', { style: S.row },
            h('button', {
              style: S.btnOn,
              onClick: () => {
                const el = document.getElementById('dsh-read-pick')
                if (el) el.click()
              },
            }, '选择文件…'),
            h('input', {
              id: 'dsh-read-pick',
              type: 'file',
              accept: '.txt,.md,text/plain',
              style: { display: 'none' },
              onChange: (e) => {
                const f = e.target.files && e.target.files[0]
                if (!f) return
                setMsg('读取 ' + f.name + '…')
                const rd2 = new FileReader()
                rd2.onload = async () => {
                  try {
                    const buf = new Uint8Array(rd2.result)
                    let bin = ''
                    const CH = 0x8000
                    for (let i = 0; i < buf.length; i += CH) {
                      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH))
                    }
                    const data = btoa(bin)
                    setMsg('导入中…', 'imp')
                    const r = await fetch('/dsh-reading.importText', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, data }) })
                    const j = await r.json()
                    if (!j.ok) { setMsg('失败：' + (j.error || '未知'), 'imp'); return }
                    setMsg('已导入 ' + (j.id || '') + '（' + (j.chapters || 0) + ' 章）', 'imp')
                    await load()
                  } catch (err) { setMsg('失败：' + String(err)) }
                }
                rd2.readAsArrayBuffer(f)
                e.target.value = ''
              },
            }),
            h('div', { style: S.dim }, '点左边选文件，或把完整路径粘在下面'),
          ),
          h('div', { style: S.row },
            h('input', {
              style: { ...S.input, width: 300 },
              placeholder: 'D:\\...\\书名.txt 或 .md',
              onChange: (e) => { importPath = e.target.value },
            }),
            h('button', {
              style: S.btnOn,
              onClick: async () => {
                const p = String(importPath || '').trim()
                if (!p) { setMsg('先填文件路径', 'imp'); return }
                setMsg('导入中…', 'imp')
                try {
                  const r = await fetch('/dsh-reading.import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
                  const j = await r.json()
                  if (!j.ok) { setMsg('失败：' + (j.error || '未知'), 'imp'); return }
                  setMsg('已导入 ' + (j.id || '') + '（' + (j.chapters || 0) + ' 章）', 'imp')
                  importPath = ''
                  await load()
                } catch (e) { setMsg('失败：' + String(e), 'imp') }
              },
            }, '导入'),
          ),
          msgAt === 'imp' ? h('div', { style: { ...S.dim, color: C.ok, marginTop: 4 } }, msg) : null,
          h('div', { style: S.dim }, '只认 .txt / .md，会复制到书架并统计章数。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '写作'),
          h('div', { style: S.row },
            h('div', null, '开启写作功能'),
            h('button', { style: (cfg && cfg.writing) ? S.btnOn : S.btn, onClick: () => saveCfg({ writing: !(cfg && cfg.writing) }) }, (cfg && cfg.writing) ? '已开启' : '已关闭'),
            h('div', { style: S.dim }, '关掉后我只读书，不写东西'),
          ),
        ),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '备份 / 恢复'),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: async () => {
              setBusy(true)
              setMsg('正在打包…', 'bak')
              try {
                const r = await fetch('/dsh-reading.backupFile', { method: 'POST' }).then((x) => x.json())
                if (r && r.ok) {
                  setLastBackup(r.path)
                  setMsg('已备份到 ' + r.path, 'bak')
                  fetch('/dsh-reading.reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: r.path }) }).catch(() => {})
                } else setMsg('备份失败：' + ((r && r.error) || '未知'), 'bak')
              } catch (e) {
                setMsg('备份失败：' + String(e), 'bak')
              } finally { setBusy(false) }
            } }, '备份全部数据'),
            h('button', { style: S.btn, onClick: () => { if (!lastBackup) { setMsg('先点一次备份', 'bak'); return } reveal(lastBackup) } }, '在文件夹里打开'),
          ),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('button', { style: S.btn, onClick: async () => {
              setBusy(true)
              setMsg('正在读取备份…', 'bak')
              try {
                let path = (restorePath || '').trim()
                if (!path) {
                  const pick = await fetch('/dsh-reading.pickFile', { method: 'POST' }).then((x) => x.json()).catch(() => null)
                  if (pick && pick.ok && pick.path) { path = pick.path; setRestorePath(path) }
                }
                if (!path) { setMsg('先点「选择备份文件」，或把完整路径填在下面的框里', 'bak'); return }
                const f = await fetch('/dsh-reading.readFile?path=' + encodeURIComponent(path)).then((x) => x.json())
                if (!f || !f.ok) { setMsg('读不到那个文件：' + ((f && f.error) || '未知'), 'bak'); return }
                const r = await fetch('/dsh-reading.restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: f.text }) }).then((x) => x.json())
                if (r && r.ok) { setMsg('已恢复：' + (r.books || 0) + ' 本 · ' + (r.chapters || 0) + ' 段读后感', 'bak'); await load() }
                else setMsg('恢复失败：' + ((r && r.error) || '未知'), 'bak')
              } catch (e) {
                setMsg('恢复失败：' + String(e), 'bak')
              } finally { setBusy(false) }
            } }, '恢复全部数据'),
          ),          msgAt === 'bak' ? h('div', { style: { ...S.dim, color: C.ok, marginTop: 4 } }, msg) : null,
          h('div', { style: { ...S.dim, marginTop: 6 } }, '备份 = 读后感全文 + 阅读进度，存成一个 .json 文件；恢复时在弹出的窗口里选那个文件。恢复前旧文件会存成 *bak-restore-*。'),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '单独想拿文字的话：' , h('span', { style: { cursor: 'pointer', textDecoration: 'underline' }, onClick: () => { copy(raw); setMsg('读后感全文已复制') } }, '复制读后感'), ' · ', h('span', { style: { cursor: 'pointer', textDecoration: 'underline' }, onClick: () => { copy(JSON.stringify(state, null, 2)); setMsg('进度 JSON 已复制') } }, '复制进度')),
        ),
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
            h('div', { style: { fontWeight: 600 } }, '更新'),
            h('div', { style: { ...S.dim, fontSize: 12 } }, 'v' + ((upd && upd.current) || (state && state.version) || '')),
            (upd && upd.latest) ? h('div', { style: { fontSize: 12, color: upd.outdated ? C.warn : C.ok } }, 'npm 最新 ' + upd.latest) : null,
          ),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: async () => {
              setBusy(true)
              try {
                const r = await fetch('/dsh-reading.update').then((x) => x.json())
                if (r && r.ok) {
                  const d = new Date()
                  const pad = (n) => String(n).padStart(2, '0')
                  setUpd({ ...r, at: pad(d.getHours()) + ':' + pad(d.getMinutes()) })
                  setMsg(r.outdated
                    ? ('发现新版本 ' + r.latest + '：可以点「复制更新命令」，在终端里跑')
                    : (r.latest ? ('已是最新版 ' + r.current + '，不用更新') : '查不到 npm（可能离线），稍后再试'), 'upd')
                } else setMsg('检测失败：' + ((r && r.error) || '未知'), 'upd')
              } catch (e) {
                setMsg('检测失败：' + String((e && e.message) || e), 'upd')
              } finally { setBusy(false) }
            } }, '检测更新'),
            h('button', { style: S.btn, onClick: () => { copy('dsh plugin add dsh-half-page@latest'); setMsg('更新命令已复制', 'upd') } }, '复制更新命令'),
          ),
          msgAt === 'upd' ? h('div', { style: { ...S.dim, color: (upd && upd.outdated) ? C.warn : C.ok, marginTop: 4 } }, msg) : null,
          h('div', { style: { ...S.dim, marginTop: 4 } }, '更新就是把 npm 上的最新版装一遍；命令可以复制出去，在终端里跑。'),
        ),
      )

      const favTab = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '收藏'),
          favs.length ? favs.map((f, i) => {
            const isFile = String(f).startsWith('file:')
            const fpath = isFile ? f.slice(5) : ''
            const w = isFile && works && (works.files || []).find((x) => x.path === fpath)
            const who = w ? w.author : ''
            return h('div', { key: i, style: S.item },
            h('div', {
              style: { flex: 1, cursor: 'pointer', borderTop: i ? '1px solid ' + C.line : 'none', paddingTop: i ? 8 : 0 },
              onClick: () => openFav(f),
            }, String(f).startsWith('file:') ? f.slice(5) : f.replace('|', ' · ')),
            isFile ? h('div', { style: who ? S.dim : { ...S.dim, color: C.warn } }, who ? ('署名 · ' + who) : '未署名') : null,
            h('button', { style: S.btn, onClick: () => copyFav(f) }, '复制'),
            h('button', { style: S.btn, onClick: () => toggleFav(f) }, '取消收藏'),
            )
          }) : h('div', { style: S.dim }, '在读后感或作品上点 ☆，收藏的东西会出现在这儿。'),
        ),
        opened && String(opened.path || '').startsWith('fav:')
          ? h('div', { style: { ...S.text, marginTop: 0 } }, (opened.title ? opened.title + '\n\n' : '') + opened.text)
          : null,
      )

      const viewerLayer = viewer ? h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(10,14,22,0.86)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 10, padding: 20, cursor: 'zoom-out',
        },
        onClick: () => setViewer(null),
      },
        h('img', {
          src: viewer.url,
          alt: viewer.name,
          onClick: (e) => e.stopPropagation(),
          style: { maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 6, boxShadow: '0 12px 48px rgba(0,0,0,0.55)', background: '#fff', minWidth: 120, cursor: 'default' },
        }),
        h('div', { style: { color: '#e8eef8', fontSize: 12, textAlign: 'center', maxWidth: '90vw', wordBreak: 'break-all' } },
          viewer.name + (viewer.width && viewer.height ? ' · ' + viewer.width + '×' + viewer.height : '') + ' · ' + fmt(viewer.size) + '　（点空白或按 Esc 关闭）'),
        h('div', { style: { color: 'rgba(232,238,248,0.55)', fontSize: 11, maxWidth: '90vw', wordBreak: 'break-all' } }, viewer.rel || ''),
      ) : null

      return h('div', { style: S.wrap },
        head,
        tabs,
        tab === 'read' ? readTab : tab === 'note' ? noteTab : tab === 'works' ? worksTab : tab === 'fav' ? favTab : setTabView,
        viewerLayer,
      )
    }

    function Boundary(props) {
      try { return h(Panel, props) } catch (e) {
        return h('div', { style: { padding: 14, color: '#ff8080', fontSize: 12 } }, '半页出错了：' + String((e && e.message) || e))
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('conversation.view', () => slots.register({ name: 'conversation.view', id: 'reading', order: 42, label: '半页' }, (props) => h(Boundary, props)))
        slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'dsh-half-page', order: 66, label: '半页' }, () => h(Boundary)))
      },
    }
  },
})
