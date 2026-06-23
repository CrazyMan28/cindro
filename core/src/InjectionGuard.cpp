#include "jarvis/InjectionGuard.h"

#include <QRegularExpression>
#include <QUrl>

namespace jarvis {

QString InjectionGuard::Result::summary() const
{
    if (!risky)
        return QStringLiteral("No injection cues detected.");
    QString s = QStringLiteral("Possible prompt injection / risky action (%1 risk): ")
                    .arg(risk);
    s += cues.join(QStringLiteral("; "));
    return s;
}

namespace {

// A scored cue: a case-insensitive substring/regex and the risk weight it adds.
struct Cue {
    const char *pattern; // regex (case-insensitive)
    int weight;          // contribution to the risk score
    const char *label;   // shown in the approval summary
};

// Ordered roughly high-signal first. Weights: a single >=3 cue, or >=2 total,
// trips the gate (see thresholds below).
const Cue kCues[] = {
    // Classic instruction-override injections.
    {R"(ignore (all )?(the )?(previous|prior|above)\b.{0,20}\binstructions?)", 3,
     "instruction-override ('ignore previous instructions')"},
    {R"(disregard (the )?(previous|above|prior)\b)", 3, "instruction-override ('disregard the above')"},
    {R"(forget (everything|all)\b.{0,20}\b(said|instructions?|told))", 2,
     "instruction-override ('forget everything')"},
    {R"(you are now\b.{0,40}\b(dan|jailbreak|developer mode|unrestricted))", 3,
     "jailbreak persona switch"},
    {R"(new (system )?(prompt|instructions?)\s*:)", 2, "embedded new-instructions block"},

    // Credential / secret exfiltration.
    {R"(exfiltrat)", 3, "exfiltration verb"},
    {R"((send|email|post|upload|leak|share)\b.{0,30}\b(credential|password|secret|token|api[ _-]?key|cookie|session))", 3,
     "credential/cookie exfiltration request"},
    {R"((your|the|my)\b.{0,15}\b(\.env|environment variable|ssh key|private key|aws|secret))", 2,
     "secrets reference"},
    {R"(curl\b.{0,80}\b(http|https)://)", 2, "embedded curl to a URL"},
    {R"((paste|reveal|print|show)\b.{0,20}\b(the )?(system prompt|your instructions))", 2,
     "system-prompt extraction"},

    // Destructive shell.
    {R"(rm\s+-rf\s+[~/])", 3, "destructive shell (rm -rf)"},
    {R"(:\(\)\s*\{\s*:\|:&\s*\}\s*;:)", 3, "fork bomb"},
    {R"(\bmkfs\b|\bdd\s+if=.{0,20}of=/dev/)", 3, "disk-wipe command"},
};

// A long base64-looking blob embedded in page text is a common stego /
// exfil-payload smell. Match a run of >=120 base64 chars.
const QRegularExpression &base64Blob()
{
    static const QRegularExpression re(QStringLiteral("[A-Za-z0-9+/]{120,}={0,2}"));
    return re;
}

// True if a URL is an off-host (external) HTTP(S) target: not localhost / a
// loopback / the tailnet engine. Used to flag unexpected external POSTs.
bool isExternalUrl(const QString &raw)
{
    const QUrl u(raw);
    if (!u.isValid() || u.scheme().isEmpty())
        return false;
    if (u.scheme() != QStringLiteral("http") && u.scheme() != QStringLiteral("https"))
        return false;
    const QString host = u.host();
    if (host.isEmpty())
        return false;
    if (host == QStringLiteral("localhost") || host == QStringLiteral("127.0.0.1") ||
        host == QStringLiteral("::1") || host.startsWith(QStringLiteral("100.")) ||
        host.startsWith(QStringLiteral("192.168.")) || host.startsWith(QStringLiteral("10.")) ||
        host.startsWith(QStringLiteral("172.16.")))
        return false;
    return true;
}

// Map an accumulated score to a tier. A single weight-3 cue => high; >=2 total
// => medium; below that => low (not risky).
void scoreToTier(int score, bool sawHigh, InjectionGuard::Result *r)
{
    if (sawHigh || score >= 3) {
        r->risky = true;
        r->risk = QStringLiteral("high");
    } else if (score >= 2) {
        r->risky = true;
        r->risk = QStringLiteral("medium");
    } else {
        r->risky = false;
        r->risk = QStringLiteral("low");
    }
}

} // namespace

InjectionGuard::Result InjectionGuard::scanText(const QString &text, const QString &context)
{
    Result r;
    if (text.trimmed().isEmpty())
        return r;

    int score = 0;
    bool sawHigh = false;

    for (const Cue &c : kCues) {
        QRegularExpression re(QString::fromLatin1(c.pattern),
                              QRegularExpression::CaseInsensitiveOption |
                                  QRegularExpression::DotMatchesEverythingOption);
        if (re.match(text).hasMatch()) {
            score += c.weight;
            if (c.weight >= 3)
                sawHigh = true;
            r.cues << QString::fromLatin1(c.label);
        }
    }

    // Large embedded base64 blob (only meaningful for longer page text, not a
    // short legitimately-base64 argument like an image — caller passes image
    // bytes out-of-band, never as scanned text).
    if (text.size() > 200) {
        const auto m = base64Blob().match(text);
        if (m.hasMatch()) {
            score += 2;
            r.cues << QStringLiteral("large embedded base64 blob");
        }
    }

    scoreToTier(score, sawHigh, &r);

    if (r.risky && !context.isEmpty())
        r.cues.prepend(QStringLiteral("[%1]").arg(context));
    return r;
}

InjectionGuard::Result InjectionGuard::scanToolCall(const QString &toolName, const QString &argsJson)
{
    // Start from the text cues over the rendered args.
    Result r = scanText(argsJson, toolName);

    // Extra: an unexpected external POST/network call. We look for any http(s)
    // URL token in the args that resolves to an off-host target and treat it as
    // medium (combined with any text cue it escalates).
    static const QRegularExpression urlRe(
        QStringLiteral(R"((https?://[^\s"'<>\)]+))"));
    auto it = urlRe.globalMatch(argsJson);
    bool sawExternal = false;
    while (it.hasNext()) {
        const QString url = it.next().captured(1);
        if (isExternalUrl(url)) {
            sawExternal = true;
            break;
        }
    }
    if (sawExternal) {
        const QString tl = toolName.toLower();
        // Network-sending tools (fetch/post/http/curl/upload/exec) to an external
        // host are the risky combination; a plain navigate is informational.
        const bool sendish = tl.contains(QStringLiteral("post")) ||
                             tl.contains(QStringLiteral("fetch")) ||
                             tl.contains(QStringLiteral("http")) ||
                             tl.contains(QStringLiteral("upload")) ||
                             tl.contains(QStringLiteral("curl")) ||
                             tl.contains(QStringLiteral("request")) ||
                             tl.contains(QStringLiteral("exec")) ||
                             tl.contains(QStringLiteral("eval"));
        if (sendish) {
            r.cues << QStringLiteral("unexpected external network call");
            if (!r.risky) {
                r.risky = true;
                r.risk = QStringLiteral("medium");
            } else if (r.risk == QStringLiteral("medium")) {
                r.risk = QStringLiteral("high"); // text cue + external POST
            }
            if (!r.cues.contains(QStringLiteral("[%1]").arg(toolName)) &&
                !toolName.isEmpty())
                r.cues.prepend(QStringLiteral("[%1]").arg(toolName));
        }
    }
    return r;
}

} // namespace jarvis
