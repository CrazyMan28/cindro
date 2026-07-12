#include "jarvis/UiManifest.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>

#include <cassert>

namespace jarvis {

namespace {

// The builtin surface. Columns/actions mirror what the audited GUI pages and
// TUI panes actually render today — this is the contract the generic
// table-page renderers on both frontends consume. Keep field names identical
// to the verbs' response row keys.
constexpr const char *kBaseManifest = R"json({
  "v": 1,
  "pages": [
    {"id": "home",     "title": "Home",     "section": "workspace", "kind": "bespoke"},
    {"id": "chat",     "title": "Chat",     "section": "workspace", "kind": "bespoke"},
    {"id": "voice",    "title": "Voice",    "section": "workspace", "kind": "bespoke"},
    {"id": "computer", "title": "Computer", "section": "workspace", "kind": "bespoke",
     "gated_by": "agent_desktop"},
    {"id": "browser",  "title": "Browser",  "section": "workspace", "kind": "bespoke"},
    {"id": "canvas",   "title": "Canvas",   "section": "workspace", "kind": "bespoke"},
    {"id": "widgets",  "title": "Widgets",  "section": "workspace", "kind": "bespoke"},
    {"id": "phone",    "title": "Phone",    "section": "workspace", "kind": "bespoke"},

    {"id": "sessions", "title": "Sessions", "section": "workspace", "kind": "table",
     "data": {"list": {"verb": "session.list", "result_key": "sessions"}},
     "columns": [
       {"key": "title",   "label": "Title"},
       {"key": "brain",   "label": "Brain"},
       {"key": "model",   "label": "Model"},
       {"key": "state",   "label": "State"},
       {"key": "updated", "label": "Updated", "format": "reltime"}],
     "row_actions": [
       {"id": "open",   "label": "Open",   "kind": "navigate", "target": "chat"},
       {"id": "replay", "label": "Replay", "kind": "navigate", "target": "replay"},
       {"id": "delete", "label": "Delete", "kind": "verb", "verb": "session.delete",
        "params": {"session_id": "$id"}, "confirm": true}],
     "page_actions": [
       {"id": "new", "label": "New chat", "kind": "navigate", "target": "chat"}],
     "refresh_events": ["session.opened"]},

    {"id": "memory", "title": "Memory", "section": "mind", "kind": "table",
     "data": {"list":   {"verb": "memory.list",   "result_key": "memories"},
              "search": {"verb": "memory.search", "result_key": "memories",
                         "query_param": "q",
                         "params": {"include_agent_scoped": true}}},
     "columns": [
       {"key": "text", "label": "Memory"},
       {"key": "tags", "label": "Tags", "format": "chips"},
       {"key": "created", "label": "When", "format": "reltime"}],
     "row_actions": [
       {"id": "forget", "label": "Forget", "kind": "verb", "verb": "memory.remove",
        "params": {"id": "$id"}, "confirm": true}],
     "input_actions": [
       {"id": "remember", "placeholder": "Remember this… #tag", "kind": "verb",
        "verb": "memory.add", "params": {"text": "$input"}}]},

    {"id": "memorygraph", "title": "Memory Graph", "section": "mind", "kind": "bespoke"},

    {"id": "skills", "title": "Skills", "section": "mind", "kind": "table",
     "data": {"list":     {"verb": "skills.list", "result_key": "skills"},
              "archived": {"verb": "skills.list_archived", "result_key": "skills"}},
     "columns": [
       {"key": "name",        "label": "Skill"},
       {"key": "group",       "label": "Group"},
       {"key": "description", "label": "Description"},
       {"key": "pinned",      "label": "Pinned", "format": "flag"},
       {"key": "use_count",   "label": "Uses"}],
     "row_actions": [
       {"id": "view",      "label": "View",    "kind": "verb", "verb": "skills.get",
        "params": {"name": "$name"}, "show": "detail"},
       {"id": "pin",       "label": "Pin",     "kind": "verb", "verb": "skills.pin",
        "params": {"name": "$name"}},
       {"id": "run",       "label": "Run",     "kind": "send_chat", "text": "/$name"},
       {"id": "unarchive", "label": "Restore", "kind": "verb", "verb": "skills.unarchive",
        "params": {"name": "$name"}, "when": "archived"},
       {"id": "remove",    "label": "Remove",  "kind": "verb", "verb": "skills.remove",
        "params": {"name": "$name"}, "confirm": true}]},

    {"id": "agents", "title": "Agents", "section": "mind", "kind": "table",
     "data": {"list":    {"verb": "agents.list",    "result_key": "agents"},
              "running": {"verb": "agents.running", "result_key": "agents"}},
     "columns": [
       {"key": "name",        "label": "Agent"},
       {"key": "brain",       "label": "Brain"},
       {"key": "model",       "label": "Model"},
       {"key": "profile",     "label": "Profile"},
       {"key": "description", "label": "Description"}],
     "row_actions": [
       {"id": "view",     "label": "View",     "kind": "verb", "verb": "agents.get",
        "params": {"name": "$name"}, "show": "detail"},
       {"id": "dispatch", "label": "Dispatch", "kind": "verb", "verb": "agents.dispatch",
        "params": {"name": "$name", "task": "$input"}, "input": "task"},
       {"id": "remove",   "label": "Remove",   "kind": "verb", "verb": "agents.remove",
        "params": {"name": "$name"}, "confirm": true}]},

    {"id": "queue", "title": "Queue", "section": "mind", "kind": "table",
     "data": {"list": {"verb": "queue.list", "result_key": "items"}},
     "columns": [
       {"key": "title",    "label": "Task"},
       {"key": "state",    "label": "State"},
       {"key": "priority", "label": "Priority"}],
     "row_actions": [
       {"id": "cancel", "label": "Cancel", "kind": "verb", "verb": "queue.cancel",
        "params": {"id": "$id"}, "confirm": true}],
     "input_actions": [
       {"id": "add", "placeholder": "Queue a task…", "kind": "verb",
        "verb": "queue.add", "params": {"title": "$input"}}]},

    {"id": "schedules", "title": "Schedules", "section": "mind", "kind": "table",
     "data": {"list": {"verb": "schedule.list", "result_key": "schedules"}},
     "columns": [
       {"key": "name",     "label": "Job"},
       {"key": "cron",     "label": "When"},
       {"key": "next_run", "label": "Next", "format": "reltime"},
       {"key": "last_run", "label": "Last", "format": "reltime"},
       {"key": "enabled",  "label": "On", "format": "flag"}],
     "row_actions": [
       {"id": "run_now", "label": "Run now", "kind": "verb", "verb": "schedule.run_now",
        "params": {"id": "$id"}},
       {"id": "toggle",  "label": "Enable/disable", "kind": "verb",
        "verb": "schedule.set_enabled", "params": {"id": "$id", "enabled": "$toggle"}},
       {"id": "remove",  "label": "Remove", "kind": "verb", "verb": "schedule.remove",
        "params": {"id": "$id"}, "confirm": true}]},

    {"id": "activity", "title": "Activity", "section": "system", "kind": "table",
     "data": {"list": {"verb": "audit.list", "result_key": "entries",
                       "params": {"limit": 100}}},
     "columns": [
       {"key": "ts",      "label": "Time", "format": "time"},
       {"key": "tool",    "label": "Tool"},
       {"key": "risk",    "label": "Risk", "format": "risk"},
       {"key": "ok",      "label": "OK", "format": "flag"},
       {"key": "summary", "label": "Summary"}]},

    {"id": "mcp", "title": "MCP", "section": "system", "kind": "table",
     "data": {"list": {"verb": "mcp.list", "result_key": "servers"}},
     "columns": [
       {"key": "name",      "label": "Server"},
       {"key": "transport", "label": "Transport"},
       {"key": "endpoint",  "label": "Endpoint"},
       {"key": "enabled",   "label": "On", "format": "flag"},
       {"key": "risk",      "label": "Risk", "format": "risk"}],
     "row_actions": [
       {"id": "toggle", "label": "Enable/disable", "kind": "verb",
        "verb": "mcp.set_enabled", "params": {"id": "$id", "enabled": "$toggle"}},
       {"id": "test",   "label": "Test", "kind": "verb", "verb": "mcp.test",
        "params": {"id": "$id"}},
       {"id": "remove", "label": "Remove", "kind": "verb", "verb": "mcp.remove",
        "params": {"id": "$id"}, "confirm": true, "when": "!builtin"}],
     "refresh_events": []},

    {"id": "plugins", "title": "Plugins", "section": "system", "kind": "table",
     "data": {"list": {"verb": "plugins.catalog", "result_key": "plugins"}},
     "columns": [
       {"key": "name",    "label": "Plugin"},
       {"key": "version", "label": "Version"},
       {"key": "kind",    "label": "Kind"},
       {"key": "enabled", "label": "On", "format": "flag"}],
     "row_actions": [
       {"id": "install", "label": "Install", "kind": "verb", "verb": "plugins.install",
        "params": {"name": "$name"}, "when": "!installed"},
       {"id": "toggle",  "label": "Enable/disable", "kind": "verb",
        "verb": "plugins.set_enabled", "params": {"name": "$name", "enabled": "$toggle"}},
       {"id": "remove",  "label": "Remove", "kind": "verb", "verb": "plugins.remove",
        "params": {"name": "$name"}, "confirm": true}]},

    {"id": "outpost", "title": "Outpost", "section": "system", "kind": "table",
     "data": {"list": {"verb": "outpost.list", "result_key": "machines"}},
     "columns": [
       {"key": "name",      "label": "Machine"},
       {"key": "os",        "label": "OS"},
       {"key": "status",    "label": "Status"},
       {"key": "last_seen", "label": "Last seen", "format": "reltime"}],
     "row_actions": [
       {"id": "exec",       "label": "Run command", "kind": "verb", "verb": "outpost.exec",
        "params": {"machine": "$name", "cmd": "$input"}, "input": "command", "show": "detail"},
       {"id": "screenshot", "label": "Screenshot", "kind": "verb", "verb": "outpost.screenshot",
        "params": {"machine": "$name"}, "show": "detail"},
       {"id": "revoke",     "label": "Revoke", "kind": "verb", "verb": "outpost.revoke",
        "params": {"machine": "$name"}, "confirm": true}]},

    {"id": "replay",   "title": "Replay",   "section": "system", "kind": "bespoke"},
    {"id": "settings", "title": "Settings", "section": "system", "kind": "bespoke"}
  ],

  "commands": [
    {"name": "new",      "description": "start a fresh chat session", "kind": "session"},
    {"name": "clear",    "description": "start a fresh chat session", "kind": "session",
     "alias_of": "new"},
    {"name": "stop",     "description": "cancel the in-flight turn", "kind": "session"},
    {"name": "goal",     "description": "set a persistent session goal", "kind": "session"},
    {"name": "y",        "description": "approve the pending action", "kind": "session",
     "aliases": ["yes"]},
    {"name": "n",        "description": "deny the pending action", "kind": "session",
     "aliases": ["no"]},
    {"name": "chat",     "description": "jump to Chat", "kind": "navigate", "target": "chat"},
    {"name": "home",     "description": "jump to Home", "kind": "navigate", "target": "home"},
    {"name": "canvas",   "description": "jump to Canvas", "kind": "navigate", "target": "canvas"},
    {"name": "widgets",  "description": "jump to Widgets", "kind": "navigate", "target": "widgets"},
    {"name": "phone",    "description": "jump to Phone", "kind": "navigate", "target": "phone"},
    {"name": "computer", "description": "jump to Computer", "kind": "navigate", "target": "computer"},
    {"name": "browser",  "description": "jump to Browser", "kind": "navigate", "target": "browser"},
    {"name": "replay",   "description": "jump to Replay", "kind": "navigate", "target": "replay"},
    {"name": "settings", "description": "jump to Settings", "kind": "navigate", "target": "settings"},
    {"name": "sessions", "description": "browse sessions", "kind": "page", "target": "sessions",
     "aliases": ["resume"]},
    {"name": "memory",   "description": "browse memories", "kind": "page", "target": "memory"},
    {"name": "memorygraph", "description": "knowledge graph", "kind": "page",
     "target": "memorygraph"},
    {"name": "skills",   "description": "browse skills", "kind": "page", "target": "skills"},
    {"name": "agents",   "description": "browse agents", "kind": "page", "target": "agents"},
    {"name": "queue",    "description": "work queue", "kind": "page", "target": "queue"},
    {"name": "activity", "description": "audit trail", "kind": "page", "target": "activity"},
    {"name": "mcp",      "description": "MCP servers", "kind": "page", "target": "mcp"},
    {"name": "plugins",  "description": "plugin marketplace", "kind": "page", "target": "plugins"},
    {"name": "outpost",  "description": "remote machines", "kind": "page", "target": "outpost"},
    {"name": "pair",     "description": "pair a new Outpost machine", "kind": "verb",
     "verb": "outpost.pair_start"},
    {"name": "schedules","description": "scheduled jobs", "kind": "page", "target": "schedules"},
    {"name": "voice",    "description": "voice mode", "kind": "navigate", "target": "voice"},
    {"name": "model",    "description": "pick the default model", "kind": "picker",
     "target": "model"},
    {"name": "provider", "description": "pick the default brain", "kind": "picker",
     "target": "brain", "aliases": ["brain"]},
    {"name": "dispatch", "description": "dispatch a task to an agent", "kind": "verb",
     "verb": "agents.dispatch"},
    {"name": "tui",      "description": "ask Cindro to build a custom page", "kind": "send_chat"},
    {"name": "stage",    "description": "git add a reviewed file", "kind": "verb",
     "verb": "diff.stage"},
    {"name": "commit",   "description": "commit staged changes", "kind": "verb",
     "verb": "diff.commit"},
    {"name": "revert",   "description": "discard local changes to a file", "kind": "verb",
     "verb": "diff.revert", "confirm": true},
    {"name": "openpr",   "description": "push + open a pull request", "kind": "verb",
     "verb": "diff.open_pr"},
    {"name": "help",     "description": "list commands + keys", "kind": "help"}
  ],

  "settings_sections": [
    {"id": "autonomy", "title": "Mode & autonomy", "knobs": [
      {"id": "agent_mode",       "label": "Agent mode", "type": "enum",
       "choices": ["coworker", "plan", "build"]},
      {"id": "permission_level", "label": "Permissions", "type": "enum",
       "choices": ["cautious", "balanced", "autonomous"]},
      {"id": "self_improve",     "label": "Self-improve", "type": "toggle"},
      {"id": "auto_continue",    "label": "Auto-continue", "type": "enum",
       "choices": ["off", "capped", "on"]},
      {"id": "wake_notify",      "label": "Wake notify", "type": "enum",
       "choices": ["silent", "ping", "always"]},
      {"id": "skill_archive_days", "label": "Skill archive after", "type": "enum",
       "choices": ["0", "14", "30", "90"]},
      {"id": "api_context_max_tokens", "label": "API context compression", "type": "enum",
       "choices": ["0", "50000", "100000"]}]},
    {"id": "updates", "title": "Updates", "knobs": [
      {"id": "auto_update",       "label": "Auto-update", "type": "toggle"},
      {"id": "auto_update_apply", "label": "Auto-install updates", "type": "toggle"}]}
  ],

  "status_segments": [
    {"id": "link",    "label": "LINK",   "kind": "connection"},
    {"id": "version", "label": "",       "kind": "value", "source": "version"},
    {"id": "brain",   "label": "",       "kind": "value", "source": "default_brain"},
    {"id": "mode",    "label": "MODE",   "kind": "setting", "source": "agent_mode"},
    {"id": "mcp",     "label": "MCP",    "kind": "value", "source": "mcp.enabled"},
    {"id": "agents",  "label": "AGENTS", "kind": "value", "source": "agents_running"}
  ]
})json";

} // namespace

QJsonObject UiManifest::base()
{
    static const QJsonObject cached = [] {
        QJsonParseError err{};
        const QJsonDocument doc =
            QJsonDocument::fromJson(QByteArray(kBaseManifest), &err);
        assert(err.error == QJsonParseError::NoError && doc.isObject());
        return doc.object();
    }();
    return cached;
}

QJsonObject UiManifest::merged(const QVector<TuiPageSpec> &customPages,
                               const QVector<CommandRow> &customCommands)
{
    QJsonObject m = base();

    QJsonArray pages = m.value(QStringLiteral("pages")).toArray();
    for (const TuiPageSpec &p : customPages) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), p.id);
        o.insert(QStringLiteral("title"), p.title);
        o.insert(QStringLiteral("kind"), p.kind);
        o.insert(QStringLiteral("config"), p.config);
        o.insert(QStringLiteral("order"), p.order);
        o.insert(QStringLiteral("section"), QStringLiteral("custom"));
        o.insert(QStringLiteral("source"), QStringLiteral("custom"));
        pages.append(o);
    }
    m.insert(QStringLiteral("pages"), pages);

    QJsonArray commands = m.value(QStringLiteral("commands")).toArray();
    for (const CommandRow &c : customCommands) {
        QJsonObject o;
        o.insert(QStringLiteral("name"), c.name);
        o.insert(QStringLiteral("description"), c.description);
        o.insert(QStringLiteral("kind"), c.actionKind); // prompt | mcp_tool | shell
        o.insert(QStringLiteral("source"), QStringLiteral("custom"));
        commands.append(o);
    }
    m.insert(QStringLiteral("commands"), commands);

    return m;
}

} // namespace jarvis
