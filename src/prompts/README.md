# Prompts

LLM prompts used by the KB CLI, stored as plain Markdown files so they can be read and edited without touching TypeScript.

## Files

| File | Used by | Kind |
|---|---|---|
| `chat-system.md` | `chat-cli.ts` — `CHAT_SYSTEM_PROMPT` | single-part |
| `graph-extraction.md` | `graph-entity-extractor.ts` — `EXTRACTION_SYSTEM_PROMPT` | single-part |
| `init-synthesis.md` | `init-cli.ts` — `runSynthesisPass` | two-part (intro + instructions) |
| `init-refinement.md` | `init-cli.ts` — `runRefinementPass` | two-part (intro + instructions) |
| `init-quality.md` | `init-cli.ts` — `runQualityPass` | two-part (intro + instructions) |
| `init-enrichment.md` | `init-cli.ts` — `runPerDocEnrichmentPass` | two-part (intro + instructions) |

## Prompt formats

### Single-part

Plain Markdown text. The entire file content is used as the prompt string.

```
You are a widget inspector. Examine the widget and report defects.
```

Load with:

```typescript
import { loadPrompt } from '../prompts/loader'

const SYSTEM_PROMPT = loadPrompt('my-prompt.md')
```

### Single-part with placeholders

Same as single-part, but the file contains `{{placeholder}}` tokens that are replaced at call time.

```
Check whether the following claim is accurate.

Claim: {{claim}}

Context:
{{context}}
```

Load with:

```typescript
const prompt = loadPrompt('my-prompt.md')
  .replace('{{claim}}', claim)
  .replace('{{context}}', context)
```

### Two-part (intro + instructions)

For prompts passed to `buildBudgetedPrompt`, the file is split into an **intro** (role/context given to the LLM) and **instructions** (the task rules) by a `---` divider on its own line.

```
You are a widget inspector. Your job is to find defects in the widgets provided.

---

1. List every visible defect.
2. Rate severity: low | medium | high.
3. Return ONLY a JSON array.
```

Load with:

```typescript
import { loadPromptParts } from '../prompts/loader'

const { intro, instructions } = loadPromptParts('my-prompt.md')
buildBudgetedPrompt({ intro, sections: [...], instructions })
```

Placeholders work in two-part files too — call `.replace()` on `intro` or `instructions` after loading.

## Adding a new prompt

1. Create a `.md` file in this directory.
2. Choose single-part or two-part format (use two-part when the prompt goes into `buildBudgetedPrompt`).
3. Import `loadPrompt` or `loadPromptParts` from `../prompts/loader` in the consuming file.
4. Add a row to the table above.
5. Add a test case in `tests/prompts/loader.test.ts` if the new file uses a non-obvious format or a placeholder.
