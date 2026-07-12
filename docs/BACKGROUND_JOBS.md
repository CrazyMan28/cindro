# Background jobs, monitor & sleep/wake

Claude-Code-style background shell for Cindro: start long work detached, then keep
going (or sleep) and get **automatically woken** with the result. No babysitting a
slow command.

## MCP tools (computer-use engine — `tools_bg.py`)

| Tool | What it does |
|---|---|
| `bg_start(command, cwd?, name?, notify_on_done=true)` | Run `command` as a **detached** job; capture combined stdout/stderr to a log; return an id immediately. When it finishes you're woken with the exit code + an output tail. For training, builds, deploys, downloads. |
| `bg_status(id)` | State (running/done/failed/stopped/expired/ended), pid, exit_code, timing. |
| `bg_logs(id, lines=80)` | Last N lines of the job's log. |
| `bg_stop(id)` | Kill the job/monitor/timer (whole process group). |
| `bg_list()` | All jobs/monitors/timers + states. |
| `bg_wait(id, timeout_sec=7200)` | Block until done (rarely needed — you're woken). |
| `monitor(command, interval_sec=30, until_regex?, until_exit=-1, wake_on_match=true, max_checks=0, name?)` | Run `command` every interval; **wake** when its output matches `until_regex` OR it exits with `until_exit`. `max_checks=0` = watch forever. Use to watch a training metric, a queue, a health endpoint, a file. |
| `wake_me_in(seconds, note?)` | Sleep, then wake yourself with an optional note-to-self. |

Example: `bg_start("python train.py", name="finetune")` → go do other things →
when training exits you're woken: *"[BACKGROUND JOB succeeded] finetune … run tests."*

## How it works
- **Runner:** `computer-use/computer_use_mcp/bg_jobs.py` — each job is a detached
  process tree rooted at a re-exec of the module (`--run` / `--monitor` / `--sleep`),
  so it survives the MCP call returning and even an engine restart. State + log live
  under `~/.local/share/jarvis/bg_jobs/<id>/` (`job.json` + `out.log`). `$JARVIS_BG_JOBS_DIR`
  relocates this (used by tests).
- **The wake:** on completion the runner calls the daemon's Contract A `session.wake`
  (`daemon/src/ControlServer.cpp`), which injects a turn into the originating session —
  **queued if it's mid-turn** — exactly like the subagent-done wake, so the brain resumes
  on its own. The session to wake is frozen from `$JARVIS_AGENT_SESSION` at start.
- **Notify:** `session.wake` forwards `wake_notify` (Settings, see [MODES.md](MODES.md))
  so a completion can also ping the user's phone for long/critical jobs.

Tests: `computer-use/tests/test_bg_jobs.py` (real detached jobs: success/failure/monitor/
timer/stop, hermetic via `$JARVIS_BG_JOBS_DIR`).
