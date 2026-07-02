"""Proactive anomaly detection (jarvis#68) — the PURE analysis core.

A watcher periodically runs a probe command and feeds each output to this
module, which learns a baseline and reports only GENUINELY unusual results —
a low-noise background guardian, not a firehose.

Two modes, auto-picked from the probe output (or forced):
  - NUMERIC: the output's last number is tracked. After `learn_checks`
    samples a running mean/stddev is the baseline; a sample is anomalous when
    it deviates more than `z` standard deviations (z set by sensitivity), with
    a small absolute floor so a dead-flat baseline doesn't fire on rounding.
  - LINES: the SET of output lines seen during learning is the baseline; any
    later line not in that set is anomalous ("a new error appeared").

Low-noise guarantees live here: (1) nothing fires during the learning window,
(2) an anomaly with the same signature won't re-fire until `cooldown_checks`
quiet checks pass, so a persistent condition alerts ONCE, not every interval.

`WatchState` is a plain dict so bg_jobs can persist it in job.json across the
detached runner's checks. Everything here is deterministic + side-effect-free
(no clock, no I/O) so it's unit-testable.
"""

from __future__ import annotations

import math
import re
from typing import Any

# sensitivity -> (numeric z-threshold, absolute floor as fraction of mean)
_SENS = {
    "low":    (4.0, 0.50),   # only wild swings
    "medium": (3.0, 0.30),
    "high":   (2.0, 0.15),   # twitchy
}

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def new_state(mode: str = "auto", learn_checks: int = 5,
              sensitivity: str = "medium", cooldown_checks: int = 10) -> dict:
    return {
        "mode": mode if mode in ("auto", "numeric", "lines") else "auto",
        "learn_checks": max(1, int(learn_checks)),
        "sensitivity": sensitivity if sensitivity in _SENS else "medium",
        "cooldown_checks": max(1, int(cooldown_checks)),
        "checks": 0,
        # numeric baseline (Welford)
        "n": 0, "mean": 0.0, "m2": 0.0,
        # line baseline
        "known": [],
        # cooldown: signature -> checks-remaining-quiet
        "cooldowns": {},
    }


def _last_number(text: str):
    nums = _NUM_RE.findall(text or "")
    if not nums:
        return None
    try:
        return float(nums[-1])
    except ValueError:
        return None


def _decide_mode(state: dict, text: str) -> str:
    if state["mode"] != "auto":
        return state["mode"]
    return "numeric" if _last_number(text) is not None else "lines"


def observe(state: dict, text: str) -> dict:
    """Feed one probe output. Mutates `state`; returns a report dict:
      {check, learning, anomaly: bool, mode, detail, signature?, value?}
    `anomaly` is True only for a fresh, out-of-cooldown deviation.
    """
    state["checks"] += 1
    check = state["checks"]
    mode = _decide_mode(state, text)

    # age cooldowns each check; drop expired
    for sig in list(state["cooldowns"].keys()):
        state["cooldowns"][sig] -= 1
        if state["cooldowns"][sig] <= 0:
            del state["cooldowns"][sig]

    learning = check <= state["learn_checks"]
    report: dict[str, Any] = {"check": check, "learning": learning,
                              "anomaly": False, "mode": mode}

    if mode == "numeric":
        val = _last_number(text)
        report["value"] = val
        if val is None:
            report["detail"] = "no number in output"
            return report
        if learning:
            _welford_add(state, val)
            report["detail"] = f"baseline sample {state['n']}: {val}"
            return report
        mean, std = state["mean"], _stddev(state)
        z, floor_frac = _SENS[state["sensitivity"]]
        floor = max(abs(mean) * floor_frac, 1e-9)
        dev = abs(val - mean)
        deviant = dev > floor and (std < 1e-9 or dev > z * std)
        # keep the baseline adapting to slow drift (only on normal samples)
        if not deviant:
            _welford_add(state, val)
            report["detail"] = f"normal ({val} ~ mean {round(mean, 3)})"
            return report
        sig = "num"
        report["signature"] = sig
        report["detail"] = (f"value {val} deviates from baseline mean "
                            f"{round(mean, 3)} (±{round(std, 3)})")
        if sig not in state["cooldowns"]:
            report["anomaly"] = True
            state["cooldowns"][sig] = state["cooldown_checks"]
        return report

    # lines mode
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if learning:
        for ln in lines:
            if ln not in state["known"]:
                state["known"].append(ln)
        report["detail"] = f"baseline: {len(state['known'])} known lines"
        return report
    known = set(state["known"])
    fresh = [ln for ln in lines if ln not in known]
    if not fresh:
        report["detail"] = "all lines known"
        return report
    # signature = the set of new lines (so the SAME new error won't re-fire)
    sig = "|".join(sorted(set(fresh)))[:500]
    report["signature"] = sig
    report["detail"] = "new line(s): " + " ⏎ ".join(fresh[:5])
    if sig not in state["cooldowns"]:
        report["anomaly"] = True
        state["cooldowns"][sig] = state["cooldown_checks"]
        # learn it so it becomes normal after alerting once
        for ln in fresh:
            state["known"].append(ln)
    return report


def _welford_add(state: dict, x: float) -> None:
    state["n"] += 1
    d = x - state["mean"]
    state["mean"] += d / state["n"]
    state["m2"] += d * (x - state["mean"])


def _stddev(state: dict) -> float:
    if state["n"] < 2:
        return 0.0
    return math.sqrt(state["m2"] / (state["n"] - 1))
