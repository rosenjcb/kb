/**
 * In-memory fan-in for subagent streams (Ticket 105).
 * Lets a parent harness observe per-channel AgentEvents without changing tool contracts.
 */

import type { AgentEvent } from '../types'

export class StreamManager {
  private readonly buffers = new Map<string, AgentEvent[]>()

  push(channelId: string, event: AgentEvent): void {
    const next = this.buffers.get(channelId) ?? []
    next.push(event)
    this.buffers.set(channelId, next)
  }

  snapshot(channelId: string): AgentEvent[] {
    return [...(this.buffers.get(channelId) ?? [])]
  }

  /** Returns accumulated events and clears the channel buffer. */
  drain(channelId: string): AgentEvent[] {
    const buf = this.buffers.get(channelId) ?? []
    this.buffers.delete(channelId)
    return buf
  }
}
