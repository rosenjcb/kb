/**
 * kb-slack — a Slack bot that answers `@kb <question>` from a kb-server instance.
 *
 * Runtime shape (see README.md): a standalone container that receives Slack **Events API**
 * webhooks over HTTP, verifies the signature, and on an `app_mention` calls the kb-server
 * `POST /v1/query` and posts the synthesized answer back in-thread. It holds no index and
 * no LLM key of its own — it is a thin bridge to `KB_SERVER_URL`.
 *
 * Endpoints:
 *   POST  /slack/events   Slack Events API (url_verification + app_mention)
 *   GET   /healthz        liveness
 *
 * Required env: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, KB_SERVER_API_KEY.
 * Optional: KB_SERVER_URL (default http://kb-server:8080), PORT (3000), SLACK_EVENTS_PATH.
 */
import { createServer } from 'node:http'
import { formatReply, stripMention } from './format.mjs'
import { queryKb } from './kb.mjs'
import { postMessage } from './slack.mjs'
import { isValidSlackRequest } from './verify.mjs'

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3000
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? ''
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const KB_SERVER_URL = (process.env.KB_SERVER_URL ?? 'http://kb-server:8080').replace(/\/$/, '')
const KB_API_KEY = process.env.KB_SERVER_API_KEY ?? ''
const EVENTS_PATH = process.env.SLACK_EVENTS_PATH ?? '/slack/events'
const MAX_BODY_BYTES = 1024 * 1024

function requireEnv() {
  const missing = []
  if (!SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET')
  if (!BOT_TOKEN) missing.push('SLACK_BOT_TOKEN')
  if (!KB_API_KEY) missing.push('KB_SERVER_API_KEY')
  if (missing.length > 0) {
    console.error(`✖ kb-slack: missing required env: ${missing.join(', ')}`)
    process.exit(1)
  }
}

// Slack re-delivers an event (same `event_id`) if we do not ack within 3s; dedupe so a slow
// kb query never yields a double answer. Bounded in-memory set (process-local, best-effort).
const seenEvents = new Set()
const SEEN_CAP = 1000

function alreadyHandled(eventId) {
  if (!eventId) return false
  if (seenEvents.has(eventId)) return true
  seenEvents.add(eventId)
  if (seenEvents.size > SEEN_CAP) {
    for (const id of seenEvents) {
      seenEvents.delete(id)
      if (seenEvents.size <= SEEN_CAP / 2) break
    }
  }
  return false
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleMention(event) {
  const threadTs = event.thread_ts ?? event.ts
  const question = stripMention(event.text)
  if (!question) {
    await postMessage({
      token: BOT_TOKEN,
      channel: event.channel,
      threadTs,
      text: 'Ask me a question, e.g. `@kb how does auth work?`',
    })
    return
  }
  try {
    const result = await queryKb({ baseUrl: KB_SERVER_URL, apiKey: KB_API_KEY, question })
    await postMessage({
      token: BOT_TOKEN,
      channel: event.channel,
      threadTs,
      text: formatReply(result),
    })
  } catch (err) {
    console.error(`kb-slack: query failed: ${err.message}`)
    await postMessage({
      token: BOT_TOKEN,
      channel: event.channel,
      threadTs,
      text: `⚠️ Sorry, I hit an error answering that (${err.message}).`,
    }).catch(() => {})
  }
}

/** Route a verified `event_callback`. Only acts on human `app_mention`s. */
function dispatchEvent(body) {
  const event = body.event
  if (!event || event.type !== 'app_mention') return
  if (event.bot_id) return // ignore bots (including ourselves) to avoid loops
  handleMention(event).catch(err => console.error(`kb-slack: unhandled: ${err.message}`))
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0]

  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method !== 'POST' || url !== EVENTS_PATH) {
    res.writeHead(404).end()
    return
  }

  let raw
  try {
    raw = await readRawBody(req)
  } catch {
    res.writeHead(400).end()
    return
  }

  const valid = isValidSlackRequest({
    signingSecret: SIGNING_SECRET,
    signature: req.headers['x-slack-signature'],
    timestamp: req.headers['x-slack-request-timestamp'],
    rawBody: raw,
  })
  if (!valid) {
    res.writeHead(401).end()
    return
  }

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    res.writeHead(400).end()
    return
  }

  // URL verification handshake when you set the Request URL in Slack.
  if (body.type === 'url_verification') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ challenge: body.challenge }))
    return
  }

  // Ack fast (< 3s), then process out of band so retries do not pile up.
  res.writeHead(200).end()
  if (body.type === 'event_callback' && !alreadyHandled(body.event_id)) {
    dispatchEvent(body)
  }
})

requireEnv()
server.listen(PORT, () => {
  console.log(`🤖 kb-slack listening on :${PORT} (events ${EVENTS_PATH} → ${KB_SERVER_URL})`)
})
