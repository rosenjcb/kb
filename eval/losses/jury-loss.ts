import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { LLMCallParams, LLMProvider } from '@kb/core/core/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROMPT_TEMPLATE_PATH = path.join(__dirname, '../prompts/judge-meta-prompt.md')

export interface JudgeConfig {
  provider: LLMProvider
}

export interface JuryInput {
  candidate: string
  reference: string
  rubric: string[]
}

export interface JudgeDetail {
  providerName: string
  scores: Record<string, number>
  adjustedScores: Record<string, number>
  weight: number
  vetoFlag: boolean
  positionConsistencyDelta?: number
}

export interface JuryResult {
  loss: number
  vetoed: boolean
  warnings: string[]
  judgeDetails: JudgeDetail[]
}

export interface BiasConfig {
  vetoThreshold: number
  enableVerbosityNormalization: boolean
  enablePositionDebiasing: boolean
  enforceModelFamilyDiversity: boolean
}

export const DEFAULT_BIAS_CONFIG: BiasConfig = {
  vetoThreshold: 2,
  enableVerbosityNormalization: true,
  enablePositionDebiasing: true,
  enforceModelFamilyDiversity: true,
}

interface JudgeVerdict {
  analysis: string
  scores: Record<string, number>
  veto_flag: boolean
  veto_reason: string
}

export function parseVerdict(raw: string): JudgeVerdict | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.analysis !== 'string' ||
      parsed.analysis.trim() === '' ||
      typeof parsed.scores !== 'object' ||
      parsed.scores === null ||
      typeof parsed.veto_flag !== 'boolean'
    ) {
      return null
    }
    return parsed as unknown as JudgeVerdict
  } catch {
    return null
  }
}

function fillPrompt(
  template: string,
  rubric: string[],
  candidate: string,
  reference: string
): string {
  const rubricItems = rubric.map((item, i) => `rubric_${i + 1}: ${item}`).join('\n')
  return template
    .replace('{rubricItems}', rubricItems)
    .replace('{candidate}', candidate)
    .replace('{reference}', reference)
}

async function callJudge(
  provider: LLMProvider,
  candidate: string,
  reference: string,
  rubric: string[],
  template: string
): Promise<JudgeVerdict | null> {
  const params: LLMCallParams = {
    systemPrompt: "You are an expert software engineering judge evaluating an agent's output.",
    messages: [{ role: 'user', content: fillPrompt(template, rubric, candidate, reference) }],
    maxTokens: 2048,
    temperature: 0,
  }
  const response = await provider.call(params)
  return parseVerdict(response.text)
}

function meanOf(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export async function runJury(
  input: JuryInput,
  judges: JudgeConfig[],
  biasConfig?: Partial<BiasConfig>,
  generatorProviderName?: 'anthropic' | 'openai' | 'gemini' | 'ollama'
): Promise<JuryResult> {
  const config: BiasConfig = { ...DEFAULT_BIAS_CONFIG, ...biasConfig }

  if (config.enforceModelFamilyDiversity && generatorProviderName) {
    const distinctNonGenerator = new Set(
      judges.map(j => j.provider.name).filter(n => n !== generatorProviderName)
    )
    if (distinctNonGenerator.size < 2) {
      throw new Error(
        'BiasConfig requires at least 2 judge provider families distinct from the generator family'
      )
    }
  }

  const template = await readFile(PROMPT_TEMPLATE_PATH, 'utf-8')

  const augmentedRubric = [
    ...input.rubric,
    'Is the response free of unnecessary verbosity and repetition?',
  ]

  const warnings: string[] = []
  const judgeDetails: JudgeDetail[] = []
  let vetoCount = 0

  const candidateTokenCount = input.candidate.trim().split(/\s+/).length
  const log1pTokens = Math.log1p(candidateTokenCount)

  for (const judge of judges) {
    const providerName = judge.provider.name

    let weight = 1.0
    if (generatorProviderName && providerName === generatorProviderName) {
      weight = 0.5
      warnings.push(
        `Self-enhancement warning: judge ${providerName} matches generator family, weight=0.5`
      )
    }

    let scores: Record<string, number> = {}
    let vetoFlag = false
    let positionConsistencyDelta: number | undefined

    if (config.enablePositionDebiasing) {
      const forward = await callJudge(
        judge.provider,
        input.candidate,
        input.reference,
        augmentedRubric,
        template
      )
      const reversed = await callJudge(
        judge.provider,
        input.reference,
        input.candidate,
        augmentedRubric,
        template
      )

      if (!forward || !reversed) {
        vetoFlag = true
        positionConsistencyDelta = 0
      } else {
        vetoFlag = forward.veto_flag || reversed.veto_flag

        let maxDelta = 0
        const keys = new Set([...Object.keys(forward.scores), ...Object.keys(reversed.scores)])
        for (const key of keys) {
          const fwd = forward.scores[key] ?? 0
          const rev = reversed.scores[key] ?? 0
          scores[key] = (fwd + rev) / 2
          const delta = Math.abs(fwd - rev)
          if (delta > 2) {
            warnings.push(
              `Position consistency warning: judge ${providerName} rubric item ${key} delta=${delta}`
            )
          }
          maxDelta = Math.max(maxDelta, delta)
        }
        positionConsistencyDelta = maxDelta
      }
    } else {
      const verdict = await callJudge(
        judge.provider,
        input.candidate,
        input.reference,
        augmentedRubric,
        template
      )
      if (!verdict) {
        vetoFlag = true
      } else {
        vetoFlag = verdict.veto_flag
        scores = verdict.scores
      }
    }

    if (vetoFlag) vetoCount++

    const adjustedScores: Record<string, number> = {}
    for (const [key, score] of Object.entries(scores)) {
      adjustedScores[key] = config.enableVerbosityNormalization ? score / log1pTokens : score
    }

    const detail: JudgeDetail = { providerName, scores, adjustedScores, weight, vetoFlag }
    if (config.enablePositionDebiasing) {
      detail.positionConsistencyDelta = positionConsistencyDelta ?? 0
    }
    judgeDetails.push(detail)
  }

  if (vetoCount >= config.vetoThreshold) {
    return { loss: 1.0, vetoed: true, warnings, judgeDetails }
  }

  let totalWeight = 0
  let weightedSum = 0
  for (const d of judgeDetails) {
    const mean = meanOf(Object.values(d.adjustedScores))
    weightedSum += d.weight * mean
    totalWeight += d.weight
  }

  const weightedMeanScore = totalWeight > 0 ? weightedSum / totalWeight : 0
  const loss = Math.max(0, Math.min(1, 1 - weightedMeanScore / 5))

  return { loss, vetoed: false, warnings, judgeDetails }
}
