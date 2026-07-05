#pragma once

// UiManifest — the daemon-owned "surface manifest": ONE declarative
// description of every user-facing surface (pages, commands, settings knobs,
// status-strip segments) that BOTH frontends (desktop QML + terminal TUI)
// consume, so a feature lands in the manifest once and appears in both UIs.
//
//   ui.manifest.get      -> { v, pages[], commands[], settings_sections[],
//                             status_segments[] }
//   ui.manifest.changed  -> (no payload) clients refetch
//
// Page kinds:
//   "table"   — generic list page: data.list verb + columns + row/page
//               actions + refresh_events. A frontend renders these with ONE
//               generic table-page component (zero per-feature UI code).
//   "bespoke" — a hand-built page on each frontend (chat, canvas, phone…).
//               The manifest still owns its id/title/section so navigation,
//               palettes and /commands stay in sync.
//   custom TuiLayoutStore pages (log|table|markdown|widget|list) are merged
//   in at request time with source:"custom" — the pre-existing tui.layout.*
//   custom-page mechanism, now part of the one manifest.
//
// This generalizes tui.layout.* (which stays, verbatim, for compat).

#include "jarvis/CommandStore.h"
#include "jarvis/TuiLayoutStore.h"

#include <QJsonObject>
#include <QVector>

namespace jarvis {

class UiManifest {
public:
    // The compiled-in builtin surface (parsed once, cached). Always a valid
    // object — a parse failure of the embedded JSON is a programmer error
    // and asserts in debug builds.
    static QJsonObject base();

    // base() with the live extras merged in: custom TUI pages and custom
    // slash commands are appended with source:"custom".
    static QJsonObject merged(const QVector<TuiPageSpec> &customPages,
                              const QVector<CommandRow> &customCommands);
};

} // namespace jarvis
