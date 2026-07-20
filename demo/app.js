// ---- Surface runtime errors ----------------------------------------------
// A swallowed exception in here (e.g. a strict-mode TypeError) used to freeze
// the whole UI silently. Log both channels so failures show up in the console
// instead of vanishing into an unhandled rejection.
addEventListener('error', e => console.error('[kb-demo] error:', e.error || e.message))
addEventListener('unhandledrejection', e => console.error('[kb-demo] unhandled:', e.reason))

// ---- Config --------------------------------------------------------------
// The server URL and the optional API key are both BAKED into the page
// (demo/config.js → window.__KB_SERVER__ / window.__KB_API_KEY__) — there is no
// settings dialog. The knowledge base is chosen from the header picker, driven by
// the server's own /v1/bases list.
function trimUrl(u) {
  return (u || '').trim().replace(/\/+$/, '')
}
const FLY_DEFAULT_URL = 'https://kb-demo.fly.dev'
const isLocalDemo = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname)
const BAKED_SERVER_URL = trimUrl(typeof window !== 'undefined' ? window.__KB_SERVER__ || '' : '')
// scripts/demo-serve.mjs sets this when KB_DEMO_SERVER_URL is passed, so local
// dev can explicitly opt into a deployed server (incl. the Fly default) instead
// of falling back to localhost below.
const FORCE_BAKED = typeof window !== 'undefined' && window.__KB_SERVER_FORCE__ === true
// Local `pnpm run demo` talks to a localhost server unless the page was baked
// with a non-default URL; hosted copies always use the baked (or Fly) URL.
const SERVER_URL =
  isLocalDemo && !FORCE_BAKED && (!BAKED_SERVER_URL || BAKED_SERVER_URL === FLY_DEFAULT_URL)
    ? 'http://localhost:38117'
    : BAKED_SERVER_URL || FLY_DEFAULT_URL

const LS_BASE = 'kb-chat-base.v1'
// The API key is BAKED into the page (demo/config.js → window.__KB_API_KEY__),
// not typed into a settings dialog. Empty ⇒ unauthenticated (public demo default).
const apiKey = ((typeof window !== 'undefined' && window.__KB_API_KEY__) || '').trim()

// Currently selected knowledge base (server slug) + the /v1/bases metadata that
// backs the header picker and per-base source links.
let currentBase = ''
let defaultBase = ''
/** name → [{ slug, url, branch }] built from /v1/bases (for source blob links). */
let baseRepos = {}
let baseNames = []

let sessionId = null // set by the server on the first turn, reused after
/** Bumped on "new chat" so an in-flight turn stops updating the cleared thread. */
let chatEpoch = 0
/** Abort the active /v1/chat fetch when starting a new session. */
let chatAbort = null

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
const basePicker = $('basePicker')
const baseSelect = $('baseSelect')
const emptyTitle = $('emptyTitle')
const emptyRepo = $('emptyRepo')
const emptyRepoLink = $('emptyRepoLink')

// The server's own dogfood base is literally named "demo" — show it as "kb" so
// it isn't mistaken for a target codebase (every other base names a real repo).
function displayBaseName(base) {
  return base === 'demo' ? 'kb' : base
}

/** Keep the empty-state title, repo link, and tab title honest about which
 *  codebase (not the KB tool itself) the selected base is asking about. */
function renderEmptyHeader() {
  if (currentBase) {
    emptyTitle.innerHTML = `Ask KB anything about the <b>${escapeHtml(displayBaseName(currentBase))}</b> codebase`
  } else {
    emptyTitle.textContent = 'Ask KB anything about the codebase'
  }
  const repo = (baseRepos[currentBase] || [])[0]
  if (repo?.url) {
    emptyRepoLink.href = repo.url
    emptyRepoLink.textContent = repo.url
    emptyRepo.hidden = false
  } else {
    emptyRepo.hidden = true
  }
  document.title = currentBase ? `KB — ${displayBaseName(currentBase)} chat` : 'KB — try the chat'
}

/** Clear the thread and drop the server session id (theme / base stay). */
function startNewChat() {
  chatEpoch++
  if (chatAbort) {
    chatAbort.abort()
    chatAbort = null
  }
  sessionId = null
  thread.replaceChildren()
  empty.style.display = ''
  input.value = ''
  input.disabled = false
  _sendBtn.disabled = false
  main.scrollTop = 0
  input.focus()
}

// ---- Helpers -------------------------------------------------------------
function authHeaders(extra) {
  const h = { ...(extra || {}) }
  if (apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
  if (currentBase.trim()) h['X-KB-Base'] = currentBase.trim()
  return h
}

// Source links are per-base: the server's /v1/bases advertises each base's repos
// (slug → browse url + branch), so a source's `gitRepo` slug maps to the right
// GitHub blob URL for whichever base is selected.
function reposForCurrentBase() {
  return baseRepos[currentBase] || []
}
/** Pick the repo a source belongs to: by gitRepo slug, else sole repo, else path segment. */
function repoForSource(src) {
  const repos = reposForCurrentBase()
  if (!repos.length) return null
  if (src?.gitRepo) {
    const match = repos.find(r => r.slug === src.gitRepo)
    if (match) return match
  }
  if (repos.length === 1) return repos[0]
  const seg = String(src?.filePath || '')
    .replace(/^\.\//, '')
    .split('/')[0]
  return repos.find(r => r.slug === seg) || null
}
/** Strip the git-repo slug prefix → repo-relative path, or null if not a file. */
function relPathForSource(filePath, repo) {
  let p = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (!p || p.startsWith('fact://') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null
  if (repo?.slug && (p === repo.slug || p.startsWith(`${repo.slug}/`))) {
    p = p.slice(repo.slug.length).replace(/^\//, '')
  }
  p = p.replace(/#.*$/, '') // drop segment anchors
  return p || null
}
/** Repo-relative label shown for a source (falls back to the raw path). */
function sourceLabel(src) {
  const raw = (src && (src.filePath || src.title || src.id)) || 'unknown'
  const rel = relPathForSource(raw, repoForSource(src))
  return rel || raw
}
/** GitHub (or other) blob URL for a source in the current base, or null. */
function sourceGithubUrl(src) {
  const repo = repoForSource(src)
  if (!repo || !repo.url) return null
  const rel = relPathForSource(src?.filePath || '', repo)
  if (!rel) return null
  const branch = repo.branch || 'HEAD'
  return `${repo.url}/blob/${branch}/${rel.split('/').map(encodeURIComponent).join('/')}`
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
          const rel = sourceLabel(src)
          const key = (rel + (src.symbol ? `#${src.symbol}` : '')).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          unique.push(src)
        }
        s.innerHTML = `<div class="label">Sources</div>${unique
          .map((src, i) => {
            const rel = sourceLabel(src)
            const href = sourceGithubUrl(src)
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
// First-boot bootstrap 503s chat (like Slack). Scheduled reindex does not — chat stays up.
async function postChat(message, signal) {
  return fetch(`${trimUrl(SERVER_URL)}/v1/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    signal,
  })
}

/** Poll /healthz until bootstrap finishes (Slack's waitForBootstrap). */
async function waitForBootstrap(turn, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const h = await probeConnection(SERVER_URL, authHeaders())
    applyHealthStatus(h)
    if (h.state === 'failed') {
      turn.setError('Index build failed', h.bootstrapError || 'bootstrap failed')
      return false
    }
    if (h.state === 'unauthorized') {
      turn.setError(
        'Unauthorized (401)',
        h.detail || 'API key missing or wrong. Bake the right key into demo/config.js.'
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
  const epoch = chatEpoch
  if (chatAbort) chatAbort.abort()
  chatAbort = new AbortController()
  const { signal } = chatAbort
  const stillCurrent = () => epoch === chatEpoch
  const turn = addAssistantMessage()
  // If /healthz already says first-boot indexing, wait like Slack before chat.
  const pre = await probeConnection(SERVER_URL, authHeaders(), {
    healthTimeoutMs: 4000,
    authTimeoutMs: 2000,
  })
  if (!stillCurrent()) return
  applyHealthStatus(pre)
  if (pre.state === 'indexing') {
    const prog = pre.progress ? `\nCurrent progress: ${pre.progress}` : ''
    turn.setStage(
      `KB is still indexing its knowledge base.${prog}\nI will reply with the answer once indexing is complete.`
    )
    const ready = await waitForBootstrap(turn, 10 * 60 * 1000)
    if (!stillCurrent() || !ready) return
    turn.setStage('Index ready — answering…')
  }
  let res
  try {
    res = await postChat(message, signal)
  } catch (_e) {
    if (!stillCurrent() || signal.aborted) return
    // First-boot can drop TCP while the event loop is saturated — treat like
    // Slack's indexing wait instead of failing the turn immediately.
    turn.setStage(
      'KB is still indexing its knowledge base.\nI will reply with the answer once indexing is complete.'
    )
    const ready = await waitForBootstrap(turn, 10 * 60 * 1000)
    if (!stillCurrent() || !ready) return
    turn.setStage('Index ready — answering…')
    try {
      res = await postChat(message, signal)
    } catch (e2) {
      if (!stillCurrent() || signal.aborted) return
      turn.setError("Couldn't reach the server", describeNetworkError(e2))
      return
    }
  }
  if (!stillCurrent()) return
  if (res.status === 401) {
    turn.setError(
      'Unauthorized (401)',
      'API key missing or wrong. Bake the key matching KB_SERVER_API_KEY into demo/config.js.'
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
        body.error || 'That base is not on this server. Pick another from the base picker.'
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
        res = await postChat(message, signal)
      } catch (e) {
        if (!stillCurrent() || signal.aborted) return
        turn.setError("Couldn't reach the server", describeNetworkError(e))
        return
      }
      if (!stillCurrent()) return
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
      if (!stillCurrent()) {
        try {
          await reader.cancel()
        } catch {}
        return
      }
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
    if (!stillCurrent()) return
    if (!answered) turn.setError('No answer', 'The server closed the stream without an answer.')
  } catch (e) {
    if (!stillCurrent() || signal.aborted) return
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
    trimUrl(SERVER_URL).startsWith('http://') &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(trimUrl(SERVER_URL))
  if (mixed)
    return 'This page is served over HTTPS but the server URL is HTTP. Browsers block that (mixed content). Use an HTTPS server URL.'
  return `${msg} — check the URL, that the server is running, and that it allows this origin (CORS: start kb-server with --allow-origin ${location.origin}).`
}

// ---- Health check --------------------------------------------------------
// /healthz is always HTTP 200 when reachable (liveness). Readiness is in the
// body: ok / indexing / reindexing. First-boot: ok=false + indexing. Scheduled
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
  const h = await probeConnection(SERVER_URL, authHeaders())
  if (gen !== healthGen) return // superseded by a newer check
  applyHealthStatus(h)
  // Populate the base picker once the server is answering (it may have been
  // mid-boot when the page first loaded, so /v1/bases was empty then).
  if (h.state === 'ready' && baseNames.length === 0) {
    fetchBases().then(renderSuggestions)
  }
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
// Starter chips are per-base: each base's pack is hard-coded here from that
// repo's eval suite question pack (eval/suites/<base>.yaml), lightly trimmed for
// chip length and skipping out-of-scope trap questions. Keyed by the server base
// slug from /v1/bases (the golden `demo`/`kb` base is this repo). Bases without a
// dedicated pack fall back to GENERIC_SUGGESTIONS (eval/suites/generic.yaml).
const GENERIC_SUGGESTIONS = [
  'What is this project for, and what are its main capabilities?',
  "How does this project's architecture work, including its major modules?",
  'How do I install and build this project, including its dependencies and build system?',
  'What are the coding conventions and style guidelines for contributing?',
  'What are the main gotchas, constraints, and known limitations?',
  'What does the roadmap or changelog say about recent history and future plans?',
]
const BASE_SUGGESTIONS = {
  // demo === this repo (kb dogfood pack, eval/suites/kb.yaml).
  kb: [
    'What problem does kb solve, and what is the normal workflow for setting up indexing and querying a knowledge base?',
    'How are markdown documents turned into import_doc facts during indexing?',
    'How does code indexing work at a high level, including the role of the tree-sitter indexer?',
    'How does kb query retrieve evidence from facts, FTS/vector scoring, and graph relationships?',
    "Does kb send my repository's code or documents to a remote server to build the knowledge base, or does indexing happen locally?",
    "Step by step, how does one interactive chat turn work, from the user's message through retrieval to the synthesized reply?",
  ],
  brew: [
    'What are Homebrew Formulae, and what rules map a package name to its Ruby class?',
    'Explain the core differences between a Formula and a Cask within Homebrew.',
    'How does Homebrew sandbox formula execution and enforce directory write restrictions during installation?',
    "Describe Homebrew's cache system architecture and how it tracks downloaded assets and dependencies.",
    'How are formula dependency trees evaluated and resolved during installations?',
    "Step by step, what changed in Homebrew 4.0's API-first install path versus cloning homebrew-core?",
  ],
  datasette: [
    'What is Datasette for, and what product surfaces does it expose when you point it at a SQLite database?',
    'What does `datasette serve` start, and what URL does an operator open to explore a database?',
    'Step by step, what happens in the web UI when a user opens a table and applies a facet or filter?',
    'How do metadata.json and canned/stored queries show up in the HTML UI and API?',
    "Explain Datasette's plugin system: where are hooks declared, and how do plugins register?",
    'What does `datasette publish` do (e.g. Heroku / Cloud Run), and which area implements publish providers?',
  ],
  'fish-shell': [
    'What were the primary engineering drivers that prompted the rewrite of fish-shell from C++ to Rust?',
    'What are the build system requirements for building fish-shell from source?',
    'How does fish-shell implement its signature autocomplete suggestions and command history lookups?',
    'How does fish-shell manage background jobs and monitor pipeline process groups?',
    "Step by step, how does fish_config's web UI change a theme in a live shell session?",
    'How can developers add and register a new built-in shell command in the Rust-based codebase?',
  ],
  fzf: [
    'What is fzf for, and what are its main capabilities and use cases?',
    "How does fzf's architecture relate the fuzzy matching core to the TUI and shell integration?",
    'How do I install and build fzf, including platform support and build systems?',
    'What fuzzy matching algorithm and scoring scheme does fzf use?',
    'How does fzf integrate with shells (bash, zsh, fish) and editors like Vim/Neovim?',
    'What are the main gotchas, constraints, and known limitations of fzf?',
  ],
  kestra: [
    'What is Kestra, and how do flows relate to namespaces, tasks, and triggers?',
    'Which top-level modules (webserver, executor, worker, scheduler, cli, ui) make up Kestra, and what is each responsible for?',
    'How does the UI workflow editor keep the on-screen graph synchronized with the YAML flow definition?',
    'Step by step, what happens when a user clicks Execute on a flow in the UI?',
    'Explain how plugins extend Kestra tasks and become available in the UI palette / YAML autocomplete.',
    'How does Kestra support starting a local all-in-one server from the CLI, and what does that mode wire together?',
  ],
  lazygit: [
    'What is the structural layout of the lazygit interface, and what are its primary interactive panels?',
    "Where are lazygit's global configuration YAML files located across different operating systems?",
    'Infer the end-to-end UI process for staging a file and committing: focus, keybindings, controllers, and the confirmation modal.',
    "What rendering library forms the foundation of lazygit's UI?",
    'How does lazygit run background Git commands concurrently without locking the UI thread?',
    'How are custom shell commands and keybindings declared inside the lazygit YAML configuration?',
  ],
  mitmproxy: [
    'Detail the primary operating modes of mitmproxy and explain how it performs HTTPS decryption.',
    'What is the FlowReader component, and how does it deserialize network traffic programmatically?',
    'Describe the architecture of the mitmproxy addon framework and detail the execution hook flow.',
    'Step by step, what happens when a client issues HTTPS CONNECT (SNI, cert generation, handshakes, hooks)?',
    'How does mitmproxy manage its asynchronous event loop and handle multiple proxies programmatically?',
    'How are custom HTTP mock responses generated and mapped dynamically using mitmproxy addons?',
  ],
  raylib: [
    'What is raylib for, and what are its main capabilities?',
    "How does raylib's architecture work, including modules and platform support?",
    'How do I install and build raylib, including dependencies and build systems?',
    'Step by step, what happens inside InitWindow() to open a window and set up the graphics context?',
    "Trace raylib's standard render loop — what do BeginDrawing, the drawing calls, and EndDrawing each do?",
    'How do I add a new example program to raylib and get it built, step by step?',
  ],
  shellcheck: [
    "What are the three primary functional goals of ShellCheck's static analysis on shell scripts?",
    'What are the core source files that implement parsing, syntax tree representation, and static analysis checks?',
    "Why is ShellCheck's Zsh support so constrained compared to its Bash parsing capabilities?",
    'Step by step, infer the analysis pipeline from raw text through tokenization, AST construction, variable tracing, and checks.',
    'How does an inline `shellcheck disable=SCxxxx` annotation suppress a matching warning during analysis?',
    'How are tests organized and executed to verify parsing correctness?',
  ],
}
function suggestionsForBase(base) {
  if (base === 'demo') return BASE_SUGGESTIONS.kb
  return BASE_SUGGESTIONS[base] || GENERIC_SUGGESTIONS
}
const suggestionsBox = $('suggestions')
function renderSuggestions() {
  suggestionsBox.replaceChildren()
  for (const q of suggestionsForBase(currentBase)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = q
    suggestionsBox.appendChild(b)
  }
}
suggestionsBox.addEventListener('click', e => {
  if (e.target.tagName === 'BUTTON') {
    input.value = e.target.textContent
    form.requestSubmit()
  }
})

// Theme
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('kb-chat-theme', t)
}
$('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
})
applyTheme(localStorage.getItem('kb-chat-theme') || 'dark')

// Header brand → new chat (keeps theme / base / connection pill).
$('brandHome').addEventListener('click', e => {
  // Allow modified clicks (new tab / middle-click) to follow href="./".
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  e.preventDefault()
  startNewChat()
})

// ---- Base picker ---------------------------------------------------------
function loadSavedBase() {
  try {
    return (localStorage.getItem(LS_BASE) || '').trim()
  } catch {
    return ''
  }
}
function saveBase(name) {
  try {
    if (name) localStorage.setItem(LS_BASE, name)
    else localStorage.removeItem(LS_BASE)
  } catch {}
}
function updateHint() {
  const suffix = currentBase
    ? ` · base <code>${escapeHtml(displayBaseName(currentBase))}</code>`
    : ''
  hint.innerHTML = `Server <code>${escapeHtml(SERVER_URL)}</code>${suffix}. Press Enter to send, Shift+Enter for a newline.`
}
function populateBaseSelect() {
  baseSelect.replaceChildren()
  for (const name of baseNames) {
    const opt = document.createElement('option')
    opt.value = name
    const label = displayBaseName(name)
    opt.textContent = name === defaultBase ? `${label} (default)` : label
    if (name === currentBase) opt.selected = true
    baseSelect.appendChild(opt)
  }
  basePicker.hidden = baseNames.length === 0
}
/** Load the server's base list (+ per-base repos) and reconcile the active base. */
async function fetchBases() {
  let payload
  try {
    payload = await fetchJson(`${SERVER_URL}/v1/bases`, authHeaders(), 6000)
  } catch {
    return
  }
  const { res, body } = payload
  if (!res.ok || !body || !Array.isArray(body.bases)) return
  baseNames = body.bases.map(b => b.name)
  defaultBase = body.default || body.bases.find(b => b.default)?.name || baseNames[0] || ''
  baseRepos = {}
  for (const b of body.bases) baseRepos[b.name] = Array.isArray(b.repos) ? b.repos : []
  // Keep the current base if still served; else the saved one; else the default.
  let next = currentBase
  if (!next || !baseNames.includes(next)) next = loadSavedBase()
  if (!next || !baseNames.includes(next)) next = defaultBase
  currentBase = next
  populateBaseSelect()
  updateHint()
  renderEmptyHeader()
}
baseSelect.addEventListener('change', () => {
  const name = baseSelect.value
  if (!name || name === currentBase) return
  currentBase = name
  saveBase(name)
  updateHint()
  renderSuggestions()
  renderEmptyHeader()
  startNewChat() // base switch → fresh server session + cleared thread
  checkHealth()
})

// Init
currentBase = loadSavedBase()
renderSuggestions()
updateHint()
renderEmptyHeader()
;(async () => {
  await fetchBases()
  renderSuggestions()
  checkHealth()
})()
input.focus()
