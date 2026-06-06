# TICKET-008: Statistical Calibration Framework

**Status:** Open  
**Priority:** P2  
**Language:** Python  
**Labels:** evaluation, statistics, calibration

## Context

Even after bias mitigation, individual judges have idiosyncratic error rates. A regression-based calibration layer trained on human-annotated ground truth can align the ensemble's outputs to actual correctness more precisely than majority vote.

This is the only ticket that uses Python. The pattern mirrors the existing `requirements/fact-category-clustering.txt` approach: a small Python script that auto-installs to `~/.kb/.kb-python` and is invoked by the TypeScript harness via a subprocess call. Scikit-learn's logistic regression is used for TPR/TNR calibration.

## Objective

Implement a Python calibration script that:
1. Loads a human-annotated calibration dataset.
2. Fits per-judge TPR and TNR via logistic regression.
3. Applies bias-corrected weighting to produce a calibrated ensemble score.
4. Writes fitted model parameters to JSON for reproducibility.

## Acceptance Criteria

- [ ] Python script at `eval/calibration/calibrate.py` accepts `--data calibration_data.json --output calibration_model.json`.
- [ ] Calibration dataset schema: each entry has `taskId`, `candidate`, `reference`, `rubric: string[]`, `humanScores: Record<string, number>` (per rubric item), `humanPass: boolean`.
- [ ] Fits `LogisticRegression` from scikit-learn per judge: `P(correct | judge_score) = σ(β0 + β1 · score)`.
- [ ] Uses leave-one-out cross-validation (given small dataset size) to estimate generalization error.
- [ ] Writes `calibration_model.json` with: per-judge `beta0`, `beta1`, `tpr`, `tnr`, `balancedAccuracy`; and overall `maxAbsoluteError` on calibration set.
- [ ] Target: `maxAbsoluteError ≤ 1.5%` on the calibration set.
- [ ] A companion `eval/calibration/apply_calibration.py` accepts a jury's raw score dict and the model JSON via **stdin as a single JSON line** and writes a calibrated float to **stdout as a JSON line** (same newline-delimited JSON protocol as `scripts/fact_categories_hdbscan.py`).
- [ ] Requirements added to `requirements/moel-calibration.txt` following the same pattern as `requirements/fact-category-clustering.txt`.
- [ ] The TypeScript harness (TICKET-010) calls `apply_calibration.py` via `execFileSync` into `~/.kb/.kb-python`, same pattern used for the existing clustering script in `src/core/fact-categories.ts`.

## Subprocess Invocation Pattern

**Copy this pattern exactly from `src/core/fact-categories.ts`.**

### Python binary resolution (`resolvePythonBinary` / `ensurePythonEnv`)

Resolution order (first match wins):

1. `process.env.KB_CATEGORY_CLUSTER_PYTHON` — env-var override (trimmed).
2. `<REPO_ROOT>/.kb-python/bin/python3` — repo-local venv (dev workflow).
3. `path.join(process.env.KB_HOME ?? os.homedir() + '/.kb', '.kb-python', 'bin', 'python3')` — global venv.
4. If none exist: auto-create the global venv, write `kb-requirements.txt` into it, and run `pip install --quiet -r <reqsFile>`.

The global venv directory helper:
```ts
function globalVenvDir(): string {
  const kbHome = process.env.KB_HOME?.trim() ?? path.join(os.homedir(), '.kb')
  return path.join(kbHome, '.kb-python')
}
// binary: path.join(globalVenvDir(), 'bin', 'python3')
```

### Auto-install (one-time, triggered when venv is absent)

```ts
// 1. Verify python3 is on PATH
const base = spawnSync('python3', ['--version'], { encoding: 'utf8' })
// throws if missing — requires Python 3.9+

// 2. Create the venv
spawnSync('python3', ['-m', 'venv', venvDir], { encoding: 'utf8' })

// 3. Write a requirements file into the venv dir and pip-install it
const pip = path.join(venvDir, 'bin', 'pip')
const reqsFile = path.join(venvDir, 'kb-requirements.txt')
writeFileSync(reqsFile, PYTHON_REQUIREMENTS.join('\n') + '\n', 'utf8')
spawnSync(pip, ['install', '--quiet', '-r', reqsFile], { encoding: 'utf8', stdio: 'inherit' })
```

`PYTHON_REQUIREMENTS` for calibration — inline copy mirroring `requirements/moel-calibration.txt`:
```ts
const PYTHON_REQUIREMENTS = ['numpy==2.2.5', 'scikit-learn==1.6.1']
```

### Calling the script (`runCalibrationPython`)

```ts
import { execFileSync } from 'node:child_process'

const PYTHON_CALIBRATOR_PATH = path.join(REPO_ROOT, 'eval', 'calibration', 'apply_calibration.py')

function runCalibrationPython(payload: Record<string, unknown>): unknown {
  const pythonBinary = resolveCalibrationPythonBinary()   // same logic as resolvePythonBinary()
  const raw = execFileSync(pythonBinary, [PYTHON_CALIBRATOR_PATH], {
    cwd: REPO_ROOT,
    input: JSON.stringify(payload),   // written to the script's stdin
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
    },
  }).trim()
  if (!raw) throw new Error('apply_calibration.py returned empty output.')
  return JSON.parse(raw)             // parse single JSON line from stdout
}
```

Key points:
- `execFileSync` (not `spawnSync`, not `spawn`) — synchronous, throws on non-zero exit.
- `input` is the serialised JSON payload written to **stdin**.
- `PYTHONUTF8: '1'` must be present in the env object.
- `maxBuffer: 10 * 1024 * 1024` (10 MB).
- The script's **stdout** must be a single JSON line; anything diagnostic goes to **stderr**.

## stdin/stdout Protocol for `apply_calibration.py`

### stdin (one JSON object, written by TypeScript)

```json
{
  "model": "<path to calibration_model.json, or the parsed object>",
  "juryScores": {
    "judge-gpt4o": 3.8,
    "judge-claude": 4.1,
    "judge-gemini": 2.9
  }
}
```

`model` may be either a file path string or the inline parsed model object — the script must handle both.

### stdout (one JSON line, read by TypeScript)

```json
{"calibratedScore": 0.812}
```

The float is the final calibrated ensemble probability in `[0, 1]`. No trailing newline is required, but the line must be valid JSON. All warnings, progress messages, and debug output must go to **stderr only**.

### Exit codes

- `0` — success; stdout contains the JSON result.
- Non-zero — failure; TypeScript will throw from `execFileSync`.

## `requirements/moel-calibration.txt` (exact content)

Follow the pinned-version format of `requirements/fact-category-clustering.txt` (no extras, no version ranges):

```
numpy==2.2.5
scikit-learn==1.6.1
```

`hdbscan` is **not** needed for calibration. The inline `PYTHON_REQUIREMENTS` constant in the TypeScript harness for TICKET-010 must mirror this file exactly (as `fact-categories.ts` mirrors `requirements/fact-category-clustering.txt`).

## Python Version

Python 3.9+ is required (enforced by the `ensurePythonEnv` auto-install path, which calls `python3 --version` and throws a descriptive error if `python3` is not found on `PATH`).

## Building the Calibration Set

The 20 tasks should be drawn from the existing `eval/suites/*.yaml` question packs where possible. Human annotation means at least one person rates each candidate response on the same 0–5 rubric used by the jury. Aim for:
- At least 3 question types (architecture, usage, retrieval behavior)
- ~50% correct / ~50% incorrect candidates to ensure TNR is estimable
- Inter-rater agreement tracked if two annotators are available (Cohen's kappa target: > 0.7)

## Files to Create

- `eval/calibration/calibrate.py`
- `eval/calibration/apply_calibration.py`
- `eval/calibration/calibration_data.json` (seed 20-task dataset)
- `eval/calibration/calibration_model.json` (generated output, gitignored)
- `requirements/moel-calibration.txt`

## Files to Reference (do not modify)

- `src/core/fact-categories.ts` — the exact subprocess invocation pattern to copy (`runFactCategoryPython`, `ensurePythonEnv`, `globalVenvDir`, `resolvePythonBinary`).
- `scripts/fact_categories_hdbscan.py` — example Python script implementing the stdin → stdout JSON protocol.
- `requirements/fact-category-clustering.txt` — pinned-package format to follow.

## Dependencies

TICKET-007

## Feeds Into

TICKET-010
