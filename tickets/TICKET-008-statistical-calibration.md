# TICKET-008: Statistical Calibration Framework

**Status:** Open  
**Priority:** P2  
**Labels:** evaluation, statistics, calibration

## Context

Even after applying bias mitigations, individual judges have idiosyncratic error rates. A regression-based calibration layer trained on human-annotated ground truth can align the ensemble's raw outputs to actual correctness more precisely than majority vote alone. The target from the research plan is a maximum absolute error of 1.2% on the calibration set.

## Objective

Implement a calibration module that:
1. Maintains a human-annotated calibration dataset of 20 evaluation tasks.
2. Fits per-judge TPR (True Positive Rate) and TNR (True Negative Rate) via logistic regression.
3. Applies bias-corrected weighting to the ensemble's final score.

## Acceptance Criteria

- [ ] Calibration dataset schema: each entry has `task_id`, `candidate`, `reference`, `rubric`, `human_score` (0–5 per rubric item), `human_pass` (bool).
- [ ] `calibrate_judges(calibration_data: list[dict], jury_runner: JuryRunner) -> CalibrationModel` fits per-judge `(TPR_i, TNR_i)` on the annotated set.
- [ ] `CalibrationModel.apply(raw_scores: dict[str, float]) -> float` returns a calibrated ensemble score.
- [ ] Calibrated score on the calibration set achieves max absolute error ≤ 1.5% against human ground truth.
- [ ] Model parameters (`β` coefficients) are persisted to a JSON file for reproducibility.
- [ ] Includes a calibration report: per-judge TPR, TNR, and the pre/post-calibration error on the annotated set.
- [ ] Unit tests cover: perfect judge (TPR=1, TNR=1) → no adjustment, all judges wrong → calibration should reduce weight to near zero.

## Implementation Notes

### Calibration Model

For each judge `i`, the model learns:

```
P(correct | judge_i_score) = σ(β_0i + β_1i · score_i)
```

where `σ` is the logistic sigmoid. The ensemble prediction is the weighted average of these per-judge probabilities, with weights proportional to each judge's `(TPR_i + TNR_i) / 2` (balanced accuracy).

Use `scikit-learn`'s `LogisticRegression` with the calibration data. If the calibration set is too small for held-out validation, use leave-one-out cross-validation to estimate generalization error.

### Building the Calibration Set

The 20 tasks should span:
- At least 3 programming languages.
- Both correct and incorrect candidates (roughly 50/50 to ensure TNR is well-estimated).
- A mix of code generation, documentation generation, and refactoring tasks.

Annotation should be done by at least 2 human reviewers with inter-rater agreement tracked (Cohen's kappa target: > 0.7).

### Calibration Persistence

```
eval/calibration/
  calibration_data.json     # human-annotated ground truth
  calibration_model.json    # fitted β coefficients
  calibration_report.md     # TPR/TNR table and error metrics
```

## Output Artifact

`eval/calibration/calibrator.py`  
`eval/calibration/calibration_data.json` (initial 20-task seed)  
`eval/calibration/calibration_model.json`

## Dependencies

TICKET-007

## Feeds Into

TICKET-010
