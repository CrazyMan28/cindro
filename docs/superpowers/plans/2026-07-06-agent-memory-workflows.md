# Per-Agent-Scoped Memory & Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Orin's existing memory + scheduling subsystems so memories can be scoped to a named agent/machine and recalled by that scope, and so recurring/conditional/webhook-triggered jobs can be persisted and managed as first-class "Workflows".

**Architecture:** Two thin, additive extensions to code that already exists. (1) The SQLite-backed `MemoryStore` (C++ core) gains an `agent` scope + `entity_ref` column, surfaced through the daemon's `memory.add`/`memory.search` Contract-A RPCs and the `remember`/`recall` MCP tools. (2) The `Scheduler` (C++ core) gains three additive columns (`target_ref`, `report_thread`, `webhook_token`) and a `webhook` trigger kind that never fires on a timer; new `workflow_*` MCP tools wrap the existing `schedule.create`/`schedule.list`/`schedule.remove` RPCs, and a new FastAPI `POST /workflows/webhook/<id>` endpoint fires a webhook workflow through the SAME `schedule.run_now` → `Scheduler::runNow` → `fireScheduledJob` path the cron scheduler uses. No new subsystems; no new LLM-provider work.

**Tech Stack:** C++17 / Qt6 (Core + Sql) for `core/` and `daemon/`; CMake + Ninja + ctest for C++ tests; Python 3.12 + FastMCP + FastAPI (`computer-use/computer_use_mcp/`) for the MCP tool layer; pytest for Python tests; SQLite (`~/.local/share/jarvis/jarvis.db`) for storage.

## Global Constraints

- **Branch:** work on `dev` (current branch). Commit after every task.
- **Additive, backward-compatible migrations only.** Existing memory/schedule rows must be untouched. Existing global `recall(query)` and existing `schedule_task`/`list_schedules`/`cancel_schedule` behavior must remain byte-for-byte identical when the new optional params are absent/empty. This is a strict regression-safety requirement.
- **No new LLM-provider work.** `core/include/jarvis/ApiBrain.h` already supports openai/anthropic/mistral/ollama/gemini/xai/deepseek, and `daemon/src/ControlServer.cpp` already resolves the key from `secrets.json`. Workflows only *reference* a `model` string (e.g. `"mistral-large-latest"`) that already works.
- **Webhook tokens:** mint with `secrets.token_urlsafe(32)` (the repo-wide convention, e.g. `computer-use/computer_use_mcp/config.py`). Compare with `hmac.compare_digest` (the repo-wide convention, e.g. `computer-use/computer_use_mcp/auth.py`).
- **`outpost_exec` is an EXTERNAL tool** from a separate, concurrent feature plan. Reference it by name in prompt/doc text only. NEVER define or implement it here.
- **Python MCP tool style:** new/edited tool functions are **module-level** and wired in `register()` via `mcp.tool()(fn)` (the `tools_tui_ops.py` precedent) so they are directly importable and unit-testable.
- **C++ test command:** `QT_QPA_PLATFORM=offscreen ctest --test-dir build --output-on-failure` (build first with `cmake --build build`; the `build/` dir is already configured).
- **Python test command:** `computer-use/.venv/bin/python -m pytest <path> -q` (the package is installed editable in that venv).

---

## File Structure

**Gap 1 — per-agent-scoped memory (extend):**
- `core/include/jarvis/MemoryStore.h` — MODIFY: `MemoryRow` gains `scope`/`entityRef`; `add()` and `search()` gain optional scope params; private `hasColumn()`.
- `core/src/MemoryStore.cpp` — MODIFY: additive `ALTER TABLE` migration, `add()`/`get()`/`list()`/`search()` carry scope + entity_ref, `MemoryRow::toJson()` emits them.
- `core/tests/memory_store_test.cpp` — MODIFY: agent-scope round-trip checks (already registered in CMake — no CMake edit).
- `daemon/src/ControlServer.cpp` — MODIFY: `handleMemoryAdd`/`handleMemorySearch` read an `agent` param.
- `computer-use/computer_use_mcp/tools_jarvis_ops.py` — MODIFY: `remember`/`recall` become module-level, gain an `agent` param.
- `computer-use/tests/test_tools_memory_scope.py` — CREATE: proxy tests for `remember`/`recall`.

**Gap 2 — Workflows (new, on top of the existing Scheduler):**
- `core/include/jarvis/Scheduler.h` — MODIFY: `CronSpec::Kind::Webhook`; `ScheduleRow` gains `targetRef`/`reportThread`/`webhookToken`; `create()` gains the three params; private `hasColumn()`.
- `core/src/Scheduler.cpp` — MODIFY: parse `"webhook"`, additive migration, persist + read the three columns, `toJson()` emits `target`/`report_thread` (never the token).
- `core/tests/scheduler_test.cpp` — MODIFY: webhook-kind + new-column checks (already registered — no CMake edit).
- `daemon/src/ControlServer.h` — MODIFY: declare `handleScheduleWebhookToken`.
- `daemon/src/ControlServer.cpp` — MODIFY: `handleScheduleCreate` passes the three fields; `fireScheduledJob` injects the report-thread instruction; new `handleScheduleWebhookToken` + dispatch entry.
- `computer-use/computer_use_mcp/tools_workflows.py` — CREATE: `workflow_create`/`workflow_list`/`workflow_delete` tools, `fire_webhook` helper, `is_webhook_path`, `register_webhook_route`, `register`.
- `computer-use/computer_use_mcp/server.py` — MODIFY: register the workflow tools, mount the webhook route, exempt the webhook path from the bearer middleware.
- `computer-use/tests/test_tools_workflows.py` — CREATE: CRUD + webhook + route tests.
- `docs/WORKFLOWS.md` — CREATE: usage doc (triggers, target, inbox reporting, condition-polling pattern, webhook curl example).

---

## Task 1: MemoryStore — agent scope + entity_ref column

**Files:**
- Modify: `core/include/jarvis/MemoryStore.h`
- Modify: `core/src/MemoryStore.cpp`
- Test: `core/tests/memory_store_test.cpp` (already registered via `add_test(NAME memory_store_test ...)` in `core/CMakeLists.txt`)

**Interfaces:**
- Produces:
  - `struct MemoryRow { ...; QString scope = "global"; QString entityRef; }` (new fields).
  - `QString MemoryStore::add(const QString &text, const QStringList &tags = {}, const QString &id = QString(), const QString &scope = QStringLiteral("global"), const QString &entityRef = QString());`
  - `QVector<MemoryRow> MemoryStore::search(const QString &query, int limit = 20, const QString &entityRef = QString());`
  - JSON shape: `MemoryRow::toJson()` adds `"scope"` only when != `"global"` and `"entityRef"` only when non-empty (global rows stay byte-identical).

- [ ] **Step 1: Write the failing test additions**

In `core/tests/memory_store_test.cpp`, insert this block immediately BEFORE the final `if (g_failures) {` line (around line 320):

```cpp
    // --- agent-scoped memory (per-agent-scoped recall) ---------------------
    {
        QTemporaryDir tmpA;
        const QString dbPathA = tmpA.path() + QStringLiteral("/agent_scope.db");
        MemoryStore s;
        check(s.open(dbPathA, QStringLiteral("mem-agent-conn")), "agent-scope: store open");

        // Two agent-scoped memories + one global memory.
        const QString a1 = s.add(QStringLiteral("runner service is healthy"),
                                 {QStringLiteral("status")}, QString(),
                                 QStringLiteral("agent"), QStringLiteral("ci-runner-104"));
        const QString a2 = s.add(QStringLiteral("disk at 40 percent"),
                                 {QStringLiteral("status")}, QString(),
                                 QStringLiteral("agent"), QStringLiteral("ci-runner-106"));
        const QString g1 = s.add(QStringLiteral("the runner keychain lives in vault"),
                                 {QStringLiteral("status")});
        check(!a1.isEmpty() && !a2.isEmpty() && !g1.isEmpty(), "agent-scope: three memories added");

        // recall filtered by agent returns ONLY that agent's rows.
        {
            const auto hits = s.search(QStringLiteral("runner"), 20, QStringLiteral("ci-runner-104"));
            bool sawA1 = false, sawG1 = false, sawA2 = false;
            for (const auto &r : hits) {
                if (r.id == a1) sawA1 = true;
                if (r.id == g1) sawG1 = true;
                if (r.id == a2) sawA2 = true;
            }
            check(sawA1, "agent-scope: search(agent=104) returns the 104 memory");
            check(!sawG1, "agent-scope: search(agent=104) excludes the global memory");
            check(!sawA2, "agent-scope: search(agent=104) excludes the other agent's memory");
        }

        // Empty-query + agent returns that agent's rows (condition-polling pattern).
        {
            const auto hits = s.search(QString(), 20, QStringLiteral("ci-runner-104"));
            bool sawA1 = false, sawA2 = false;
            for (const auto &r : hits) {
                if (r.id == a1) sawA1 = true;
                if (r.id == a2) sawA2 = true;
            }
            check(sawA1, "agent-scope: empty-query search(agent=104) returns 104 rows");
            check(!sawA2, "agent-scope: empty-query search(agent=104) excludes other agents");
        }

        // Regression: search with NO agent filter still returns everything.
        {
            const auto hits = s.search(QStringLiteral("runner"), 20);
            bool sawA1 = false, sawG1 = false;
            for (const auto &r : hits) {
                if (r.id == a1) sawA1 = true;
                if (r.id == g1) sawG1 = true;
            }
            check(sawA1 && sawG1, "agent-scope: unfiltered search still spans global + agent rows");
        }

        // The row carries its scope + entityRef; toJson surfaces them.
        {
            auto r = s.get(a1);
            check(r && r->scope == QStringLiteral("agent"), "agent-scope: stored scope is 'agent'");
            check(r && r->entityRef == QStringLiteral("ci-runner-104"), "agent-scope: entityRef stored");
            const QJsonObject j = r->toJson();
            check(j.value(QStringLiteral("scope")).toString() == QStringLiteral("agent"),
                  "agent-scope: toJson emits scope for an agent row");
            check(j.value(QStringLiteral("entityRef")).toString() == QStringLiteral("ci-runner-104"),
                  "agent-scope: toJson emits entityRef for an agent row");
        }

        // Regression: a global row's JSON does NOT gain scope/entityRef keys.
        {
            auto r = s.get(g1);
            const QJsonObject j = r->toJson();
            check(!j.contains(QStringLiteral("scope")), "agent-scope: global row toJson omits scope");
            check(!j.contains(QStringLiteral("entityRef")), "agent-scope: global row toJson omits entityRef");
        }
    }
```

- [ ] **Step 2: Build and run — verify it fails**

Run: `cmake --build build 2>&1 | tail -20`
Expected: FAIL — compile error, e.g. `no matching function for call to 'jarvis::MemoryStore::add(...)'` (5-arg) and `'struct jarvis::MemoryRow' has no member named 'scope'`.

- [ ] **Step 3: Extend the header**

In `core/include/jarvis/MemoryStore.h`, in `struct MemoryRow` add two fields after `double score = 0.0; // ...`:

```cpp
    QString scope = QStringLiteral("global"); // global|project|agent
    QString entityRef;                        // set when scope=="project"/"agent" (project name / agent id)
```

Change the `add` declaration to:

```cpp
    QString add(const QString &text, const QStringList &tags = {},
                const QString &id = QString(),
                const QString &scope = QStringLiteral("global"),
                const QString &entityRef = QString());
```

Change the `search` declaration to:

```cpp
    QVector<MemoryRow> search(const QString &query, int limit = 20,
                              const QString &entityRef = QString());
```

In the `private:` section, add after `bool migrate();`:

```cpp
    bool hasColumn(const QString &table, const QString &column);
```

- [ ] **Step 4: Implement the .cpp changes**

In `core/src/MemoryStore.cpp`:

**(a)** In `MemoryRow::toJson()`, add after `o.insert(QStringLiteral("updated"), updated);` (before the `if (score != 0.0)` line):

```cpp
    if (scope != QStringLiteral("global"))
        o.insert(QStringLiteral("scope"), scope);
    if (!entityRef.isEmpty())
        o.insert(QStringLiteral("entityRef"), entityRef);
```

**(b)** Add the `hasColumn` helper just above `bool MemoryStore::migrate()`:

```cpp
bool MemoryStore::hasColumn(const QString &table, const QString &column)
{
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral("PRAGMA table_info(%1)").arg(table)))
        return false;
    while (q.next())
        if (q.value(1).toString().compare(column, Qt::CaseInsensitive) == 0)
            return true;
    return false;
}
```

**(c)** In `migrate()`, immediately after the `memories` `CREATE TABLE IF NOT EXISTS` block (right after its closing `return false;` guard, before the `memories_fts` create), add:

```cpp
    // Additive scope columns (agent-scoped memory). Existing rows default to
    // scope='global', entity_ref='' — untouched and recalled exactly as before.
    if (!hasColumn(QStringLiteral("memories"), QStringLiteral("scope")))
        exec(QStringLiteral("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'"));
    if (!hasColumn(QStringLiteral("memories"), QStringLiteral("entity_ref")))
        exec(QStringLiteral("ALTER TABLE memories ADD COLUMN entity_ref TEXT"));
```

**(d)** Replace the `add()` signature line and its upsert block. Change the signature to:

```cpp
QString MemoryStore::add(const QString &text, const QStringList &tags, const QString &id,
                         const QString &scope, const QString &entityRef)
```

Replace the "Upsert into memories" `QSqlQuery` block with:

```cpp
    // Upsert into memories.
    {
        QSqlQuery q(m_db);
        q.prepare(QStringLiteral(
            "INSERT INTO memories (id,text,tags,created,updated,scope,entity_ref)"
            " VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET text=excluded.text, tags=excluded.tags,"
            " updated=excluded.updated, scope=excluded.scope, entity_ref=excluded.entity_ref"));
        q.addBindValue(memId);
        q.addBindValue(text);
        q.addBindValue(tagStr);
        q.addBindValue(now);
        q.addBindValue(now);
        q.addBindValue(scope.isEmpty() ? QStringLiteral("global") : scope);
        q.addBindValue(entityRef);
        if (!q.exec()) {
            m_lastError = q.lastError().text();
            return QString();
        }
    }
```

**(e)** In `get()`, change the SELECT and row build to carry the new columns:

```cpp
    q.prepare(QStringLiteral(
        "SELECT id,text,tags,created,updated,scope,entity_ref FROM memories WHERE id=?"));
```
and after `r.updated = q.value(4).toLongLong();` add:
```cpp
    r.scope = q.value(5).toString();
    r.entityRef = q.value(6).toString();
```

**(f)** In `list()`, change the SELECT to:

```cpp
    QString sql = QStringLiteral(
        "SELECT id,text,tags,created,updated,scope,entity_ref FROM memories ORDER BY updated DESC");
```
and inside the `while (q.next())` loop, after `r.updated = q.value(4).toLongLong();` add:
```cpp
        r.scope = q.value(5).toString();
        r.entityRef = q.value(6).toString();
```

**(g)** Replace the whole body of `search()` with this (adds the optional `entityRef` filter to BOTH the FTS branch and the LIKE fallback; when `entityRef` is empty the queries are semantically identical to today):

```cpp
QVector<MemoryRow> MemoryStore::search(const QString &query, int limit, const QString &entityRef)
{
    QVector<MemoryRow> out;
    if (limit <= 0)
        limit = 20;
    const bool scoped = !entityRef.isEmpty();

    const QString fts = toFtsQuery(query);
    if (!fts.isEmpty()) {
        QString sql = QStringLiteral(
            "SELECT m.id,m.text,m.tags,m.created,m.updated,m.scope,m.entity_ref,"
            "       bm25(memories_fts) AS rank"
            " FROM memories_fts f JOIN memories m ON m.id=f.id"
            " WHERE memories_fts MATCH ?");
        if (scoped)
            sql += QStringLiteral(" AND m.entity_ref = ?");
        sql += QStringLiteral(" ORDER BY rank ASC LIMIT ?");
        QSqlQuery q(m_db);
        q.prepare(sql);
        q.addBindValue(fts);
        if (scoped)
            q.addBindValue(entityRef);
        q.addBindValue(limit);
        if (q.exec()) {
            while (q.next()) {
                MemoryRow r;
                r.id = q.value(0).toString();
                r.text = q.value(1).toString();
                r.tags = tagsFromStorage(q.value(2).toString());
                r.created = q.value(3).toLongLong();
                r.updated = q.value(4).toLongLong();
                r.scope = q.value(5).toString();
                r.entityRef = q.value(6).toString();
                const double rank = q.value(7).toDouble();
                r.score = 1.0 / (1.0 + (rank < 0 ? -rank : rank));
                out.push_back(r);
            }
            if (!out.isEmpty())
                return out;
        } else {
            m_lastError = q.lastError().text();
        }
    }

    // Fallback: LIKE scan over text+tags (covers FTS-tokenless queries, empty
    // query, and any FTS error). Recency-ordered.
    QString sql = QStringLiteral(
        "SELECT id,text,tags,created,updated,scope,entity_ref FROM memories"
        " WHERE (text LIKE ? OR tags LIKE ?)");
    if (scoped)
        sql += QStringLiteral(" AND entity_ref = ?");
    sql += QStringLiteral(" ORDER BY updated DESC LIMIT ?");
    QSqlQuery q(m_db);
    q.prepare(sql);
    const QString like = QStringLiteral("%") + query.trimmed() + QStringLiteral("%");
    q.addBindValue(like);
    q.addBindValue(like);
    if (scoped)
        q.addBindValue(entityRef);
    q.addBindValue(limit);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return out;
    }
    while (q.next()) {
        MemoryRow r;
        r.id = q.value(0).toString();
        r.text = q.value(1).toString();
        r.tags = tagsFromStorage(q.value(2).toString());
        r.created = q.value(3).toLongLong();
        r.updated = q.value(4).toLongLong();
        r.scope = q.value(5).toString();
        r.entityRef = q.value(6).toString();
        r.score = 0.5; // unranked match
        out.push_back(r);
    }
    return out;
}
```

- [ ] **Step 5: Build and run — verify it passes**

Run: `cmake --build build && QT_QPA_PLATFORM=offscreen ctest --test-dir build -R memory_store_test --output-on-failure`
Expected: PASS — `memory_store_test` passes, all `ok:` lines including the new `agent-scope:` checks.

- [ ] **Step 6: Commit**

```bash
git add core/include/jarvis/MemoryStore.h core/src/MemoryStore.cpp core/tests/memory_store_test.cpp
git commit -m "feat(memory): add agent scope + entity_ref to MemoryStore"
```

---

## Task 2: Daemon memory RPC + remember/recall MCP tools gain `agent`

**Files:**
- Modify: `daemon/src/ControlServer.cpp` (`handleMemoryAdd` ~line 4561, `handleMemorySearch` ~line 4549)
- Modify: `computer-use/computer_use_mcp/tools_jarvis_ops.py`
- Test: `computer-use/tests/test_tools_memory_scope.py` (create)

**Interfaces:**
- Consumes (from Task 1): `MemoryStore::add(text, tags, id, scope, entityRef)`, `MemoryStore::search(query, limit, entityRef)`.
- Produces:
  - `memory.add` RPC accepts optional `"agent"` (string). Empty ⇒ unchanged global add. Non-empty ⇒ `scope="agent", entityRef=agent`.
  - `memory.search` RPC accepts optional `"agent"` (string). Empty ⇒ unchanged. Non-empty ⇒ filters `entity_ref == agent`.
  - `remember(text, tags=None, agent="")` — module-level; sends `memory.add {text, tags}` (+`agent` only when non-empty).
  - `recall(query="", agent="", limit=20)` — module-level; sends `memory.search {q, limit}` (+`agent` only when non-empty).

- [ ] **Step 1: Write the failing Python test**

Create `computer-use/tests/test_tools_memory_scope.py`:

```python
# computer-use/tests/test_tools_memory_scope.py
"""remember/recall proxy the right memory.* verbs and add agent scope."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_jarvis_ops


def test_remember_without_agent_omits_agent():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"id": "mem_1"}) as m:
        result = json.loads(tools_jarvis_ops.remember("dark mode", ["prefs"]))
    m.assert_called_once_with("memory.add", {"text": "dark mode", "tags": ["prefs"]})
    assert result["id"] == "mem_1"


def test_remember_with_agent_adds_scope():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"id": "mem_2"}) as m:
        tools_jarvis_ops.remember("runner healthy", agent="ci-runner-104")
    m.assert_called_once_with("memory.add",
                              {"text": "runner healthy", "tags": [],
                               "agent": "ci-runner-104"})


def test_recall_without_agent_matches_legacy_shape():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"memories": []}) as m:
        tools_jarvis_ops.recall("dark mode")
    m.assert_called_once_with("memory.search", {"q": "dark mode", "limit": 20})


def test_recall_with_agent_filters_by_scope():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      return_value={"memories": []}) as m:
        tools_jarvis_ops.recall(agent="ci-runner-104")
    m.assert_called_once_with("memory.search",
                              {"q": "", "limit": 20, "agent": "ci-runner-104"})


def test_remember_error_returns_json_error_not_exception():
    with patch.object(tools_jarvis_ops.daemon_client, "call",
                      side_effect=RuntimeError("boom")):
        result = json.loads(tools_jarvis_ops.remember("x"))
    assert "error" in result
```

- [ ] **Step 2: Run it — verify it fails**

Run: `computer-use/.venv/bin/python -m pytest computer-use/tests/test_tools_memory_scope.py -q`
Expected: FAIL — `AttributeError: module 'computer_use_mcp.tools_jarvis_ops' has no attribute 'remember'` (the functions are still nested inside `register()`).

- [ ] **Step 3: Refactor `remember`/`recall` to module level with an `agent` param**

In `computer-use/computer_use_mcp/tools_jarvis_ops.py`, add these two module-level functions immediately after the `_err` helper (after line 21):

```python
def remember(text: str, tags: list[str] | None = None, agent: str = "") -> str:
    """Save a fact to Jarvis's long-term memory so it persists across sessions
    (preferences, project facts, decisions). Pass `agent` (an agent name or a
    paired-machine id, e.g. "ci-runner-104") to scope the fact to THAT agent so
    it is only recalled with recall(agent=...); omit it for global memory.
    Returns {id}."""
    try:
        params: dict = {"text": text, "tags": tags or []}
        if agent:
            params["agent"] = agent
        return json.dumps(daemon_client.call("memory.add", params))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def recall(query: str = "", agent: str = "", limit: int = 20) -> str:
    """Full-text search Jarvis's long-term memory for relevant facts. Pass
    `agent` (an agent name / paired-machine id) to recall ONLY that agent's
    scoped memories (empty `query` + `agent` returns that agent's recent
    state — the condition-polling pattern). Omit `agent` for global recall."""
    try:
        params: dict = {"q": query, "limit": limit}
        if agent:
            params["agent"] = agent
        return json.dumps(daemon_client.call("memory.search", params))
    except Exception as exc:  # noqa: BLE001
        return _err(exc)
```

Then DELETE the nested `@mcp.tool()\n    def remember(...)` block (lines ~91–99) and the nested `@mcp.tool()\n    def recall(...)` block (lines ~101–108) from inside `register()`, and in their place (keep the `# ---- MEMORY ----` comment) add:

```python
    # ---- MEMORY -------------------------------------------------------------
    mcp.tool()(remember)
    mcp.tool()(recall)
```

- [ ] **Step 4: Extend the daemon RPC handlers**

In `daemon/src/ControlServer.cpp`, in `handleMemoryAdd`, replace the line:

```cpp
    const QString id = m_memory.add(text, tags);
```
with:
```cpp
    const QString agent = req.params.value(QStringLiteral("agent")).toString();
    const QString id = agent.isEmpty()
        ? m_memory.add(text, tags)
        : m_memory.add(text, tags, QString(), QStringLiteral("agent"), agent);
```

In `handleMemorySearch`, replace:

```cpp
    for (const MemoryRow &m : m_memory.search(q, limit))
```
with:
```cpp
    const QString agent = req.params.value(QStringLiteral("agent")).toString();
    for (const MemoryRow &m : m_memory.search(q, limit, agent))
```

- [ ] **Step 5: Run tests — verify pass + no regressions**

Run: `computer-use/.venv/bin/python -m pytest computer-use/tests/test_tools_memory_scope.py computer-use/tests/test_moa.py computer-use/tests/test_committee.py -q`
Expected: PASS — new tests pass; `test_moa`/`test_committee` (which call `tools_jarvis_ops.register`) still pass.

Run: `cmake --build build && QT_QPA_PLATFORM=offscreen ctest --test-dir build -R memory_store_test --output-on-failure`
Expected: PASS — daemon compiles; memory tests green.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/ControlServer.cpp computer-use/computer_use_mcp/tools_jarvis_ops.py computer-use/tests/test_tools_memory_scope.py
git commit -m "feat(memory): expose agent scope via memory.add/search + remember/recall"
```

---

## Task 3: Scheduler — webhook trigger + workflow columns

**Files:**
- Modify: `core/include/jarvis/Scheduler.h`
- Modify: `core/src/Scheduler.cpp`
- Test: `core/tests/scheduler_test.cpp` (already registered via `add_test(NAME scheduler_test ...)`)

**Interfaces:**
- Produces:
  - `enum class CronSpec::Kind { Invalid, Interval, DailyAt, Cron, Webhook };` — `parse("webhook")` ⇒ `Kind::Webhook` (valid); `nextAfter()` for Webhook ⇒ invalid `QDateTime` (never timer-fires).
  - `struct ScheduleRow { ...; QString targetRef; QString reportThread; QString webhookToken; }`.
  - `QString Scheduler::create(name, cronExpr, prompt, brain="", model="", profile="", enabled=true, targetRef="", reportThread="", webhookToken="");`
  - `ScheduleRow::toJson()` adds `"target"` (when non-empty) and `"report_thread"` (when non-empty). It NEVER emits the token.

- [ ] **Step 1: Write the failing test additions**

In `core/tests/scheduler_test.cpp`, insert this block immediately BEFORE the final `if (g_failures) {` line (around line 185):

```cpp
    // --- webhook trigger + workflow columns -------------------------------
    {
        const CronSpec w = CronSpec::parse(QStringLiteral("webhook"));
        check(w.valid() && w.kind == CronSpec::Kind::Webhook, "'webhook' parses as Webhook kind");
        check(!w.nextAfter(QDateTime::currentDateTime()).isValid(),
              "webhook nextAfter is invalid (never timer-scheduled)");
    }
    {
        QTemporaryDir tmp;
        const QString dbPath = tmp.path() + QStringLiteral("/wf_test.db");
        Scheduler sched;
        check(sched.open(dbPath, QStringLiteral("wf-test-conn")), "workflow: scheduler open");

        int fireCount = 0;
        sched.setFireCallback([&](const ScheduleRow &) -> QString {
            ++fireCount;
            return QStringLiteral("sess_wf");
        });

        // A cron workflow carrying target + report thread.
        const QString cid = sched.create(
            QStringLiteral("nightly-runner-check"), QStringLiteral("0 2 * * *"),
            QStringLiteral("check runner"), QStringLiteral("api"),
            QStringLiteral("mistral-large-latest"), QString(), true,
            QStringLiteral("ci-runner-104"), QStringLiteral("Workflows"), QString());
        check(!cid.isEmpty(), "workflow: cron workflow created");
        auto crow = sched.get(cid);
        check(crow && crow->targetRef == QStringLiteral("ci-runner-104"), "workflow: target persisted");
        check(crow && crow->reportThread == QStringLiteral("Workflows"), "workflow: report thread persisted");
        check(crow && crow->nextRun > 0, "workflow: cron workflow has a next_run");
        {
            const QJsonObject j = crow->toJson();
            check(j.value(QStringLiteral("target")).toString() == QStringLiteral("ci-runner-104"),
                  "workflow: toJson emits target");
            check(j.value(QStringLiteral("report_thread")).toString() == QStringLiteral("Workflows"),
                  "workflow: toJson emits report_thread");
            check(!j.contains(QStringLiteral("webhook_token")) && !j.contains(QStringLiteral("token")),
                  "workflow: toJson NEVER emits the webhook token");
        }

        // A webhook workflow: valid, stored, but never fires on a tick.
        const QString wid = sched.create(
            QStringLiteral("deploy-hook"), QStringLiteral("webhook"),
            QStringLiteral("handle deploy"), QString(), QString(), QString(), true,
            QString(), QStringLiteral("Workflows"), QStringLiteral("secret-token-xyz"));
        check(!wid.isEmpty(), "workflow: webhook workflow created (webhook is a valid trigger)");
        auto wrow = sched.get(wid);
        check(wrow && wrow->nextRun == 0, "workflow: webhook workflow is never timer-scheduled");
        check(wrow && wrow->webhookToken == QStringLiteral("secret-token-xyz"),
              "workflow: webhook token stored");

        // A far-future tick fires neither (cron is 02:00; webhook never).
        const QDateTime soon = QDateTime::currentDateTime().addSecs(120);
        sched.tick(soon);
        check(fireCount == 0, "workflow: neither the 02:00 cron nor the webhook fires on a near-term tick");

        // runNow fires the webhook workflow through the normal fire path.
        const auto sid = sched.runNow(wid);
        check(sid.has_value() && fireCount == 1, "workflow: runNow fires the webhook workflow");
    }
```

- [ ] **Step 2: Build and run — verify it fails**

Run: `cmake --build build 2>&1 | tail -20`
Expected: FAIL — e.g. `'Webhook' is not a member of 'jarvis::CronSpec::Kind'` and `'struct jarvis::ScheduleRow' has no member named 'targetRef'`.

- [ ] **Step 3: Extend the header**

In `core/include/jarvis/Scheduler.h`:

Change the `CronSpec::Kind` enum to:

```cpp
    enum class Kind { Invalid, Interval, DailyAt, Cron, Webhook };
```

In `struct ScheduleRow`, add after `qint64 created = 0;`:

```cpp
    QString targetRef;    // agent name / paired-machine id (free-text ref, no FK)
    QString reportThread; // inbox thread for the fired session's report ("" => none)
    QString webhookToken; // per-workflow bearer for trigger=="webhook" (never serialized)
```

Change the `create` declaration to:

```cpp
    QString create(const QString &name, const QString &cronExpr, const QString &prompt,
                   const QString &brain = QString(), const QString &model = QString(),
                   const QString &profile = QString(), bool enabled = true,
                   const QString &targetRef = QString(),
                   const QString &reportThread = QString(),
                   const QString &webhookToken = QString());
```

In the `private:` section, add after `bool migrate();`:

```cpp
    bool hasColumn(const QString &table, const QString &column);
```

- [ ] **Step 4: Implement the .cpp changes**

In `core/src/Scheduler.cpp`:

**(a)** In `CronSpec::parse`, add right after `const QString lower = e.toLower();`:

```cpp
    if (lower == QStringLiteral("webhook")) {
        s.kind = Kind::Webhook;
        return s;
    }
```

**(b)** In `CronSpec::nextAfter`, add a case before `case Kind::Invalid:`:

```cpp
    case Kind::Webhook:
        return QDateTime(); // externally triggered only — never timer-scheduled
```

**(c)** In `ScheduleRow::toJson()`, add after `o.insert(QStringLiteral("created"), created);`:

```cpp
    if (!targetRef.isEmpty())
        o.insert(QStringLiteral("target"), targetRef);
    if (!reportThread.isEmpty())
        o.insert(QStringLiteral("report_thread"), reportThread);
```

**(d)** Add the `hasColumn` helper just above `bool Scheduler::migrate()`:

```cpp
bool Scheduler::hasColumn(const QString &table, const QString &column)
{
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral("PRAGMA table_info(%1)").arg(table)))
        return false;
    while (q.next())
        if (q.value(1).toString().compare(column, Qt::CaseInsensitive) == 0)
            return true;
    return false;
}
```

**(e)** Replace the body of `migrate()` with:

```cpp
bool Scheduler::migrate()
{
    if (!exec(QStringLiteral(
            "CREATE TABLE IF NOT EXISTS schedules ("
            " id TEXT PRIMARY KEY,"
            " name TEXT,"
            " cron TEXT NOT NULL,"
            " prompt TEXT NOT NULL,"
            " brain TEXT,"
            " model TEXT,"
            " profile TEXT,"
            " enabled INTEGER NOT NULL DEFAULT 1,"
            " next_run INTEGER NOT NULL DEFAULT 0,"
            " last_run INTEGER NOT NULL DEFAULT 0,"
            " created INTEGER)")))
        return false;
    // Additive workflow columns (target ref, inbox report thread, webhook token).
    // Existing schedule rows keep NULL/'' for all three — untouched.
    if (!hasColumn(QStringLiteral("schedules"), QStringLiteral("target_ref")))
        exec(QStringLiteral("ALTER TABLE schedules ADD COLUMN target_ref TEXT"));
    if (!hasColumn(QStringLiteral("schedules"), QStringLiteral("report_thread")))
        exec(QStringLiteral("ALTER TABLE schedules ADD COLUMN report_thread TEXT"));
    if (!hasColumn(QStringLiteral("schedules"), QStringLiteral("webhook_token")))
        exec(QStringLiteral("ALTER TABLE schedules ADD COLUMN webhook_token TEXT"));
    return true;
}
```

**(f)** Change the `create()` signature line to:

```cpp
QString Scheduler::create(const QString &name, const QString &cronExpr, const QString &prompt,
                          const QString &brain, const QString &model,
                          const QString &profile, bool enabled,
                          const QString &targetRef, const QString &reportThread,
                          const QString &webhookToken)
```

In `create()`, after `r.created = QDateTime::currentMSecsSinceEpoch();` add:

```cpp
    r.targetRef = targetRef;
    r.reportThread = reportThread;
    r.webhookToken = webhookToken;
```

and replace the INSERT `QSqlQuery` block with:

```cpp
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO schedules"
        " (id,name,cron,prompt,brain,model,profile,enabled,next_run,last_run,created,"
        "  target_ref,report_thread,webhook_token)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"));
    q.addBindValue(r.id);
    q.addBindValue(r.name);
    q.addBindValue(r.cron);
    q.addBindValue(r.prompt);
    q.addBindValue(r.brain);
    q.addBindValue(r.model);
    q.addBindValue(r.profile);
    q.addBindValue(r.enabled ? 1 : 0);
    q.addBindValue(r.nextRun);
    q.addBindValue(r.lastRun);
    q.addBindValue(r.created);
    q.addBindValue(r.targetRef);
    q.addBindValue(r.reportThread);
    q.addBindValue(r.webhookToken);
    if (!q.exec()) {
        m_lastError = q.lastError().text();
        return QString();
    }
    return r.id;
```

**(g)** Replace the `rowFromQuery` helper with:

```cpp
static ScheduleRow rowFromQuery(QSqlQuery &q)
{
    ScheduleRow r;
    r.id = q.value(0).toString();
    r.name = q.value(1).toString();
    r.cron = q.value(2).toString();
    r.prompt = q.value(3).toString();
    r.brain = q.value(4).toString();
    r.model = q.value(5).toString();
    r.profile = q.value(6).toString();
    r.enabled = q.value(7).toInt() != 0;
    r.nextRun = q.value(8).toLongLong();
    r.lastRun = q.value(9).toLongLong();
    r.created = q.value(10).toLongLong();
    r.targetRef = q.value(11).toString();
    r.reportThread = q.value(12).toString();
    r.webhookToken = q.value(13).toString();
    return r;
}
```

**(h)** Update the SELECT column list in BOTH `list()` and `get()` — replace the string
`"SELECT id,name,cron,prompt,brain,model,profile,enabled,next_run,last_run,created"` (it appears in each) with:

```cpp
        "SELECT id,name,cron,prompt,brain,model,profile,enabled,next_run,last_run,created,"
        "target_ref,report_thread,webhook_token"
```
(keep the trailing `" FROM schedules ..."` fragment on each unchanged).

- [ ] **Step 5: Build and run — verify it passes**

Run: `cmake --build build && QT_QPA_PLATFORM=offscreen ctest --test-dir build -R scheduler_test --output-on-failure`
Expected: PASS — `scheduler_test` passes, including the new `workflow:` and `webhook` checks.

- [ ] **Step 6: Commit**

```bash
git add core/include/jarvis/Scheduler.h core/src/Scheduler.cpp core/tests/scheduler_test.cpp
git commit -m "feat(scheduler): webhook trigger + target/report_thread/webhook_token columns"
```

---

## Task 4: Daemon schedule wiring — pass workflow fields, inject report instruction, expose webhook token

**Files:**
- Modify: `daemon/src/ControlServer.h` (declare the new handler near line 437)
- Modify: `daemon/src/ControlServer.cpp` (`handleScheduleCreate` ~6109, `fireScheduledJob` ~6074, `dispatchOpsMethod` ~6051)

**Interfaces:**
- Consumes (Task 3): `Scheduler::create(..., targetRef, reportThread, webhookToken)`, `ScheduleRow::{targetRef,reportThread,webhookToken}`, `Scheduler::get(id)`, `Scheduler::runNow(id)`.
- Produces:
  - `schedule.create` RPC additionally reads `"target"`, `"report_thread"`, `"token"` params and stores them (existing `schedule_task` callers omit them ⇒ unchanged).
  - `fireScheduledJob` appends a "post your report to inbox thread `<reportThread>`" instruction to the fired session's prompt when `reportThread` is non-empty (empty ⇒ prompt unchanged — plain `schedule_task` behavior preserved).
  - New RPC `schedule.webhook_token {id} -> {token}` (empty string for unknown id / non-webhook rows). Used ONLY by the webhook endpoint.

- [ ] **Step 1: Declare the new handler**

In `daemon/src/ControlServer.h`, add after the `handleScheduleRunNow` declaration (line ~437):

```cpp
    Response handleScheduleWebhookToken(const Request &req);
```

- [ ] **Step 2: Wire schedule.create to pass the workflow fields**

In `daemon/src/ControlServer.cpp`, in `handleScheduleCreate`, replace the `m_scheduler.create(...)` call:

```cpp
    const QString id = m_scheduler.create(
        p.value(QStringLiteral("name")).toString(), cronExpr, prompt,
        p.value(QStringLiteral("brain")).toString(),
        p.value(QStringLiteral("model")).toString(),
        p.value(QStringLiteral("profile")).toString(),
        p.value(QStringLiteral("enabled")).toBool(true));
```
with:
```cpp
    const QString id = m_scheduler.create(
        p.value(QStringLiteral("name")).toString(), cronExpr, prompt,
        p.value(QStringLiteral("brain")).toString(),
        p.value(QStringLiteral("model")).toString(),
        p.value(QStringLiteral("profile")).toString(),
        p.value(QStringLiteral("enabled")).toBool(true),
        p.value(QStringLiteral("target")).toString(),
        p.value(QStringLiteral("report_thread")).toString(),
        p.value(QStringLiteral("token")).toString());
```

- [ ] **Step 3: Inject the report-thread instruction in the fire path**

In `fireScheduledJob`, replace:

```cpp
    if (!sendToSession(sid, row.prompt, {}, &err))
        qWarning("jarvisd: scheduled job '%s' send failed: %s",
                 qPrintable(row.name), qPrintable(err));
```
with:
```cpp
    QString prompt = row.prompt;
    if (!row.reportThread.isEmpty()) {
        prompt += QStringLiteral(
            "\n\n[Workflow report] When you finish this task, post a concise "
            "summary of the outcome to the user's Jarvis inbox by calling the "
            "notify_user tool with title=\"%1\". Keep it to a few lines.")
            .arg(row.reportThread);
    }
    if (!sendToSession(sid, prompt, {}, &err))
        qWarning("jarvisd: scheduled job '%s' send failed: %s",
                 qPrintable(row.name), qPrintable(err));
```

- [ ] **Step 4: Add the webhook-token accessor RPC**

In `dispatchOpsMethod`, add after the `schedule.run_now` line:

```cpp
    if (m == QStringLiteral("schedule.webhook_token")) return handleScheduleWebhookToken(req);
```

Add the handler implementation immediately after `handleScheduleRunNow` (after its closing brace, ~line 6192):

```cpp
Response ControlServer::handleScheduleWebhookToken(const Request &req)
{
    // Returns the stored per-workflow webhook bearer for `id` (empty for an
    // unknown id or a non-webhook workflow). Used ONLY by the webhook ingestion
    // endpoint to hmac-compare the presented bearer — never surfaced in
    // schedule.list / workflow_list output.
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const std::optional<ScheduleRow> row = m_scheduler.get(id);
    QJsonObject result;
    result.insert(QStringLiteral("token"), row ? row->webhookToken : QString());
    return Response::success(req.id, result);
}
```

- [ ] **Step 5: Build and verify no regressions**

Run: `cmake --build build && QT_QPA_PLATFORM=offscreen ctest --test-dir build --output-on-failure`
Expected: PASS — the daemon compiles and the full C++ suite (incl. `scheduler_test`, `memory_store_test`) stays green. (No daemon-level unit test harness exists in this repo; the Scheduler behavior these handlers wrap is covered by `scheduler_test`, and the MCP surface is covered by the Python tests in Tasks 2/5/6.)

- [ ] **Step 6: Commit**

```bash
git add daemon/src/ControlServer.h daemon/src/ControlServer.cpp
git commit -m "feat(daemon): workflow fields on schedule.create + report injection + schedule.webhook_token"
```

---

## Task 5: Workflow MCP tools — workflow_create / workflow_list / workflow_delete

**Files:**
- Create: `computer-use/computer_use_mcp/tools_workflows.py`
- Modify: `computer-use/computer_use_mcp/server.py`
- Test: `computer-use/tests/test_tools_workflows.py` (create)

**Interfaces:**
- Consumes (Task 4): `schedule.create` (accepts `target`/`report_thread`/`token`/`cron`), `schedule.list` (rows now carry `target`/`report_thread`), `schedule.remove`.
- Produces (module-level, importable):
  - `workflow_create(name, trigger, prompt, brain="", model="", target="", report_thread="") -> json str` — returns `{"id"}` for cron/interval/at triggers; `{"id","webhook_url","token"}` when `trigger=="webhook"`. Defaults `report_thread` to `"Workflows"` when blank.
  - `workflow_list() -> json str` `{"workflows":[{id,name,trigger,target,report_thread,brain,model,next_run,last_run,enabled}]}`.
  - `workflow_delete(id) -> json str` `{"ok","deleted"}`.
  - Constants `DEFAULT_REPORT_THREAD = "Workflows"`, `_WEBHOOK_PREFIX = "/workflows/webhook/"`; helper `_webhook_base()`.
  - `register(mcp)` wiring the three tools.

- [ ] **Step 1: Write the failing Python test**

Create `computer-use/tests/test_tools_workflows.py`:

```python
# computer-use/tests/test_tools_workflows.py
"""workflow_* tools proxy schedule.* verbs and mint webhook tokens."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_workflows


def test_workflow_create_cron_passes_trigger_as_cron():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "sched_1"}) as m:
        result = json.loads(tools_workflows.workflow_create(
            name="nightly-runner-check", trigger="0 2 * * *",
            prompt="check runner", brain="api",
            model="mistral-large-latest", target="ci-runner-104"))
    method, params = m.call_args[0][0], m.call_args[0][1]
    assert method == "schedule.create"
    assert params["cron"] == "0 2 * * *"
    assert params["target"] == "ci-runner-104"
    assert params["report_thread"] == "Workflows"   # default
    assert params["brain"] == "api"
    assert params["model"] == "mistral-large-latest"
    assert "token" not in params
    assert result == {"id": "sched_1"}


def test_workflow_create_defaults_report_thread_when_blank():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "s"}) as m:
        tools_workflows.workflow_create(name="n", trigger="every 5m", prompt="p")
    assert m.call_args[0][1]["report_thread"] == "Workflows"


def test_workflow_create_honors_explicit_report_thread():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "s"}) as m:
        tools_workflows.workflow_create(name="n", trigger="every 5m", prompt="p",
                                        report_thread="Runners")
    assert m.call_args[0][1]["report_thread"] == "Runners"


def test_workflow_create_webhook_mints_token_and_url(monkeypatch):
    monkeypatch.setenv("JARVIS_WEBHOOK_BASE", "http://100.64.0.1:8794")
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"id": "sched_wh"}) as m:
        result = json.loads(tools_workflows.workflow_create(
            name="deploy-hook", trigger="webhook", prompt="handle deploy"))
    params = m.call_args[0][1]
    assert params["cron"] == "webhook"
    assert params["token"] and len(params["token"]) >= 32
    assert result["id"] == "sched_wh"
    assert result["webhook_url"] == "http://100.64.0.1:8794/workflows/webhook/sched_wh"
    assert result["token"] == params["token"]


def test_workflow_create_requires_fields():
    result = json.loads(tools_workflows.workflow_create(name="", trigger="every 5m", prompt="p"))
    assert "error" in result


def test_workflow_list_maps_cron_to_trigger_and_new_fields():
    rows = {"schedules": [{"id": "s1", "name": "nightly", "cron": "0 2 * * *",
                           "target": "ci-runner-104", "report_thread": "Workflows",
                           "brain": "api", "model": "mistral-large-latest",
                           "next_run": 111, "last_run": 0, "enabled": True}]}
    with patch.object(tools_workflows.daemon_client, "call", return_value=rows):
        result = json.loads(tools_workflows.workflow_list())
    wf = result["workflows"][0]
    assert wf["trigger"] == "0 2 * * *"
    assert wf["target"] == "ci-runner-104"
    assert wf["report_thread"] == "Workflows"
    assert wf["next_run"] == 111
    assert wf["model"] == "mistral-large-latest"


def test_workflow_delete_maps_ok_to_deleted():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"ok": True}) as m:
        result = json.loads(tools_workflows.workflow_delete("sched_1"))
    m.assert_called_once_with("schedule.remove", {"id": "sched_1"})
    assert result == {"ok": True, "deleted": True}
```

- [ ] **Step 2: Run it — verify it fails**

Run: `computer-use/.venv/bin/python -m pytest computer-use/tests/test_tools_workflows.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'computer_use_mcp.tools_workflows'`.

- [ ] **Step 3: Create the tools module**

Create `computer-use/computer_use_mcp/tools_workflows.py`:

```python
"""Workflows — first-class, nameable recurring / conditional / webhook jobs
built on Jarvis's existing Scheduler (the schedule.* Contract-A verbs). A
Workflow bundles a trigger (a 5-field cron / "every Nm" / "at HH:MM" / the
literal "webhook"), a prompt, an optional brain+model, a free-text `target`
reference (an agent name or paired-machine id), and an inbox `report_thread`
(default "Workflows").

Condition-polling ("check X, only report if it changed") needs NO new schema:
author a tight-cadence Workflow whose prompt tells the fired session to
recall(agent=<target>) for last-known state, compare, and only escalate on a
change. See docs/WORKFLOWS.md.

Tool functions are module-level (tools_tui_ops.py style) so they are directly
importable/testable; register() wires them into FastMCP.
"""

from __future__ import annotations

import json
import os
import secrets

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client
from computer_use_mcp.config import load_config

DEFAULT_REPORT_THREAD = "Workflows"
_WEBHOOK_PREFIX = "/workflows/webhook/"


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def _webhook_base() -> str:
    """Base URL the minted webhook_url is built on. JARVIS_WEBHOOK_BASE wins;
    else the computer-use server's advertise_host:port (set advertise_host to a
    tailnet-reachable name/IP for external callers)."""
    cfg = load_config()
    return os.environ.get("JARVIS_WEBHOOK_BASE") or \
        f"http://{cfg['advertise_host']}:{cfg['port']}"


def workflow_create(name: str, trigger: str, prompt: str, brain: str = "",
                    model: str = "", target: str = "", report_thread: str = "") -> str:
    """Create a nameable Workflow (a managed recurring / webhook job). `trigger`
    is a cron ("0 2 * * *"), an interval ("every 30m"), a clock time ("at 09:00"),
    OR the literal "webhook". `target` is a free-text agent name / paired-machine
    id the prompt refers to (e.g. recall(agent=<target>) or outpost_exec on it).
    `report_thread` is the in-app inbox thread the fired session posts its report
    to (default "Workflows"). For trigger="webhook" this mints a per-workflow
    bearer token and returns {id, webhook_url, token}; otherwise returns {id}."""
    try:
        if not name.strip():
            return _err(ValueError("name is required"))
        if not trigger.strip():
            return _err(ValueError("trigger is required"))
        if not prompt.strip():
            return _err(ValueError("prompt is required"))
        thread = report_thread or DEFAULT_REPORT_THREAD
        is_webhook = trigger.strip().lower() == "webhook"
        params: dict = {"name": name, "prompt": prompt, "brain": brain,
                        "model": model, "target": target,
                        "report_thread": thread, "enabled": True}
        token = ""
        if is_webhook:
            token = secrets.token_urlsafe(32)
            params["cron"] = "webhook"
            params["token"] = token
        else:
            params["cron"] = trigger
        res = daemon_client.call("schedule.create", params)
        wid = res.get("id", "")
        out: dict = {"id": wid}
        if is_webhook and wid:
            out["webhook_url"] = f"{_webhook_base()}{_WEBHOOK_PREFIX}{wid}"
            out["token"] = token
        return json.dumps(out)
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def workflow_list() -> str:
    """List all Workflows (id, name, trigger, target, report_thread, brain,
    model, next_run, last_run, enabled)."""
    try:
        res = daemon_client.call("schedule.list")
        workflows = [{
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "trigger": r.get("cron", ""),
            "target": r.get("target", ""),
            "report_thread": r.get("report_thread", ""),
            "brain": r.get("brain", ""),
            "model": r.get("model", ""),
            "next_run": r.get("next_run", 0),
            "last_run": r.get("last_run", 0),
            "enabled": r.get("enabled", True),
        } for r in res.get("schedules", [])]
        return json.dumps({"workflows": workflows})
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def workflow_delete(id: str) -> str:
    """Delete a Workflow by id (from workflow_list). Returns {ok, deleted}."""
    try:
        res = daemon_client.call("schedule.remove", {"id": id})
        ok = bool(res.get("ok", False))
        return json.dumps({"ok": ok, "deleted": ok})
    except Exception as exc:  # noqa: BLE001
        return _err(exc)


def register(mcp: FastMCP) -> None:
    mcp.tool()(workflow_create)
    mcp.tool()(workflow_list)
    mcp.tool()(workflow_delete)
```

- [ ] **Step 4: Register the tools in the server**

In `computer-use/computer_use_mcp/server.py`, add `tools_workflows` to the import block. Change:

```python
from computer_use_mcp import (
    __version__, agent_bus, auth, live_widgets, policy, screen, session,
    tools_bg, tools_browser, tools_commands, tools_desktop, tools_jarvis_ops,
    tools_lsp, tools_phone, tools_todo, tools_tui_ops, tools_video,
    tools_widgets,
)
```
to:
```python
from computer_use_mcp import (
    __version__, agent_bus, auth, live_widgets, policy, screen, session,
    tools_bg, tools_browser, tools_commands, tools_desktop, tools_jarvis_ops,
    tools_lsp, tools_phone, tools_todo, tools_tui_ops, tools_video,
    tools_widgets, tools_workflows,
)
```

Then add a registration line after `tools_video.register(mcp)` (and before `policy.install(mcp)`):

```python
    tools_workflows.register(mcp)   # workflow_create/list/delete — managed jobs (proxied to jarvisd)
```

- [ ] **Step 5: Run tests — verify pass**

Run: `computer-use/.venv/bin/python -m pytest computer-use/tests/test_tools_workflows.py -q`
Expected: PASS — all workflow CRUD tests green.

- [ ] **Step 6: Commit**

```bash
git add computer-use/computer_use_mcp/tools_workflows.py computer-use/computer_use_mcp/server.py computer-use/tests/test_tools_workflows.py
git commit -m "feat(workflows): workflow_create/list/delete MCP tools over the Scheduler"
```

---

## Task 6: Webhook ingestion endpoint — POST /workflows/webhook/<id>

**Files:**
- Modify: `computer-use/computer_use_mcp/tools_workflows.py` (add `is_webhook_path`, `fire_webhook`, `register_webhook_route`)
- Modify: `computer-use/computer_use_mcp/server.py` (mount the route + exempt its path from the bearer middleware)
- Test: `computer-use/tests/test_tools_workflows.py` (append webhook-endpoint tests)

**Interfaces:**
- Consumes (Task 4): `schedule.webhook_token {id} -> {token}`, `schedule.run_now {id} -> {ok, session_id}` (the SAME internal fire path as cron).
- Produces:
  - `is_webhook_path(path: str) -> bool` — True for paths under `/workflows/webhook/`.
  - `fire_webhook(workflow_id: str, presented_token: str) -> tuple[int, dict]` — `(401, ...)` missing/invalid token, `(404, ...)` unknown/non-webhook id, `(200, {"ok","fired","session_id"})` on success, `(502, ...)` on daemon failure. Uses `hmac.compare_digest`.
  - `register_webhook_route(app)` — adds `POST /workflows/webhook/{workflow_id}` to a FastAPI app; the handler extracts the Bearer (header, else `?token=`), runs `fire_webhook` off-thread, and returns a `JSONResponse` with its status/body.

- [ ] **Step 1: Write the failing endpoint tests**

Append to `computer-use/tests/test_tools_workflows.py`:

```python
# --- webhook ingestion -------------------------------------------------------

def test_is_webhook_path():
    assert tools_workflows.is_webhook_path("/workflows/webhook/abc")
    assert not tools_workflows.is_webhook_path("/health")
    assert not tools_workflows.is_webhook_path("/mcp")


def test_fire_webhook_missing_token_401():
    status, body = tools_workflows.fire_webhook("w1", "")
    assert status == 401


def test_fire_webhook_unknown_workflow_404():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": ""}):
        status, body = tools_workflows.fire_webhook("nope", "whatever")
    assert status == 404


def test_fire_webhook_wrong_token_401():
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": "correct-secret"}):
        status, body = tools_workflows.fire_webhook("w1", "wrong-secret")
    assert status == 401


def test_fire_webhook_valid_token_fires_run_now():
    calls = []

    def fake(method, params=None, timeout=15.0):
        calls.append((method, params))
        if method == "schedule.webhook_token":
            return {"token": "secret"}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_9"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        status, body = tools_workflows.fire_webhook("w1", "secret")
    assert status == 200
    assert body["fired"] is True
    assert body["session_id"] == "sess_9"
    assert ("schedule.run_now", {"id": "w1"}) in calls


def test_webhook_route_fires_on_valid_bearer():
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    tools_workflows.register_webhook_route(app)

    def fake(method, params=None, timeout=15.0):
        if method == "schedule.webhook_token":
            return {"token": "secret"}
        if method == "schedule.run_now":
            return {"ok": True, "session_id": "sess_1"}
        return {}

    with patch.object(tools_workflows.daemon_client, "call", side_effect=fake):
        client = TestClient(app)
        resp = client.post("/workflows/webhook/w1",
                           headers={"Authorization": "Bearer secret"})
    assert resp.status_code == 200
    assert resp.json()["session_id"] == "sess_1"


def test_webhook_route_rejects_bad_bearer():
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    app = FastAPI()
    tools_workflows.register_webhook_route(app)
    with patch.object(tools_workflows.daemon_client, "call",
                      return_value={"token": "secret"}):
        client = TestClient(app)
        resp = client.post("/workflows/webhook/w1",
                           headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401
```

- [ ] **Step 2: Run it — verify it fails**

Run: `computer-use/.venv/bin/python -m pytest computer-use/tests/test_tools_workflows.py -q -k "webhook or fire_webhook or is_webhook_path"`
Expected: FAIL — `AttributeError: module 'computer_use_mcp.tools_workflows' has no attribute 'is_webhook_path'`.

- [ ] **Step 3: Add the webhook logic to the tools module**

In `computer-use/computer_use_mcp/tools_workflows.py`, extend the imports. Change:

```python
import json
import os
import secrets
```
to:
```python
import asyncio
import hmac
import json
import os
import secrets
```
and add below the existing `from computer_use_mcp.config import load_config` line:
```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
```

Add these functions after `workflow_delete` (before `register`):

```python
def is_webhook_path(path: str) -> bool:
    """True for the webhook ingestion path — exempted from the bearer middleware
    (it authenticates with the per-workflow token instead)."""
    return path.startswith(_WEBHOOK_PREFIX)


def fire_webhook(workflow_id: str, presented_token: str):
    """Verify the presented bearer against the workflow's stored per-workflow
    token (hmac-safe) and, on match, fire it through the SAME code path the cron
    scheduler uses (schedule.run_now -> Scheduler::runNow -> fireScheduledJob).
    Returns (http_status:int, body:dict)."""
    if not presented_token:
        return 401, {"error": "missing bearer token"}
    try:
        info = daemon_client.call("schedule.webhook_token", {"id": workflow_id})
    except Exception as exc:  # noqa: BLE001
        return 502, {"error": str(exc)}
    stored = str(info.get("token") or "")
    if not stored:
        return 404, {"error": "no such webhook workflow"}
    if not hmac.compare_digest(presented_token, stored):
        return 401, {"error": "invalid token"}
    try:
        res = daemon_client.call("schedule.run_now", {"id": workflow_id})
    except Exception as exc:  # noqa: BLE001
        return 502, {"error": str(exc)}
    return 200, {"ok": bool(res.get("ok", True)), "fired": True,
                 "session_id": res.get("session_id", "")}


def register_webhook_route(app: FastAPI) -> None:
    """Mount POST /workflows/webhook/<workflow_id> on the given FastAPI app."""

    @app.post(_WEBHOOK_PREFIX + "{workflow_id}")
    async def workflow_webhook(workflow_id: str, request: Request):  # noqa: ANN202
        auth_header = request.headers.get("Authorization") or ""
        token = ""
        parts = auth_header.split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1]
        if not token:
            token = request.query_params.get("token", "")
        status, body = await asyncio.to_thread(fire_webhook, workflow_id, token)
        return JSONResponse(status_code=status, content=body)
```

- [ ] **Step 4: Mount the route + exempt its path in the server**

In `computer-use/computer_use_mcp/server.py`:

**(a)** Exempt the webhook path from the bearer middleware. In `auth_middleware`, change:

```python
    if request.url.path in ("/health", "/ready") or request.method == "OPTIONS":
        return await call_next(request)
```
to:
```python
    if (request.url.path in ("/health", "/ready")
            or tools_workflows.is_webhook_path(request.url.path)
            or request.method == "OPTIONS"):
        return await call_next(request)
```

**(b)** Mount the route. Add immediately after the `app.add_middleware(CORSMiddleware, ...)` block (after its closing `)`, before the `@app.middleware("http")` decorator):

```python
# Webhook ingestion for trigger="webhook" Workflows. Authenticates with the
# per-workflow token (see is_webhook_path exemption above), NOT the global bearer.
tools_workflows.register_webhook_route(app)
```

- [ ] **Step 5: Run tests — verify pass**

Run: `computer-use/.venv/bin/python -m pytest computer-use/tests/test_tools_workflows.py -q`
Expected: PASS — all workflow CRUD + webhook + route tests green.

- [ ] **Step 6: Commit**

```bash
git add computer-use/computer_use_mcp/tools_workflows.py computer-use/computer_use_mcp/server.py computer-use/tests/test_tools_workflows.py
git commit -m "feat(workflows): webhook ingestion endpoint POST /workflows/webhook/<id>"
```

---

## Task 7: Documentation — docs/WORKFLOWS.md

**Files:**
- Create: `docs/WORKFLOWS.md`

**Interfaces:**
- Consumes: all tools from Tasks 1–6 (`remember`/`recall` with `agent`; `workflow_create`/`workflow_list`/`workflow_delete`; the webhook endpoint).

- [ ] **Step 1: Write the doc**

Create `docs/WORKFLOWS.md`:

````markdown
# Workflows & Agent-Scoped Memory

Two thin extensions to Orin's existing memory + scheduler.

## Agent-scoped memory

`remember`/`recall` gained an optional `agent` argument (an agent name or a
paired-machine id, e.g. `ci-runner-104`).

- `remember(text, tags=[], agent="ci-runner-104")` stores the fact scoped to
  that agent (SQLite `scope="agent"`, `entity_ref="ci-runner-104"`).
- `recall(query, agent="ci-runner-104")` returns ONLY that agent's memories.
- `recall(agent="ci-runner-104")` (empty query) returns that agent's recent
  state — the basis of the condition-polling pattern below.
- Omitting `agent` preserves the original global behavior exactly.

## Workflows

A **Workflow** is a nameable, managed job = trigger + prompt + (optional
brain+model) + a free-text `target` + an inbox `report_thread`. Workflows are
persisted in the same `schedules` table the scheduler already uses.

### Tools

- `workflow_create(name, trigger, prompt, brain="", model="", target="", report_thread="")`
  - `trigger`: a 5-field cron (`"0 2 * * *"`), an interval (`"every 30m"`), a
    clock time (`"at 09:00"`), or the literal `"webhook"`.
  - `target`: free-text agent/machine reference the prompt refers to (e.g.
    `recall(agent=<target>)`, or run `outpost_exec` on it).
  - `report_thread`: the in-app inbox thread the fired session posts its report
    to (default `"Workflows"`, auto-created on first `notify_user`). In-app inbox
    only — no push/SMS.
  - Returns `{id}`, or `{id, webhook_url, token}` for `trigger="webhook"`.
- `workflow_list()` → `{workflows:[{id,name,trigger,target,report_thread,brain,model,next_run,last_run,enabled}]}`.
- `workflow_delete(id)` → `{ok, deleted}`.

### Reporting to the inbox

When a Workflow fires, the daemon appends an instruction to the fired session's
prompt: *post a concise summary to the inbox via `notify_user(title="<report_thread>")`.*
The phone/inbox server creates the named thread on first use.

### Condition-polling ("check X, only report if it changed")

No new schema — it's a prompt pattern. Author a tight-cadence Workflow whose
prompt tells the fired session to `recall(agent=<target>)` for the last-known
state, compare, escalate only on a change, then `remember(..., agent=<target>)`
the new state.

### Worked example

```
workflow_create(
  name="nightly-runner-check", trigger="0 2 * * *", target="ci-runner-104",
  brain="api", model="mistral-large-latest",
  prompt="Run outpost_exec on ci-runner-104 checking the GitHub Actions runner "
         "service status; recall(agent='ci-runner-104') for last-known state; only "
         "escalate if it changed from healthy; otherwise just log OK.",
  report_thread="Workflows")
```

### Webhook trigger

`workflow_create(name, trigger="webhook", prompt=...)` mints a per-workflow
bearer token and returns `{id, webhook_url, token}`. POST to that URL with the
token to fire the workflow immediately through the same path the cron scheduler
uses:

```
curl -X POST "$WEBHOOK_URL" -H "Authorization: Bearer $TOKEN"
```

The endpoint (`POST /workflows/webhook/<id>` on the computer-use MCP server,
default `:8794`) is exempt from the global bearer and authenticates ONLY with
the per-workflow token (hmac-safe compare). Set `advertise_host` in
`~/.computer-use/config.yaml` (or `JARVIS_WEBHOOK_BASE`) to a tailnet-reachable
name so `webhook_url` is callable from off-box.
````

- [ ] **Step 2: Verify it renders / links resolve**

Run: `test -f docs/WORKFLOWS.md && grep -c "workflow_create" docs/WORKFLOWS.md`
Expected: prints a non-zero count (file exists and documents the tools).

- [ ] **Step 3: Commit**

```bash
git add docs/WORKFLOWS.md
git commit -m "docs: workflows + agent-scoped memory usage guide"
```

---

## Self-Review

**1. Spec coverage**

- Gap 1 — `"agent"` scope value + `entityRef` column, additive/backward-compatible → Task 1 (store) + Task 2 (daemon RPC).
- Gap 1 — `remember(text, tags=None, agent="")` stores `scope="agent", entityRef=agent` when non-empty, unchanged otherwise → Task 2.
- Gap 1 — `recall(query, agent="", limit=20)` filters `entityRef==agent`, unchanged when empty (strict regression safety) → Task 1 (`search` filter, unfiltered path identical) + Task 2. (`query` defaulted to `""` so the documented `recall(agent=...)` call works — a superset of the spec signature.)
- Gap 2 — two additive columns `targetRef`/`reportThread` on `schedules` (+ `webhook_token`) → Task 3.
- Gap 2 — `reportThread` defaults to `"Workflows"`, auto-created on first use → default applied in `workflow_create` (Task 5); auto-creation happens via `notify_user` (documented Task 7); injected into the fire path (Task 4).
- Gap 2 — `workflow_create`/`workflow_list`/`workflow_delete` wrapping the existing schedule code path → Task 5 (wraps `schedule.create`/`list`/`remove`).
- Gap 2 — condition-polling documented as a usage pattern, no new schema → Task 7.
- Gap 2 — webhook trigger mints `secrets.token_urlsafe(32)`, returns `{webhook_url, token}` → Task 5.
- Gap 2 — new `POST /workflows/webhook/<id>` on the existing FastAPI app, hmac-safe compare, fires via the SAME internal path (`schedule.run_now` → `runNow` → `fireScheduledJob`) → Task 6 (+ `schedule.webhook_token` accessor in Task 4). No fire logic duplicated.
- No new LLM-provider work; `outpost_exec` referenced only in prompt/doc text — confirmed (Global Constraints, Task 7).
- Ordering: Gap 1 (Tasks 1–2) before Gap 2 (Tasks 3–6); webhook (Task 6) after `workflow_create` (Task 5). ✓

**2. Placeholder scan**

No "TBD"/"TODO"/"handle edge cases"/"similar to Task N"/"write tests for the above". Every code step shows complete code; every test step shows full test bodies; every run step gives the exact command + expected result. ✓

**3. Type consistency**

- C++ `MemoryStore::add(text, tags, id, scope, entityRef)` and `search(query, limit, entityRef)` — declared in Task 1 header, called with matching arity in Task 1 tests, Task 2 daemon.
- `MemoryRow.scope` / `MemoryRow.entityRef` — used consistently (`entityRef`, camelCase) in header, cpp, tests, and JSON key `"entityRef"`.
- C++ `Scheduler::create(..., targetRef, reportThread, webhookToken)` — declared Task 3, called with matching 10-arg order in Task 3 test and Task 4 daemon (`target`/`report_thread`/`token` JSON params map to those three).
- `ScheduleRow.{targetRef,reportThread,webhookToken}` + JSON keys `"target"`/`"report_thread"` (token never serialized) — consistent across Task 3 (toJson/rowFromQuery), Task 4 (`fireScheduledJob`, `handleScheduleWebhookToken`), Task 5 (`workflow_list` reads `cron`→`trigger`, `target`, `report_thread`).
- Python params: `remember`/`recall` send `{"agent": ...}` only when non-empty; daemon reads `"agent"` — matched (Task 2). `workflow_create` sends `{"cron","target","report_thread","token","enabled","name","prompt","brain","model"}`; daemon `handleScheduleCreate` reads exactly those — matched (Tasks 4/5).
- Webhook flow: `fire_webhook` calls `schedule.webhook_token` (Task 4) then `schedule.run_now` (pre-existing) — names match; `is_webhook_path`/`_WEBHOOK_PREFIX` consistent between the module and server exemption (Task 6).

No inconsistencies found.
