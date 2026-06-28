import { describe, expect, it } from 'vitest'
import type { InitContext } from '../../src/cli/init-cli'
import {
  assessTopicCoverage,
  buildTopicCoverageGaps,
  summariseCoverage,
} from '../../src/cli/init-topic-coverage'

describe('init topic coverage', () => {
  it('[TC-303] Given grounded source, user answers, and draft docs, then marks topic sufficient', () => {
    const context: InitContext = {
      sourceFiles: {
        'README.md': 'Install with npm install. Configure with .env.local. Run tests with vitest.',
      },
      userAnswers: [
        {
          question: 'How do you install or set up this project?',
          answer: 'Run npm install and then npm run build.',
          topic: 'install-setup',
        },
      ],
    }

    const coverage = assessTopicCoverage(
      context,
      [
        {
          title: 'Installation and Configuration',
          content: 'Install with npm install and configure via .env.local before first run.',
        },
      ],
      false
    )

    const installTopic = coverage.find(topic => topic.topic === 'install-setup')
    expect(installTopic?.status).toBe('sufficient')
    expect(installTopic?.confidence).toBe('high')
    expect(installTopic?.enoughContext).toBe(true)
  })

  it('[TC-304] Given contradictory deployment signals, then surfaces unresolved contradiction gap', () => {
    const context: InitContext = {
      sourceFiles: {
        'README.md': 'Deployments are manual from a local machine.',
      },
      userAnswers: [
        {
          question: 'How is the project deployed, released, or published?',
          answer: 'Deployments are automatic in the cloud.',
          topic: 'deployment-release',
        },
      ],
    }

    const coverage = assessTopicCoverage(
      context,
      [
        {
          title: 'Release Flow',
          content: 'The project ships automatically using cloud deployment jobs.',
        },
      ],
      false
    )

    const deploymentTopic = coverage.find(topic => topic.topic === 'deployment-release')
    expect(deploymentTopic?.status).toBe('unresolved')
    expect(deploymentTopic?.keyEvidence.join(' ')).toContain('contradictory signals')

    const gaps = buildTopicCoverageGaps(coverage)
    const deploymentGap = gaps.find(topic => topic.topic === 'deployment-release')
    expect(deploymentGap?.reason).toBe('contradiction')
  })

  it('[TC-305] Given weak non-interactive evidence, then marks topic inferred and summarizes unresolved topics', () => {
    const context: InitContext = {
      sourceFiles: {
        'README.md': 'This project has a CLI.',
      },
      userAnswers: [],
    }

    const coverage = assessTopicCoverage(
      context,
      [
        {
          title: 'CLI Basics',
          content: 'The CLI can query the KB and submit facts.',
        },
      ],
      true
    )

    const workflowTopic = coverage.find(topic => topic.topic === 'core-workflows')
    expect(workflowTopic?.status).toBe('inferred-only')
    expect(workflowTopic?.stopReason).toBe('non-interactive-mode')

    const summary = summariseCoverage(coverage)
    expect(summary.inferredTopics).toContain('core-workflows')
    expect(summary.unresolvedTopics).toContain('architecture')
  })
})
