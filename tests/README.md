# Jarvis — Tests

The single entry point is **[`run-all.sh`](run-all.sh)** — it runs every suite below.

```bash
./tests/run-all.sh             # everything (needs jarvisd + phone server running for the live scripts)
./tests/run-all.sh --no-live   # unit + integration suites only, no running services needed
```

> Always run Python/builds with `env -u PYTHONPATH` (a user site-packages `PYTHONPATH`
> leak breaks the engine venv). `run-all.sh` already does this.

## Where the tests live

Unit tests sit next to the code they cover (so the build/test runners find them); this
folder holds the **end-to-end / live integration** tests + this index.

| Suite | Location | Count | Run |
|---|---|---|---|
| **C++ unit** (core lib) | `core/tests/*.cpp` | **22 ctest targets** | `env -u PYTHONPATH QT_QPA_PLATFORM=offscreen ctest --test-dir build` |
| **Python engine** (computer-use) | `computer-use/tests/test_*.py` | **423 tests** | `env -u PYTHONPATH computer-use/.venv/bin/python -m pytest computer-use/tests -q` |
| **Phone server** (vendored) | `phone/server/src/tests/*.ts` | **168 tests** | `cd phone/server && AGENT_PHONE_SKIP_DOTENV=true MISTRAL_REAL_AUDIO=false npm test` |
| **Live integration** (this folder) | `tests/integration/*.py` | **3 scripts / 155 checks** | `env -u PYTHONPATH computer-use/.venv/bin/python tests/integration/<script>.py` |

## The new capabilities are heavily covered (8,274 lines added)

**Background jobs / monitor / sleep-wake** — `computer-use/tests/`:
`test_bg_lifecycle` (exit codes, state machine), `test_bg_logs` (10k-line capture, unicode,
truncation), `test_bg_cwd_env` (cwd, env, PYTHONPATH stripped), `test_bg_monitor_regex` /
`_exit` / `_limits` (regex/exit match, max_checks expire, stop mid-run), `test_bg_timers`
(sleep_wake + cancel), `test_bg_concurrency` (8–12 parallel jobs, isolation), `test_bg_edge`
(unknown ids, malformed meta, weird/unicode commands, rapid start/stop), `test_bg_wait_status`,
`test_tools_bg_register` (MCP tool registration), `test_bg_wake_payload` (the `session.wake`
payload shape: critical-on-failure, no-wake when disabled).

**Hooks** — `core/tests/hook_store_comprehensive_test.cpp`: every event, every matcher form,
all block paths (exit 2 / `decision:block` / `continue:false` / `permissionDecision:deny`),
all inject paths (`additionalContext` / `hookSpecificOutput` / non-JSON), multi-hook/group,
timeout-kill, CRUD round-trip.

**Modes / settings** — `core/tests/settings_modes_comprehensive_test.cpp`: `agent_mode`,
`wake_notify`, `permission_level` (valid + invalid normalization), config.toml round-trip,
unrelated-key preservation, PIN hashing.

**Phone (native, vendored)** — `tests/integration/`: `verify_phone_mcp_full.py` (all phone
tools through the daemon `phone.mcp` proxy + allowlist/screening round-trips + edge cases),
`verify_contract_a_full.py` (settings + hooks Contract A round-trips, with reset),
`verify_phone_http.py` (the phone server's HTTP + MCP surface + auth rejection). The vendored
server's own 168 tests run via `npm test`.

_Last full run: ctest 22/22 · pytest 423/423 · vitest 168/168 · live 155/155 — all green._
