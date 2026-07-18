/**
 * Slack Events API handler for `POST /slack/events`.
 *
 * Routing logic:
 *  - `url_verification`      → echo challenge (Slack webhook registration)
 *  - `app_mention` (no thread_ts) → single-shot query, reply in new thread
 *  - `app_mention` (has thread_ts) → multi-turn chat, continuing the thread conversation
 *  - `message` (channel_type=im) → multi-turn chat, session per user
 *  - All other events         → 200 ack, ignored
 *
 * The handler acks Slack immediately (Slack requires a response within 3 s) and
 * runs the query/chat + Slack reply asynchronously. `event_id` deduplication
 * prevents double-processing on Slack retries. Signature verification rejects
 * requests with an invalid HMAC or a timestamp older than 5 minutes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  chatSourceReposFromBaseRepos,
  formatChatReply,
} from '@kb/core/service/chat-reply.js'
import type { QuerySource } from '@kb/core/service/serialize.js'
import type { KbHealth, KbService } from '@kb/core/service/kb-service.js'
import { discoverBaseRepos } from '@kb/core/storage/base-repos.js'
import { log } from './logger.js'

export interface SlackOptions {
  signingSecret: string
  botToken: string
}

/**
 * Verify a Slack request signature.
 *
 * Implements the `v0` HMAC-SHA256 scheme described in the Slack docs.
 * Returns false (reject) when:
 *  - timestamp or signature header is missing
 *  - timestamp is more than 5 minutes old (replay-attack window)
 *  - computed HMAC does not match the provided signature
 */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
): boolean {
  if (!timestamp || !signature) return false

  const tsNum = Number.parseInt(timestamp, 10)
  if (Number.isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const computed = `v0=${createHmac('sha256', signingSecret).update(baseString).digest('hex')}`

  try {
    return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(computed, 'utf8'))
  } catch {
    return false
  }
}

/** Strip leading `<@USER_ID>` mentions from Slack message text. */
export function stripMentions(text: string): string {
  return text.replace(/^(<@[^>]+>\s*)+/, '').trim()
}

// ---------------------------------------------------------------------------
// Event deduplication
// Slack retries unacknowledged events up to 3 times. We cache recently seen
// event_ids so duplicate deliveries are silently ack'd without re-processing.
// ---------------------------------------------------------------------------

const seenEventIds = new Map<string, number>() // eventId → expiry ms
const DEDUP_TTL_MS = 60_000 // 1 minute; Slack retry window is ~30 s

export function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now()
  for (const [id, expiry] of seenEventIds) {
    if (expiry < now) seenEventIds.delete(id)
  }
  if (seenEventIds.has(eventId)) return true
  seenEventIds.set(eventId, now + DEDUP_TTL_MS)
  return false
}

// ---------------------------------------------------------------------------
// Slack API call
// ---------------------------------------------------------------------------

async function postSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  const payload: Record<string, string> = { channel, text }
  if (threadTs) payload.thread_ts = threadTs

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as { ok: boolean; error?: string }
  if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`)
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface SlackEvent {
  type: string
  text?: string
  user?: string
  channel?: string
  channel_type?: string
  ts?: string
  thread_ts?: string
  /** Present on bot-posted messages — used to detect and skip bot's own events. */
  bot_id?: string
  /** Set for message subtypes (e.g. 'bot_message', 'message_changed'). */
  subtype?: string
}

export interface SlackEventPayload {
  type: string
  challenge?: string
  event?: SlackEvent
  event_id?: string
}

// ---------------------------------------------------------------------------
// Async event dispatcher
// Called after the 200 ack is sent. Errors are logged and swallowed.
// ---------------------------------------------------------------------------

export async function dispatchSlackEvent(
  service: KbService,
  slackOpts: SlackOptions,
  payload: SlackEventPayload,
): Promise<void> {
  const event = payload.event
  if (!event) return

  // Skip the bot's own messages to avoid infinite reply loops.
  if (event.bot_id || event.subtype) return

  const rawText = event.text ?? ''
  const message = stripMentions(rawText)
  if (!message) return

  const channel = event.channel
  if (!channel) return

  const threadTs = event.thread_ts ?? event.ts
  const bootstrapNotice = formatBootstrapSlackNotice(service.health())
  if (bootstrapNotice) {
    await postSlackMessage(slackOpts.botToken, channel, bootstrapNotice, threadTs)
    await service.waitForBootstrap()
    const afterBootstrap = service.health()
    if (afterBootstrap.bootstrapError) {
      await postSlackMessage(
        slackOpts.botToken,
        channel,
        `KB bootstrap failed before I could answer: ${afterBootstrap.bootstrapError}`,
        threadTs,
      )
      return
    }
  }

  if (event.type === 'app_mention') {
    // All channel mentions use chat mode so the thread stays coherent across turns.
    // Session key = thread_ts ?? event.ts: for the first mention thread_ts is absent
    // and event.ts becomes the thread root (Slack sets thread_ts = that ts on all replies),
    // so the session id is stable whether this is turn 1 or turn N.
    const sessionId = event.thread_ts ?? event.ts ?? channel
    await replyWithChat(service, slackOpts, message, channel, threadTs, sessionId)
  } else if (event.type === 'message' && event.channel_type === 'im') {
    // Direct message → multi-turn chat; session is per-user DM channel.
    const sessionId = `dm:${event.user ?? channel}`
    await replyWithChat(service, slackOpts, message, channel, undefined, sessionId)
  }
}

function formatBootstrapSlackNotice(health: KbHealth): string | null {
  if (!health.indexing) return null
  const lines = ['KB is still indexing its knowledge base.']
  if (health.bootstrapProgress) {
    lines.push(`Current progress: ${health.bootstrapProgress}`)
  }
  lines.push('I will reply with the answer once indexing is complete.')
  return lines.join('\n')
}

async function replyWithChat(
  service: KbService,
  slackOpts: SlackOptions,
  message: string,
  channel: string,
  threadTs: string | undefined,
  sessionId: string,
): Promise<void> {
  // Same chat stream as HTTP `/v1/chat` / the Pages demo: answer + sources[].
  let answer = ''
  let sources: QuerySource[] = []
  let errorMessage = ''
  for await (const event of service.chat({ sessionId, message })) {
    if (event.type === 'answer') {
      answer = event.text
      sources = event.sources ?? []
    } else if (event.type === 'error') {
      errorMessage = event.message
    }
  }
  if (answer) {
    // Per-repo blob links from the volume registry (clone gitUrl + gitBranch).
    // No global KB_SOURCE_* — each slug uses its own primary branch.
    const sourceRepos = chatSourceReposFromBaseRepos(await discoverBaseRepos(service.baseDir))
    const text = formatChatReply(answer, sources, {
      flavor: 'slack',
      sourceRepos,
    })
    await postSlackMessage(slackOpts.botToken, channel, text, threadTs)
  } else if (errorMessage) {
    // Surface the real failure (e.g. a retired-model 404) instead of silently
    // dropping it — otherwise a broken pipeline looks identical to "no result".
    log.error('slack chat failed', { channel, sessionId, error: errorMessage })
    await postSlackMessage(slackOpts.botToken, channel, `⚠️ Sorry, I hit an error: ${errorMessage}`, threadTs)
  } else {
    log.warn('slack chat produced no answer', { channel, sessionId, message: message.slice(0, 100) })
  }
}
