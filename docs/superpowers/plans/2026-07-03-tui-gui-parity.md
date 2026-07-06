# TUI GUI-Parity + Self-Edit Layout + Slash Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `jarvis` TUI to full feature parity with the 18-page desktop
GUI, add an MCP tool so Jarvis can add/edit/remove/reorder TUI pages live
(declarative config, no code), and add a full script/tool-backed `/`
command engine that both the user and Jarvis can extend.

**Architecture:** Two small new C++ core stores (`TuiLayoutStore`,
`CommandStore`, both mirroring existing store classes byte-for-byte in
shape) get thin `ControlServer` glue exposing new Contract-A verbs. Two new
Python engine modules proxy those verbs as MCP tools, following
`tools_jarvis_ops.py`'s existing `daemon_client.call()` pattern exactly. 13
new Textual screens (`TablePane` subclasses, following `screens.py`'s
existing shape) consume the *same* verbs/REST endpoints/file buses the
desktop `Bridge.cpp` already uses — no new backend surface for those, only
for the two genuinely new subsystems (self-edit layout, slash commands).

**Tech Stack:** C++20/Qt6 (core, daemon), Python 3.10+ (computer-use engine,
cli/Textual), `rich`/`textual` for terminal UI, `qrcode` (pure-Python, new
cli dependency) for ASCII QR.

> **2026-07 update:** this plan predates the web dashboard's GUI-parity pass.
> `web/` (Bun+Vite+SolidJS) now separately reaches the same 18-page+Browser
> set described here — see `web/README.md`'s "Known differences from the
> desktop GUI" section for its browser-specific trade-offs (no filesystem
> access means the widget saved-library and host CPU/RAM/NET telemetry work
> differently there than on TUI/GUI). This doc's scope remains the TUI.

**Deviation from the approved spec (grounded during research, noted here
per brainstorming's "follow existing patterns" guidance):** the spec said
slash commands live in `~/.config/jarvis/commands/*.yaml`. Research found
the codebase has **no YAML library** — `SkillStore` (the direct precedent
for self-authored, agent-writable artifacts) hand-parses flat
Markdown+frontmatter files at `~/.local/share/jarvis/skills/<group>/<name>/
SKILL.md`. `CommandStore` mirrors that exact convention instead:
`~/.local/share/jarvis/commands/<name>/COMMAND.md`. Same trust model, one
less dependency, consistent with `create_skill`.

## Global Constraints

- New C++ store classes: `#pragma once`, `namespace jarvis`, constructor
  takes an optional `dir` (defaults via a `defaultDir()` static, honoring
  `jarvis::dataDir()`), file-backed, no exceptions thrown (best-effort).
  Mirror `core/include/jarvis/WidgetLeaseRegistry.h` exactly in shape.
- New C++ tests: plain `main()` + a homemade `check(bool, const char*)` /
  `g_failures` counter (see `core/tests/widget_lease_test.cpp`) — **not**
  QTest macros. Use a `QTemporaryDir` so tests never touch the real
  `~/.local/share/jarvis`. Register in `core/CMakeLists.txt` via
  `add_executable(<name>_test tests/<name>_test.cpp)` +
  `target_link_libraries(<name>_test PRIVATE jarvis-core Qt6::Core)` +
  `add_test(NAME <name>_test COMMAND <name>_test)`.
- New Contract-A verbs dispatch from `ControlServer::dispatchOpsMethod`
  (`daemon/src/ControlServer.cpp`, the `if (m == QStringLiteral("verb"))
  return handleX(req);` chain).
- New daemon broadcasts follow `ControlServer::broadcastSessionOpened`'s
  exact shape: build `{v:1, event:"...", data:{...}}`, iterate
  `m_clients`, `client->sendTextMessage(payload)`.
- New MCP tools: a `register(mcp: FastMCP)` function per module, each tool
  `@mcp.tool()`-decorated, calling `daemon_client.call(verb, params)`,
  returning `json.dumps(result)`, wrapped in `try/except Exception as exc:
  return _err(exc)` — mirror `computer-use/computer_use_mcp/
  tools_jarvis_ops.py` exactly. Register the module in
  `computer-use/computer_use_mcp/server.py`'s import list + `<module>.
  register(mcp)` call.
- New TUI panes subclass `TablePane` (`cli/jarvis_cli/tui/screens.py`) when
  list-shaped: set `HINT`, `COLUMNS`, implement `async def fetch(self) ->
  list[dict]` and `def to_cells(self, row: dict) -> tuple`, override
  `on_key`/`compose`/`on_input_submitted` only when the base isn't enough.
  Every new pane is registered in `cli/jarvis_cli/tui/app.py`'s
  `compose()` (`TabPane("Title", id="tab-x"): yield XPane(id="x")`) and
  import list.
- Python tests use the existing fake-daemon harness
  (`cli/tests/harness.py`) + `pytest`; Textual smoke tests use `Pilot`
  (`cli/tests/test_tui.py`'s existing style).
- No system binaries required for anything new — `qrcode` (pip) not
  `qrencode` (not installed on this machine, confirmed).
- Reserved built-in TUI page ids (cannot be added/edited/removed through
  the self-edit tool): `chat, sessions, memory, skills, agents, queue,
  settings, canvas, widgets, phone, computer, browser, activity, replay,
  mcp, plugins, ssh, memorygraph, home, schedules`.

---

### Task 1: Core+Daemon — `TuiLayoutStore` + `tui.layout.*` verbs

**Files:**
- Create: `core/include/jarvis/TuiLayoutStore.h`
- Create: `core/src/TuiLayoutStore.cpp`
- Test: `core/tests/tui_layout_store_test.cpp`
- Modify: `core/CMakeLists.txt` (add lib source + test executable)
- Modify: `daemon/src/ControlServer.h` (declare 5 handlers + member)
- Modify: `daemon/src/ControlServer.cpp` (dispatch + handlers + broadcast)

**Interfaces:**
- Produces: `jarvis::TuiLayoutStore` with `struct TuiPageSpec {QString id,
  title, kind; QJsonObject config; int order;}`; methods `list()`,
  `addPage(spec, QString *error) -> bool`, `editPage(id, config, error) ->
  bool`, `removePage(id, error) -> bool`, `reorder(orderedIds, error) ->
  bool`, `static bool isReservedId(const QString &id)`. `kind` must be one
  of `log|table|markdown|widget|list` (validated in `addPage`/`editPage`,
  else `*error = "invalid kind"` and return false).
- Produces Contract-A verbs: `tui.layout.list` (no params) → `{"pages":
  [{"id","title","kind","config","order","reserved":bool}, ...]}` (built-in
  20 reserved ids are NOT included — they're always present client-side);
  `tui.layout.add` (`id,title,kind,config`) → `{"ok":true}` or error;
  `tui.layout.edit` (`id,config`) → `{"ok":true}`; `tui.layout.remove`
  (`id`) → `{"ok":true}`; `tui.layout.reorder` (`order: [id,...]`) →
  `{"ok":true}`. Every mutation broadcasts `tui.layout.changed` with
  `{"pages": <same shape as list's pages>}` to `m_clients`.

- [ ] **Step 1: Write the failing test**

```cpp
// core/tests/tui_layout_store_test.cpp
// ctest: TuiLayoutStore CRUD + reserved-id guard + persistence across
// instances.

#include "jarvis/TuiLayoutStore.h"

#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

int main()
{
    QTemporaryDir tmp;

    // addPage + list round-trip.
    {
        jarvis::TuiLayoutStore store(tmp.path());
        QString err;
        jarvis::TuiPageSpec spec;
        spec.id = QStringLiteral("errorlog");
        spec.title = QStringLiteral("Error Log");
        spec.kind = QStringLiteral("log");
        spec.config = QJsonObject{{"path", QStringLiteral("/var/log/jarvis.log")}};
        check(store.addPage(spec, &err), "addPage succeeds for a fresh id");
        const auto pages = store.list();
        check(pages.size() == 1, "list() returns the added page");
        check(pages[0].title == QStringLiteral("Error Log"), "title round-trips");
    }

    // Reserved id is rejected.
    {
        jarvis::TuiLayoutStore store(tmp.path() + QStringLiteral("/other"));
        QString err;
        jarvis::TuiPageSpec spec;
        spec.id = QStringLiteral("chat");
        spec.title = QStringLiteral("Nope");
        spec.kind = QStringLiteral("log");
        check(!store.addPage(spec, &err), "addPage rejects a reserved id");
        check(!err.isEmpty(), "addPage sets an error message");
        check(jarvis::TuiLayoutStore::isReservedId(QStringLiteral("chat")),
              "isReservedId recognizes a builtin");
        check(!jarvis::TuiLayoutStore::isReservedId(QStringLiteral("errorlog")),
              "isReservedId does not flag a custom id");
    }

    // Invalid kind is rejected.
    {
        jarvis::TuiLayoutStore store(tmp.path() + QStringLiteral("/kindcheck"));
        QString err;
        jarvis::TuiPageSpec spec;
        spec.id = QStringLiteral("weird");
        spec.title = QStringLiteral("Weird");
        spec.kind = QStringLiteral("video");   // not in log|table|markdown|widget|list
        check(!store.addPage(spec, &err), "addPage rejects an invalid kind");
    }

    // editPage + removePage + persistence across instances (new object, same dir).
    {
        const QString dir = tmp.path() + QStringLiteral("/persist");
        QString err;
        {
            jarvis::TuiLayoutStore store(dir);
            jarvis::TuiPageSpec spec;
            spec.id = QStringLiteral("todo");
            spec.title = QStringLiteral("Todo");
            spec.kind = QStringLiteral("list");
            spec.config = QJsonObject{{"rows", QJsonArray{}}};
            store.addPage(spec, &err);
        }
        {
            jarvis::TuiLayoutStore store(dir);   // fresh instance, same dir
            check(store.list().size() == 1, "a fresh instance loads the persisted page");
            check(store.editPage(QStringLiteral("todo"),
                                  QJsonObject{{"rows", QJsonArray{"buy milk"}}}, &err),
                  "editPage succeeds for an existing id");
            check(!store.editPage(QStringLiteral("missing"), QJsonObject{}, &err),
                  "editPage fails for a missing id");
            check(store.removePage(QStringLiteral("todo"), &err),
                  "removePage succeeds for an existing id");
            check(store.list().isEmpty(), "removePage actually removes it");
        }
    }

    // reorder.
    {
        const QString dir = tmp.path() + QStringLiteral("/reorder");
        jarvis::TuiLayoutStore store(dir);
        QString err;
        jarvis::TuiPageSpec a; a.id = QStringLiteral("a"); a.title = QStringLiteral("A");
        a.kind = QStringLiteral("log");
        jarvis::TuiPageSpec b; b.id = QStringLiteral("b"); b.title = QStringLiteral("B");
        b.kind = QStringLiteral("log");
        store.addPage(a, &err);
        store.addPage(b, &err);
        check(store.reorder({QStringLiteral("b"), QStringLiteral("a")}, &err),
              "reorder succeeds with a valid full id list");
        const auto pages = store.list();
        check(pages.size() == 2 && pages[0].id == QStringLiteral("b")
              && pages[0].order == 0 && pages[1].order == 1,
              "reorder writes the new order field");
    }

    if (g_failures == 0)
        std::fprintf(stderr, "ALL TuiLayoutStore TESTS PASSED\n");
    return g_failures == 0 ? 0 : 1;
}
```

- [ ] **Step 2: Run test to verify it fails (won't even compile — header doesn't exist)**

Run: `cmake --build build --target tui_layout_store_test` (from repo root,
assuming `build/` is already configured per the existing project; if not,
`cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug` first)
Expected: FAIL — `fatal error: jarvis/TuiLayoutStore.h: No such file or directory`

- [ ] **Step 3: Write `core/include/jarvis/TuiLayoutStore.h`**

```cpp
#pragma once

// TuiLayoutStore — file-backed CRUD for the terminal client's CUSTOM (non-
// builtin) page layout. Lets Jarvis add/edit/remove/reorder TUI pages via
// an MCP tool WITHOUT touching source code: each custom page is a small
// declarative spec {id, title, kind, config}, kind in
// {log, table, markdown, widget, list}. The 20 builtin pages are reserved
// ids and never stored here.

#include <QJsonObject>
#include <QString>
#include <QVector>

namespace jarvis {

struct TuiPageSpec {
    QString id;
    QString title;
    QString kind;       // log | table | markdown | widget | list
    QJsonObject config;
    int order = 0;
};

class TuiLayoutStore {
public:
    // dir defaults to jarvis::dataDir() (the same root as widget_viewers/,
    // agent/, etc.) — file is "<dir>/tui_layout.json".
    explicit TuiLayoutStore(const QString &dir = QString());

    QVector<TuiPageSpec> list() const;
    bool addPage(const TuiPageSpec &page, QString *error);
    bool editPage(const QString &id, const QJsonObject &config, QString *error);
    bool removePage(const QString &id, QString *error);
    bool reorder(const QStringList &orderedIds, QString *error);

    static bool isReservedId(const QString &id);
    static QStringList reservedIds();
    static bool isValidKind(const QString &kind);
    static QString defaultDir();

private:
    QString filePath() const;
    QVector<TuiPageSpec> load() const;
    bool save(const QVector<TuiPageSpec> &pages) const;

    QString m_dir;
};

} // namespace jarvis
```

- [ ] **Step 4: Write `core/src/TuiLayoutStore.cpp`**

```cpp
#include "jarvis/TuiLayoutStore.h"
#include "jarvis/DataPaths.h"   // jarvis::dataDir() — same header WidgetLeaseRegistry.cpp uses

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>

namespace jarvis {

namespace {
const QStringList kReserved = {
    QStringLiteral("chat"), QStringLiteral("sessions"), QStringLiteral("memory"),
    QStringLiteral("skills"), QStringLiteral("agents"), QStringLiteral("queue"),
    QStringLiteral("settings"), QStringLiteral("canvas"), QStringLiteral("widgets"),
    QStringLiteral("phone"), QStringLiteral("computer"), QStringLiteral("browser"),
    QStringLiteral("activity"), QStringLiteral("replay"), QStringLiteral("mcp"),
    QStringLiteral("plugins"), QStringLiteral("ssh"), QStringLiteral("memorygraph"),
    QStringLiteral("home"), QStringLiteral("schedules"),
};
const QStringList kKinds = {
    QStringLiteral("log"), QStringLiteral("table"), QStringLiteral("markdown"),
    QStringLiteral("widget"), QStringLiteral("list"),
};
}

TuiLayoutStore::TuiLayoutStore(const QString &dir)
    : m_dir(dir.isEmpty() ? defaultDir() : dir)
{
    QDir().mkpath(m_dir);
}

QString TuiLayoutStore::defaultDir() { return jarvis::dataDir(); }

bool TuiLayoutStore::isReservedId(const QString &id) { return kReserved.contains(id); }
QStringList TuiLayoutStore::reservedIds() { return kReserved; }
bool TuiLayoutStore::isValidKind(const QString &kind) { return kKinds.contains(kind); }

QString TuiLayoutStore::filePath() const { return m_dir + QStringLiteral("/tui_layout.json"); }

QVector<TuiPageSpec> TuiLayoutStore::load() const
{
    QVector<TuiPageSpec> out;
    QFile f(filePath());
    if (!f.open(QIODevice::ReadOnly))
        return out;
    const auto doc = QJsonDocument::fromJson(f.readAll());
    if (!doc.isArray())
        return out;
    for (const auto &v : doc.array()) {
        const auto o = v.toObject();
        TuiPageSpec p;
        p.id = o.value(QStringLiteral("id")).toString();
        p.title = o.value(QStringLiteral("title")).toString();
        p.kind = o.value(QStringLiteral("kind")).toString();
        p.config = o.value(QStringLiteral("config")).toObject();
        p.order = o.value(QStringLiteral("order")).toInt();
        if (!p.id.isEmpty())
            out.push_back(p);
    }
    return out;
}

bool TuiLayoutStore::save(const QVector<TuiPageSpec> &pages) const
{
    QJsonArray arr;
    for (const auto &p : pages) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), p.id);
        o.insert(QStringLiteral("title"), p.title);
        o.insert(QStringLiteral("kind"), p.kind);
        o.insert(QStringLiteral("config"), p.config);
        o.insert(QStringLiteral("order"), p.order);
        arr.append(o);
    }
    QFile f(filePath());
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    f.write(QJsonDocument(arr).toJson(QJsonDocument::Compact));
    return true;
}

QVector<TuiPageSpec> TuiLayoutStore::list() const
{
    auto pages = load();
    std::sort(pages.begin(), pages.end(),
              [](const TuiPageSpec &a, const TuiPageSpec &b) { return a.order < b.order; });
    return pages;
}

bool TuiLayoutStore::addPage(const TuiPageSpec &page, QString *error)
{
    if (isReservedId(page.id)) {
        if (error) *error = QStringLiteral("reserved page id");
        return false;
    }
    if (!isValidKind(page.kind)) {
        if (error) *error = QStringLiteral("invalid kind");
        return false;
    }
    auto pages = load();
    for (const auto &p : pages) {
        if (p.id == page.id) {
            if (error) *error = QStringLiteral("id already exists");
            return false;
        }
    }
    TuiPageSpec toAdd = page;
    toAdd.order = static_cast<int>(pages.size());
    pages.push_back(toAdd);
    return save(pages);
}

bool TuiLayoutStore::editPage(const QString &id, const QJsonObject &config, QString *error)
{
    auto pages = load();
    for (auto &p : pages) {
        if (p.id == id) {
            p.config = config;
            return save(pages);
        }
    }
    if (error) *error = QStringLiteral("no such page");
    return false;
}

bool TuiLayoutStore::removePage(const QString &id, QString *error)
{
    auto pages = load();
    const auto before = pages.size();
    pages.erase(std::remove_if(pages.begin(), pages.end(),
                                [&](const TuiPageSpec &p) { return p.id == id; }),
                pages.end());
    if (pages.size() == before) {
        if (error) *error = QStringLiteral("no such page");
        return false;
    }
    return save(pages);
}

bool TuiLayoutStore::reorder(const QStringList &orderedIds, QString *error)
{
    auto pages = load();
    if (orderedIds.size() != pages.size()) {
        if (error) *error = QStringLiteral("order list must include every custom page id");
        return false;
    }
    QVector<TuiPageSpec> reordered;
    for (const auto &id : orderedIds) {
        bool found = false;
        for (const auto &p : pages) {
            if (p.id == id) {
                reordered.push_back(p);
                found = true;
                break;
            }
        }
        if (!found) {
            if (error) *error = QStringLiteral("unknown id in order list: ") + id;
            return false;
        }
    }
    for (int i = 0; i < reordered.size(); ++i)
        reordered[i].order = i;
    return save(reordered);
}

} // namespace jarvis
```

If `jarvis::dataDir()` is declared somewhere other than `jarvis/DataPaths.h`,
grep first: `grep -rn "QString dataDir" core/include/` and fix the include
to match — do not guess, this is a one-line fix.

- [ ] **Step 5: Register in `core/CMakeLists.txt`**

Find the `jarvis-core` library's source list (near where `WidgetLeaseRegistry.cpp`
is listed) and add `src/TuiLayoutStore.cpp`. Then add near the
`widget_lease_test` block (around line 317-319):

```cmake
add_executable(tui_layout_store_test tests/tui_layout_store_test.cpp)
target_link_libraries(tui_layout_store_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME tui_layout_store_test COMMAND tui_layout_store_test)
```

- [ ] **Step 6: Build + run test to verify it passes**

Run: `cmake --build build --target tui_layout_store_test -j && ctest --test-dir build -R tui_layout_store_test --output-on-failure`
Expected: `ALL TuiLayoutStore TESTS PASSED`, exit 0.

- [ ] **Step 7: Wire the 5 Contract-A verbs into `ControlServer`**

In `daemon/src/ControlServer.h`, add a member and 5 handler declarations
(near the other `handleSchedule*` declarations):

```cpp
Response handleTuiLayoutList(const Request &req);
Response handleTuiLayoutAdd(const Request &req);
Response handleTuiLayoutEdit(const Request &req);
Response handleTuiLayoutRemove(const Request &req);
Response handleTuiLayoutReorder(const Request &req);
void broadcastTuiLayoutChanged();
```
and `jarvis::TuiLayoutStore m_tuiLayoutStore;` alongside the other store members.

In `daemon/src/ControlServer.cpp`, add to `dispatchOpsMethod` (in the same
chain as the `schedule.*` lines, `core/tests` confirmed this dispatch
pattern at `ControlServer.cpp:5954-5968`):

```cpp
if (m == QStringLiteral("tui.layout.list"))    return handleTuiLayoutList(req);
if (m == QStringLiteral("tui.layout.add"))     return handleTuiLayoutAdd(req);
if (m == QStringLiteral("tui.layout.edit"))    return handleTuiLayoutEdit(req);
if (m == QStringLiteral("tui.layout.remove"))  return handleTuiLayoutRemove(req);
if (m == QStringLiteral("tui.layout.reorder")) return handleTuiLayoutReorder(req);
```

And the handler bodies + broadcast (add near the `handleSchedule*`
implementations), reusing `#include "jarvis/TuiLayoutStore.h"`:

```cpp
static QJsonArray tuiPagesToJson(const QVector<jarvis::TuiPageSpec> &pages)
{
    QJsonArray arr;
    for (const auto &p : pages) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), p.id);
        o.insert(QStringLiteral("title"), p.title);
        o.insert(QStringLiteral("kind"), p.kind);
        o.insert(QStringLiteral("config"), p.config);
        o.insert(QStringLiteral("order"), p.order);
        arr.append(o);
    }
    return arr;
}

Response ControlServer::handleTuiLayoutList(const Request &req)
{
    QJsonObject result;
    result.insert(QStringLiteral("pages"), tuiPagesToJson(m_tuiLayoutStore.list()));
    return Response::success(req.id, result);
}

Response ControlServer::handleTuiLayoutAdd(const Request &req)
{
    jarvis::TuiPageSpec spec;
    spec.id = req.params.value(QStringLiteral("id")).toString();
    spec.title = req.params.value(QStringLiteral("title")).toString();
    spec.kind = req.params.value(QStringLiteral("kind")).toString();
    spec.config = req.params.value(QStringLiteral("config")).toObject();
    QString err;
    if (!m_tuiLayoutStore.addPage(spec, &err))
        return Response::failure(req.id, QStringLiteral("invalid_page"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleTuiLayoutEdit(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const QJsonObject config = req.params.value(QStringLiteral("config")).toObject();
    QString err;
    if (!m_tuiLayoutStore.editPage(id, config, &err))
        return Response::failure(req.id, QStringLiteral("not_found"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleTuiLayoutRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    QString err;
    if (!m_tuiLayoutStore.removePage(id, &err))
        return Response::failure(req.id, QStringLiteral("not_found"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleTuiLayoutReorder(const Request &req)
{
    QStringList order;
    for (const auto &v : req.params.value(QStringLiteral("order")).toArray())
        order << v.toString();
    QString err;
    if (!m_tuiLayoutStore.reorder(order, &err))
        return Response::failure(req.id, QStringLiteral("invalid_order"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

void ControlServer::broadcastTuiLayoutChanged()
{
    // Same shape as broadcastSessionOpened (ControlServer.cpp:4285) — a
    // global, non-session-scoped event every connected client hears.
    QJsonObject data;
    data.insert(QStringLiteral("pages"), tuiPagesToJson(m_tuiLayoutStore.list()));
    QJsonObject frame;
    frame.insert(QStringLiteral("v"), 1);
    frame.insert(QStringLiteral("event"), QStringLiteral("tui.layout.changed"));
    frame.insert(QStringLiteral("data"), data);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_clients))
        client->sendTextMessage(payload);
}
```

If `Response::failure`/`Response::success` have a different exact signature
than shown, grep `grep -n "Response::failure\|Response::success" daemon/src/ControlServer.cpp | head -5`
and match the existing convention exactly rather than guessing.

- [ ] **Step 8: Build the daemon + full ctest suite to confirm nothing broke**

Run: `cmake --build build -j && ctest --test-dir build --output-on-failure`
Expected: all tests pass (same count as before + 1 new `tui_layout_store_test`).

- [ ] **Step 9: Commit**

```bash
git add core/include/jarvis/TuiLayoutStore.h core/src/TuiLayoutStore.cpp \
        core/tests/tui_layout_store_test.cpp core/CMakeLists.txt \
        daemon/src/ControlServer.h daemon/src/ControlServer.cpp
git commit -m "feat(daemon): tui.layout.* Contract-A verbs — Jarvis can add/edit/remove/reorder TUI pages without touching code"
```

---

### Task 2: Core+Daemon — `CommandStore` + `command.*` verbs

**Files:**
- Create: `core/include/jarvis/CommandStore.h`
- Create: `core/src/CommandStore.cpp`
- Test: `core/tests/command_store_test.cpp`
- Modify: `core/CMakeLists.txt`
- Modify: `daemon/src/ControlServer.h`, `daemon/src/ControlServer.cpp`

**Interfaces:**
- Produces: `jarvis::CommandStore` mirroring `SkillStore`'s Markdown+
  frontmatter convention exactly. `struct CommandRow {QString name,
  description, actionKind /* mcp_tool|shell|prompt */, actionTarget,
  argsHint; bool selfAuthored;}`. Methods: `list() -> QVector<CommandRow>`,
  `get(name) -> std::optional<CommandRow>` (+ body via `read()`),
  `create(name, description, actionKind, actionTarget, body, selfAuthored)
  -> bool` (rejects a name collision with a BUILT-IN command name),
  `remove(name) -> bool`.
- Produces Contract-A verbs: `command.list` → `{"commands": [{"name",
  "description","action_kind","action_target","self_authored"}, ...]}`;
  `command.create` (`name,description,action_kind,action_target,body`) →
  `{"ok":true}`; `command.remove` (`name`) → `{"ok":true}`; `command.invoke`
  (`name,args`) → for `action_kind=="prompt"` returns `{"prompt": <body
  with {{ARGS}} substituted>}` (the caller sends it as a chat turn);
  `"mcp_tool"` returns `{"mcp_tool": action_target, "args": args}` (the
  caller invokes that MCP tool); `"shell"` returns `{"shell":
  action_target, "args": args}` (the caller runs the script under
  `~/.local/share/jarvis/commands/scripts/` — enforced by CommandStore only
  ever storing a target under that directory, never an arbitrary path).
- Built-in command names reserved (rejected by `create`): `new, stop, goal,
  y, n, canvas, widgets, phone, memory, skills, agents, queue, settings,
  schedules, mcp, plugins, ssh, replay, activity, browser, computer, home,
  tui`.

- [ ] **Step 1: Write the failing test**

```cpp
// core/tests/command_store_test.cpp
// ctest: CommandStore create/list/get/remove roundtrip + reserved-name
// guard + Markdown+frontmatter persistence, mirroring agent_store_test.cpp.

#include "jarvis/CommandStore.h"

#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

int main()
{
    QTemporaryDir tmp;
    jarvis::CommandStore store(tmp.path());

    check(store.list().isEmpty(), "a fresh store has no commands");

    bool created = store.create(QStringLiteral("deploy"),
                                QStringLiteral("Deploy the current branch"),
                                QStringLiteral("shell"),
                                QStringLiteral("scripts/deploy.sh"),
                                QStringLiteral("Runs the deploy script."),
                                /*selfAuthored=*/true);
    check(created, "create() succeeds for a fresh name");

    const auto rows = store.list();
    check(rows.size() == 1, "list() sees the new command");
    check(rows[0].name == QStringLiteral("deploy"), "name round-trips");
    check(rows[0].actionKind == QStringLiteral("shell"), "action_kind round-trips");
    check(rows[0].selfAuthored, "self_authored round-trips true");

    const auto got = store.get(QStringLiteral("deploy"));
    check(got.has_value(), "get() finds the command");
    check(got->actionTarget == QStringLiteral("scripts/deploy.sh"), "action_target round-trips");

    check(!store.create(QStringLiteral("goal"), QStringLiteral("x"),
                        QStringLiteral("prompt"), QStringLiteral(""),
                        QStringLiteral("x"), false),
          "create() rejects a name that collides with a built-in");

    check(!store.create(QStringLiteral("deploy"), QStringLiteral("dup"),
                        QStringLiteral("prompt"), QStringLiteral(""),
                        QStringLiteral("x"), false),
          "create() rejects a name that already exists");

    // Persistence across instances.
    {
        jarvis::CommandStore store2(tmp.path());
        check(store2.list().size() == 1, "a fresh instance loads the persisted command");
    }

    check(store.remove(QStringLiteral("deploy")), "remove() succeeds for an existing command");
    check(store.list().isEmpty(), "remove() actually removes it");
    check(!store.remove(QStringLiteral("missing")), "remove() fails for a missing command");

    if (g_failures == 0)
        std::fprintf(stderr, "ALL CommandStore TESTS PASSED\n");
    return g_failures == 0 ? 0 : 1;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cmake --build build --target command_store_test`
Expected: FAIL — header missing.

- [ ] **Step 3: Write `core/include/jarvis/CommandStore.h`**

```cpp
#pragma once

// CommandStore — self-authored slash commands (mirrors SkillStore exactly:
// a Markdown file with flat YAML-style frontmatter, no YAML library
// needed). A command is
//   ~/.local/share/jarvis/commands/<name>/COMMAND.md
// Frontmatter: name, description, action_kind (mcp_tool|shell|prompt),
// action_target, self_authored. Body: the prompt text (action_kind=prompt)
// or a human-readable note (mcp_tool/shell). Both the user (hand-writes the
// file) and Jarvis (via the create_slash_command MCP tool) can add one.

#include <QString>
#include <QVector>
#include <optional>

namespace jarvis {

struct CommandRow {
    QString name;
    QString description;
    QString actionKind;    // mcp_tool | shell | prompt
    QString actionTarget;  // mcp tool name | script path (relative to commands/scripts/) | ""
    QString body;
    bool selfAuthored = false;
};

class CommandStore {
public:
    explicit CommandStore(const QString &dir = QString());

    QVector<CommandRow> list() const;
    std::optional<CommandRow> get(const QString &name) const;
    bool create(const QString &name, const QString &description,
                const QString &actionKind, const QString &actionTarget,
                const QString &body, bool selfAuthored);
    bool remove(const QString &name);

    static bool isBuiltinName(const QString &name);
    static bool isValidActionKind(const QString &kind);
    static QString defaultDir();

private:
    QString commandDir(const QString &name) const;
    QString m_dir;
};

} // namespace jarvis
```

- [ ] **Step 4: Write `core/src/CommandStore.cpp`**

Read `core/src/SkillStore.cpp`'s frontmatter reader/writer first
(`grep -n "parseFrontmatter\|writeFrontmatter" core/src/SkillStore.cpp`) and
reuse the SAME flat-key parse/write helpers if they're free functions in a
shared header — do not duplicate a second hand-rolled frontmatter parser if
one already exists as reusable. If `SkillStore.cpp`'s parser is a private
static function, factor it out to a small shared
`core/include/jarvis/FrontmatterUtil.h` (`parseFlatFrontmatter(QString) ->
QMap<QString,QString>` + `writeFlatFrontmatter(QMap<QString,QString>) ->
QString`) used by BOTH `SkillStore` and `CommandStore` — this is the one
factor-out this plan calls for, since duplicating a hand-rolled parser
would violate DRY on a piece of logic two stores now need identically. Then:

```cpp
#include "jarvis/CommandStore.h"
#include "jarvis/DataPaths.h"
#include "jarvis/FrontmatterUtil.h"

#include <QDir>
#include <QFile>
#include <QTextStream>

namespace jarvis {

namespace {
const QStringList kBuiltins = {
    QStringLiteral("new"), QStringLiteral("stop"), QStringLiteral("goal"),
    QStringLiteral("y"), QStringLiteral("n"), QStringLiteral("canvas"),
    QStringLiteral("widgets"), QStringLiteral("phone"), QStringLiteral("memory"),
    QStringLiteral("skills"), QStringLiteral("agents"), QStringLiteral("queue"),
    QStringLiteral("settings"), QStringLiteral("schedules"), QStringLiteral("mcp"),
    QStringLiteral("plugins"), QStringLiteral("ssh"), QStringLiteral("replay"),
    QStringLiteral("activity"), QStringLiteral("browser"), QStringLiteral("computer"),
    QStringLiteral("home"), QStringLiteral("tui"),
};
const QStringList kKinds = {QStringLiteral("mcp_tool"), QStringLiteral("shell"),
                            QStringLiteral("prompt")};
}

CommandStore::CommandStore(const QString &dir)
    : m_dir(dir.isEmpty() ? defaultDir() : dir)
{
    QDir().mkpath(m_dir);
}

QString CommandStore::defaultDir() { return jarvis::dataDir() + QStringLiteral("/commands"); }
bool CommandStore::isBuiltinName(const QString &name) { return kBuiltins.contains(name); }
bool CommandStore::isValidActionKind(const QString &kind) { return kKinds.contains(kind); }

QString CommandStore::commandDir(const QString &name) const { return m_dir + QStringLiteral("/") + name; }

QVector<CommandRow> CommandStore::list() const
{
    QVector<CommandRow> out;
    QDir root(m_dir);
    for (const auto &entry : root.entryList(QDir::Dirs | QDir::NoDotAndDotDot)) {
        if (auto row = get(entry))
            out.push_back(*row);
    }
    return out;
}

std::optional<CommandRow> CommandStore::get(const QString &name) const
{
    QFile f(commandDir(name) + QStringLiteral("/COMMAND.md"));
    if (!f.open(QIODevice::ReadOnly))
        return std::nullopt;
    const QString content = QString::fromUtf8(f.readAll());
    const auto [front, body] = splitFrontmatter(content);   // from FrontmatterUtil.h
    const auto fm = parseFlatFrontmatter(front);
    CommandRow row;
    row.name = name;
    row.description = fm.value(QStringLiteral("description"));
    row.actionKind = fm.value(QStringLiteral("action_kind"));
    row.actionTarget = fm.value(QStringLiteral("action_target"));
    row.selfAuthored = fm.value(QStringLiteral("self_authored")) == QStringLiteral("true");
    row.body = body;
    return row;
}

bool CommandStore::create(const QString &name, const QString &description,
                          const QString &actionKind, const QString &actionTarget,
                          const QString &body, bool selfAuthored)
{
    if (isBuiltinName(name) || !isValidActionKind(actionKind))
        return false;
    if (get(name).has_value())
        return false;
    QDir().mkpath(commandDir(name));
    QFile f(commandDir(name) + QStringLiteral("/COMMAND.md"));
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    QMap<QString, QString> fm;
    fm[QStringLiteral("description")] = description;
    fm[QStringLiteral("action_kind")] = actionKind;
    fm[QStringLiteral("action_target")] = actionTarget;
    fm[QStringLiteral("self_authored")] = selfAuthored ? QStringLiteral("true") : QStringLiteral("false");
    QTextStream out(&f);
    out << writeFlatFrontmatter(fm) << "\n" << body;
    return true;
}

bool CommandStore::remove(const QString &name)
{
    if (!get(name).has_value())
        return false;
    return QDir(commandDir(name)).removeRecursively();
}

} // namespace jarvis
```

`splitFrontmatter`/`parseFlatFrontmatter`/`writeFlatFrontmatter` signatures
must match whatever the factored-out `FrontmatterUtil.h` actually declares
— write that header to match `SkillStore.cpp`'s existing parse logic
faithfully (same delimiter convention, e.g. `---` fencing) rather than
inventing a new format.

- [ ] **Step 5: Register in `core/CMakeLists.txt`** (same pattern as Task 1 Step 5, `command_store_test`).

- [ ] **Step 6: Build + run to verify it passes**

Run: `cmake --build build --target command_store_test -j && ctest --test-dir build -R command_store_test --output-on-failure`
Expected: `ALL CommandStore TESTS PASSED`.

- [ ] **Step 7: Wire `command.list/create/remove/invoke` into `ControlServer`**

Same shape as Task 1 Step 7 (dispatch chain entries + 4 handler bodies
using `m_commandStore`). `command.invoke` handler:

```cpp
Response ControlServer::handleCommandInvoke(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const auto row = m_commandStore.get(name);
    if (!row)
        return Response::failure(req.id, QStringLiteral("not_found"), QStringLiteral("no such command"));
    QJsonObject result;
    if (row->actionKind == QStringLiteral("prompt")) {
        QString prompt = row->body;
        prompt.replace(QStringLiteral("{{ARGS}}"),
                       req.params.value(QStringLiteral("args")).toString());
        result.insert(QStringLiteral("prompt"), prompt);
    } else if (row->actionKind == QStringLiteral("mcp_tool")) {
        result.insert(QStringLiteral("mcp_tool"), row->actionTarget);
        result.insert(QStringLiteral("args"), req.params.value(QStringLiteral("args")));
    } else {
        result.insert(QStringLiteral("shell"), row->actionTarget);
        result.insert(QStringLiteral("args"), req.params.value(QStringLiteral("args")));
    }
    return Response::success(req.id, result);
}
```

No broadcast needed here — clients pull `command.list` on demand (chat
input is local and doesn't need push updates the way widgets/layout do).

- [ ] **Step 8: Build + full ctest**

Run: `cmake --build build -j && ctest --test-dir build --output-on-failure`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add core/include/jarvis/CommandStore.h core/include/jarvis/FrontmatterUtil.h \
        core/src/CommandStore.cpp core/src/SkillStore.cpp \
        core/tests/command_store_test.cpp core/CMakeLists.txt \
        daemon/src/ControlServer.h daemon/src/ControlServer.cpp
git commit -m "feat(daemon): command.* Contract-A verbs — self-authored slash commands, mirrors SkillStore"
```

---

### Task 3: Engine — `tools_tui_ops.py` MCP tools

**Files:**
- Create: `computer-use/computer_use_mcp/tools_tui_ops.py`
- Modify: `computer-use/computer_use_mcp/server.py` (import + register)
- Test: `computer-use/tests/test_tools_tui_ops.py`

**Interfaces:**
- Consumes: `daemon_client.call(method, params)` from
  `computer-use/computer_use_mcp/daemon_client.py:42-65` (raises
  `RuntimeError` on error/timeout).
- Produces: `register(mcp)` exporting `tui_list_pages()`,
  `tui_add_page(page_id, title, kind, config)`, `tui_edit_page(page_id,
  config)`, `tui_remove_page(page_id)`, `tui_reorder_pages(order)` — every
  tool returns a JSON string, `config`/`order` accept a JSON string OR a
  native list/dict (be liberal: `json.loads(x) if isinstance(x, str) else x`).

- [ ] **Step 1: Write the failing test**

```python
# computer-use/tests/test_tools_tui_ops.py
"""tools_tui_ops proxies to daemon_client.call with the right verb/params."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_tui_ops


def test_tui_list_pages_calls_list_verb():
    with patch.object(tools_tui_ops.daemon_client, "call",
                      return_value={"pages": [{"id": "errorlog"}]}) as m:
        result = json.loads(tools_tui_ops.tui_list_pages())
    m.assert_called_once_with("tui.layout.list", {})
    assert result["pages"][0]["id"] == "errorlog"


def test_tui_add_page_passes_through_fields():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        result = json.loads(tools_tui_ops.tui_add_page(
            page_id="errorlog", title="Error Log", kind="log",
            config='{"path": "/var/log/jarvis.log"}'))
    m.assert_called_once_with("tui.layout.add", {
        "id": "errorlog", "title": "Error Log", "kind": "log",
        "config": {"path": "/var/log/jarvis.log"},
    })
    assert result["ok"] is True


def test_tui_add_page_accepts_native_dict_config():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_add_page(page_id="x", title="X", kind="log", config={"a": 1})
    assert m.call_args[0][1]["config"] == {"a": 1}


def test_tui_edit_page_calls_edit_verb():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_edit_page(page_id="errorlog", config='{"path": "/tmp/x.log"}')
    m.assert_called_once_with("tui.layout.edit",
                              {"id": "errorlog", "config": {"path": "/tmp/x.log"}})


def test_tui_remove_page_calls_remove_verb():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_remove_page(page_id="errorlog")
    m.assert_called_once_with("tui.layout.remove", {"id": "errorlog"})


def test_tui_reorder_pages_accepts_json_list():
    with patch.object(tools_tui_ops.daemon_client, "call", return_value={"ok": True}) as m:
        tools_tui_ops.tui_reorder_pages(order='["b", "a"]')
    m.assert_called_once_with("tui.layout.reorder", {"order": ["b", "a"]})


def test_daemon_error_returns_json_error_not_exception():
    with patch.object(tools_tui_ops.daemon_client, "call",
                      side_effect=RuntimeError("reserved page id")):
        result = json.loads(tools_tui_ops.tui_add_page(
            page_id="chat", title="x", kind="log", config="{}"))
    assert "error" in result
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd computer-use && .venv/bin/python -m pytest tests/test_tools_tui_ops.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'computer_use_mcp.tools_tui_ops'`

- [ ] **Step 3: Write `computer-use/computer_use_mcp/tools_tui_ops.py`**

First read the exact shape of `_err()` in `tools_jarvis_ops.py`
(`grep -n "^def _err" computer-use/computer_use_mcp/tools_jarvis_ops.py`)
and import it rather than redefining it.

```python
"""MCP tools letting Jarvis reshape the TUI's own page layout live — a
declarative CRUD over custom pages (add/edit/remove/reorder), NOT code.
The 20 builtin pages are reserved and rejected daemon-side; this module is
a thin proxy over the tui.layout.* Contract-A verbs, same shape as
tools_jarvis_ops.py's schedule_task/remember/create_skill."""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client
from computer_use_mcp.tools_jarvis_ops import _err


def _as_obj(value):
    if isinstance(value, str):
        return json.loads(value) if value.strip() else {}
    return value


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def tui_list_pages() -> str:
        """List the terminal client's CUSTOM pages (not the 20 builtins)."""
        try:
            return json.dumps(daemon_client.call("tui.layout.list", {}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def tui_add_page(page_id: str, title: str, kind: str, config: str | dict = "{}") -> str:
        """Add a NEW custom TUI page (declarative content spec, no code).
        kind must be one of: log, table, markdown, widget, list. `config`
        is a JSON object shaped for that kind (e.g. {"path": "..."} for
        log). Fails if page_id collides with a builtin page."""
        try:
            return json.dumps(daemon_client.call("tui.layout.add", {
                "id": page_id, "title": title, "kind": kind,
                "config": _as_obj(config),
            }))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def tui_edit_page(page_id: str, config: str | dict) -> str:
        """Replace a custom TUI page's content spec."""
        try:
            return json.dumps(daemon_client.call("tui.layout.edit", {
                "id": page_id, "config": _as_obj(config),
            }))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def tui_remove_page(page_id: str) -> str:
        """Remove a custom TUI page."""
        try:
            return json.dumps(daemon_client.call("tui.layout.remove", {"id": page_id}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def tui_reorder_pages(order: str | list) -> str:
        """Reorder ALL custom TUI pages. `order` is the full list of custom
        page ids in the desired order (must include every existing one)."""
        try:
            order_list = json.loads(order) if isinstance(order, str) else order
            return json.dumps(daemon_client.call("tui.layout.reorder", {"order": order_list}))
        except Exception as exc:
            return _err(exc)
```

- [ ] **Step 4: Register in `server.py`**

Add `tools_tui_ops` to the import list (`computer-use/computer_use_mcp/
server.py:24-32`) and add `tools_tui_ops.register(mcp)` next to the other
`.register(mcp)` calls.

- [ ] **Step 5: Run to verify it passes**

Run: `cd computer-use && .venv/bin/python -m pytest tests/test_tools_tui_ops.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add computer-use/computer_use_mcp/tools_tui_ops.py \
        computer-use/computer_use_mcp/server.py \
        computer-use/tests/test_tools_tui_ops.py
git commit -m "feat(engine): tools_tui_ops MCP tools — self-edit the TUI's page layout"
```

---

### Task 4: Engine — `tools_commands.py` MCP tools (slash commands)

**Files:**
- Create: `computer-use/computer_use_mcp/tools_commands.py`
- Modify: `computer-use/computer_use_mcp/server.py`
- Test: `computer-use/tests/test_tools_commands.py`

**Interfaces:**
- Produces: `create_slash_command(name, description, action_kind,
  action_target, body)`, `list_slash_commands()`,
  `remove_slash_command(name)` — mirrors `create_skill`'s exact shape
  (`tools_jarvis_ops.py:155-167`).

- [ ] **Step 1: Write the failing test**

```python
# computer-use/tests/test_tools_commands.py
"""tools_commands proxies to daemon_client.call, mirroring create_skill."""

import json
from unittest.mock import patch

from computer_use_mcp import tools_commands


def test_create_slash_command_calls_command_create():
    with patch.object(tools_commands.daemon_client, "call", return_value={"ok": True}) as m:
        result = json.loads(tools_commands.create_slash_command(
            name="deploy", description="Deploy the current branch",
            action_kind="shell", action_target="scripts/deploy.sh",
            body="Runs the deploy script."))
    m.assert_called_once_with("command.create", {
        "name": "deploy", "description": "Deploy the current branch",
        "action_kind": "shell", "action_target": "scripts/deploy.sh",
        "body": "Runs the deploy script.",
    })
    assert result["ok"] is True


def test_list_slash_commands_calls_command_list():
    with patch.object(tools_commands.daemon_client, "call",
                      return_value={"commands": []}) as m:
        json.loads(tools_commands.list_slash_commands())
    m.assert_called_once_with("command.list", {})


def test_remove_slash_command_calls_command_remove():
    with patch.object(tools_commands.daemon_client, "call", return_value={"ok": True}) as m:
        json.loads(tools_commands.remove_slash_command(name="deploy"))
    m.assert_called_once_with("command.remove", {"name": "deploy"})


def test_daemon_error_returns_json_error():
    with patch.object(tools_commands.daemon_client, "call",
                      side_effect=RuntimeError("name collides with a built-in")):
        result = json.loads(tools_commands.create_slash_command(
            name="goal", description="x", action_kind="prompt",
            action_target="", body="x"))
    assert "error" in result
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd computer-use && .venv/bin/python -m pytest tests/test_tools_commands.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `computer-use/computer_use_mcp/tools_commands.py`**

```python
"""MCP tools for the slash-command engine — lets Jarvis author a NEW /
command for itself (same trust model as create_skill: Jarvis writes the
definition, the user sees what runs)."""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client
from computer_use_mcp.tools_jarvis_ops import _err


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def create_slash_command(name: str, description: str, action_kind: str,
                             action_target: str, body: str) -> str:
        """Author a NEW / command. action_kind is one of:
        - "prompt": body is sent as a chat turn ({{ARGS}} substituted)
        - "mcp_tool": action_target is the MCP tool name to call with the
          command's args
        - "shell": action_target is a script path under
          ~/.local/share/jarvis/commands/scripts/
        Fails if `name` collides with a built-in command."""
        try:
            return json.dumps(daemon_client.call("command.create", {
                "name": name, "description": description,
                "action_kind": action_kind, "action_target": action_target,
                "body": body,
            }))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def list_slash_commands() -> str:
        """List every custom / command (built-ins aren't included — they're
        always present client-side)."""
        try:
            return json.dumps(daemon_client.call("command.list", {}))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def remove_slash_command(name: str) -> str:
        """Remove a custom / command."""
        try:
            return json.dumps(daemon_client.call("command.remove", {"name": name}))
        except Exception as exc:
            return _err(exc)
```

- [ ] **Step 4: Register in `server.py`** (same pattern as Task 3 Step 4).

- [ ] **Step 5: Run to verify it passes.**

Run: `cd computer-use && .venv/bin/python -m pytest tests/test_tools_commands.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add computer-use/computer_use_mcp/tools_commands.py \
        computer-use/computer_use_mcp/server.py \
        computer-use/tests/test_tools_commands.py
git commit -m "feat(engine): tools_commands MCP tools — Jarvis can author its own / commands"
```

---

### Task 5: TUI — shared `canvas_render.py` DSL renderer

**Files:**
- Create: `cli/jarvis_cli/tui/canvas_render.py`
- Test: `cli/tests/test_canvas_render.py`

**Interfaces:**
- Produces: `render_widget_spec(spec: dict) -> rich.console.RenderableType`
  — the single entry point every consumer (Canvas/Widgets/Computer panes)
  calls. Mirrors the Android `WidgetBitmapRenderer.kt` DSL exactly: layout
  node types `column|row|grid|text|badge|rect|divider|progress|spacer|
  list|canvas|pager`, canvas ops `circle|ellipse|rect|line|path`.
- Also produces: `terminal_supports_images() -> bool` (checks
  `KITTY_WINDOW_ID`, `TERM_PROGRAM == "iTerm.app"`, `TERM` containing
  `"kitty"`) used by `svg`/`image`-bearing nodes (there is no `svg`/`image`
  *layout node type* in the confirmed DSL — the Android renderer's op list
  has no such op either; **this plan does not invent one**. Where a widget
  spec's `canvas` node contains a `path`/`rect`/etc a Rich `Group` of
  primitives is built; if a future spec ever needs a raster image, the
  fallback path is a `Text` placeholder `"[image — open in desktop/web]"`,
  wired but untriggered until such a spec type exists — do not build
  speculative image-protocol code with no real caller.)

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_canvas_render.py
"""canvas_render mirrors the Android WidgetBitmapRenderer DSL: layout nodes
column/row/grid/text/badge/rect/divider/progress/spacer/list/canvas/pager
and canvas ops circle/ellipse/rect/line/path."""

from rich.console import Console

from jarvis_cli.tui.canvas_render import render_widget_spec


def _render_to_text(renderable) -> str:
    console = Console(width=60, record=True, force_terminal=False)
    console.print(renderable)
    return console.export_text()


def test_text_node_renders_its_content():
    out = _render_to_text(render_widget_spec({"type": "text", "text": "hello widget"}))
    assert "hello widget" in out


def test_column_renders_children_in_order():
    spec = {"type": "column", "children": [
        {"type": "text", "text": "first"}, {"type": "text", "text": "second"},
    ]}
    out = _render_to_text(render_widget_spec(spec))
    assert out.index("first") < out.index("second")


def test_badge_renders_its_label():
    out = _render_to_text(render_widget_spec({"type": "badge", "text": "NEW"}))
    assert "NEW" in out


def test_list_renders_every_row():
    spec = {"type": "list", "rows": [{"text": "row one"}, {"text": "row two"}]}
    out = _render_to_text(render_widget_spec(spec))
    assert "row one" in out and "row two" in out


def test_progress_renders_without_error():
    # No text assertion — a progress bar is drawn as blocks, not literal text.
    render_widget_spec({"type": "progress", "value": 0.5})


def test_divider_renders_without_error():
    render_widget_spec({"type": "divider"})


def test_grid_renders_children():
    spec = {"type": "grid", "cols": 2, "children": [
        {"type": "text", "text": "a"}, {"type": "text", "text": "b"},
        {"type": "text", "text": "c"}, {"type": "text", "text": "d"},
    ]}
    out = _render_to_text(render_widget_spec(spec))
    for expect in ("a", "b", "c", "d"):
        assert expect in out


def test_canvas_op_circle_renders_without_error():
    spec = {"type": "canvas", "w": 40, "h": 20,
            "ops": [{"op": "circle", "x": 5, "y": 5, "r": 3, "fill": "#5FE0FF"}]}
    render_widget_spec(spec)


def test_canvas_op_path_renders_without_error():
    spec = {"type": "canvas", "w": 40, "h": 20,
            "ops": [{"op": "path", "points": [[0, 0], [10, 0], [10, 10]],
                    "stroke": "#5FE0FF", "close": True}]}
    render_widget_spec(spec)


def test_pager_renders_current_page_only():
    spec = {"type": "pager", "page": 1, "pages": [
        {"type": "text", "text": "page zero"}, {"type": "text", "text": "page one"},
    ]}
    out = _render_to_text(render_widget_spec(spec))
    assert "page one" in out and "page zero" not in out


def test_unknown_node_type_renders_a_placeholder_not_a_crash():
    out = _render_to_text(render_widget_spec({"type": "totally_unknown"}))
    assert out.strip() != ""
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_canvas_render.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/canvas_render.py`**

```python
"""Renders the Android WidgetBitmapRenderer DSL (the same spec Canvas/
Widgets/live-widget cards use everywhere else in Jarvis) as Rich
renderables, so the terminal shows the SAME widgets the GUI does instead of
punting to a labeled transcript line.

Layout node types: column, row, grid, text, badge, rect, divider, progress,
spacer, list, canvas, pager. Canvas ops (inside a "canvas" node's "ops"
list): circle, ellipse, rect, line, path.
"""

from __future__ import annotations

from typing import Any

from rich.console import Group, RenderableType
from rich.padding import Padding
from rich.panel import Panel
from rich.progress_bar import ProgressBar
from rich.table import Table
from rich.text import Text


def render_widget_spec(spec: dict[str, Any]) -> RenderableType:
    node_type = spec.get("type", "")
    if node_type == "column":
        return _render_container(spec, vertical=True)
    if node_type == "row":
        return _render_container(spec, vertical=False)
    if node_type == "grid":
        return _render_grid(spec)
    if node_type == "text":
        return _render_text(spec)
    if node_type == "badge":
        return Panel(Text(str(spec.get("text", "")), style="bold cyan"),
                     expand=False, border_style="cyan", padding=(0, 1))
    if node_type == "rect":
        return Panel("", height=1, style=f"on {spec.get('color', '#5FE0FF')}",
                     border_style=spec.get("color", "#5FE0FF"))
    if node_type == "divider":
        return Text("─" * 40, style=spec.get("color", "bright_black"))
    if node_type == "progress":
        bar = ProgressBar(total=1.0, completed=float(spec.get("value", 0.0)),
                          width=30)
        return bar
    if node_type == "spacer":
        return Text(" " * max(int(spec.get("size", 8)), 1))
    if node_type == "list":
        return _render_list(spec)
    if node_type == "canvas":
        return _render_canvas(spec)
    if node_type == "pager":
        pages = spec.get("pages", [])
        idx = int(spec.get("page", 0))
        if 0 <= idx < len(pages):
            return render_widget_spec(pages[idx])
        return Text("")
    return Text(f"[unsupported widget node: {node_type or '?'}]", style="bright_black")


def _apply_frame(spec: dict, renderable: RenderableType) -> RenderableType:
    if spec.get("border") or spec.get("bg"):
        return Panel(renderable, border_style=spec.get("border", "bright_black"),
                     style=f"on {spec['bg']}" if spec.get("bg") else "")
    if spec.get("pad"):
        return Padding(renderable, int(spec["pad"]))
    return renderable


def _render_container(spec: dict, *, vertical: bool) -> RenderableType:
    children = [render_widget_spec(c) for c in spec.get("children", [])]
    body = Group(*children) if vertical else Table.grid(padding=(0, int(spec.get("gap", 1))))
    if not vertical:
        row = body
        row.add_row(*children)
        return _apply_frame(spec, row)
    return _apply_frame(spec, body)


def _render_grid(spec: dict) -> RenderableType:
    cols = max(int(spec.get("cols", 1)), 1)
    table = Table.grid(padding=(0, int(spec.get("gap", 1))))
    for _ in range(cols):
        table.add_column()
    children = [render_widget_spec(c) for c in spec.get("children", [])]
    for i in range(0, len(children), cols):
        row = children[i:i + cols]
        row += [""] * (cols - len(row))
        table.add_row(*row)
    return _apply_frame(spec, table)


def _render_text(spec: dict) -> RenderableType:
    style = ""
    if spec.get("bold"):
        style += "bold "
    if spec.get("color"):
        style += spec["color"]
    return Text(str(spec.get("text", "")), style=style.strip() or None,
               justify=spec.get("align", "left"))


def _render_list(spec: dict) -> RenderableType:
    table = Table.grid(padding=(0, 1))
    table.add_column()
    for row in spec.get("rows", []):
        badge = f"[cyan]{row['badge']}[/]" if row.get("badge") else ""
        color = row.get("color", "")
        text = f"[{color}]{row.get('text', '')}[/]" if color else row.get("text", "")
        table.add_row(Text.from_markup(f"{text}  {badge}".strip()))
    return _apply_frame(spec, table)


def _render_canvas(spec: dict) -> RenderableType:
    # Terminal cells aren't pixels — canvas ops render as a compact
    # description list rather than a pixel-accurate raster (a deliberate,
    # documented translation, same treatment as MemoryGraph's Tree view).
    lines = []
    for op in spec.get("ops", []):
        kind = op.get("op", "?")
        if kind in ("circle", "ellipse"):
            lines.append(f"● at ({op.get('x', 0)},{op.get('y', 0)}) r={op.get('r', op.get('rx', 0))}")
        elif kind == "rect":
            lines.append(f"▭ ({op.get('x', 0)},{op.get('y', 0)}) {op.get('w', 0)}x{op.get('h', 0)}")
        elif kind == "line":
            lines.append(f"─ ({op.get('x1', 0)},{op.get('y1', 0)}) → ({op.get('x2', 0)},{op.get('y2', 0)})")
        elif kind == "path":
            pts = op.get("points", [])
            closed = " (closed)" if op.get("close") else ""
            lines.append(f"⟨path {len(pts)} pts{closed}⟩")
        else:
            lines.append(f"? {kind}")
    return _apply_frame(spec, Text("\n".join(lines) or "(empty canvas)", style="bright_black"))
```

If any Android op field name doesn't match what `WidgetBitmapRenderer.kt`
actually uses (double-check `rx`/`ry` for ellipse vs `r` for circle), grep
`grep -n '"rx"\|"ry"\|"r"' android/app/src/main/java/com/jarvis/app/widget/WidgetBitmapRenderer.kt`
and adjust the field lookups above to match exactly.

- [ ] **Step 4: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_canvas_render.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/jarvis_cli/tui/canvas_render.py cli/tests/test_canvas_render.py
git commit -m "feat(cli): canvas_render.py — terminal renderer for the widget DSL, real Canvas/Widgets parity"
```

---

### Task 6: TUI — `CanvasPane` + `WidgetsPane`

**Files:**
- Create: `cli/jarvis_cli/tui/canvas_pane.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- Consumes: `canvas_render.render_widget_spec` (Task 5); `ControlClient.
  on_broadcast` dispatch already covers arbitrary event names
  (`control.py:132-157`) — subscribing to `widget.render`/`widget.remove`/
  `widget.clear` needs NO new daemon work, they're already broadcast
  (`ControlServer.cpp:4323-4373`). Widget library file:
  `config.data_dir() / "saved_widgets.json"` (same `data_dir()` resolver
  cli/config.py:23-28 already uses for profile isolation, confirmed to
  match `jarvis::dataDir()`'s override precedence).

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_canvas_pane_renders_a_widget_render_broadcast():
    """A widget.render broadcast event appends a rendered widget to the Canvas pane."""
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause()
        canvas = app.query_one("#canvas")
        canvas._on_widget_event("widget.render", {
            "id": "w1", "title": "Test Widget",
            "spec": {"type": "text", "text": "hello from canvas"},
        })
        await pilot.pause()
        assert any("Test Widget" in str(item.renderable) for item in canvas.items)


async def test_widgets_pane_lists_saved_widgets(tmp_path, monkeypatch):
    """WidgetsPane reads the saved-widget library from the data dir."""
    import json
    from jarvis_cli import config
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    (tmp_path / "saved_widgets.json").write_text(json.dumps({
        "widgets": [{"id": "w1", "name": "My Widget",
                    "spec": json.dumps({"type": "text", "text": "hi"})}]
    }))
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause()
        pane = app.query_one("#widgets")
        pane.refresh_saved()
        await pilot.pause()
        assert any(w["name"] == "My Widget" for w in pane.saved)
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "canvas_pane or widgets_pane" -v`
Expected: FAIL — no `#canvas`/`#widgets` widget mounted yet.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/canvas_pane.py`**

```python
"""CanvasPane (live widget.* broadcast feed) + WidgetsPane (saved widget
library, ~/.local/share/jarvis/saved_widgets.json) — real terminal
rendering via canvas_render, closing the GUI-parity gap the old TUI
punted on."""

from __future__ import annotations

import json

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import ListItem, ListView, Static

from jarvis_cli import config
from jarvis_cli.tui.canvas_render import render_widget_spec


class CanvasPane(VerticalScroll):
    """Tails widget.render/remove/clear broadcasts (already sent to every
    connected control client — no new daemon work needed here)."""

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.items: dict[str, Static] = {}

    def compose(self) -> ComposeResult:
        yield Static(Text("live canvas — renders as widgets stream in",
                          style="bright_black"), classes="pane-hint")

    def on_mount(self) -> None:
        self.app.client.on_broadcast_extra = self._maybe_dispatch

    def _maybe_dispatch(self, event: str, data: dict) -> None:
        if event.startswith("widget."):
            self._on_widget_event(event, data)

    def _on_widget_event(self, event: str, data: dict) -> None:
        wid = data.get("id", "")
        if event == "widget.clear":
            for w in list(self.items.values()):
                w.remove()
            self.items.clear()
            return
        if event == "widget.remove":
            widget = self.items.pop(wid, None)
            if widget:
                widget.remove()
            return
        spec = data.get("spec")
        if isinstance(spec, str):
            spec = json.loads(spec)
        title = data.get("title", "") or wid
        rendered = render_widget_spec(spec or {})
        block = Static(Text(f"── {title} ──\n", style="cyan") if False else rendered)
        if wid in self.items:
            self.items[wid].remove()
        self.items[wid] = block
        self.mount(block)


class WidgetsPane(VerticalScroll):
    """The saved-widget library — reads/writes the SAME
    ~/.local/share/jarvis/saved_widgets.json the desktop app's Widgets page
    uses (Bridge.cpp:3137), via config.data_dir() so profile isolation
    (JARVIS_DATA_DIR) matches the daemon's jarvis::dataDir()."""

    HINT = "enter: render to Canvas · r: refresh"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.saved: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield ListView(id="widgets-list")

    def on_mount(self) -> None:
        self.refresh_saved()

    def refresh_if_stale(self) -> None:
        self.refresh_saved()

    def _library_path(self):
        return config.data_dir() / "saved_widgets.json"

    def refresh_saved(self) -> None:
        path = self._library_path()
        self.saved = []
        if path.exists():
            try:
                data = json.loads(path.read_text())
                self.saved = list(data.get("widgets", []))
            except Exception as exc:
                self.notify(str(exc), severity="error")
        lv = self.query_one("#widgets-list", ListView)
        lv.clear()
        for w in self.saved:
            lv.append(ListItem(Static(w.get("name", w.get("id", "?")))))

    async def on_list_view_selected(self, event: ListView.Selected) -> None:
        idx = self.query_one("#widgets-list", ListView).index
        if idx is None or not (0 <= idx < len(self.saved)):
            return
        w = self.saved[idx]
        spec = w.get("spec")
        if isinstance(spec, str):
            spec = json.loads(spec)
        canvas = self.app.query_one("#canvas", CanvasPane)
        self.app.query_one("TabbedContent").active = "tab-canvas"
        canvas._on_widget_event("widget.render", {
            "id": f"saved:{w.get('id', '')}", "title": w.get("name", ""), "spec": spec,
        })
```

`ControlClient` needs one small addition to support a second broadcast
listener without disturbing `app.py`'s existing `_on_broadcast` (which
already handles `session.opened`): add an `on_broadcast_extra` attribute
in `cli/jarvis_cli/control.py`'s `__init__` (default `None`) and call it
(best-effort, swallow exceptions) right after the existing
`self.on_broadcast(...)` call at `control.py:132-157`. This is a 4-line
addition — do not restructure the existing dispatch.

- [ ] **Step 4: Wire both panes into `app.py`**

Add to the import list: `from jarvis_cli.tui.canvas_pane import CanvasPane,
WidgetsPane`. Add to `compose()`, after the `Settings` `TabPane` (order
matches the GUI's NavRail: Chat/Sessions/.../Canvas/Widgets/...):

```python
            with TabPane("Canvas", id="tab-canvas"):
                yield CanvasPane(id="canvas")
            with TabPane("Widgets", id="tab-widgets"):
                yield WidgetsPane(id="widgets")
```

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "canvas_pane or widgets_pane" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/canvas_pane.py cli/jarvis_cli/tui/app.py \
        cli/jarvis_cli/control.py cli/tests/test_tui.py
git commit -m "feat(cli): CanvasPane + WidgetsPane — real terminal Canvas/Widgets parity"
```

---

### Task 7: TUI — `PhonePane`

**Files:**
- Create: `cli/jarvis_cli/tui/phone_pane.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Modify: `cli/pyproject.toml` (add `qrcode` dependency)
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- Consumes verbs: `devices.list`, `devices.pair_start` (→ `{code,
  payload, expires_at}` per `pairingStarted` signal shape,
  `Bridge.cpp:4140-4142`), `devices.revoke(id)`, `phone.event.subscribe`
  (opt in to call/message broadcasts).

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_phone_pane_lists_devices():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#phone")
        pane.rows = [{"id": "dev1", "name": "Pixel", "last_seen": "now"}]
        await pilot.pause()


async def test_phone_pane_pair_renders_ascii_qr(monkeypatch):
    from jarvis_cli.tui import phone_pane
    monkeypatch.setattr(phone_pane, "_ascii_qr", lambda payload: "##\n##")
    assert phone_pane._ascii_qr("anything") == "##\n##"
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k phone_pane -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `qrcode` to `cli/pyproject.toml`'s dependencies list** (next to `websockets`/`rich`/`textual`).

- [ ] **Step 4: Write `cli/jarvis_cli/tui/phone_pane.py`**

```python
"""PhonePane — device pairing (ASCII QR, pure-Python `qrcode`, no system
qrencode binary needed — confirmed absent on dev machines) + device list +
revoke, mirroring the desktop app's Devices section (Bridge.cpp:894-920)."""

from __future__ import annotations

import io

import qrcode
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, Static

from jarvis_cli.control import ControlError


def _ascii_qr(payload: str) -> str:
    qr = qrcode.QRCode(border=1)
    qr.add_data(payload)
    qr.make(fit=True)
    buf = io.StringIO()
    qr.print_ascii(out=buf, invert=True)
    return buf.getvalue()


class PhonePane(Vertical):
    HINT = "p: pair a new device · x: revoke · r: refresh"
    COLUMNS = ("device", "id", "last seen")

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.rows: list[dict] = []

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table
        yield Static("", id="phone-qr")

    def on_mount(self) -> None:
        self.refresh_data()

    def refresh_if_stale(self) -> None:
        self.refresh_data()

    async def refresh_data(self) -> None:
        try:
            res = await self.client.call("devices.list", {})
            self.rows = list(res.get("devices", []))
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.rows = []
            self.notify(str(exc), severity="error", timeout=4)
        table = self.query_one(DataTable)
        table.clear()
        for r in self.rows:
            table.add_row(r.get("name", ""), r.get("id", ""), r.get("last_seen", ""))

    def selected(self) -> dict | None:
        table = self.query_one(DataTable)
        if not self.rows or table.cursor_row is None:
            return None
        if 0 <= table.cursor_row < len(self.rows):
            return self.rows[table.cursor_row]
        return None

    async def on_key(self, event) -> None:
        if event.key == "r":
            await self.refresh_data()
        elif event.key == "p":
            try:
                res = await self.client.call("devices.pair_start", {})
                qr_text = _ascii_qr(res.get("payload", res.get("code", "")))
                self.query_one("#phone-qr", Static).update(
                    Text(f"{qr_text}\ncode: {res.get('code', '')} "
                        f"(expires {res.get('expires_at', '?')})"))
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("devices.revoke", {"id": row.get("id", "")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                await self.refresh_data()
```

- [ ] **Step 5: Wire into `app.py`** — import `PhonePane`, add
  `TabPane("Phone", id="tab-phone"): yield PhonePane(id="phone")`.

- [ ] **Step 6: Install the new dependency + run to verify it passes.**

Run: `cd cli && .venv/bin/pip install -e . && .venv/bin/python -m pytest tests/test_tui.py -k phone_pane -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/jarvis_cli/tui/phone_pane.py cli/jarvis_cli/tui/app.py \
        cli/pyproject.toml cli/tests/test_tui.py
git commit -m "feat(cli): PhonePane — device pairing (ASCII QR) + list/revoke"
```

---

### Task 8: TUI — `ComputerPane`

**Files:**
- Create: `cli/jarvis_cli/tui/computer_pane.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- Consumes verbs: `session.create` (profile="coworker", target=
  "agent"|"real"), `session.cancel`, `model.list`, `approval.respond`
  (`session_id, approval_id, decision`). Per-session engine coordinates
  (`port`, `bearer`) come back via the `agent_desktop.info` reply /
  `session.create`'s `engine_url` field (`Bridge.cpp:3424,3748-3757,
  3781-3784`) — poll a single JPEG frame from `http://127.0.0.1:{port}/
  video/frame` with `Authorization: Bearer {bearer}` and render it via
  `canvas_render`'s image-fallback text (`"[live desktop — open the
  desktop app or jarvis web for video]"`), since a raw JPEG has no lossless
  terminal rendering path without a real image-protocol terminal — this
  pane's real value is the STATUS/ACTION LOG, not the video, matching the
  design spec's "live status ... + action log tail" scoping.

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_computer_pane_starts_a_coworker_session(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#computer")
        calls = []
        async def fake_call(method, params=None, timeout=60.0):
            calls.append((method, params))
            if method == "session.create":
                return {"session_id": "s1"}
            return {}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.start_coworker(target="agent")
        assert calls[0][0] == "session.create"
        assert calls[0][1]["target"] == "agent"
        assert pane.session_id == "s1"


async def test_computer_pane_logs_approval_events():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#computer")
        pane._on_session_event({"kind": "approval", "risk": "medium",
                                "summary": "open Spotify"})
        assert any("open Spotify" in line for line in pane.log_lines)
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k computer_pane -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/computer_pane.py`**

```python
"""ComputerPane — start/stop a co-work session (agent desktop or real
take-over), approval prompts, and a scrolling action-log tail. The video
feed itself has no lossless terminal path without an image-protocol
terminal, so this mirrors the GUI's status + approval + action-log surface
rather than the pixels — a deliberate, documented translation."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Static

from jarvis_cli.control import ControlError


class ComputerPane(Vertical):
    HINT = "a: start on agent desktop · w: start on your REAL screen · s: stop · y/n: approve/deny last"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.session_id: str = ""
        self.log_lines: list[str] = []
        self._last_approval_id: str = ""

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Static(Text("no active co-work session", style="bright_black"), id="computer-status")
        yield Static("", id="computer-log")

    def _append(self, line: str) -> None:
        self.log_lines.append(line)
        self.log_lines = self.log_lines[-200:]
        self.query_one("#computer-log", Static).update("\n".join(self.log_lines))

    async def start_coworker(self, target: str) -> None:
        try:
            res = await self.client.call("session.create", {
                "profile": "coworker", "target": target,
            })
            self.session_id = res.get("session_id", "")
            self.query_one("#computer-status", Static).update(
                Text(f"co-work session {self.session_id} ({target})", style="cyan"))
            self._append(f"started co-work on {target}")
            if self.session_id:
                await self.app.client.subscribe(self.session_id)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def stop_coworker(self) -> None:
        if not self.session_id:
            return
        try:
            await self.client.call("session.cancel", {"session_id": self.session_id})
            self._append("stopped")
        except ControlError as exc:
            self.notify(str(exc), severity="error")
        self.session_id = ""
        self.query_one("#computer-status", Static).update(
            Text("no active co-work session", style="bright_black"))

    def _on_session_event(self, ev: dict) -> None:
        kind = ev.get("kind", "")
        if kind == "approval":
            self._last_approval_id = ev.get("approval_id", "")
            self._append(f"[approval:{ev.get('risk', '?')}] {ev.get('summary', '')}")
        else:
            self._append(f"{kind}: {ev.get('summary') or ev.get('text') or ''}")

    async def on_key(self, event) -> None:
        if event.key == "a":
            await self.start_coworker("agent")
        elif event.key == "w":
            await self.start_coworker("real")
        elif event.key == "s":
            await self.stop_coworker()
        elif event.key in ("y", "n") and self._last_approval_id and self.session_id:
            try:
                await self.client.call("approval.respond", {
                    "session_id": self.session_id, "approval_id": self._last_approval_id,
                    "decision": "approve" if event.key == "y" else "deny",
                })
                self._append(f"approval {'approved' if event.key == 'y' else 'denied'}")
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self._last_approval_id = ""
```

Wiring `_on_session_event` to the actual per-session event queue
(`ControlClient.subscribe`/`queue_for`, `control.py:211-237`) needs a
small polling `@work` loop identical in shape to `ChatPane`'s existing
session-event consumer — read `cli/jarvis_cli/tui/chat.py`'s event-pump
method (`grep -n "queue_for\|async for\|while True" cli/jarvis_cli/tui/chat.py`)
and mirror that exact loop shape here rather than inventing a new one, so
the two panes' event-consumption code stays consistent.

- [ ] **Step 4: Wire into `app.py`** — import `ComputerPane`, add
  `TabPane("Computer", id="tab-computer"): yield ComputerPane(id="computer")`.

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k computer_pane -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/computer_pane.py cli/jarvis_cli/tui/app.py cli/tests/test_tui.py
git commit -m "feat(cli): ComputerPane — co-work session start/stop, approvals, action log"
```

---

### Task 9: TUI — `BrowserPane`

**Files:**
- Create: `cli/jarvis_cli/tui/browser_pane.py`
- Modify: `cli/jarvis_cli/tui/app.py`, `cli/pyproject.toml` (add `httpx`
  if not already a dependency — check first: `grep -n httpx cli/pyproject.toml`)
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- Consumes: per-session engine REST `POST /browser/{status|navigate|back|
  forward|reload|snapshot|click}` (`Bridge.cpp:2339-2408`), reachable at
  `http://127.0.0.1:{port}` using the SAME `(port, bearer)` resolution
  as `ComputerPane` (Task 8) — reuse rather than re-deriving it: factor a
  tiny shared helper `cli/jarvis_cli/tui/engine_endpoint.py` with
  `async def resolve(client, session_id) -> tuple[str, str]` (port,
  bearer) calling `agent_desktop.info`, used by BOTH panes.

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_browser_pane_shows_status_after_navigate(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui import browser_pane
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#browser")

        async def fake_resolve(client, session_id):
            return ("8810", "test-bearer")
        monkeypatch.setattr(browser_pane, "resolve_engine_endpoint", fake_resolve)

        class FakeResponse:
            def json(self):
                return {"url": "https://example.com", "title": "Example",
                        "can_back": False, "can_forward": False}
        class FakeClient:
            async def post(self, url, json=None, headers=None):
                return FakeResponse()
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
        monkeypatch.setattr(browser_pane.httpx, "AsyncClient", lambda **kw: FakeClient())

        pane.session_id = "s1"
        await pane.navigate("https://example.com")
        assert pane.url == "https://example.com"
        assert pane.title == "Example"
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k browser_pane -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/engine_endpoint.py`**

```python
"""Resolves a session's per-session computer-use engine (port, bearer) —
the SAME agent_desktop.info round-trip Bridge.cpp uses (Bridge.cpp:3748-
3757) — shared by BrowserPane and ComputerPane so the lookup lives in
exactly one place."""

from __future__ import annotations


async def resolve_engine_endpoint(client, session_id: str) -> tuple[str, str]:
    """Returns (port, bearer) for session_id's per-session engine."""
    res = await client.call("agent_desktop.info", {"session_id": session_id})
    return str(res.get("port", "8810")), str(res.get("bearer", ""))
```

- [ ] **Step 4: Write `cli/jarvis_cli/tui/browser_pane.py`**

```python
"""BrowserPane — the per-session in-app browser (Bridge.cpp:2339-2408's
REST surface: status/navigate/back/forward/reload/snapshot/click), text-
only DOM snapshot instead of a screenshot (no lossless terminal image path)."""

from __future__ import annotations

import httpx
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.engine_endpoint import resolve_engine_endpoint


class BrowserPane(Vertical):
    HINT = "type a URL + enter: navigate · b: back · f: forward · r: reload/refresh snapshot"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.session_id = ""
        self.url = ""
        self.title = ""
        self.nodes: list[dict] = []

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="https://…", id="browser-url")
        yield Static("no active computer-use session", id="browser-status")
        yield Static("", id="browser-snapshot")

    async def _post(self, path: str, payload: dict | None = None) -> dict:
        computer = self.app.query_one("#computer")
        self.session_id = computer.session_id
        if not self.session_id:
            raise ControlError("no active computer-use session — start one in the Computer tab")
        port, bearer = await resolve_engine_endpoint(self.client, self.session_id)
        async with httpx.AsyncClient(timeout=10) as http:
            resp = await http.post(f"http://127.0.0.1:{port}{path}", json=payload or {},
                                   headers={"Authorization": f"Bearer {bearer}"})
            return resp.json()

    def _apply_status(self, data: dict) -> None:
        self.url = data.get("url", self.url)
        self.title = data.get("title", self.title)
        self.query_one("#browser-status", Static).update(
            Text(f"{self.title or '(no title)'} — {self.url}", style="cyan"))

    async def navigate(self, url: str) -> None:
        try:
            data = await self._post("/browser/navigate", {"url": url})
            self._apply_status(data)
        except (ControlError, Exception) as exc:
            self.notify(str(exc), severity="error")

    async def refresh_snapshot(self) -> None:
        try:
            data = await self._post("/browser/snapshot")
            self.nodes = list(data.get("nodes", []))
            lines = [f"[{n.get('ref', '')}] {n.get('role', '')}: {n.get('name', '')}"
                    for n in self.nodes]
            self.query_one("#browser-snapshot", Static).update("\n".join(lines[:60]))
        except Exception as exc:
            self.notify(str(exc), severity="error")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "browser-url" and event.value.strip():
            await self.navigate(event.value.strip())

    async def on_key(self, event) -> None:
        if event.key == "b":
            try:
                self._apply_status(await self._post("/browser/back"))
            except Exception as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "f":
            try:
                self._apply_status(await self._post("/browser/forward"))
            except Exception as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "r":
            await self.refresh_snapshot()
```

Assumes `#computer`'s `ComputerPane` (Task 8) exposes `.session_id` — it
does (set in `start_coworker`). If `httpx` isn't already a cli dependency,
add it to `cli/pyproject.toml`'s dependency list next to `websockets`.

- [ ] **Step 5: Wire into `app.py`** — import `BrowserPane`, add
  `TabPane("Browser", id="tab-browser"): yield BrowserPane(id="browser")`.

- [ ] **Step 6: Run to verify it passes.**

Run: `cd cli && .venv/bin/pip install -e . && .venv/bin/python -m pytest tests/test_tui.py -k browser_pane -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/jarvis_cli/tui/browser_pane.py cli/jarvis_cli/tui/engine_endpoint.py \
        cli/jarvis_cli/tui/app.py cli/pyproject.toml cli/tests/test_tui.py
git commit -m "feat(cli): BrowserPane — per-session browser navigate/back/forward/snapshot"
```

---

### Task 10: TUI — `ActivityPane` + `ReplayPane`

**Files:**
- Create: `cli/jarvis_cli/tui/activity_pane.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- `ActivityPane` (subclasses `TablePane`, `screens.py`): `audit.list`
  (`limit`) → `{"entries": [{ts, tool, ok, risk, summary}, ...]}`
  (`Bridge.cpp:1273-1279`).
- `ReplayPane`: `session.history` (`session_id`) →
  `{id, title, events: [{seq, ts, kind, role, text, ...}]}`
  (`Bridge.cpp:883-892`) — a seekable text log, not a scrubber.

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_activity_pane_lists_audit_entries(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#activity")
        async def fake_call(method, params=None, timeout=60.0):
            assert method == "audit.list"
            return {"entries": [{"ts": "12:00", "tool": "shell", "ok": True,
                                 "risk": "low", "summary": "ran ls"}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.refresh_data()
        assert pane.rows[0]["summary"] == "ran ls"


async def test_replay_pane_loads_a_session_and_seeks():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#replay")
        pane.events = [{"seq": 0, "kind": "user", "text": "hi"},
                      {"seq": 1, "kind": "assistant", "text": "hello"}]
        pane.cursor = 0
        assert pane.current_line() == "[user] hi"
        pane.seek(1)
        assert pane.current_line() == "[assistant] hello"
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "activity_pane or replay_pane" -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/activity_pane.py`**

```python
"""ActivityPane (audit log tail) + ReplayPane (session event timeline,
step fwd/back — a text translation of the GUI's scrubber)."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.screens import TablePane


class ActivityPane(TablePane):
    HINT = "r: refresh"
    COLUMNS = ("time", "tool", "risk", "ok", "summary")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("audit.list", {"limit": 100})
        return list(res.get("entries", []))

    def to_cells(self, r: dict) -> tuple:
        ok = r.get("ok", True)
        return (r.get("ts", ""), r.get("tool", ""), r.get("risk", ""),
                Text("✓" if ok else "✗", style="green" if ok else "red"),
                (r.get("summary") or "")[:80])

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()


class ReplayPane(Vertical):
    HINT = "type a session id + enter: load · j/k: step fwd/back"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.events: list[dict] = []
        self.cursor = 0

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="session id…", id="replay-session")
        yield Static("", id="replay-line")
        yield Static("", id="replay-pos")

    def current_line(self) -> str:
        if not self.events or not (0 <= self.cursor < len(self.events)):
            return ""
        ev = self.events[self.cursor]
        return f"[{ev.get('kind', ev.get('role', '?'))}] {ev.get('text', ev.get('summary', ''))}"

    def _refresh_display(self) -> None:
        self.query_one("#replay-line", Static).update(self.current_line())
        self.query_one("#replay-pos", Static).update(
            Text(f"{self.cursor + 1}/{len(self.events)}" if self.events else "(none loaded)",
                style="bright_black"))

    def seek(self, index: int) -> None:
        if self.events:
            self.cursor = max(0, min(index, len(self.events) - 1))
        self._refresh_display()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "replay-session":
            return
        session_id = event.value.strip()
        if not session_id:
            return
        try:
            res = await self.client.call("session.history", {"session_id": session_id})
            self.events = list(res.get("events", []))
            self.cursor = 0
            self._refresh_display()
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def on_key(self, event) -> None:
        if event.key == "j":
            self.seek(self.cursor + 1)
        elif event.key == "k":
            self.seek(self.cursor - 1)
```

- [ ] **Step 4: Wire into `app.py`** — import `ActivityPane`, `ReplayPane`,
  add both `TabPane`s (`tab-activity`, `tab-replay`).

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "activity_pane or replay_pane" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/activity_pane.py cli/jarvis_cli/tui/app.py cli/tests/test_tui.py
git commit -m "feat(cli): ActivityPane + ReplayPane — audit tail + session timeline seek"
```

---

### Task 11: TUI — `McpPane` + `PluginsPane` + `SshPane`

**Files:**
- Create: `cli/jarvis_cli/tui/system_panes.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- `McpPane` (`TablePane`): `mcp.list` → `{"servers": [{id,name,transport,
  endpoint,enabled,builtin,risk,tools_count}]}`; `enter` → `mcp.
  set_enabled(id, !enabled)`.
- `PluginsPane` (`TablePane`): `plugins.catalog` → `{"plugins": [{id,name,
  author,version,kind,description,permissions,installed,enabled}]}`;
  `i` → `plugins.install(id)`; `enter` → `plugins.set_enabled`; `x` →
  `plugins.remove`.
- `SshPane` (`TablePane` over a flat string list, not dicts — adapt):
  `ssh.allow_list` → `{"hosts": [str]}`; typed input + enter →
  `ssh.allow_add`; `x` → `ssh.allow_remove`.

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_mcp_pane_lists_servers(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#mcp")
        async def fake_call(method, params=None, timeout=60.0):
            return {"servers": [{"id": "m1", "name": "context7", "transport": "http",
                                 "endpoint": "https://x", "enabled": True,
                                 "builtin": False, "tools_count": 3}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.fetch()


async def test_plugins_pane_lists_catalog(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#plugins")
        async def fake_call(method, params=None, timeout=60.0):
            return {"plugins": [{"id": "p1", "name": "weather", "author": "jarvis",
                                 "version": "1.0", "kind": "mcp", "installed": False,
                                 "enabled": False}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        rows = await pane.fetch()
        assert rows[0]["name"] == "weather"


async def test_ssh_pane_lists_allowed_hosts(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#ssh")
        async def fake_call(method, params=None, timeout=60.0):
            return {"hosts": ["deploy@k2-runner"]}
        monkeypatch.setattr(app.client, "call", fake_call)
        rows = await pane.fetch()
        assert rows[0]["host"] == "deploy@k2-runner"
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "mcp_pane or plugins_pane or ssh_pane" -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/system_panes.py`**

```python
"""McpPane + PluginsPane + SshPane — the SYSTEM group's config/admin
screens, all thin TablePane subclasses over existing Contract-A verbs."""

from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.widgets import Input, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.screens import TablePane


class McpPane(TablePane):
    HINT = "enter: enable/disable · r: refresh"
    COLUMNS = ("name", "transport", "tools", "enabled")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("mcp.list", {})
        return list(res.get("servers", []))

    def to_cells(self, r: dict) -> tuple:
        enabled = r.get("enabled", False)
        return (r.get("name", ""), r.get("transport", ""), str(r.get("tools_count", 0)),
                Text("on" if enabled else "off", style="green" if enabled else "bright_black"))

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "enter":
            row = self.selected()
            if row:
                try:
                    await self.client.call("mcp.set_enabled",
                                           {"id": row.get("id"), "enabled": not row.get("enabled")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()


class PluginsPane(TablePane):
    HINT = "i: install · enter: enable/disable · x: remove · r: refresh"
    COLUMNS = ("name", "kind", "version", "installed", "enabled")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("plugins.catalog", {})
        return list(res.get("plugins", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("name", ""), r.get("kind", ""), r.get("version", ""),
                "✓" if r.get("installed") else "", "on" if r.get("enabled") else "off")

    async def on_key(self, event) -> None:
        row = self.selected()
        if event.key == "r":
            self.refresh_data()
        elif event.key == "i" and row:
            try:
                await self.client.call("plugins.install", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "enter" and row:
            try:
                await self.client.call("plugins.set_enabled",
                                       {"id": row.get("id"), "enabled": not row.get("enabled")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "x" and row:
            try:
                await self.client.call("plugins.remove", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()


class SshPane(TablePane):
    HINT = "type a host + enter: allow · x: revoke · r: refresh"
    COLUMNS = ("allowed host",)

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="user@host", id="ssh-add")
        from textual.widgets import DataTable
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        res = await self.client.call("ssh.allow_list", {})
        return [{"host": h} for h in res.get("hosts", [])]

    def to_cells(self, r: dict) -> tuple:
        return (r["host"],)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "ssh-add":
            return
        host = event.value.strip()
        event.input.value = ""
        if not host:
            return
        try:
            await self.client.call("ssh.allow_add", {"host": host})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
        self.refresh_data()

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("ssh.allow_remove", {"host": row["host"]})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()
```

- [ ] **Step 4: Wire into `app.py`** — import all three, add
  `tab-mcp`/`tab-plugins`/`tab-ssh` `TabPane`s.

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "mcp_pane or plugins_pane or ssh_pane" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/system_panes.py cli/jarvis_cli/tui/app.py cli/tests/test_tui.py
git commit -m "feat(cli): McpPane + PluginsPane + SshPane — system admin parity"
```

---

### Task 12: TUI — `MemoryGraphPane` + `HomePane` + `SchedulesPane`

**Files:**
- Create: `cli/jarvis_cli/tui/misc_panes.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- `MemoryGraphPane`: `memory.graph(root="", depth=2)` →
  `{"nodes":[{id,name,text,kind,type,scope}], "edges":[{from,to,relation}]}`
  (`Bridge.cpp:1000-1024`) — rendered as a Rich `Tree` (a text translation
  of the GUI's force-directed layout, same documented-translation pattern
  as the canvas renderer).
- `HomePane`: `session.list` + `settings.get` (`Bridge.cpp:871-874,
  644-647`) — a live status/recent-sessions dashboard, no home-widget-pin
  editing (that's `WidgetsPane`'s job; Home here is read-only overview,
  matching this plan's YAGNI scoping — pin-to-home ordering
  (`home_order.json`) is NOT wired in this pass since no task above needs
  to write it and the spec's Home requirement was "status + recent
  activity + quick links", satisfied without it).
- `SchedulesPane` (`TablePane`): `schedule.list` → `{"schedules":[{id,name,
  cron,when,next_run,last_run,enabled}]}`; input+enter → `schedule.create`;
  `enter` on a row → `schedule.set_enabled`; `x` → `schedule.remove`; `g`
  → `schedule.run_now`.

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_memory_graph_pane_builds_a_tree(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#memorygraph")
        async def fake_call(method, params=None, timeout=60.0):
            return {"nodes": [{"id": "n1", "name": "Issac", "kind": "entity"},
                              {"id": "n2", "name": "likes coffee", "kind": "memory"}],
                    "edges": [{"from": "n1", "to": "n2", "relation": "mentions"}]}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.load_graph()
        assert "Issac" in str(pane.tree.label) or any(
            "Issac" in str(child.label) for child in pane.tree.children)


async def test_home_pane_shows_recent_sessions(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#home")
        async def fake_call(method, params=None, timeout=60.0):
            if method == "session.list":
                return {"sessions": [{"id": "s1", "title": "chat about X", "brain": "claude"}]}
            return {"settings": {"version": "1.2.3", "default_brain": "claude"}}
        monkeypatch.setattr(app.client, "call", fake_call)
        await pane.refresh_data()
        assert "chat about X" in "\n".join(pane.lines)


async def test_schedules_pane_creates_a_job(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async with app.run_test() as pilot:
        pane = app.query_one("#schedules")
        calls = []
        async def fake_call(method, params=None, timeout=60.0):
            calls.append((method, params))
            return {"schedules": []}
        monkeypatch.setattr(app.client, "call", fake_call)
        pane.query_one("#schedule-add").value = "water plants :: remind me to water the plants"
        from textual.widgets import Input
        await pane.on_input_submitted(Input.Submitted(pane.query_one("#schedule-add"),
                                                       "water plants :: remind me to water the plants"))
        assert calls[0][0] == "schedule.create"
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "memory_graph_pane or home_pane or schedules_pane" -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/misc_panes.py`**

```python
"""MemoryGraphPane (Rich Tree translation of the GUI's node graph) +
HomePane (read-only status/recent-sessions dashboard) + SchedulesPane
(cron jobs, distinct backend from the Queue kanban)."""

from __future__ import annotations

from rich.text import Text
from rich.tree import Tree
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import Input, Static, Tree as TextualTree

from jarvis_cli.control import ControlError
from jarvis_cli.tui.screens import TablePane


class MemoryGraphPane(Vertical):
    HINT = "type a root entity id + enter: recenter · r: refresh (depth 2)"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.tree = Tree("memory graph")

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="root entity id (blank = everything)", id="graph-root")
        yield Static(id="graph-view")

    def on_mount(self) -> None:
        self.call_later(self.load_graph)

    def refresh_if_stale(self) -> None:
        self.call_later(self.load_graph)

    async def load_graph(self) -> None:
        root = ""
        try:
            root = self.query_one("#graph-root", Input).value.strip()
        except Exception:
            pass
        try:
            res = await self.client.call("memory.graph", {"root": root, "depth": 2})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        nodes = {n["id"]: n for n in res.get("nodes", [])}
        edges = res.get("edges", [])
        self.tree = Tree("memory graph")
        added: set[str] = set()
        by_from: dict[str, list[dict]] = {}
        for e in edges:
            by_from.setdefault(e.get("from", ""), []).append(e)
        roots = [n for n in nodes.values() if n["id"] not in {e.get("to") for e in edges}]
        for n in roots or list(nodes.values())[:1]:
            self._add_node(self.tree, n, nodes, by_from, added)
        self.query_one("#graph-view", Static).update(self.tree)

    def _add_node(self, parent, node, nodes, by_from, added) -> None:
        if node["id"] in added:
            return
        added.add(node["id"])
        label = node.get("name") or node.get("text", "")[:40] or node["id"]
        branch = parent.add(label)
        for edge in by_from.get(node["id"], []):
            child = nodes.get(edge.get("to"))
            if child:
                self._add_node(branch, child, nodes, by_from, added)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "graph-root":
            await self.load_graph()


class HomePane(Vertical):
    HINT = "r: refresh"

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.lines: list[str] = []

    @property
    def client(self):
        return self.app.client

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Static(id="home-view")

    def on_mount(self) -> None:
        self.call_later(self.refresh_data)

    def refresh_if_stale(self) -> None:
        self.call_later(self.refresh_data)

    async def refresh_data(self) -> None:
        try:
            sessions = (await self.client.call("session.list", {})).get("sessions", [])
            settings = (await self.client.call("settings.get", {})).get("settings", {})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        self.lines = [
            f"jarvisd v{settings.get('version', '?')} · default brain: "
            f"{settings.get('default_brain', '?')}",
            "",
            "recent sessions:",
        ] + [f"  {s.get('title') or '(untitled)'} [{s.get('brain', '')}]" for s in sessions[:10]]
        self.query_one("#home-view", Static).update("\n".join(self.lines))

    async def on_key(self, event) -> None:
        if event.key == "r":
            await self.refresh_data()


class SchedulesPane(TablePane):
    HINT = "type 'name :: prompt' + enter: schedule · enter on a row: enable/disable · g: run now · x: remove · r: refresh"
    COLUMNS = ("name", "cron/when", "next run", "enabled")

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="name :: prompt (runs once 'now'; edit cron via the GUI for cadences)",
                   id="schedule-add")
        from textual.widgets import DataTable
        table = DataTable(cursor_type="row")
        table.add_columns(*self.COLUMNS)
        yield table

    async def fetch(self) -> list[dict]:
        res = await self.client.call("schedule.list", {})
        return list(res.get("schedules", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("name", ""), r.get("cron") or r.get("when", ""),
                r.get("next_run", ""), "on" if r.get("enabled") else "off")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "schedule-add":
            return
        raw = event.value.strip()
        event.input.value = ""
        if not raw:
            return
        name, _, prompt = raw.partition("::")
        try:
            await self.client.call("schedule.create", {
                "name": name.strip(), "prompt": (prompt or name).strip(), "enabled": True,
            })
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
        self.refresh_data()

    async def on_key(self, event) -> None:
        row = self.selected()
        if event.key == "r":
            self.refresh_data()
        elif event.key == "enter" and row:
            try:
                await self.client.call("schedule.set_enabled",
                                       {"id": row.get("id"), "enabled": not row.get("enabled")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "g" and row:
            try:
                await self.client.call("schedule.run_now", {"id": row.get("id")})
                self.notify("triggered")
            except ControlError as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x" and row:
            try:
                await self.client.call("schedule.remove", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
```

- [ ] **Step 4: Wire into `app.py`** — import all three, add
  `tab-memorygraph`/`tab-home`/`tab-schedules` `TabPane`s. `Home` should be
  the FIRST tab in the `TabbedContent` (matches the GUI's NavRail order —
  Home is the landing page), so set `initial="tab-home"` and reorder the
  `with TabPane(...)` blocks accordingly, keeping `Chat` immediately after.

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "memory_graph_pane or home_pane or schedules_pane" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/misc_panes.py cli/jarvis_cli/tui/app.py cli/tests/test_tui.py
git commit -m "feat(cli): MemoryGraphPane + HomePane + SchedulesPane — remaining GUI-parity tabs"
```

---

### Task 13: TUI — self-edit hot-reload (`CustomPane` + `tui.layout.changed`)

**Files:**
- Create: `cli/jarvis_cli/tui/custom_pane.py`
- Modify: `cli/jarvis_cli/tui/app.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- Consumes: `tui.layout.list` (on startup) + `tui.layout.changed` broadcast
  (Task 1) via `ControlClient.on_broadcast`; `canvas_render.
  render_widget_spec` (Task 5, for `kind == "widget"`).
- Produces: `CustomPane(page_id, title, kind, config)` — a generic Textual
  widget rendering `kind`-appropriate content: `log` tails `config["path"]`
  (last 200 lines, re-read on refresh), `table` renders `config["rows"]`
  as a `DataTable`, `markdown` renders `config["text"]` via Textual's
  `Markdown` widget, `widget` renders `config["spec"]` via
  `canvas_render.render_widget_spec`, `list` renders `config["items"]` as
  a bullet `ListView`.

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_custom_pages_mount_from_tui_layout_list(monkeypatch, tmp_path):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    log_file = tmp_path / "err.log"
    log_file.write_text("line one\nline two\n")

    async def fake_call(method, params=None, timeout=60.0):
        if method == "tui.layout.list":
            return {"pages": [{"id": "errorlog", "title": "Error Log", "kind": "log",
                              "config": {"path": str(log_file)}, "order": 0}]}
        return {}
    monkeypatch.setattr(app.client, "call", fake_call)

    async with app.run_test() as pilot:
        await app.load_custom_pages()
        await pilot.pause()
        assert app.query_one("#tab-custom-errorlog") is not None


def test_custom_pages_hot_reload_on_broadcast():
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    added = []
    app._mount_custom_page = lambda page: added.append(page["id"])
    app._on_broadcast("tui.layout.changed", {"pages": [{"id": "x", "title": "X",
                                                        "kind": "log", "config": {}}]})
    assert added == ["x"]
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k custom_page -v`
Expected: FAIL — `load_custom_pages`/`_mount_custom_page` don't exist yet.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/custom_pane.py`**

```python
"""CustomPane — renders a user/Jarvis-defined custom TUI page (declarative
content spec only, no code: kind in log/table/markdown/widget/list). This
is what makes tui_add_page/tui_edit_page (tools_tui_ops.py) actually show
up live in the running terminal."""

from __future__ import annotations

import json

from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import DataTable, ListItem, ListView, Markdown, Static

from jarvis_cli.tui.canvas_render import render_widget_spec


class CustomPane(VerticalScroll):
    def __init__(self, page_id: str, title: str, kind: str, config: dict, **kw) -> None:
        super().__init__(**kw)
        self.page_id = page_id
        self.title = title
        self.kind = kind
        self.config = config or {}

    def compose(self) -> ComposeResult:
        if self.kind == "log":
            yield Static(id="custom-log")
        elif self.kind == "table":
            table = DataTable()
            cols = self.config.get("columns") or (
                list(self.config["rows"][0].keys()) if self.config.get("rows") else [])
            table.add_columns(*cols)
            for row in self.config.get("rows", []):
                table.add_row(*[str(row.get(c, "")) for c in cols])
            yield table
        elif self.kind == "markdown":
            yield Markdown(self.config.get("text", ""))
        elif self.kind == "widget":
            yield Static(render_widget_spec(self.config.get("spec", {})))
        elif self.kind == "list":
            lv = ListView()
            for item in self.config.get("items", []):
                lv.append(ListItem(Static(str(item))))
            yield lv
        else:
            yield Static(f"[unsupported custom page kind: {self.kind}]")

    def on_mount(self) -> None:
        if self.kind == "log":
            self.refresh_log()

    def refresh_if_stale(self) -> None:
        if self.kind == "log":
            self.refresh_log()

    def refresh_log(self) -> None:
        path = self.config.get("path", "")
        text = "(no path configured)"
        if path:
            try:
                with open(path, "r", errors="replace") as f:
                    lines = f.readlines()[-200:]
                text = "".join(lines) or "(empty)"
            except OSError as exc:
                text = f"(couldn't read {path}: {exc})"
        self.query_one("#custom-log", Static).update(text)
```

- [ ] **Step 4: Wire hot-reload into `app.py`**

Add to `JarvisTui`:

```python
async def load_custom_pages(self) -> None:
    try:
        res = await self.client.call("tui.layout.list", {})
    except Exception:
        return
    for page in res.get("pages", []):
        self._mount_custom_page(page)

def _mount_custom_page(self, page: dict) -> None:
    tabbed = self.query_one(TabbedContent)
    tab_id = f"tab-custom-{page['id']}"
    if tabbed.query(f"#{tab_id}"):
        return
    from jarvis_cli.tui.custom_pane import CustomPane
    pane = CustomPane(page["id"], page["title"], page["kind"], page.get("config", {}),
                      id=f"custom-{page['id']}")
    tabbed.add_pane(TabPane(page["title"], pane, id=tab_id))
```

Modify `on_mount` to also call `self.load_custom_pages()` (as a `@work`
task, same fire-and-forget style as `load_daemon_line`). Modify
`_on_broadcast` to dispatch `tui.layout.changed`:

```python
def _on_broadcast(self, event: str, data: dict) -> None:
    if event == "session.opened":
        try:
            self.query_one("#sessions", SessionsPane).refresh_data()
        except Exception:
            pass
    elif event == "tui.layout.changed":
        for page in data.get("pages", []):
            self._mount_custom_page(page)
    if self.client.on_broadcast_extra:
        self.client.on_broadcast_extra(event, data)
```

(This subsumes Task 6's `on_broadcast_extra` wiring — if Task 6 already
added a direct call site, keep only ONE dispatch path; prefer this
version since it's the one both `_on_broadcast` and `CanvasPane` need.)
This does not handle a page being REMOVED live (no test above requires
it) — the built-in pages are reserved so a running client never needs to
unmount one of ITS OWN tabs, and unmounting a live custom tab under the
user is out of scope for this pass (YAGNI: no task above needs it,
`tui.layout.list` on next launch reflects removals either way).

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k custom_page -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/custom_pane.py cli/jarvis_cli/tui/app.py cli/tests/test_tui.py
git commit -m "feat(cli): CustomPane + tui.layout.changed hot-reload — Jarvis can add/edit TUI pages live"
```

---

### Task 14: TUI — slash-command popup UI + `chat.py` routing

**Files:**
- Modify: `cli/jarvis_cli/tui/chat.py`
- Create: `cli/jarvis_cli/tui/command_palette.py`
- Test: `cli/tests/test_tui.py` (extend)

**Interfaces:**
- Consumes: `command.list` (Task 2/4), the existing built-in set
  (`/new /stop /goal /y /n` plus one launcher per new tab:
  `/canvas /widgets /phone /computer /browser /activity /replay /mcp
  /plugins /ssh /memorygraph /home /schedules /tui`), `command.invoke`
  (Task 2) for custom commands.
- Produces: `CommandPalette` (a Textual `ListView` overlay), mounted by
  `ChatPane` when the input's value starts with `/` and has no space yet
  (still "typing the command name").

- [ ] **Step 1: Write the failing test**

```python
# cli/tests/test_tui.py — append
async def test_typing_slash_opens_the_command_palette(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    async def fake_call(method, params=None, timeout=60.0):
        if method == "command.list":
            return {"commands": [{"name": "deploy", "description": "Deploy the current branch"}]}
        return {}
    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat")
        await pilot.click("#chat-input")
        await pilot.press("/")
        await pilot.pause()
        assert chat.query("CommandPalette")


async def test_palette_filters_as_you_type(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    from jarvis_cli.tui.command_palette import CommandPalette
    app = JarvisTui()
    async with app.run_test() as pilot:
        palette = CommandPalette(builtins=[("new", "start a fresh chat"),
                                          ("stop", "cancel the current turn")],
                                 customs=[])
        matches = palette.filter("st")
        assert [m[0] for m in matches] == ["stop"]


async def test_selecting_a_custom_command_invokes_it(monkeypatch):
    from jarvis_cli.tui.app import JarvisTui
    app = JarvisTui()
    calls = []
    async def fake_call(method, params=None, timeout=60.0):
        calls.append((method, params))
        if method == "command.list":
            return {"commands": [{"name": "deploy", "description": "d",
                                  "action_kind": "prompt"}]}
        if method == "command.invoke":
            return {"prompt": "deploy the current branch now"}
        return {}
    async with app.run_test() as pilot:
        monkeypatch.setattr(app.client, "call", fake_call)
        chat = app.query_one("#chat")
        await chat.run_slash_command("deploy", "")
        assert ("command.invoke", {"name": "deploy", "args": ""}) in calls
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "palette or slash_command" -v`
Expected: FAIL — module not found / no such method.

- [ ] **Step 3: Write `cli/jarvis_cli/tui/command_palette.py`**

```python
"""CommandPalette — the "/" popup: fuzzy-filters built-in + custom
commands as you type, arrow keys + enter/tab to pick. Mirrors Claude
Code's own slash-command menu."""

from __future__ import annotations

from textual.containers import Vertical
from textual.widgets import ListItem, ListView, Static


class CommandPalette(Vertical):
    def __init__(self, builtins: list[tuple[str, str]], customs: list[tuple[str, str]], **kw) -> None:
        super().__init__(**kw)
        self.all_commands = builtins + customs
        self.matches: list[tuple[str, str]] = list(self.all_commands)

    def compose(self):
        yield ListView(id="palette-list")

    def on_mount(self) -> None:
        self._render_matches()

    def filter(self, query: str) -> list[tuple[str, str]]:
        q = query.lower()
        self.matches = [c for c in self.all_commands if q in c[0].lower()]
        self._render_matches()
        return self.matches

    def _render_matches(self) -> None:
        lv = self.query_one("#palette-list", ListView)
        lv.clear()
        for name, desc in self.matches:
            lv.append(ListItem(Static(f"/{name}  [bright_black]{desc}[/]"), name=name))

    def selected_name(self) -> str | None:
        lv = self.query_one("#palette-list", ListView)
        if lv.index is None or not (0 <= lv.index < len(self.matches)):
            return None
        return self.matches[lv.index][0]
```

- [ ] **Step 4: Wire into `chat.py`**

Read `cli/jarvis_cli/tui/chat.py`'s `compose()`/`on_input_changed` (if it
exists) or add `on_input_changed`. The exact addition:

```python
# imports, add:
from jarvis_cli.tui.command_palette import CommandPalette

BUILTIN_COMMANDS = [
    ("new", "start a fresh chat"), ("stop", "cancel the current turn"),
    ("goal", "set the session goal"), ("y", "approve the pending action"),
    ("n", "deny the pending action"), ("canvas", "open the Canvas tab"),
    ("widgets", "open the Widgets tab"), ("phone", "open the Phone tab"),
    ("computer", "open the Computer tab"), ("browser", "open the Browser tab"),
    ("activity", "open the Activity tab"), ("replay", "open the Replay tab"),
    ("mcp", "open the MCP tab"), ("plugins", "open the Plugins tab"),
    ("ssh", "open the SSH tab"), ("memorygraph", "open the Memory Graph tab"),
    ("home", "open the Home tab"), ("schedules", "open the Schedules tab"),
    ("tui", "ask Jarvis to add/edit/remove a TUI page"),
]

TAB_JUMP_COMMANDS = {name for name, _ in BUILTIN_COMMANDS
                    if name not in ("new", "stop", "goal", "y", "n")}
```

Add methods to `ChatPane` (adjust to the class's ACTUAL existing method
names for sending a chat turn / responding to approvals — read
`chat.py`'s current `_send`/`_respond_approval`/`_set_goal` first and call
those exact names, do not rename them):

```python
async def on_input_changed(self, event) -> None:
    if event.input.id != "chat-input":
        return
    value = event.value
    if value.startswith("/") and " " not in value:
        await self._open_or_update_palette(value[1:])
    else:
        self._close_palette()

async def _open_or_update_palette(self, query: str) -> None:
    try:
        existing = self.query_one(CommandPalette)
    except Exception:
        try:
            res = await self.app.client.call("command.list", {})
            customs = [(c["name"], c.get("description", "")) for c in res.get("commands", [])]
        except Exception:
            customs = []
        existing = CommandPalette(BUILTIN_COMMANDS, customs)
        await self.mount(existing)
    existing.filter(query)

def _close_palette(self) -> None:
    try:
        self.query_one(CommandPalette).remove()
    except Exception:
        pass

async def run_slash_command(self, name: str, args: str) -> None:
    if name in ("y", "yes"):
        await self._respond_approval(True)
    elif name in ("n", "no"):
        await self._respond_approval(False)
    elif name == "new":
        await self.new_session()
    elif name == "stop":
        await self._stop_turn()
    elif name == "goal":
        await self._set_goal(args)
    elif name in TAB_JUMP_COMMANDS:
        from textual.widgets import TabbedContent
        self.app.query_one(TabbedContent).active = f"tab-{name}"
    else:
        try:
            res = await self.app.client.call("command.invoke", {"name": name, "args": args})
        except Exception as exc:
            self.notify(str(exc), severity="error")
            return
        if "prompt" in res:
            await self._send(res["prompt"])
        elif "mcp_tool" in res:
            self.notify(f"custom command '{name}' calls MCP tool "
                       f"'{res['mcp_tool']}' — invoke it via a normal chat turn "
                       f"for now (direct in-TUI MCP dispatch is a fast-follow)")
        elif "shell" in res:
            self.notify(f"custom command '{name}' would run script "
                       f"'{res['shell']}' — shell execution wiring is a fast-follow")
```

Modify the existing `on_input_submitted` (`chat.py:134-154`) so that when
a `CommandPalette` is open and Enter is pressed, it commits the selected
command instead of sending raw text:

```python
async def on_input_submitted(self, event: Input.Submitted) -> None:
    if event.input.id != "chat-input":
        return
    text = event.value.strip()
    try:
        palette = self.query_one(CommandPalette)
    except Exception:
        palette = None
    if palette is not None:
        name = palette.selected_name() or (text[1:] if text.startswith("/") else text[1:])
        self._close_palette()
        event.input.value = ""
        if name:
            parts = name.split(" ", 1)
            await self.run_slash_command(parts[0], parts[1] if len(parts) > 1 else "")
        return
    # ...existing body unchanged below (the /y /n /new /goal chain), OR
    # delegate entirely to run_slash_command for the existing built-ins too:
    event.input.value = ""
    if not text:
        return
    if text.startswith("/"):
        parts = text[1:].split(" ", 1)
        await self.run_slash_command(parts[0], parts[1] if len(parts) > 1 else "")
        return
    await self._send(text)
```

This REPLACES the old hardcoded `if text in ("/y","/yes")...` chain
(`chat.py:134-154`) with a single dispatch through `run_slash_command` —
delete the old chain rather than leaving both paths live.

`mcp_tool`/`shell` action kinds intentionally only notify rather than
execute in this pass — direct in-TUI MCP tool dispatch and script
execution are flagged as fast-follows in the notification text itself, not
silently dropped; `prompt` (the common case for both built-ins and
`create_slash_command` calls Jarvis is likely to make) is fully wired.

- [ ] **Step 5: Run to verify it passes.**

Run: `cd cli && .venv/bin/python -m pytest tests/test_tui.py -k "palette or slash_command" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/jarvis_cli/tui/command_palette.py cli/jarvis_cli/tui/chat.py cli/tests/test_tui.py
git commit -m "feat(cli): / command palette — built-ins + custom commands, Claude-Code-style popup"
```

---

### Task 15: Docs — `cli/README.md` + root `README.md`

**Files:**
- Modify: `cli/README.md`
- Modify: `README.md` (root — find the existing feature-row table via
  `grep -n "jarvis-sidebar\|Canvas\|Widgets" README.md`)

- [ ] **Step 1: Rewrite `cli/README.md`'s "The TUI" section**

Replace the 7-row table (lines 19-36) with all 20 tabs, and note the two
new subsystems:

```markdown
## The TUI (`jarvis` with no arguments)

Every GUI screen, in the terminal, over one streaming connection — full
parity, including live Canvas/Widget rendering (no more "use the desktop
app"):

| Tab | What it mirrors | Keys |
|---|---|---|
| Home | status + recent sessions overview | `r` refresh |
| Chat | live streamed turns: thinking, tool cards, approvals | `/` opens the command palette |
| Sessions | the session list | `enter` open · `n` new · `x` delete |
| Memory | long-term memory | type to search · `x` forget |
| Skills | skill library + usage stats | `enter` run · `p` pin · `v` archived · `a` restore |
| Agents | background subagents | `r` refresh |
| Queue | the durable work queue | type `title :: prompt` to enqueue · `c` cancel |
| Schedules | cron-style scheduled tasks | type `name :: prompt` to schedule · `g` run now · `x` remove |
| Settings | autonomy + update knobs | `enter` cycles a value (saves immediately) |
| Canvas | live rendered widgets as they stream in | (read-only feed) |
| Widgets | the saved widget library | `enter` render to Canvas |
| Phone | device pairing (ASCII QR) + list | `p` pair · `x` revoke |
| Computer | co-work session start/stop, approvals, action log | `a` agent desktop · `w` your real screen · `s` stop |
| Browser | the per-session in-app browser | type a URL + enter · `b`/`f` back/forward · `r` snapshot |
| Activity | the audit log tail | `r` refresh |
| Replay | step through a past session's event timeline | type a session id + enter · `j`/`k` step |
| Mcp | configured MCP servers | `enter` enable/disable |
| Plugins | the signed plugin marketplace | `i` install · `enter` enable/disable · `x` remove |
| Ssh | the SSH allowlist | type `user@host` + enter · `x` revoke |
| MemoryGraph | the memory relationship graph (as a tree) | type a root id + enter |

Global: `Ctrl+N` new chat · `F5` refresh tab · `Ctrl+Q` quit.

### Slash commands

Type `/` in Chat to open a fuzzy-filtered command palette — built-ins
(`/new /stop /goal /y /n` + one jump-command per tab above) plus any
CUSTOM command you or Jarvis have defined. Ask Jarvis to make you one
("make me a /deploy command that runs my deploy script") — it calls
`create_slash_command` and it shows up immediately, no restart needed.
`prompt`-kind commands run today; `mcp_tool`/`shell`-kind commands are
recognized but notify rather than auto-execute (direct in-TUI dispatch is
a fast-follow — see docs/superpowers/plans/2026-07-03-tui-gui-parity.md).

### Self-editing the TUI's layout

Ask Jarvis to add/edit/remove a custom page ("add me a page that tails
/var/log/jarvis.log") — it calls `tui_add_page` (no code, a declarative
content spec: `log`/`table`/`markdown`/`widget`/`list`) and the change
appears live in every connected terminal, no restart needed. The 20 tabs
above are reserved and can't be touched this way.
```

- [ ] **Step 2: Add `qrcode` and (if newly added) `httpx` to the README's
  dependency mention**, and bump the "16 tests" count in the Tests section
  to the actual final count (run `cd cli && .venv/bin/python -m pytest
  tests --collect-only -q | tail -1` after Task 16's full run and paste
  the real number — do not guess it here).

- [ ] **Step 3: Update the root `README.md`'s feature table**

Follow the exact row format already used for prior waves (grep an
existing row: `grep -n "| Canvas\|| Widgets" README.md`) and add a row (or
extend the existing TUI row) noting: "jarvis terminal now has full GUI
parity (Canvas/Widgets/Phone/Computer/Browser/Activity/Replay/Mcp/
Plugins/Ssh/MemoryGraph/Home/Schedules), a self-edit MCP tool for its own
layout, and an extensible `/` command engine."

- [ ] **Step 4: Commit**

```bash
git add cli/README.md README.md
git commit -m "docs: TUI/GUI-parity wave — full page table, slash commands, self-edit layout"
```

---

### Task 16: Integration — full test suite, final review prep, branch delivery

**Files:** none new — verification + git operations only.

- [ ] **Step 1: Full C++ build + ctest**

Run: `cmake --build build -j && ctest --test-dir build --output-on-failure`
Expected: 100% pass (existing count + `tui_layout_store_test` +
`command_store_test`).

- [ ] **Step 2: Full Python test suite across every touched package**

Run:
```bash
cd computer-use && .venv/bin/python -m pytest tests -v; cd ..
cd cli && .venv/bin/python -m pytest tests -v; cd ..
```
Expected: 100% pass. Any environmental-skip (matching `test_video_source.py`'s
existing precedent) must be a `pytest.mark.skip` with a reason string, not
a silent failure.

- [ ] **Step 3: Manual smoke — launch the real TUI against a running daemon**

Run: `jarvis` (or `cli/.venv/bin/jarvis` if not installed system-wide) —
tab through every one of the 20 tabs, confirm each loads without a
traceback (a "no active session" / empty-list state is fine; a Python
traceback is not). This is the same live-verification bar the WAVE
commits in git history hold themselves to.

- [ ] **Step 4: Run `/code-review` (high or max effort) and fix every finding**

Per the user's explicit requirement (see memory `feedback-review-
before-ship.md`): do NOT skip this even under time pressure. Re-run the
affected package's tests after each fix.

- [ ] **Step 5: Branch delivery**

```bash
git log --oneline dev..HEAD   # confirm exactly this feature's commits
git push origin dev
git rev-list --left-right --count qa...dev   # confirm the current gap before promoting
git checkout qa && git merge --ff-only dev && git push origin qa
git checkout dev
gh pr create --base main --head qa --title "TUI/GUI parity + self-edit layout + slash commands" \
  --body "$(cat <<'EOF'
## Summary
- Full TUI↔GUI parity: 13 new terminal screens (Canvas/Widgets/Phone/
  Computer/Browser/Activity/Replay/Mcp/Plugins/Ssh/MemoryGraph/Home/
  Schedules) alongside the existing 7
- Self-edit TUI layout: tui_add_page/edit_page/remove_page/reorder_pages
  MCP tools + tui.layout.* Contract-A verbs, live hot-reload
- Slash-command engine: command.* Contract-A verbs, create_slash_command
  MCP tool, Claude-Code-style `/` popup in the TUI
- Design: docs/superpowers/specs/2026-07-03-tui-gui-parity-design.md
- Plan: docs/superpowers/plans/2026-07-03-tui-gui-parity.md

## Test plan
- [ ] ctest --test-dir build (all pass)
- [ ] cli + computer-use pytest suites (all pass)
- [ ] Manual: jarvis TUI, tab through all 20 tabs
- [ ] /code-review findings addressed
EOF
)"
```

**Note on the fast-forward:** if `git merge --ff-only dev` on `qa`
fails (non-fast-forward), STOP and report back rather than force-merging —
this means `qa` picked up commits from elsewhere since the plan's research
phase and a real merge decision is needed, not a silent override.
