#pragma once

// The canonical Jarvis data root, resolved IDENTICALLY on every platform AND in
// lock-step with the Python computer-use engine.
//
// The engine (widgets_bus.py, tools_todo.py, ask_bus.py, live_widgets.py, …) and
// the SQLite DB + every C++ store (SessionStore, MemoryStore, SkillStore, …) all
// live under `os.environ.get("XDG_DATA_HOME", ~/.local/share)/jarvis`. A handful of
// C++ *readers* (the desktop widget/question/pointer file-bus tails, the device
// inbox) instead used `QStandardPaths::GenericDataLocation`. On Linux that returns
// the SAME `~/.local/share`, so it worked. On Windows it returns `%LOCALAPPDATA%`,
// so the desktop looked in a DIFFERENT directory than the engine wrote to and the
// model's widgets / todos / approval prompts NEVER appeared (GitHub #81). Routing
// those readers through this helper makes both sides agree on every OS while leaving
// Linux byte-for-byte identical.

#include <QDir>
#include <QString>

namespace jarvis {

// Base data dir (no trailing "/jarvis"): $XDG_DATA_HOME or ~/.local/share.
// Mirrors the Python engine's `os.environ.get("XDG_DATA_HOME", Path.home()/".local"/"share")`.
inline QString dataHome()
{
    const QString xdg = qEnvironmentVariable("XDG_DATA_HOME");
    return xdg.isEmpty() ? QDir::homePath() + QStringLiteral("/.local/share") : xdg;
}

// The Jarvis data directory itself: <dataHome>/jarvis.
inline QString dataDir()
{
    return dataHome() + QStringLiteral("/jarvis");
}

} // namespace jarvis
