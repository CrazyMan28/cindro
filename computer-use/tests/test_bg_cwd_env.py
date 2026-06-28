"""Comprehensive edge-case tests for bg_jobs cwd handling, env inheritance,
and PYTHONPATH stripping.

Covers:
- cwd respected: "pwd" / "echo $PWD" output matches the passed cwd
- Relative vs absolute cwd
- Default cwd (os.getcwd() when none is passed)
- cwd recorded in job metadata
- Multiple concurrent jobs with different cwds
- Files created by the job appear in the specified cwd
- Deeply nested and space-in-name cwd paths
- Custom env vars set before start() are visible inside the job
- Multiple env vars all inherited
- PYTHONPATH is stripped from the runner child even when the parent had it set
- Stripping PYTHONPATH does not remove other env vars
- Stripping does not mutate the parent process's os.environ
- PYTHONPATH absent in parent → still absent in job (no side-effects)

Hermetic: JARVIS_BG_JOBS_DIR → fresh tmp_path per test; JARVIS_AGENT_SESSION
deleted so no real daemon wake is attempted.
"""

from __future__ import annotations

import os
import time

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wait(jid, states, timeout=20):
    """Poll status until one of *states* is reached or timeout expires."""
    end = time.time() + timeout
    while time.time() < end:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


def _log(jid, lines=20):
    return bg_jobs.logs(jid, lines)["log"]


# ---------------------------------------------------------------------------
# Hermetic fixture – applied to every test in this module
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ===========================================================================
# CWD TESTS
# ===========================================================================

def test_cwd_absolute_pwd_matches(tmp_path):
    """Running 'pwd' in a job reports the exact absolute cwd we passed."""
    work = tmp_path / "workdir"
    work.mkdir()
    r = bg_jobs.start("pwd", cwd=str(work))
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done", f"job did not complete cleanly: {m}"
    assert str(work) in _log(r["id"])


def test_cwd_echo_pwd_env_var_matches(tmp_path):
    """$PWD inside the shell matches the cwd we passed (shell env, not just syscall)."""
    work = tmp_path / "target_dir"
    work.mkdir()
    r = bg_jobs.start('echo "MYDIR=$PWD"', cwd=str(work))
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    log = _log(r["id"])
    assert f"MYDIR={work}" in log


def test_cwd_default_uses_process_cwd(tmp_path, monkeypatch):
    """When no cwd is passed, the job runs in os.getcwd() captured at start() time."""
    monkeypatch.chdir(tmp_path)
    r = bg_jobs.start("pwd")  # no cwd argument
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    # The meta should record the cwd that was active when start() was called.
    assert str(tmp_path) in m["cwd"]
    assert str(tmp_path) in _log(r["id"])


def test_cwd_recorded_in_metadata(tmp_path):
    """The cwd we pass is stored verbatim in job.json metadata."""
    work = tmp_path / "meta_check"
    work.mkdir()
    r = bg_jobs.start("true", cwd=str(work))
    m = _wait(r["id"], {"done", "failed"})
    assert m["cwd"] == str(work)


def test_cwd_two_concurrent_jobs_different_dirs(tmp_path):
    """Two jobs with different cwds report entirely different pwd outputs."""
    dir_a = tmp_path / "dir_alpha"
    dir_b = tmp_path / "dir_beta"
    dir_a.mkdir()
    dir_b.mkdir()
    # Distinct names guarantee distinct IDs even if spawned within the same ms.
    r_a = bg_jobs.start("pwd", cwd=str(dir_a), name="job-alpha")
    r_b = bg_jobs.start("pwd", cwd=str(dir_b), name="job-beta")
    m_a = _wait(r_a["id"], {"done", "failed"})
    m_b = _wait(r_b["id"], {"done", "failed"})
    log_a = _log(r_a["id"])
    log_b = _log(r_b["id"])
    # Each job's log mentions its own dir…
    assert "dir_alpha" in log_a
    assert "dir_beta" in log_b
    # …and NOT the other job's dir.
    assert "dir_beta" not in log_a
    assert "dir_alpha" not in log_b


def test_relative_cwd_resolves_from_runner_cwd(tmp_path, monkeypatch):
    """A relative cwd is resolved relative to the runner's inherited cwd (the
    test's cwd at spawn time), so we can test the relative-path branch."""
    subdir_name = "rel_subdir"
    (tmp_path / subdir_name).mkdir()
    # Set the test process cwd; the runner inherits it.
    monkeypatch.chdir(tmp_path)
    r = bg_jobs.start("pwd", cwd=subdir_name)
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    # The runner sees tmp_path as cwd, so "rel_subdir" resolves to tmp_path/rel_subdir.
    log = _log(r["id"])
    assert subdir_name in log


def test_cwd_file_created_by_job_appears_in_cwd(tmp_path):
    """A file touched by the job is created inside the specified cwd directory."""
    work = tmp_path / "create_here"
    work.mkdir()
    sentinel = "sentinel_test_file.txt"
    r = bg_jobs.start(f"touch {sentinel}", cwd=str(work))
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert (work / sentinel).exists(), "sentinel file not found in cwd"


def test_cwd_deeply_nested_absolute_path(tmp_path):
    """A deep absolute path (4+ levels) works as cwd without error."""
    deep = tmp_path / "a" / "b" / "c" / "d"
    deep.mkdir(parents=True)
    r = bg_jobs.start("pwd", cwd=str(deep))
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert str(deep) in _log(r["id"])


def test_cwd_path_with_spaces(tmp_path):
    """A cwd containing spaces in the directory name is handled correctly.

    The cwd is passed as a Python string to Popen (not a shell argument), so
    spaces require no quoting — this is a common source of shell bugs that
    we verify does NOT affect the bg_jobs layer.
    """
    spaced = tmp_path / "dir with spaces"
    spaced.mkdir()
    r = bg_jobs.start("pwd", cwd=str(spaced))
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert "dir with spaces" in _log(r["id"])


def test_cwd_job_can_read_files_placed_there(tmp_path):
    """A file pre-placed in the cwd is readable by a job that references it by
    relative path — confirming the job actually runs in that directory."""
    work = tmp_path / "readable_dir"
    work.mkdir()
    (work / "hello.txt").write_text("hello_from_file\n")
    r = bg_jobs.start("cat hello.txt", cwd=str(work))
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert "hello_from_file" in _log(r["id"])


# ===========================================================================
# ENV INHERITANCE TESTS
# ===========================================================================

def test_custom_env_var_visible_in_job(monkeypatch):
    """A custom env var set in the parent before start() is visible inside
    the job (runner inherits os.environ at spawn time)."""
    monkeypatch.setenv("JARVIS_BG_CANARY", "canary_value_xyz")
    r = bg_jobs.start('echo "GOT=$JARVIS_BG_CANARY"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert "GOT=canary_value_xyz" in _log(r["id"])


def test_multiple_custom_env_vars_all_inherited(monkeypatch):
    """Multiple env vars set before start() are ALL visible inside the job."""
    monkeypatch.setenv("BG_TEST_VAR_A", "alpha_123")
    monkeypatch.setenv("BG_TEST_VAR_B", "beta_456")
    r = bg_jobs.start('echo "A=$BG_TEST_VAR_A B=$BG_TEST_VAR_B"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    log = _log(r["id"])
    assert "alpha_123" in log
    assert "beta_456" in log


def test_env_var_updated_value_is_seen(monkeypatch):
    """The overridden value of an env var (not the original) reaches the job."""
    monkeypatch.setenv("BG_OVERRIDE_VAR", "updated_value")
    r = bg_jobs.start('echo "V=$BG_OVERRIDE_VAR"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert "V=updated_value" in _log(r["id"])


def test_jarvis_bg_jobs_dir_inherited_by_runner(tmp_path, monkeypatch):
    """JARVIS_BG_JOBS_DIR — set by _hermetic — is visible to the runner
    process; this is the mechanism that makes hermetic isolation work."""
    jobs_dir = str(tmp_path / "bg")
    # _hermetic already sets it; just verify the running job can see it.
    r = bg_jobs.start('echo "JOBS=$JARVIS_BG_JOBS_DIR"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert jobs_dir in _log(r["id"])


# ===========================================================================
# PYTHONPATH STRIPPING TESTS
# ===========================================================================

def test_pythonpath_stripped_when_parent_has_it(monkeypatch):
    """PYTHONPATH set in the parent is NOT passed through to the job.

    _spawn_runner explicitly pops PYTHONPATH from the env dict it passes to
    the detached runner process, which in turn does not set it for the job.
    """
    monkeypatch.setenv("PYTHONPATH", "/some/fake/path:/another/fake")
    r = bg_jobs.start('echo "PP=$PYTHONPATH"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    log = _log(r["id"])
    assert "/some/fake/path" not in log, f"PYTHONPATH leaked into job output: {log!r}"
    assert "/another/fake" not in log


def test_pythonpath_unset_in_job_shell(monkeypatch):
    """Shell-level test: $PYTHONPATH is empty/unset inside the job even when
    the parent process has a non-empty value."""
    monkeypatch.setenv("PYTHONPATH", "/should/not/leak")
    # [ -z "${PYTHONPATH+x}" ] is true ONLY when PYTHONPATH is unset.
    # We also accept the empty-string case (stripped to "").
    cmd = (
        'if [ -z "$PYTHONPATH" ]; then echo "PYTHONPATH_EMPTY_OR_UNSET"; '
        'else echo "PYTHONPATH_PRESENT=$PYTHONPATH"; fi'
    )
    r = bg_jobs.start(cmd)
    m = _wait(r["id"], {"done", "failed"})
    log = _log(r["id"])
    assert "PYTHONPATH_EMPTY_OR_UNSET" in log, (
        f"PYTHONPATH was not stripped; job output: {log!r}"
    )
    assert "/should/not/leak" not in log


def test_pythonpath_stripped_but_other_env_preserved(monkeypatch):
    """Stripping PYTHONPATH is targeted: unrelated env vars survive."""
    monkeypatch.setenv("PYTHONPATH", "/leak/me/not")
    monkeypatch.setenv("BG_SURVIVES_STRIP", "i_survive")
    r = bg_jobs.start('echo "PP=$PYTHONPATH SURV=$BG_SURVIVES_STRIP"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    log = _log(r["id"])
    assert "/leak/me/not" not in log
    assert "i_survive" in log


def test_pythonpath_parent_os_environ_not_mutated(monkeypatch):
    """Calling start() does not mutate the parent process's os.environ.

    _spawn_runner builds a *copy* of os.environ and pops PYTHONPATH from that
    copy.  The parent's environment must remain intact after start() returns.
    """
    monkeypatch.setenv("PYTHONPATH", "/parent/original/path")
    bg_jobs.start("echo ok")
    # Parent still has PYTHONPATH set to the original value.
    assert os.environ.get("PYTHONPATH") == "/parent/original/path"


def test_pythonpath_absent_in_parent_also_absent_in_job(monkeypatch):
    """When the parent has no PYTHONPATH at all, the job also has none
    (no accidental injection from the venv or elsewhere)."""
    monkeypatch.delenv("PYTHONPATH", raising=False)
    assert "PYTHONPATH" not in os.environ
    cmd = (
        'if [ -z "$PYTHONPATH" ]; then echo "PP_CLEAN"; '
        'else echo "PP_DIRTY=$PYTHONPATH"; fi'
    )
    r = bg_jobs.start(cmd)
    m = _wait(r["id"], {"done", "failed"})
    log = _log(r["id"])
    assert "PP_CLEAN" in log


def test_pythonpath_stripped_across_long_value(monkeypatch):
    """Stripping works regardless of how large PYTHONPATH is
    (many colon-separated entries from a complex virtualenv setup)."""
    long_pp = ":".join(f"/fake/site{i}" for i in range(30))
    monkeypatch.setenv("PYTHONPATH", long_pp)
    r = bg_jobs.start('echo "PP=$PYTHONPATH"')
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    log = _log(r["id"])
    assert "/fake/site0" not in log
    assert "/fake/site29" not in log
