#!/usr/bin/env python3
"""
Statistical calibration for MOEL jury scores.

Fits per-judge logistic regression models: P(correct | judge_score) = σ(β0 + β1·score)
Uses leave-one-out cross-validation to estimate generalization error.

Usage:
    python calibrate.py --data calibration_data.json --output calibration_model.json
"""

import argparse
import json
import sys
import warnings
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import LeaveOneOut


def fit_judge_model(
    scores: list[float], labels: list[int]
) -> dict[str, Any]:
    """Fit logistic regression for one judge and compute LOO metrics."""
    X = np.array(scores).reshape(-1, 1)
    y = np.array(labels)

    # Fit the full model
    model = LogisticRegression(max_iter=1000, solver="lbfgs")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model.fit(X, y)

    beta0 = float(model.intercept_[0])
    beta1 = float(model.coef_[0][0])

    # LOO cross-validation for generalization error
    loo = LeaveOneOut()
    loo_preds: list[int] = []
    loo_true: list[int] = []
    for train_idx, test_idx in loo.split(X):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        loo_model = LogisticRegression(max_iter=1000, solver="lbfgs")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                loo_model.fit(X_train, y_train)
                pred = int(loo_model.predict(X_test)[0])
            except Exception:
                pred = int(round(np.mean(y_train)))
        loo_preds.append(pred)
        loo_true.append(int(y_test[0]))

    loo_preds_arr = np.array(loo_preds)
    loo_true_arr = np.array(loo_true)

    tp = int(np.sum((loo_preds_arr == 1) & (loo_true_arr == 1)))
    tn = int(np.sum((loo_preds_arr == 0) & (loo_true_arr == 0)))
    fp = int(np.sum((loo_preds_arr == 1) & (loo_true_arr == 0)))
    fn = int(np.sum((loo_preds_arr == 0) & (loo_true_arr == 1)))

    tpr = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    tnr = tn / (tn + fp) if (tn + fp) > 0 else 0.0
    balanced_accuracy = (tpr + tnr) / 2.0

    # Calibration error on full set
    full_preds = model.predict(X)
    abs_errors = np.abs(full_preds - y)
    max_abs_error = float(np.max(abs_errors)) if len(abs_errors) > 0 else 0.0

    return {
        "beta0": beta0,
        "beta1": beta1,
        "tpr": tpr,
        "tnr": tnr,
        "balancedAccuracy": balanced_accuracy,
        "looPredictions": loo_preds,
        "looTrue": loo_true,
        "maxAbsoluteError": max_abs_error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Calibrate MOEL jury scores")
    parser.add_argument("--data", required=True, help="Path to calibration_data.json")
    parser.add_argument("--output", required=True, help="Path to write calibration_model.json")
    args = parser.parse_args()

    sys.stderr.write(f"[calibrate] Loading data from {args.data}\n")
    with open(args.data, encoding="utf-8") as f:
        data: list[dict[str, Any]] = json.load(f)

    sys.stderr.write(f"[calibrate] {len(data)} calibration tasks loaded\n")

    # Collect per-judge data
    judge_scores: dict[str, list[float]] = {}
    judge_labels: dict[str, list[int]] = {}

    for entry in data:
        human_pass = 1 if entry["humanPass"] else 0
        for judge_name, score in entry["humanScores"].items():
            judge_scores.setdefault(judge_name, []).append(float(score))
            judge_labels.setdefault(judge_name, []).append(human_pass)

    judge_models: dict[str, Any] = {}
    overall_max_error = 0.0

    for judge_name in judge_scores:
        scores = judge_scores[judge_name]
        labels = judge_labels[judge_name]
        sys.stderr.write(f"[calibrate] Fitting model for judge '{judge_name}' ({len(scores)} samples)\n")
        result = fit_judge_model(scores, labels)
        judge_models[judge_name] = result
        if result["maxAbsoluteError"] > overall_max_error:
            overall_max_error = result["maxAbsoluteError"]
        sys.stderr.write(
            f"[calibrate]   β0={result['beta0']:.4f}, β1={result['beta1']:.4f}, "
            f"TPR={result['tpr']:.3f}, TNR={result['tnr']:.3f}, "
            f"balancedAcc={result['balancedAccuracy']:.3f}\n"
        )

    output = {
        "schemaVersion": 1,
        "judges": judge_models,
        "overall": {
            "maxAbsoluteError": overall_max_error,
            "numTasks": len(data),
        },
    }

    sys.stderr.write(f"[calibrate] Writing model to {args.output}\n")
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    sys.stderr.write(
        f"[calibrate] Done. maxAbsoluteError={overall_max_error:.4f} "
        f"({'✓ within 1.5%' if overall_max_error <= 0.015 else '✗ exceeds 1.5%'})\n"
    )


if __name__ == "__main__":
    main()
