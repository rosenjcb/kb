import type { InitContext, InitCoverageSummary, InitTopic, InitUserAnswer, TopicCoverageAssessment, TopicCoverageStatus } from './init-cli'

export interface TopicDefinition {
  topic: InitTopic
  keywords: string[]
  initialQuestion: string
  followUpQuestion: string
  missingFields: string[]
  contradictionTerms?: string[][]
}

export interface TopicCoverageGap {
  topic: InitTopic
  status: Extract<TopicCoverageStatus, 'needs-follow-up' | 'inferred-only' | 'unresolved'>
  confidence: 'high' | 'medium' | 'low'
  missingFields: string[]
  evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'>
  keyEvidence: string[]
  reason: 'missing-topic' | 'low-confidence' | 'contradiction' | 'needs-example'
  enoughContext: boolean
  contradictorySignals: string[]
}

type CandidateDocShape = {
  title: string
  content: string
}

export const INIT_TOPIC_DEFINITIONS: TopicDefinition[] = [
  {
    topic: 'project-overview',
    keywords: ['overview', 'purpose', 'project', 'mission', 'goal'],
    initialQuestion: 'What is this project for, and who is it for?',
    followUpQuestion: 'What should a newcomer understand first about the project purpose or audience?',
    missingFields: ['purpose', 'audience'],
  },
  {
    topic: 'install-setup',
    keywords: ['install', 'setup', 'bootstrap', 'getting started'],
    initialQuestion: 'How do you install or set up this project?',
    followUpQuestion: 'What setup details or prerequisites would block a new user if they were missing?',
    missingFields: ['installation steps', 'prerequisites'],
  },
  {
    topic: 'core-workflows',
    keywords: ['usage', 'command', 'workflow', 'example', 'cli'],
    initialQuestion: 'What are the most common workflows, commands, or day-to-day tasks?',
    followUpQuestion: 'Which workflow or command sequence is most important to explain more concretely?',
    missingFields: ['common commands', 'usage examples'],
  },
  {
    topic: 'architecture',
    keywords: ['architecture', 'component', 'design', 'system'],
    initialQuestion: 'What is the high-level architecture, and how do the main components relate?',
    followUpQuestion: 'Which component relationship or boundary needs more explanation?',
    missingFields: ['major components', 'component relationships'],
  },
  {
    topic: 'configuration',
    keywords: ['config', 'configuration', 'env', '.env', 'settings'],
    initialQuestion: 'How is the project configured? Include env vars or config files.',
    followUpQuestion: 'What configuration detail is easiest to miss or most important to document clearly?',
    missingFields: ['config sources', 'required settings'],
  },
  {
    topic: 'testing',
    keywords: ['test', 'vitest', 'jest', 'coverage', 'spec'],
    initialQuestion: 'How do you run tests, and what test flows matter most?',
    followUpQuestion: 'What testing detail or expected workflow should be spelled out more explicitly?',
    missingFields: ['test commands', 'test expectations'],
  },
  {
    topic: 'deployment-release',
    keywords: ['deploy', 'release', 'publish', 'ship'],
    initialQuestion: 'How is the project deployed, released, or published?',
    followUpQuestion: 'What release or deployment detail still feels ambiguous?',
    missingFields: ['release flow', 'deployment constraints'],
    contradictionTerms: [
      ['manual', 'automatic'],
      ['local', 'cloud'],
    ],
  },
  {
    topic: 'constraints-gotchas',
    keywords: ['constraint', 'gotcha', 'pitfall', 'decision', 'warning'],
    initialQuestion: 'What important constraints, decisions, or gotchas are easy to miss?',
    followUpQuestion: 'What subtle constraint or gotcha most often surprises contributors?',
    missingFields: ['constraints', 'gotchas'],
  },
]

export function getTopicDefinition(topic: InitTopic): TopicDefinition {
  return INIT_TOPIC_DEFINITIONS.find(definition => definition.topic === topic)!
}

export function inferTopicFromQuestion(question: string): InitTopic | undefined {
  const lower = question.toLowerCase()
  return INIT_TOPIC_DEFINITIONS.find(definition =>
    definition.keywords.some(keyword => lower.includes(keyword)) ||
    lower.includes(definition.topic.split('-')[0]),
  )?.topic
}

export function assessTopicCoverage(
  context: InitContext,
  candidateDocs: CandidateDocShape[] | undefined,
  nonInteractive: boolean,
): TopicCoverageAssessment[] {
  const sourceText = Object.values(context.sourceFiles).join('\n').toLowerCase()
  const docCorpus = (candidateDocs ?? []).map(doc => `${doc.title}\n${doc.content}`.toLowerCase())
  const answersByTopic = buildAnswersByTopic(context.userAnswers)

  return INIT_TOPIC_DEFINITIONS.map(definition => {
    const sourceHit = definition.keywords.some(keyword => sourceText.includes(keyword))
    const topicAnswers = answersByTopic.get(definition.topic) ?? []
    const answerText = topicAnswers.map(answer => answer.answer.toLowerCase()).join('\n')
    const docMatches = docCorpus.filter(doc =>
      definition.keywords.some(keyword => doc.includes(keyword)) ||
      doc.includes(definition.topic.split('-')[0]),
    )

    const contradictorySignals = detectContradictions({
      sourceText,
      answerText,
      docMatches,
      definition,
    })

    const evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'> = []
    const keyEvidence: string[] = []

    if (sourceHit) {
      evidenceSources.push('source-doc')
      keyEvidence.push('source docs mention this topic')
    }
    if (topicAnswers.length > 0) {
      evidenceSources.push('user-answer')
      keyEvidence.push(`user answered ${topicAnswers.length} question(s) about this topic`)
    }
    if (docMatches.length > 0) {
      evidenceSources.push('model-inference')
      keyEvidence.push(`draft docs cover this topic (${docMatches.length})`)
    }
    if (contradictorySignals.length > 0) {
      keyEvidence.push(`contradictory signals: ${contradictorySignals.join(', ')}`)
    }

    const score = (sourceHit ? 1 : 0) + (topicAnswers.length > 0 ? 2 : 0) + (docMatches.length > 0 ? 1 : 0)
    const groundedEvidenceCount = (sourceHit ? 1 : 0) + (topicAnswers.length > 0 ? 1 : 0)

    let confidence: TopicCoverageAssessment['confidence'] = 'low'
    let status: TopicCoverageStatus = 'unresolved'
    let enoughContext = false
    let stopReason: TopicCoverageAssessment['stopReason']

    if (contradictorySignals.length > 0) {
      confidence = 'low'
      status = 'unresolved'
      enoughContext = false
      stopReason = nonInteractive ? 'non-interactive-mode' : 'still-ambiguous'
    } else if (groundedEvidenceCount >= 2 && docMatches.length > 0) {
      confidence = 'high'
      status = 'sufficient'
      enoughContext = true
      stopReason = 'user-confirmed'
    } else if (score >= 3) {
      confidence = 'medium'
      status = 'sufficient'
      enoughContext = true
      stopReason = topicAnswers.length > 0 ? 'user-confirmed' : 'enough-grounded-evidence'
    } else if (score === 2) {
      confidence = 'medium'
      status = topicAnswers.length > 0 ? 'needs-follow-up' : nonInteractive ? 'inferred-only' : 'needs-follow-up'
      enoughContext = false
      stopReason = nonInteractive ? 'non-interactive-mode' : undefined
    } else if (score === 1) {
      confidence = 'low'
      status = nonInteractive ? 'inferred-only' : 'needs-follow-up'
      enoughContext = false
      stopReason = nonInteractive ? 'non-interactive-mode' : undefined
    } else {
      confidence = 'low'
      status = 'unresolved'
      enoughContext = false
      stopReason = nonInteractive ? 'non-interactive-mode' : undefined
    }

    return {
      topic: definition.topic,
      confidence,
      status,
      evidenceSources,
      keyEvidence,
      missingFields: enoughContext ? [] : definition.missingFields,
      enoughContext,
      stopReason,
    }
  })
}

export function buildTopicCoverageGaps(coverage: TopicCoverageAssessment[]): TopicCoverageGap[] {
  return coverage
    .filter(topic => !topic.enoughContext)
    .map(topic => ({
      topic: topic.topic,
      status: topic.status === 'sufficient' ? 'needs-follow-up' : topic.status,
      confidence: topic.confidence,
      missingFields: topic.missingFields,
      evidenceSources: topic.evidenceSources,
      keyEvidence: topic.keyEvidence,
      reason: determineGapReason(topic),
      enoughContext: topic.enoughContext,
      contradictorySignals: topic.keyEvidence
        .filter(evidence => evidence.startsWith('contradictory signals:'))
        .flatMap(evidence => evidence.replace('contradictory signals: ', '').split(', ')),
    }))
}

export function markUnaskedTopicsAsInferred(
  coverage: TopicCoverageAssessment[],
  stopReason: TopicCoverageAssessment['stopReason'],
): TopicCoverageAssessment[] {
  return coverage.map(topic => {
    if (topic.enoughContext) return topic
    if (topic.status === 'needs-follow-up') {
      return { ...topic, status: 'inferred-only', stopReason }
    }
    return { ...topic, stopReason }
  })
}

export function summariseCoverage(coverage: TopicCoverageAssessment[]): InitCoverageSummary {
  return {
    coveredTopics: coverage.filter(topic => topic.status === 'sufficient').map(topic => topic.topic),
    inferredTopics: coverage.filter(topic => topic.status === 'inferred-only').map(topic => topic.topic),
    unresolvedTopics: coverage
      .filter(topic => topic.status === 'needs-follow-up' || topic.status === 'unresolved')
      .map(topic => topic.topic),
  }
}

function buildAnswersByTopic(userAnswers: InitUserAnswer[]): Map<InitTopic, InitUserAnswer[]> {
  const map = new Map<InitTopic, InitUserAnswer[]>()
  for (const answer of userAnswers) {
    const topic = answer.topic ?? inferTopicFromQuestion(answer.question)
    if (!topic) continue
    const existing = map.get(topic) ?? []
    existing.push({ ...answer, topic })
    map.set(topic, existing)
  }
  return map
}

function detectContradictions(input: {
  sourceText: string
  answerText: string
  docMatches: string[]
  definition: TopicDefinition
}): string[] {
  const corpus = [input.sourceText, input.answerText, ...input.docMatches].join('\n')
  const contradictions: string[] = []
  for (const termPair of input.definition.contradictionTerms ?? []) {
    const [left, right] = termPair
    if (corpus.includes(left) && corpus.includes(right)) {
      contradictions.push(`${left}/${right}`)
    }
  }
  return contradictions
}

function determineGapReason(topic: TopicCoverageAssessment): TopicCoverageGap['reason'] {
  if (topic.keyEvidence.some(evidence => evidence.startsWith('contradictory signals:'))) {
    return 'contradiction'
  }
  if (topic.evidenceSources.length === 0) {
    return 'missing-topic'
  }
  if (topic.evidenceSources.includes('user-answer') && !topic.evidenceSources.includes('source-doc')) {
    return 'needs-example'
  }
  return 'low-confidence'
}
