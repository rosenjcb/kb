// ---- Surface runtime errors ----------------------------------------------
// A swallowed exception in here (e.g. a strict-mode TypeError) used to freeze
// the whole UI silently. Log both channels so failures show up in the console
// instead of vanishing into an unhandled rejection.
addEventListener('error', e => console.error('[kb-demo] error:', e.error || e.message))
addEventListener('unhandledrejection', e => console.error('[kb-demo] unhandled:', e.reason))

// ---- Config (persisted in localStorage) ----------------------------------
const LS_KEY = 'kb-chat-settings.v1'
// Local `pnpm run demo` → localhost API. GitHub Pages → public Fly demo.
const isLocalDemo = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname)
const DEFAULT_SERVER_URL = isLocalDemo ? 'http://localhost:38117' : 'https://kb-demo.fly.dev'
const DEFAULTS = { serverUrl: DEFAULT_SERVER_URL, apiKey: '', base: '' }
const LEGACY_LOCAL_DEFAULT = 'http://localhost:38117'
function trimUrl(u) {
  return (u || '').trim().replace(/\/+$/, '')
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULTS }
    const merged = { ...DEFAULTS, ...JSON.parse(raw) }
    // Pages visitors who still have the old hardcoded localhost default → Fly.
    if (!isLocalDemo && trimUrl(merged.serverUrl || '') === LEGACY_LOCAL_DEFAULT) {
      merged.serverUrl = DEFAULT_SERVER_URL
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(merged))
      } catch {}
    }
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}
function saveSettings(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s))
}
let settings = loadSettings()
let sessionId = null // set by the server on the first turn, reused after

// ---- DOM refs ------------------------------------------------------------
const $ = id => document.getElementById(id)
const thread = $('thread')
const empty = $('empty')
const input = $('input')
const _sendBtn = $('send')
const form = $('composer')
const main = $('main')
const statusDot = $('statusDot')
const statusText = $('statusText')
const hint = $('hint')
const statusEl = $('status')

// ---- Helpers -------------------------------------------------------------
// Dogfood hardcode: static Pages demo has no volume registry. Server Slack uses
// discoverBaseRepos (per-slug gitUrl + primary branch) via formatChatReply.
const SOURCE_REPO = 'https://github.com/rosenjcb/kb'
const SOURCE_BRANCH = 'main'
function authHeaders(extra) {
  const h = { ...(extra || {}) }
  if (settings.apiKey.trim()) h.Authorization = `Bearer ${settings.apiKey.trim()}`
  if (settings.base.trim()) h['X-KB-Base'] = settings.base.trim()
  return h
}
/** Strip index base / git-repo prefix → repo-relative path, or null if not a file. */
function repoRelativePath(filePath) {
  let p = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (!p || p.startsWith('fact://') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null
  const base = settings.base.trim().replace(/\/+$/, '')
  if (base && (p === base || p.startsWith(`${base}/`))) {
    p = p.slice(base.length).replace(/^\//, '')
  }
  // Common indexed form: `<gitRepo>/<relPath>` (e.g. rosenjcb-kb/TESTING.md)
  if (/^(rosenjcb-kb|kb)\//.test(p)) p = p.replace(/^(rosenjcb-kb|kb)\//, '')
  p = p.replace(/#.*$/, '') // drop segment anchors
  return p || null
}
function sourceGithubUrl(filePath) {
  const rel = repoRelativePath(filePath)
  if (!rel) return null
  return `${SOURCE_REPO}/blob/${SOURCE_BRANCH}/${rel.split('/').map(encodeURIComponent).join('/')}`
}
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}
function applyInlineMarkdown(s) {
  // Already HTML-escaped. Order: code → bold → italic → links.
  return (
    s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic: avoid turning list markers (`* item`) into <em>.
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>')
      .replace(
        /\[([^\]]+)\]\((https?:[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      )
  )
}
/**
 * Tiny safe markdown → HTML for chat bubbles (no deps).
 * Supports: ATX headers, GFM tables, fenced code, inline code, bold/italic,
 * links, ul/ol, paragraphs. Fence placeholders avoid colliding with digits.
 */
function renderMarkdown(src) {
  const FENCE = '\uE000'
  const fences = []
  let text = String(src || '').replace(/\r\n?/g, '\n')
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const i = fences.length
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return `\n${FENCE}${i}${FENCE}\n`
  })

  const lines = text.split('\n')
  const out = []
  let i = 0

  function isFence(line) {
    const m = new RegExp(`^${FENCE}(\\d+)${FENCE}$`).exec(line.trim())
    return m ? fences[+m[1]] : null
  }
  function isBlank(line) {
    return /^\s*$/.test(line)
  }
  function isUl(line) {
    return /^\s*[-*]\s+/.test(line)
  }
  function isOl(line) {
    return /^\s*\d+\.\s+/.test(line)
  }
  function isHeading(line) {
    return /^(#{1,6})\s+(.+)$/.exec(line)
  }
  function isTableRow(line) {
    const t = line.trim()
    return t.startsWith('|') && t.indexOf('|', 1) !== -1
  }
  // GFM separator: | :--- | :---: | ---: | --- |
  function isTableSep(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
  }
  function splitTableCells(line) {
    let t = line.trim()
    if (t.startsWith('|')) t = t.slice(1)
    if (t.endsWith('|')) t = t.slice(0, -1)
    return t.split('|').map(c => c.trim())
  }
  function startsTable(idx) {
    return isTableRow(lines[idx]) && idx + 1 < lines.length && isTableSep(lines[idx + 1])
  }
  function inline(line) {
    return applyInlineMarkdown(escapeHtml(line))
  }

  while (i < lines.length) {
    const line = lines[i]
    const fenceHtml = isFence(line)
    if (fenceHtml != null) {
      out.push(fenceHtml)
      i++
      continue
    }
    if (isBlank(line)) {
      i++
      continue
    }

    const heading = isHeading(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      i++
      continue
    }

    if (startsTable(i)) {
      const headers = splitTableCells(lines[i])
      i += 2 // skip header + separator
      const rows = []
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitTableCells(lines[i]))
        i++
      }
      let table = '<div class="table-wrap"><table><thead><tr>'
      for (const h of headers) table += `<th>${inline(h)}</th>`
      table += '</tr></thead><tbody>'
      for (const row of rows) {
        table += '<tr>'
        for (let c = 0; c < headers.length; c++) {
          table += `<td>${inline(row[c] || '')}</td>`
        }
        table += '</tr>'
      }
      table += '</tbody></table></div>'
      out.push(table)
      continue
    }

    if (isUl(line)) {
      const items = []
      while (i < lines.length && isUl(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    if (isOl(line)) {
      const items = []
      while (i < lines.length && isOl(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    const para = []
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !startsTable(i) &&
      !isUl(lines[i]) &&
      !isOl(lines[i])
    ) {
      para.push(inline(lines[i]))
      i++
    }
    out.push(`<p>${para.join('<br>')}</p>`)
  }

  return out.join('') || '<p></p>'
}
function scrollDown() {
  main.scrollTop = main.scrollHeight
}

// ---- Message rendering ---------------------------------------------------
function addUserMessage(text) {
  empty.style.display = 'none'
  const el = document.createElement('div')
  el.className = 'msg user'
  el.innerHTML = '<div class="avatar">You</div><div class="bubble"></div>'
  el.querySelector('.bubble').textContent = text
  thread.appendChild(el)
  scrollDown()
}
// Returns a controller for the assistant turn currently streaming.
function addAssistantMessage() {
  empty.style.display = 'none'
  const el = document.createElement('div')
  el.className = 'msg assistant'
  el.innerHTML =
    '<div class="avatar" aria-label="KB">KB</div>' +
    '<div class="bubble"><div class="pending">' +
    '<div class="status-line"><span class="typing"><span></span><span></span><span></span></span></div>' +
    '</div></div>'
  thread.appendChild(el)
  scrollDown()
  const bubble = el.querySelector('.bubble')
  // Keep stage (meta) and thinking (reasoning) in separate slots — stages used to
  // overwrite model thinking when both shared one status line.
  let stageText = ''
  let thinkingText = ''
  function renderPending() {
    let html = '<div class="pending">'
    html +=
      '<div class="status-line"><span class="typing"><span></span><span></span><span></span></span></div>'
    if (stageText) html += `<div class="stage">${escapeHtml(stageText)}</div>`
    if (thinkingText) {
      html += `<div class="thinking"><div class="thinking-label">Thinking</div>${escapeHtml(thinkingText)}</div>`
    }
    html += '</div>'
    bubble.innerHTML = html
    const thinkEl = bubble.querySelector('.thinking')
    if (thinkEl) thinkEl.scrollTop = thinkEl.scrollHeight
    scrollDown()
  }
  return {
    setStage(txt) {
      stageText = (txt || '').trim()
      renderPending()
    },
    setThinking(txt) {
      thinkingText = (txt || '').trim()
      renderPending()
    },
    setAnswer(txt, sources) {
      bubble.innerHTML = renderMarkdown(txt || '_(no answer)_')
      if (sources?.length) {
        const s = document.createElement('div')
        s.className = 'sources'
        const seen = new Set()
        const unique = []
        for (const src of sources) {
          const raw = src.filePath || src.title || src.id || 'unknown'
          const rel = repoRelativePath(raw) || raw
          const key = (rel + (src.symbol ? `#${src.symbol}` : '')).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          unique.push(src)
        }
        s.innerHTML = `<div class="label">Sources</div>${unique
          .map((src, i) => {
            const raw = src.filePath || src.title || src.id || 'unknown'
            const rel = repoRelativePath(raw) || raw
            const href = sourceGithubUrl(raw)
            const sym = src.symbol ? ` <span class="sym">· ${escapeHtml(src.symbol)}</span>` : ''
            const pathHtml = href
              ? `<a class="path" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(rel)}</a>`
              : `<span class="path">${escapeHtml(rel)}</span>`
            return `<div class="source"><span class="num">${i + 1}.</span>${pathHtml}${sym}</div>`
          })
          .join('')}`
        bubble.appendChild(s)
      }
      scrollDown()
    },
    setError(title, detail) {
      bubble.innerHTML = `<div class="err"><b>${escapeHtml(title)}</b>${detail ? `<br><code>${escapeHtml(detail)}</code>` : ''}</div>`
      scrollDown()
    },
  }
}

// ---- SSE chat call -------------------------------------------------------
// First-boot bootstrap 503s chat (like Slack). Hourly reindex does not — chat stays up.
async function postChat(message) {
  return fetch(`${trimUrl(settings.serverUrl)}/v1/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
  })
}

/** Poll /healthz until bootstrap finishes (Slack's waitForBootstrap). */
async function waitForBootstrap(turn, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const h = await probeConnection(settings.serverUrl, authHeaders())
    applyHealthStatus(h)
    if (h.state === 'failed') {
      turn.setError('Index build failed', h.bootstrapError || 'bootstrap failed')
      return false
    }
    if (h.state === 'unauthorized') {
      turn.setError(
        'Unauthorized (401)',
        h.detail || 'API key missing or wrong. Fix it in ⚙ Settings.'
      )
      return false
    }
    if (h.state === 'unknown_base') {
      turn.setError('Unknown base', h.detail || 'That base is not on this server.')
      return false
    }
    if (h.state === 'ready') return true
    // Match Slack formatBootstrapSlackNotice wording.
    const prog = h.progress ? `\nCurrent progress: ${h.progress}` : ''
    turn.setStage(
      `KB is still indexing its knowledge base.${prog}\nI will reply with the answer once indexing is complete.`
    )
    await sleep(4000)
  }
  turn.setError('Still indexing', 'Timed out waiting for the first index. Try again in a minute.')
  return false
}

async function sendChat(message) {
  const turn = addAssistantMessage()
  // If /healthz already says first-boot indexing, wait like Slack before chat.
  const pre = await probeConnection(settings.serverUrl, authHeaders(), {
    healthTimeoutMs: 4000,
    authTimeoutMs: 2000,
  })
  applyHealthStatus(pre)
  if (pre.state === 'indexing') {
    const prog = pre.progress ? `\nCurrent progress: ${pre.progress}` : ''
    turn.setStage(
      `KB is still indexing its knowledge base.${prog}\nI will reply with the answer once indexing is complete.`
    )
    const ready = await waitForBootstrap(turn, 10 * 60 * 1000)
    if (!ready) return
    turn.setStage('Index ready — answering…')
  }
  let res
  try {
    res = await postChat(message)
  } catch (_e) {
    // First-boot can drop TCP while the event loop is saturated — treat like
    // Slack's indexing wait instead of failing the turn immediately.
    turn.setStage(
      'KB is still indexing its knowledge base.\nI will reply with the answer once indexing is complete.'
    )
    const ready = await waitForBootstrap(turn, 10 * 60 * 1000)
    if (!ready) return
    turn.setStage('Index ready — answering…')
    try {
      res = await postChat(message)
    } catch (e2) {
      turn.setError("Couldn't reach the server", describeNetworkError(e2))
      return
    }
  }
  if (res.status === 401) {
    turn.setError(
      'Unauthorized (401)',
      'API key missing or wrong. Set KB_SERVER_API_KEY in ⚙ Settings.'
    )
    setStatus('bad', 'Unauthorized')
    return
  }
  if (res.status === 404) {
    let body = {}
    try {
      body = await res.json()
    } catch {}
    if (body.status === 'unknown_base' || /unknown base/i.test(body.error || '')) {
      turn.setError(
        'Unknown base',
        body.error || 'That base is not on this server. Check ⚙ Settings → Base.'
      )
      setStatus('bad', 'Unknown base')
      return
    }
  }
  if (res.status === 503) {
    let body = {}
    try {
      body = await res.json()
    } catch {}
    const indexing = body.status === 'indexing' || /index/i.test(body.error || '')
    if (indexing) {
      // Match Slack formatBootstrapSlackNotice + wait + then answer.
      const prog = body.progress ? `\nCurrent progress: ${body.progress}` : ''
      turn.setStage(
        `KB is still indexing its knowledge base.${prog}\nI will reply with the answer once indexing is complete.`
      )
      const ready = await waitForBootstrap(turn, 10 * 60 * 1000)
      if (!ready) return
      turn.setStage('Index ready — answering…')
      try {
        res = await postChat(message)
      } catch (e) {
        turn.setError("Couldn't reach the server", describeNetworkError(e))
        return
      }
      if (res.status === 503) {
        let msg = 'Server is still unavailable after indexing.'
        try {
          const b = await res.json()
          msg = b.error || msg
        } catch {}
        turn.setError('Service unavailable (503)', msg)
        return
      }
    } else {
      let msg = body.error || 'Server is unavailable.'
      if (body.progress) msg += ` (${body.progress})`
      turn.setError('Service unavailable (503)', msg)
      return
    }
  }
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`
    try {
      const b = await res.json()
      if (b.error) detail = b.error
    } catch {}
    turn.setError('Request failed', detail)
    return
  }

  // Parse the SSE stream: blocks separated by \n\n, each with event:/data: lines.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let answered = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (;;) {
        const idx = buf.indexOf('\n\n')
        if (idx === -1) break
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseSseBlock(raw)
        if (!ev) continue
        if (ev.event === 'session' && ev.data.sessionId) sessionId = ev.data.sessionId
        else if (ev.event === 'meta') {
          if (!answered) turn.setStage(ev.data.text || '')
        } else if (ev.event === 'reasoning') {
          if (!answered) turn.setThinking(ev.data.text || 'Thinking…')
        } else if (ev.event === 'answer') {
          answered = true
          turn.setAnswer(ev.data.text, ev.data.sources)
        } else if (ev.event === 'error') {
          turn.setError('The server returned an error', ev.data.message || 'unknown error')
          answered = true
        }
        // 'done' → stream ends
      }
    }
    if (!answered) turn.setError('No answer', 'The server closed the stream without an answer.')
  } catch (e) {
    if (!answered) turn.setError('Stream interrupted', describeNetworkError(e))
  }
}

function parseSseBlock(raw) {
  let event = 'message'
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return { event, data: {} }
  }
}

function describeNetworkError(e) {
  const msg = e?.message || String(e)
  const mixed =
    location.protocol === 'https:' &&
    trimUrl(settings.serverUrl).startsWith('http://') &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(trimUrl(settings.serverUrl))
  if (mixed)
    return 'This page is served over HTTPS but the server URL is HTTP. Browsers block that (mixed content). Use an HTTPS server URL.'
  return `${msg} — check the URL, that the server is running, and that it allows this origin (CORS: start kb-server with --allow-origin ${location.origin}).`
}

// ---- Health check --------------------------------------------------------
// /healthz is always HTTP 200 when reachable (liveness). Readiness is in the
// body: ok / indexing / reindexing. First-boot: ok=false + indexing. Hourly
// reindex: ok=true + reindexing — chat stays up (no 503).
let healthTimer = null
let healthGen = 0
let lastHealthKind = null // avoid flashing "Checking…" over a known-good Connected
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchJson(url, headers, timeoutMs) {
  const ctrl = new AbortController()
  let timer
  // Explicit race — don't rely on AbortSignal alone (embeds can be flaky).
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(new Error('timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { headers, signal: ctrl.signal })
        const body = await res.json().catch(() => ({}))
        return { res, body }
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fast connection probe:
 *  1) /healthz — body flags (indexing / ok); unknown base → 404
 *  2) GET /v1/bases — auth check (401 when key missing/wrong)
 *
 * Readiness comes from the JSON body, not the HTTP status (/healthz is always
 * 200 when the process answers).
 *
 * opts.healthTimeoutMs / opts.authTimeoutMs override the default budgets.
 */
async function probeConnection(url, headers, opts) {
  const healthTimeoutMs = opts?.healthTimeoutMs || 15000
  const authTimeoutMs = opts?.authTimeoutMs || 4000
  const base = trimUrl(url)
  let health
  try {
    health = await fetchJson(`${base}/healthz`, headers, healthTimeoutMs)
  } catch {
    return { state: 'offline' }
  }
  const { res, body } = health
  if (res.status === 404 || body.status === 'unknown_base') {
    return {
      state: 'unknown_base',
      detail: body.error || `Unknown base (HTTP ${res.status})`,
      progress: '',
    }
  }
  if (body.bootstrapError) {
    return {
      state: 'failed',
      bootstrapError: body.bootstrapError,
      progress: body.bootstrapProgress || '',
    }
  }
  // Body is source of truth — do not treat HTTP status as readiness.
  const indexing = body.indexing === true
  const reindexing = !!body.reindexing
  const progress = body.bootstrapProgress || body.progress || ''

  // Auth probe — short timeout; 401/200 come back immediately on a live server.
  try {
    const auth = await fetchJson(`${base}/v1/bases`, headers, authTimeoutMs)
    if (auth.res.status === 401) {
      return {
        state: 'unauthorized',
        detail: auth.body.error || 'unauthorized',
        progress,
        reindexing,
      }
    }
  } catch {
    // If auth probe times out during heavy index, fall through on health alone.
  }

  if (indexing) return { state: 'indexing', progress, reindexing }
  if (body.ok === true) return { state: 'ready', progress: '', reindexing }
  // Reachable JSON but not ready and not indexing (rare race before flag flips).
  if (res.ok) return { state: 'indexing', progress: progress || 'Starting index…', reindexing }
  return { state: 'bad', progress: '', status: res.status }
}

function applyHealthStatus(h) {
  if (h.state === 'ready') {
    setStatus('ok', h.reindexing ? 'Connected · syncing' : 'Connected')
    return
  }
  if (h.state === 'indexing') {
    const short = h.progress ? truncateStatus(`Indexing… ${h.progress}`, 42) : 'Indexing…'
    setStatus('wait', short)
    return
  }
  if (h.state === 'unauthorized') {
    setStatus('bad', 'Unauthorized — check API key')
    return
  }
  if (h.state === 'unknown_base') {
    setStatus('bad', 'Unknown base')
    return
  }
  if (h.state === 'failed') setStatus('bad', 'Index failed')
  // Timeout/refused — may still be CPU-bound; keep amber, not hard Offline.
  else if (h.state === 'offline') setStatus('wait', 'Busy / unreachable…')
  else setStatus('bad', 'Unreachable')
}

// Same state → message mapping as applyHealthStatus, but returns a value so the
// "Test connection" button can render inline feedback without touching the pill.
function describeHealth(h) {
  switch (h.state) {
    case 'ready':
      return { kind: 'ok', text: h.reindexing ? 'Connected · syncing' : 'Connected' }
    case 'indexing':
      return {
        kind: 'wait',
        text: h.progress ? truncateStatus(`Indexing… ${h.progress}`, 40) : 'Indexing…',
      }
    case 'unauthorized':
      return { kind: 'bad', text: 'Unauthorized — check API key' }
    case 'unknown_base':
      return { kind: 'bad', text: 'Unknown base' }
    case 'failed':
      return { kind: 'bad', text: 'Index failed' }
    case 'offline':
      return { kind: 'wait', text: 'Unreachable (offline / CORS / timeout)' }
    default:
      return {
        kind: 'bad',
        text: h.status ? `Server error (HTTP ${h.status})` : 'Server error',
      }
  }
}

function truncateStatus(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

async function checkHealth() {
  const gen = ++healthGen
  if (healthTimer) {
    clearTimeout(healthTimer)
    healthTimer = null
  }
  // Only flash "Checking…" when we don't already know we're connected.
  if (lastHealthKind !== 'ok') setStatus('wait', 'Checking…')
  const h = await probeConnection(settings.serverUrl, authHeaders())
  if (gen !== healthGen) return // superseded by a newer check
  applyHealthStatus(h)
  // Keep polling through first-boot index (and brief offline blips while Fly boots).
  // Do NOT keep polling hard config errors (401 / unknown base) — surface them once.
  if (h.state === 'indexing' || h.state === 'offline') {
    healthTimer = setTimeout(() => {
      checkHealth()
    }, 4000)
  }
}
function setStatus(kind, text) {
  lastHealthKind = kind
  statusDot.className = `dot ${kind}`
  statusText.textContent = text
  statusEl.title = text
}

// ---- Events --------------------------------------------------------------
function autoGrow() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`
}
input.addEventListener('input', autoGrow)
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    form.requestSubmit()
  }
})
form.addEventListener('submit', e => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  autoGrow()
  addUserMessage(text)
  sendChat(text)
})
// Starter chips — copied from eval/suites/kb.yaml (dogfood pack). Later each
// suite may become a selectable base; for now these are static strings only.
// Skips the intentional out-of-scope Kubernetes trap question.
const SUGGESTIONS = [
  'What problem does kb solve, and what is the normal workflow for setting up indexing and querying a knowledge base?',
  'How are markdown documents turned into import_doc facts during indexing?',
  'How does code indexing work at a high level, including the role of the tree-sitter indexer?',
  'How does kb query retrieve evidence from facts, FTS/vector scoring, and graph relationships?',
  "Does kb send my repository's code or documents to a remote server to build the knowledge base, or does indexing happen locally?",
  "Step by step, how does one interactive chat turn work, from the user's message through retrieval to the synthesized reply?",
]
{
  const box = $('suggestions')
  for (const q of SUGGESTIONS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = q
    box.appendChild(b)
  }
  box.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON') {
      input.value = e.target.textContent
      form.requestSubmit()
    }
  })
}

// Theme
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('kb-chat-theme', t)
}
$('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
})
applyTheme(localStorage.getItem('kb-chat-theme') || 'dark')

// Settings dialog
const dlg = $('settings')
const testBtn = $('testBtn')
const testResult = $('testResult')
function setTestResult(kind, text) {
  testResult.className = `test-result${kind ? ` ${kind}` : ''}`
  testResult.textContent = text
}
function openSettings() {
  setTestResult('', '') // clear stale result from a previous open
  $('serverUrl').value = settings.serverUrl
  $('serverUrl').placeholder = DEFAULT_SERVER_URL
  $('serverUrlHelp').innerHTML =
    `The base URL of your running <code>kb-server</code>. Default here: <code>${escapeHtml(DEFAULT_SERVER_URL)}</code>${
      isLocalDemo
        ? ' (local demo). Hosted Pages defaults to <code>https://kb-demo.fly.dev</code>.'
        : ' (GitHub Pages → Fly).'
    }`
  $('apiKey').value = settings.apiKey
  $('base').value = settings.base
  dlg.showModal()
}
$('settingsBtn').addEventListener('click', openSettings)
// Test the values currently typed in the dialog (which may be unsaved) without
// committing them, and report the result inline. Does not disturb the live pill.
testBtn.addEventListener('click', async () => {
  const url = trimUrl($('serverUrl').value) || DEFAULTS.serverUrl
  const headers = {}
  const key = $('apiKey').value.trim()
  const base = $('base').value.trim()
  if (key) headers.Authorization = `Bearer ${key}`
  if (base) headers['X-KB-Base'] = base
  testBtn.disabled = true
  setTestResult('wait', 'Testing…')
  try {
    const d = describeHealth(await probeConnection(url, headers))
    setTestResult(d.kind, d.text)
  } catch (err) {
    setTestResult('bad', `Test failed: ${err?.message ? err.message : String(err)}`)
  } finally {
    testBtn.disabled = false
  }
})
$('saveBtn').addEventListener('click', e => {
  e.preventDefault()
  settings = {
    serverUrl: trimUrl($('serverUrl').value) || DEFAULTS.serverUrl,
    apiKey: $('apiKey').value.trim(),
    base: $('base').value.trim(),
  }
  saveSettings(settings)
  sessionId = null // new connection → new session
  dlg.close()
  checkHealth()
})

// Init
hint.innerHTML = `Server: <code>${escapeHtml(settings.serverUrl)}</code> — change in ⚙ settings. Press Enter to send, Shift+Enter for a newline.`
checkHealth()
input.focus()
