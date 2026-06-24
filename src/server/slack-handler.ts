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
import { serializeQueryResult } from './serialize.js'
import { log } from './logger.js'
import type { KbService } from './kb-service.js'

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

  if (event.type === 'app_mention') {
    if (event.thread_ts) {
      // Threaded mention → continue the thread conversation in chat mode.
      // The thread_ts is stable across all messages in the thread, making it
      // a natural session identifier.
      await replyWithChat(service, slackOpts, message, channel, event.thread_ts, event.thread_ts)
    } else {
      // Top-level mention → single-shot query; reply starts a new thread.
      await replyWithQuery(service, slackOpts, message, channel, event.ts)
    }
  } else if (event.type === 'message' && event.channel_type === 'im') {
    // Direct message → multi-turn chat; session is per-user DM channel.
    const sessionId = `dm:${event.user ?? channel}`
    await replyWithChat(service, slackOpts, message, channel, undefined, sessionId)
  }
}

async function replyWithQuery(
  service: KbService,
  slackOpts: SlackOptions,
  message: string,
  channel: string,
  threadTs: string | undefined,
): Promise<void> {
  const result = await service.query({ query: message, synthesize: true })
  const answer = serializeQueryResult(result).answer
  if (answer) {
    await postSlackMessage(slackOpts.botToken, channel, answer, threadTs)
  } else {
    log.warn('slack query produced no answer', { channel, message: message.slice(0, 100) })
  }
}

async function replyWithChat(
  service: KbService,
  slackOpts: SlackOptions,
  message: string,
  channel: string,
  threadTs: string | undefined,
  sessionId: string,
): Promise<void> {
  let answer = ''
  for await (const event of service.chat({ sessionId, message })) {
    if (event.type === 'answer') answer = event.text
  }
  if (answer) {
    await postSlackMessage(slackOpts.botToken, channel, answer, threadTs)
  } else {
    log.warn('slack chat produced no answer', { channel, sessionId, message: message.slice(0, 100) })
  }
}
