#pragma once

// SkillStore — self-authored skills (HERMES_FEATURES.md §2).
//
// A skill is a Markdown file with YAML frontmatter at
//   ~/.local/share/jarvis/skills/<group>/<name>/SKILL.md
// (+ optional scripts/). Frontmatter: name, description, tags, group, metadata.
//
//   - list()/get(): index + read skills.
//   - create(): WRITES a new SKILL.md (SELF-AUTHORING) — Jarvis can learn a
//     repeatable task once and persist it as an invokable skill. Created skills
//     are ALSO mirrored into the active CLI brain's skills dir (~/.codex/skills
//     and ~/.claude/skills) so codex/claude pick them up natively.
//   - invoke(): renders {{VAR}} template vars (incl. builtins SKILL_DIR/ARGS)
//     and returns the skill body as a message to inject before the next turn.
//
// Skills expose no tools of their own; the agent uses its file/shell/computer-
// use tools to run any bundled scripts.

#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>
#include <optional>

namespace jarvis {

// Parsed YAML frontmatter (flat keys only — sufficient for our schema).
struct SkillFrontmatter {
    QString name;
    QString description;
    QStringList tags;
    QString group;
    bool selfAuthored = false; // metadata.self_authored / authored_by: jarvis
    QJsonObject extra;         // any other frontmatter keys

    QJsonObject toJson() const;
};

struct SkillRow {
    SkillFrontmatter fm;
    QString path; // absolute path to SKILL.md

    // {name,group,description,tags,self_authored} for skills.list.
    QJsonObject toListJson() const;
};

// A bundled script to write next to SKILL.md (scripts/<name>).
struct SkillScript {
    QString name;
    QString content;
};

// Per-skill usage stats (jarvis#76 item 2), stored as a _stats.json sidecar in
// the skill dir. The sidecar is invisible to the SKILL.md scanners and is never
// mirrored to the CLI dirs (mirrorToCli copies only SKILL.md + scripts/).
struct SkillStats {
    int useCount = 0;
    qint64 lastUsedAt = 0; // unix ms of the last invoke (0 = never)
    bool pinned = false;   // pinned skills are exempt from the stale sweep
};

class SkillStore {
public:
    SkillStore() = default;

    // ~/.local/share/jarvis/skills (created on demand).
    static QString defaultRoot();
    // The CLI brains' skill dirs we mirror created skills into.
    static QString codexSkillsRoot();  // ~/.codex/skills
    static QString claudeSkillsRoot(); // ~/.claude/skills

    void setRoot(const QString &root) { m_root = root; }
    QString root() const;

    QString lastError() const { return m_lastError; }

    // --- index / read ------------------------------------------------------
    // Re-scan the skills dir. Returns all indexed skills (group asc, name asc).
    QVector<SkillRow> list();
    // Like list(), but ALSO surfaces skills found in the CLI brains' dirs
    // (~/.codex/skills, ~/.claude/skills), de-duplicated by name (the Jarvis copy
    // wins). So a skill the model created via its CLI — not the create_skill tool —
    // still shows in the Jarvis Skills list. Used by the daemon's skills.list.
    QVector<SkillRow> listAll();
    // Look up a single skill by name (matches frontmatter name OR dir name).
    std::optional<SkillRow> get(const QString &name);
    // Read the raw frontmatter + body of a skill (for skills.get).
    bool read(const QString &name, SkillFrontmatter *fmOut, QString *bodyOut,
              QString *pathOut);

    // --- self-authoring ----------------------------------------------------
    // Write a new SKILL.md (and any scripts/). `group` defaults to "self".
    // Returns the absolute SKILL.md path (empty on error). Also mirrors the
    // skill into the codex + claude skill dirs (best-effort).
    QString create(const QString &name, const QString &description,
                   const QString &body, const QString &group = QString(),
                   const QStringList &tags = {},
                   const QVector<SkillScript> &scripts = {});

    bool remove(const QString &name);

    // Re-mirror EVERY stored skill into the installed CLI brains' skill dirs
    // (~/.codex/skills, ~/.claude/skills). mirrorToCli() otherwise runs only at
    // skill CREATION — and silently skips a CLI whose config dir doesn't exist
    // yet — so a machine where Jarvis ran before claude/codex was installed
    // permanently missed the mirrors (/internal_docs absent in Claude Code).
    // Idempotent overwrite (the Jarvis store is authoritative); called at daemon
    // start. Production only (no-op with an overridden root, like create()).
    // Returns the number of skills mirrored.
    int syncMirrorsToCli();

    // --- invoke ------------------------------------------------------------
    // Render the skill body, substituting {{VAR}} template vars from `vars`
    // plus the builtins {{SKILL_DIR}} (the skill's directory) and {{ARGS}}
    // (the raw args string). Returns the rendered message to inject. Sets
    // *err and returns empty on unknown skill.
    QString invoke(const QString &name, const QString &args,
                   const QJsonObject &vars, QString *err = nullptr,
                   QString *dirOut = nullptr); // resolved skill dir (for stats)

    // --- lifecycle curation (jarvis#76 item 2) ------------------------------
    // Bump use_count / last_used_at for a skill in the Jarvis root. CLI-only
    // skills (no writable Jarvis dir) are skipped silently (returns false).
    bool trackUsage(const QString &name);
    // Same, with the skill dir already resolved (skips the directory rescan —
    // invoke() hands its dir out so the invoke+track pair costs ONE lookup).
    bool trackUsageAt(const QString &skillDirPath);
    // Read/write the _stats.json sidecar for a skill directory.
    static SkillStats readStats(const QString &skillDirPath);
    bool setPinned(const QString &name, bool pinned);
    // Move a skill into <root>/_archived/<group>/<name> (never deletes) and
    // drop its CLI mirror copies (production only). Only Jarvis-root skills
    // can be archived.
    bool archive(const QString &name);
    // Restore an archived skill into the live root and re-mirror it to the
    // CLI dirs so the brain regains access immediately.
    bool unarchive(const QString &name);
    QVector<SkillRow> listArchived();
    // Archive every self-authored, unpinned, non-builtin skill whose last
    // activity (last_used_at, else SKILL.md mtime) is older than thresholdMs.
    // Returns the number archived; names reported via archivedNames.
    int sweepStale(qint64 thresholdMs, QStringList *archivedNames = nullptr);

    // Pure helpers (also unit-tested):
    // Parse a SKILL.md text into (frontmatter, body).
    static bool parse(const QString &text, SkillFrontmatter *fmOut, QString *bodyOut);
    // Serialize frontmatter+body back into a SKILL.md text.
    static QString serialize(const SkillFrontmatter &fm, const QString &body);
    // Substitute {{VAR}} occurrences in `body` from `vars`.
    static QString renderTemplate(const QString &body, const QJsonObject &vars);
    // Sanitize a skill name into a filesystem-safe directory component.
    static QString slug(const QString &name);

private:
    void mirrorToCli(const QString &group, const QString &name, const QString &md,
                     const QVector<SkillScript> &scripts);
    void writeStats(const QString &skillDirPath, const SkillStats &stats);
    QString archivedRoot() const; // <root>/_archived

    QString m_root;          // overrides defaultRoot() when set
    QString m_lastError;
};

} // namespace jarvis
