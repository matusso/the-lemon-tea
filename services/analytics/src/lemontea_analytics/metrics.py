"""Evaluation metrics. Pure numpy/scipy so they are trivially unit-testable."""

from __future__ import annotations

import numpy as np
from scipy import stats


def mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(np.asarray(y_true) - np.asarray(y_pred))))


def rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.sqrt(np.mean((np.asarray(y_true) - np.asarray(y_pred)) ** 2)))


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 3:
        return float("nan")
    return float(stats.spearmanr(a, b).statistic)


def brier(prob: np.ndarray, outcome: np.ndarray) -> float:
    """Mean squared error of probabilities against 0/1 outcomes."""
    return float(np.mean((np.asarray(prob, dtype=float) - np.asarray(outcome, dtype=float)) ** 2))


def log_loss_winner(probs: np.ndarray, winner_index: int, eps: float = 1e-6) -> float:
    """Multiclass log loss for "who takes pole": -log p(actual pole sitter)."""
    return -float(np.log(float(np.clip(probs[winner_index], eps, 1.0))))


def interval_coverage(y: np.ndarray, low: np.ndarray, high: np.ndarray) -> float:
    y = np.asarray(y)
    return float(np.mean((y >= np.asarray(low)) & (y <= np.asarray(high))))


def expected_calibration_error(prob: np.ndarray, outcome: np.ndarray, bins: int = 10) -> float:
    prob = np.asarray(prob, dtype=float)
    outcome = np.asarray(outcome, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    ece = 0.0
    for lo, hi in zip(edges[:-1], edges[1:], strict=True):
        m = (prob >= lo) & ((prob < hi) | (hi == 1.0))
        if m.any():
            ece += m.mean() * abs(prob[m].mean() - outcome[m].mean())
    return float(ece)


def pole_probabilities(pred_gap: np.ndarray, sigma: float, iterations: int = 5000, seed: int = 7) -> np.ndarray:
    """Monte Carlo P(fastest) for independent normal errors (seeded, reproducible)."""
    rng = np.random.default_rng(seed)
    draws = pred_gap[None, :] + rng.normal(0.0, sigma, size=(iterations, len(pred_gap)))
    return np.bincount(np.argmin(draws, axis=1), minlength=len(pred_gap)) / iterations
