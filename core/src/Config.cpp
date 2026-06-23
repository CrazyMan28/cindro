#include "jarvis/Config.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QStringList>
#include <QTextStream>

namespace jarvis {

namespace {

// Strip surrounding whitespace and matching single/double quotes from a TOML value.
QString unquote(QString v)
{
    v = v.trimmed();
    if (v.size() >= 2) {
        const QChar a = v.front();
        const QChar b = v.back();
        if ((a == QLatin1Char('"') && b == QLatin1Char('"')) ||
            (a == QLatin1Char('\'') && b == QLatin1Char('\''))) {
            return v.mid(1, v.size() - 2);
        }
    }
    return v;
}

} // namespace

QString Config::configDir()
{
    // BUILD_SPEC pins ~/.config/jarvis explicitly (not XDG-overridable display name).
    return QDir::homePath() + QStringLiteral("/.config/jarvis");
}

QString Config::configFilePath()
{
    return configDir() + QStringLiteral("/config.toml");
}

QString Config::controlTokenPath()
{
    return configDir() + QStringLiteral("/control_token");
}

QString Config::effectiveCwd() const
{
    if (!defaultCwd.isEmpty())
        return defaultCwd;
    return QDir::homePath();
}

Config Config::load()
{
    return loadFromFile(configFilePath());
}

Config Config::loadFromFile(const QString &path)
{
    QFile f(path);
    if (!f.exists() || !f.open(QIODevice::ReadOnly | QIODevice::Text))
        return Config{};
    const QString text = QString::fromUtf8(f.readAll());
    f.close();
    return parseToml(text);
}

Config Config::parseToml(const QString &text)
{
    Config cfg;
    QString section; // current [section] for dotted keys like ports.control

    const QStringList lines = text.split(QLatin1Char('\n'));
    for (QString line : lines) {
        line = line.trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;

        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']'))) {
            section = line.mid(1, line.size() - 2).trimmed();
            continue;
        }

        const int eq = line.indexOf(QLatin1Char('='));
        if (eq < 0)
            continue;

        QString key = line.left(eq).trimmed();
        QString value = unquote(line.mid(eq + 1));

        // Strip inline comments from unquoted scalar values.
        if (!value.startsWith(QLatin1Char('"')) && !value.startsWith(QLatin1Char('\''))) {
            const int hash = value.indexOf(QLatin1Char('#'));
            if (hash >= 0)
                value = value.left(hash).trimmed();
        }

        // Build the fully-qualified key (section-prefixed unless already dotted).
        QString fq = key;
        if (!section.isEmpty() && !key.contains(QLatin1Char('.')))
            fq = section + QLatin1Char('.') + key;

        if (fq == QStringLiteral("default_brain")) {
            cfg.defaultBrain = value;
        } else if (fq == QStringLiteral("default_model")) {
            cfg.defaultModel = value;
        } else if (fq == QStringLiteral("claude_account")) {
            // Only "max" selects the secondary (Max) account; anything else
            // (including unset/garbage) stays on Pro so the brain never
            // accidentally inherits the Max account.
            cfg.claudeAccount = (value == QStringLiteral("max"))
                                    ? QStringLiteral("max")
                                    : QStringLiteral("pro");
        } else if (fq == QStringLiteral("control_port") ||
                   fq == QStringLiteral("ports.control")) {
            bool ok = false;
            const int p = value.toInt(&ok);
            if (ok)
                cfg.controlPort = p;
        } else if (fq == QStringLiteral("device_port") ||
                   fq == QStringLiteral("ports.device")) {
            bool ok = false;
            const int p = value.toInt(&ok);
            if (ok)
                cfg.devicePort = p;
        } else if (fq == QStringLiteral("default_cwd") ||
                   fq == QStringLiteral("cwd") ||
                   fq == QStringLiteral("cwd.default")) {
            cfg.defaultCwd = value;
        }
    }

    return cfg;
}

} // namespace jarvis
