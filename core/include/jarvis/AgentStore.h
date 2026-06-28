#pragma once

// AgentStore — user/model-defined custom agents (subagents).
//
// An agent is a Markdown file with YAML frontmatter at
//   ~/.local/share/jarvis/agents/<slug>/AGENT.md
// The body is the agent's SYSTEM PROMPT. Frontmatter:
//   name        — display name
//   description — what the agent does
//   when_to_use — when Jarvis should dispatch this agent (the model reads this
//                 to decide on its own which agent to call)
//   brain       — codex | claude | api (which brain it runs on; empty = default)
//   model       — model id (empty = brain default)
//   profile     — coder | coworker (default coworker)
//   tools       — optional allow-list of tool groups (informational)
//   color       — accent colour for the UI chip (e.g. #B28BFF)
//
//   - list()/get()/read(): index + read agent defs.
//   - create(): WRITES a new AGENT.md (self-authoring) — Jarvis can define its
//     own agents. Created agents are ALSO mirrored into ~/.claude/agents/<slug>.md
//     in Claude-Code subagent format so the claude CLI brain can use them too.
//   - remove(): delete an agent def.
//
// Mirrors SkillStore deliberately (same frontmatter parser shape) so the two
// stay consistent.

#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>
#include <optional>

namespace jarvis {

// Parsed YAML frontmatter (flat keys only — sufficient for our schema).
struct AgentFrontmatter {
    QString name;
    QString description;
    QString whenToUse;
    QString brain;     // codex | claude | api (empty = default)
    QString model;     // empty = brain default
    QString profile;   // coder | coworker (default coworker)
    QStringList tools; // optional allow-list (informational)
    QString color;     // UI chip colour
    QJsonObject extra; // any other frontmatter keys

    QJsonObject toJson() const;
};

struct AgentRow {
    AgentFrontmatter fm;
    QString systemPrompt; // the AGENT.md body
    QString path;         // absolute path to AGENT.md

    // {name,description,when_to_use,brain,model,profile,tools,color,path} for agents.list.
    QJsonObject toListJson() const;
};

class AgentStore {
public:
    AgentStore() = default;

    // ~/.local/share/jarvis/agents (created on demand).
    static QString defaultRoot();
    // The claude CLI's subagent dir we mirror created agents into.
    static QString claudeAgentsRoot(); // ~/.claude/agents

    void setRoot(const QString &root) { m_root = root; }
    QString root() const;

    QString lastError() const { return m_lastError; }

    // --- index / read ------------------------------------------------------
    // Re-scan the agents dir. Returns all indexed agents (name asc).
    QVector<AgentRow> list();
    // Look up a single agent by name (matches frontmatter name OR dir name).
    std::optional<AgentRow> get(const QString &name);
    // Read the raw frontmatter + body of an agent (for agents.get).
    bool read(const QString &name, AgentFrontmatter *fmOut, QString *bodyOut,
              QString *pathOut);

    // --- self-authoring ----------------------------------------------------
    // Write a new AGENT.md (create-or-overwrite). Returns the absolute AGENT.md
    // path (empty on error). Also mirrors into ~/.claude/agents (best-effort).
    QString create(const QString &name, const QString &description,
                   const QString &whenToUse, const QString &systemPrompt,
                   const QString &brain = QString(), const QString &model = QString(),
                   const QString &profile = QString(),
                   const QStringList &tools = {}, const QString &color = QString());

    bool remove(const QString &name);

    // Pure helpers (also unit-tested):
    static bool parse(const QString &text, AgentFrontmatter *fmOut, QString *bodyOut);
    static QString serialize(const AgentFrontmatter &fm, const QString &body);
    // Serialize into Claude-Code subagent format (flat frontmatter + body).
    static QString serializeClaude(const AgentFrontmatter &fm, const QString &body);
    // Sanitize an agent name into a filesystem-safe directory component.
    static QString slug(const QString &name);

private:
    void mirrorToCli(const QString &name, const QString &md);

    QString m_root;     // overrides defaultRoot() when set
    QString m_lastError;
};

} // namespace jarvis
