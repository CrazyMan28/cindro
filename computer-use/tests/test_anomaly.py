"""Proactive anomaly detection core (jarvis#68): baseline learning, numeric +
line modes, and the low-noise (cooldown, learn-window) guarantees."""

from computer_use_mcp import anomaly


def feed(state, samples):
    return [anomaly.observe(state, s) for s in samples]


def test_no_alerts_during_learning():
    st = anomaly.new_state(learn_checks=3, sensitivity="high")
    reps = feed(st, ["100", "500", "9000"])  # wildly varied, still learning
    assert all(r["learning"] for r in reps)
    assert not any(r["anomaly"] for r in reps)


def test_numeric_anomaly_after_baseline():
    st = anomaly.new_state(learn_checks=4, sensitivity="medium")
    feed(st, ["10", "11", "9", "10"])       # baseline ~10
    r = anomaly.observe(st, "10")           # normal
    assert not r["anomaly"]
    r = anomaly.observe(st, "500")          # spike
    assert r["anomaly"] and r["mode"] == "numeric"


def test_numeric_flat_baseline_has_floor():
    # dead-flat baseline (std 0): a tiny wobble must NOT fire, a big jump must.
    st = anomaly.new_state(learn_checks=4, sensitivity="high")
    feed(st, ["100", "100", "100", "100"])
    assert not anomaly.observe(st, "101")["anomaly"]   # within floor
    assert anomaly.observe(st, "400")["anomaly"]       # way past floor


def test_numeric_anomaly_fires_once_then_cools_down():
    st = anomaly.new_state(learn_checks=3, sensitivity="medium", cooldown_checks=3)
    feed(st, ["10", "10", "10"])
    first = anomaly.observe(st, "999")
    second = anomaly.observe(st, "999")   # same anomaly, still hot
    assert first["anomaly"] and not second["anomaly"]


def test_lines_new_error_detected():
    st = anomaly.new_state(mode="lines", learn_checks=2)
    feed(st, ["INFO ok\nINFO ready", "INFO ok"])
    r = anomaly.observe(st, "INFO ok\nERROR disk full")
    assert r["anomaly"] and "disk full" in r["detail"]


def test_lines_known_line_is_quiet():
    st = anomaly.new_state(mode="lines", learn_checks=2)
    feed(st, ["a\nb", "a"])
    assert not anomaly.observe(st, "a\nb")["anomaly"]


def test_lines_same_new_error_alerts_once():
    st = anomaly.new_state(mode="lines", learn_checks=1, cooldown_checks=5)
    feed(st, ["ok"])
    first = anomaly.observe(st, "ok\nERROR boom")
    second = anomaly.observe(st, "ok\nERROR boom")
    assert first["anomaly"] and not second["anomaly"]


def test_auto_mode_picks_numeric_vs_lines():
    st = anomaly.new_state(learn_checks=1)
    assert anomaly.observe(st, "42")["mode"] == "numeric"
    st2 = anomaly.new_state(learn_checks=1)
    assert anomaly.observe(st2, "service down")["mode"] == "lines"


def test_sensitivity_changes_threshold():
    # baseline mean ~100, std ~7.9; a modest 120 (z ~2.5) should trip HIGH
    # (z=2.0) but not MEDIUM (3.0) or LOW (4.0).
    def spikes(sens):
        st = anomaly.new_state(learn_checks=5, sensitivity=sens)
        feed(st, ["100", "110", "90", "105", "95"])
        return anomaly.observe(st, "120")["anomaly"]
    assert spikes("high") is True
    assert spikes("medium") is False
    assert spikes("low") is False


def test_state_is_json_roundtrippable():
    import json
    st = anomaly.new_state()
    feed(st, ["1", "2", "3"])
    st2 = json.loads(json.dumps(st))
    # continues working after a persist/reload cycle (bg_jobs saves it to disk)
    anomaly.observe(st2, "4")
    assert st2["checks"] == 4
