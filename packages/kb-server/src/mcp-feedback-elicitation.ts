/**
 * MCP form-elicitation schema + helpers for yes/partial/no feedback.
 *
 * When a client declares the `elicitation` capability (form mode), a sampled
 * kb_query can ask the *user* directly instead of stuffing an AGENT_INSTRUCTION
 * nudge into the tool result for the agent to act on later.
 */

import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js'
import type { FeedbackHelped } from './query-feedback-store.js'

export const FEEDBACK_HELPED_VALUES: readonly FeedbackHelped[] = ['yes', 'partial', 'no']

/** Flat JSON Schema for form-mode elicitation (primitive fields only). */
export const FEEDBACK_ELICITATION_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
  type: 'object',
  properties: {
    helped: {
      type: 'string',
      title: 'Did this answer help?',
      description: 'Was the kb_query answer useful for completing your task?',
      oneOf: [
        { const: 'yes', title: 'Yes' },
        { const: 'partial', title: 'Partial' },
        { const: 'no', title: 'No' },
      ],
    },
    notes: {
      type: 'string',
      title: 'Notes (optional)',
      description: 'What was right, missing, or wrong — cite files or facts when you can.',
    },
  },
  required: ['helped'],
}

export interface FeedbackElicitContext {
  query: string
  answer: string
  requestId?: string
}

export type FeedbackElicitOutcome =
  | { kind: 'accepted'; helped: FeedbackHelped; notes?: string }
  | { kind: 'dismissed'; action: 'decline' | 'cancel' }
  | { kind: 'unavailable' }

const ANSWER_PREVIEW_CHARS = 400

/** User-facing elicitation message with enough Q/A context to rate. */
export function feedbackElicitationMessage(ctx: FeedbackElicitContext): string {
  const id = ctx.requestId ? ` (requestId: ${ctx.requestId})` : ''
  const answer = truncateForElicit(ctx.answer, ANSWER_PREVIEW_CHARS)
  return `Quick feedback on this kb answer${id}:\n\nQ: ${ctx.query}\nA: ${answer}\n\nDid it help?`
}

export function truncateForElicit(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

/** Spec back-compat: empty `elicitation: {}` means form mode only. */
export function clientSupportsFormElicitation(
  elicitation: { form?: object; url?: object } | undefined
): boolean {
  if (!elicitation) return false
  if (elicitation.form !== undefined) return true
  if (elicitation.url !== undefined) return false
  return true
}

export function parseElicitedHelped(value: unknown): FeedbackHelped | undefined {
  if (typeof value !== 'string') return undefined
  return FEEDBACK_HELPED_VALUES.includes(value as FeedbackHelped)
    ? (value as FeedbackHelped)
    : undefined
}
