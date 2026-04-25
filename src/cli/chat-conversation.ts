export interface ChatConversationTurn {
  user: string
  assistant: string
}

export type ChatPendingFollowUp =
  | {
      kind: 'search'
      query: string
      reason: string
    }
  | {
      kind: 'clarify'
      priorUserInput: string
      priorRetrievalQuery: string
      reason: string
    }

export interface ChatConversationState {
  recentTurns: ChatConversationTurn[]
  activeTopic?: string
  lastUserGoal?: string
  lastRetrievalQuery?: string
  lastRetrievedDocIds: string[]
  pendingFollowUp?: ChatPendingFollowUp
  needsSearch?: boolean
}

export type ChatTurnType =
  | 'fresh-query'
  | 'follow-up'
  | 'confirmation'
  | 'action-request'
  | 'clarification'

export interface ResolvedChatTurn {
  type: ChatTurnType
  input: string
  retrievalQuery: string
  answerFocus: string
  topic: string
  goal: string
}

export interface ChatTurnOutcome {
  answer: string
  retrievedDocIds: string[]
  /** From answer enrichment JSON when the model marks evidence insufficient. */
  answerEvidence?: 'sufficient' | 'insufficient'
}

const CONFIRMATION_PATTERN =
  /^(yes|yeah|yep|sure|ok|okay|please do|do that|do it|search it|search that|let['’]?s do (it|that|the search)|go ahead)$/i
const CONFIRMATION_WITH_CONTEXT_PATTERN =
  /^(yes|yeah|yep|sure|ok|okay)\b.*\b(do|search|go ahead|look up|find)\b/i
const ACTION_REQUEST_PATTERN = /\b(search|look up|find|check|query|search for)\b/i
const CLARIFICATION_PATTERN =
  /\b(explain (it|that|this)?\s*more|be more concrete|go deeper|which files|what files|how is it implemented|how do we implement it)\b/i
const FOLLOW_UP_PATTERN =
  /^(what about|how about|and what about|and how about|what about that|what about that one|that one|it|this|that)\b/i
const SEARCH_REQUESTED_PATTERN =
  /(let me know if you would like me to perform this search|would need to search|please let me know if you would like me to search|try: kb query)/i

const GENERIC_FOLLOW_UP_TERMS = new Set([
  'again',
  'be',
  'concrete',
  'deeper',
  'do',
  'does',
  'explain',
  'find',
  'for',
  'go',
  'help',
  'how',
  'implement',
  'implemented',
  'it',
  'let',
  'lets',
  'look',
  'more',
  'please',
  'search',
  'show',
  'that',
  'the',
  'this',
  'up',
  'what',
  'which',
  'yeah',
  'yes',
])

export function createInitialConversationState(): ChatConversationState {
  return {
    recentTurns: [],
    lastRetrievedDocIds: [],
  }
}

export function resolveConversationalChatTurn(
  input: string,
  state: ChatConversationState
): ResolvedChatTurn {
  const normalized = input.trim()
  const clarifyPending =
    state.pendingFollowUp?.kind === 'clarify' ? state.pendingFollowUp : undefined
  if (clarifyPending && normalized) {
    const looksBareConfirmation =
      CONFIRMATION_PATTERN.test(normalized) || CONFIRMATION_WITH_CONTEXT_PATTERN.test(normalized)
    if (!looksBareConfirmation) {
      const merged = `${normalized} (${clarifyPending.priorUserInput})`
      const topic = buildTopicFromQuery(normalized) ?? clarifyPending.priorUserInput
      return {
        type: 'follow-up',
        input: normalized,
        retrievalQuery: merged,
        answerFocus: normalized,
        topic,
        goal: 'answer after assistant asked for clarification',
      }
    }
  }

  const turnType = classifyChatTurn(normalized, state)
  const explicitTopic = extractExplicitTopic(normalized)
  const topicalTerms = extractTopicalTerms(normalized)
  const activeTopic = state.activeTopic?.trim()
  const searchPending = state.pendingFollowUp?.kind === 'search' ? state.pendingFollowUp : undefined
  const previousQuery = searchPending?.query?.trim() || state.lastRetrievalQuery?.trim()

  let retrievalQuery = normalized
  if (turnType === 'confirmation' && previousQuery) {
    retrievalQuery = previousQuery
  } else if (
    (turnType === 'follow-up' || turnType === 'clarification') &&
    explicitTopic &&
    isStandaloneExplicitTopic(normalized, explicitTopic)
  ) {
    retrievalQuery = explicitTopic
  } else if (
    (turnType === 'follow-up' || turnType === 'clarification' || turnType === 'action-request') &&
    activeTopic
  ) {
    const suffix = topicalTerms
      .filter(term => !activeTopic.toLowerCase().includes(term.toLowerCase()))
      .join(' ')
      .trim()
    retrievalQuery = suffix ? `${activeTopic} ${suffix}` : activeTopic
  } else if (turnType === 'action-request' && previousQuery) {
    retrievalQuery = previousQuery
  }

  const topic = explicitTopic || buildTopicFromQuery(retrievalQuery) || activeTopic || normalized

  return {
    type: turnType,
    input: normalized,
    retrievalQuery,
    answerFocus: turnType === 'fresh-query' ? normalized : retrievalQuery,
    topic,
    goal: describeUserGoal(normalized, turnType),
  }
}

export function updateConversationState(
  state: ChatConversationState,
  resolvedTurn: ResolvedChatTurn,
  outcome: ChatTurnOutcome,
  maxHistoryTurns: number
): ChatConversationState {
  const recentTurns = [
    ...state.recentTurns,
    { user: resolvedTurn.input, assistant: outcome.answer },
  ]
  if (recentTurns.length > maxHistoryTurns) {
    recentTurns.splice(0, recentTurns.length - maxHistoryTurns)
  }

  const needsSearch = answerNeedsSearch(outcome.answer)
  const pendingFollowUp =
    outcome.answerEvidence === 'insufficient'
      ? {
          kind: 'clarify' as const,
          priorUserInput: resolvedTurn.input,
          priorRetrievalQuery: resolvedTurn.retrievalQuery,
          reason: 'insufficient-grounded-evidence',
        }
      : needsSearch
        ? {
            kind: 'search' as const,
            query: resolvedTurn.retrievalQuery,
            reason: 'assistant-requested-search',
          }
        : undefined

  return {
    recentTurns,
    activeTopic: resolvedTurn.topic,
    lastUserGoal: resolvedTurn.goal,
    lastRetrievalQuery: resolvedTurn.retrievalQuery,
    lastRetrievedDocIds: outcome.retrievedDocIds,
    pendingFollowUp,
    needsSearch,
  }
}

export function classifyChatTurn(input: string, state: ChatConversationState): ChatTurnType {
  const trimmed = input.trim()
  if (!trimmed) return 'fresh-query'

  if (
    (CONFIRMATION_PATTERN.test(trimmed) || CONFIRMATION_WITH_CONTEXT_PATTERN.test(trimmed)) &&
    (state.pendingFollowUp?.kind === 'search' ||
      (!state.pendingFollowUp && state.lastRetrievalQuery))
  ) {
    return 'confirmation'
  }

  if (CLARIFICATION_PATTERN.test(trimmed) && state.activeTopic) {
    return 'clarification'
  }

  if (FOLLOW_UP_PATTERN.test(trimmed) && state.activeTopic) {
    return 'follow-up'
  }

  if (
    ACTION_REQUEST_PATTERN.test(trimmed) &&
    (state.activeTopic || state.pendingFollowUp || state.lastRetrievalQuery)
  ) {
    return 'action-request'
  }

  const topicalTerms = extractTopicalTerms(trimmed)
  if (topicalTerms.length === 0 && state.activeTopic) {
    return 'follow-up'
  }

  return 'fresh-query'
}

export function answerNeedsSearch(answer: string): boolean {
  return SEARCH_REQUESTED_PATTERN.test(answer)
}

function buildTopicFromQuery(query: string): string | undefined {
  const terms = extractTopicalTerms(query)
  if (terms.length === 0) return undefined
  return terms.slice(0, 6).join(' ')
}

function describeUserGoal(input: string, turnType: ChatTurnType): string {
  if (turnType === 'confirmation') return 'confirm prior follow-up'
  if (turnType === 'clarification') return 'refine prior explanation'
  if (turnType === 'follow-up') return 'continue prior topic'
  if (turnType === 'action-request') return 'request targeted retrieval'
  return inferGoalFromInput(input)
}

function inferGoalFromInput(input: string): string {
  const normalized = input.toLowerCase()
  if (normalized.startsWith('explain')) return 'explain topic'
  if (normalized.startsWith('summarize')) return 'summarize topic'
  if (normalized.startsWith('what')) return 'answer factual question'
  if (normalized.startsWith('how')) return 'describe workflow or implementation'
  if (normalized.startsWith('which')) return 'identify source or implementation details'
  return 'answer user question'
}

function extractExplicitTopic(input: string): string | undefined {
  const patterns = [
    /^(?:explain|summarize|describe)\s+(.+)$/i,
    /^(?:what about|how about)\s+(.+)$/i,
    /^(?:search for|find|look up|query)\s+(.+)$/i,
    /^(?:which files implement|what files implement)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = input.match(pattern)
    const topic = match?.[1]?.trim()
    if (topic) return topic.replace(/[?.!]+$/, '')
  }

  return undefined
}

function isStandaloneExplicitTopic(input: string, explicitTopic: string): boolean {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/, '')
  const topic = explicitTopic.trim().toLowerCase()
  return (
    normalized === `what about ${topic}` ||
    normalized === `how about ${topic}` ||
    normalized === `and what about ${topic}` ||
    normalized === `and how about ${topic}`
  )
}

function extractTopicalTerms(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => token.length > 1)
    .filter(token => !GENERIC_FOLLOW_UP_TERMS.has(token))
}
