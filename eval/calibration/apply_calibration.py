#!/usr/bin/env python3
"""
Apply a fitted calibration model to jury scores.

Reads one JSON line from stdin:
    {"model": <path or inline object>, "juryScores": {"judge-name": score, ...}}

Writes one JSON line to stdout:
    {"calibratedScore": 0.812}

All diagnostic output goes to stderr.
"""

import json
import math
import sys
from typing import Any, Union


def sigmoid(x: float) -> float:
    """Numerically stable sigmoid."""
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    exp_x = math.exp(x)
    return exp_x / (1.0 + exp_x)


def load_model(model_field: Union[str, dict[str, Any]]) -> dict[str, Any]:
    """Load calibration model from a file path or inline object."""
    if isinstance(model_field, str):
        sys.stderr.write(f"[apply_calibration] Loading model from {model_field}\n")
        with open(model_field, encoding="utf-8") as f:
            return json.load(f)
    return model_field


def apply_calibration(model: dict[str, Any], jury_scores: dict[str, float]) -> float:
    """
    Apply logistic calibration per judge, then average calibrated probabilities.

    For each judge j with score s_j:
        p_j = σ(β0_j + β1_j · s_j)

    Final calibrated score = mean(p_j) across all judges that have a fitted model.
    Judges without a fitted model are included as-is (raw score / 5.0) to normalize to [0,1].
    """
    judges_model: dict[str, Any] = model.get("judges", {})
    calibrated_probs: list[float] = []

    for judge_name, raw_score in jury_scores.items():
        if judge_name in judges_model:
            judge_params = judges_model[judge_name]
            beta0 = float(judge_params["beta0"])
            beta1 = float(judge_params["beta1"])
            prob = sigmoid(beta0 + beta1 * float(raw_score))
            sys.stderr.write(
                f"[apply_calibration] {judge_name}: raw={raw_score:.3f} → calibrated={prob:.4f}\n"
            )
        else:
            # No fitted model: normalize raw score from [0,5] to [0,1]
            prob = min(max(float(raw_score) / 5.0, 0.0), 1.0)
            sys.stderr.write(
                f"[apply_calibration] {judge_name}: no model, normalized={prob:.4f}\n"
            )
        calibrated_probs.append(prob)

    if not calibrated_probs:
        sys.stderr.write("[apply_calibration] WARNING: no jury scores provided, returning 0.0\n")
        return 0.0

    return sum(calibrated_probs) / len(calibrated_probs)


def main() -> None:
    raw_input = sys.stdin.read().strip()
    if not raw_input:
        sys.stderr.write("[apply_calibration] ERROR: empty stdin\n")
        sys.exit(1)

    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[apply_calibration] ERROR: invalid JSON on stdin: {e}\n")
        sys.exit(1)

    model_field = payload.get("model")
    jury_scores = payload.get("juryScores", {})

    if model_field is None:
        sys.stderr.write("[apply_calibration] ERROR: missing 'model' field in payload\n")
        sys.exit(1)

    try:
        model = load_model(model_field)
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"[apply_calibration] ERROR: failed to load model: {e}\n")
        sys.exit(1)

    calibrated_score = apply_calibration(model, jury_scores)
    sys.stderr.write(f"[apply_calibration] calibratedScore={calibrated_score:.6f}\n")

    # Single JSON line to stdout
    print(json.dumps({"calibratedScore": calibrated_score}))


if __name__ == "__main__":
    main()
