/**
 * kb-slack — answers `@kb <question>` in channels via /v1/query and
 * direct messages via /v1/chat (multi-turn, session per user).
 *
 * Endpoints:
 *   POST /slack/events   Slack Events API (handled by @slack/bolt)
 *   GET  /healthz        liveness
 *
 * Required env: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, KB_SERVER_API_KEY.
 * Optional: KB_SERVER_URL (default http://kb-server:8080), PORT (3000), SLACK_EVENTS_PATH.
 *
 * Slack app scopes needed:
 *   Bot token:  app_mentions:read  chat:write  im:history  im:read
 *   Events:     app_mention  message.im
 */
import { App, HTTPReceiver } from '@slack/bolt'
import { formatReply, stripMention } from './format.js'
import { chatKb, queryKb } from './kb.js'

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3000
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? ''
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const KB_SERVER_URL = (process.env.KB_SERVER_URL ?? 'http://kb-server:8080').replace(/\/$/, '')
const KB_API_KEY = process.env.KB_SERVER_API_KEY ?? ''
const EVENTS_PATH = process.env.SLACK_EVENTS_PATH ?? '/slack/events'

const missing: string[] = []
if (!SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET')
if (!BOT_TOKEN) missing.push('SLACK_BOT_TOKEN')
if (!KB_API_KEY) missing.push('KB_SERVER_API_KEY')
if (missing.length > 0) {
  console.error(`✖ kb-slack: missing required env: ${missing.join(', ')}`)
  process.exit(1)
}

const receiver = new HTTPReceiver({
  signingSecret: SIGNING_SECRET,
  endpoints: EVENTS_PATH,
  customRoutes: [
    {
      path: '/healthz',
      method: ['GET'],
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    },
  ],
})

const app = new App({ token: BOT_TOKEN, receiver })

// Channel @mentions → single-shot /v1/query reply in-thread
app.event('app_mention', async ({ event, client }) => {
  // DM @mentions are handled by the message handler below to keep chat mode consistent
  if (event.channel.startsWith('D')) return

  const threadTs = event.thread_ts ?? event.ts
  const question = stripMention(event.text)

  if (!question) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: 'Ask me a question, e.g. `@kb how does auth work?`',
    })
    return
  }

  try {
    const result = await queryKb({ baseUrl: KB_SERVER_URL, apiKey: KB_API_KEY, question })
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: formatReply(result),
    })
  } catch (err) {
    console.error(`kb-slack: query failed: ${(err as Error).message}`)
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `⚠️ Sorry, I hit an error answering that (${(err as Error).message}).`,
    }).catch(() => {})
  }
})

// Direct messages → multi-turn /v1/chat with a per-user session
app.message(async ({ message, client }) => {
  if (message.channel_type !== 'im') return
  // Ignore bot messages, edits, deletes, and other subtypes
  if ('subtype' in message && message.subtype) return
  if ('bot_id' in message && message.bot_id) return

  const text = 'text' in message ? stripMention(message.text) : ''
  const userId = 'user' in message ? message.user : undefined
  if (!text || !userId) return

  const sessionId = `slack-dm-${userId}`

  try {
    const result = await chatKb({ baseUrl: KB_SERVER_URL, apiKey: KB_API_KEY, sessionId, message: text })
    await client.chat.postMessage({
      channel: message.channel,
      text: formatReply(result),
    })
  } catch (err) {
    console.error(`kb-slack: chat failed: ${(err as Error).message}`)
    await client.chat.postMessage({
      channel: message.channel,
      text: `⚠️ Sorry, I hit an error answering that (${(err as Error).message}).`,
    }).catch(() => {})
  }
})

void (async () => {
  await app.start(PORT)
  console.log(`🤖 kb-slack listening on :${PORT} (events ${EVENTS_PATH} → ${KB_SERVER_URL})`)
})()
