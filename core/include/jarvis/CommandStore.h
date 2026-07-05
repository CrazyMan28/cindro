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
    // The store root (…/commands). Shell-kind targets resolve against
    // <dir()>/scripts — the daemon needs this to execute them.
    QString dir() const { return m_dir; }
    bool create(const QString &name, const QString &description,
                const QString &actionKind, const QString &actionTarget,
                const QString &body, bool selfAuthored);
    bool remove(const QString &name);

    static bool isBuiltinName(const QString &name);
    static bool isValidActionKind(const QString &kind);
    static QString defaultDir();

private:
    // Sanitize a caller-supplied command name into a filesystem-safe directory
    // component (via jarvis::slugComponent). Returns empty if the name has no
    // usable characters — create() treats that as an error rather than writing
    // to the store root. Prevents path traversal (e.g. "../../etc/evil").
    static QString slug(const QString &name);
    QString commandDir(const QString &name) const;
    QString m_dir;
};

} // namespace jarvis
