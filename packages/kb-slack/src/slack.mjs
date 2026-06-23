/**
 * Minimal Slack Web API client — just `chat.postMessage` to reply in-thread. Uses the bot
 * token (`xoxb-…`); no SDK dependency.
 */

const SLACK_API = 'https://slack.com/api'

/** Post a message to a channel, optionally threaded under `threadTs`. Throws on Slack error. */
export async function postMessage({ token, channel, text, threadTs }) {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) {
    throw new Error(`slack chat.postMessage failed: ${data.error || res.status}`)
  }
  return data
}
