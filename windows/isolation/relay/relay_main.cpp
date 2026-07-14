// jarvis-relay.exe -- the reverse-tunnel CLI for the Windows v2 agent desktop.
//
// Two modes (see ReverseTunnel.h / DESIGN.md gap #2):
//
//   dial   (run INSIDE the isolated agent box by bootstrap.ps1)
//          Keep a pool of outbound connections to the host rendezvous endpoint;
//          on pairing, splice each to the local engine. This is what makes the
//          in-sandbox engine reachable from the host without inbound routing.
//
//          jarvis-relay.exe dial --host <gatewayIP> --rendezvous <rport>
//                                --engine-port <port> [--engine-host 127.0.0.1]
//                                [--pool 4]
//
//   host   (optional; the daemon normally runs ReverseTunnel in-process, but this
//          mode lets the relay run standalone / be smoke-tested on any box)
//
//          jarvis-relay.exe host --public <port> --rendezvous <rport>
//
// Pure Qt; the same binary is staged next to jarvis-engine.exe so the read-only
// MappedFolder exposes it at C:\engine\jarvis-relay.exe inside the sandbox.

#include "ReverseTunnel.h"

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QHostAddress>
#include <QTextStream>

using namespace jarvis;

static int runDial(const QCommandLineParser &p, QCoreApplication &app)
{
    QTextStream err(stderr);
    const QString hostStr = p.value("host");
    const QHostAddress host(hostStr);
    if (hostStr.isEmpty() || host.isNull()) {
        err << "dial: --host <gatewayIP> is required (bootstrap.ps1 resolves the "
               "sandbox default gateway and passes it).\n";
        return 2;
    }
    bool okR = false, okE = false, okP = true;
    const quint16 rport = quint16(p.value("rendezvous").toUInt(&okR));
    const quint16 eport = quint16(p.value("engine-port").toUInt(&okE));
    const int pool = p.isSet("pool") ? p.value("pool").toInt(&okP) : 4;
    if (!okR || !okE || !okP || rport == 0 || eport == 0) {
        err << "dial: --rendezvous and --engine-port must be valid ports.\n";
        return 2;
    }
    QString engHostStr = p.value("engine-host");
    if (engHostStr.isEmpty())
        engHostStr = QStringLiteral("127.0.0.1");
    const QHostAddress engineHost(engHostStr);
    if (engineHost.isNull()) {
        err << "dial: --engine-host is not a valid address.\n";
        return 2;
    }

    auto *dialer = new TunnelDialer(&app);
    // AUTH HANDSHAKE (jarvis#104 Codex review follow-up): without --bearer, the
    // host's ReverseTunnel admits any rendezvous connection unconditionally --
    // see ReverseTunnel::setExpectedHandshake()'s header for why that matters
    // now that the rendezvous port is reachable from the whole LAN, not just the
    // sandbox. bootstrap.ps1 always passes this in production.
    if (p.isSet("bearer"))
        dialer->setHandshakeToken(p.value("bearer"));
    dialer->start(host, rport, engineHost, eport, pool);
    err << "jarvis-relay dial: " << host.toString() << ':' << rport
        << " -> engine " << engineHost.toString() << ':' << eport
        << " (pool " << pool << ")\n";
    err.flush();
    return app.exec();
}

static int runHost(const QCommandLineParser &p, QCoreApplication &app)
{
    QTextStream err(stderr);
    bool okPub = false, okR = false;
    const quint16 pub = quint16(p.value("public").toUInt(&okPub));
    const quint16 rport = quint16(p.value("rendezvous").toUInt(&okR));
    if (!okPub || !okR || pub == 0 || rport == 0) {
        err << "host: --public and --rendezvous must be valid ports.\n";
        return 2;
    }
    auto *tunnel = new ReverseTunnel(&app);
    if (p.isSet("bearer"))
        tunnel->setExpectedHandshake(p.value("bearer"));
    if (!tunnel->start(pub, rport)) {
        err << "host: failed to bind public 127.0.0.1:" << pub
            << " / rendezvous 0.0.0.0:" << rport << '\n';
        return 1;
    }
    err << "jarvis-relay host: 127.0.0.1:" << pub << " <- rendezvous 0.0.0.0:"
        << rport << '\n';
    err.flush();
    return app.exec();
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName("jarvis-relay");

    QCommandLineParser parser;
    parser.setApplicationDescription(
        "Cindro Windows v2 reverse tunnel (dial: in-sandbox; host: standalone).");
    parser.addHelpOption();
    parser.addPositionalArgument("mode", "dial | host");
    parser.addOptions({
        {"host", "Host gateway IP to dial out to (dial mode).", "ip"},
        {"engine-host", "Local engine host inside the box (default 127.0.0.1).", "ip"},
        {"engine-port", "Local engine port inside the box (dial mode).", "port"},
        {"rendezvous", "Rendezvous port (both modes).", "port"},
        {"public", "Host loopback port to re-expose the engine on (host mode).", "port"},
        {"bearer", "Session bearer token; rendezvous connections must present it "
                   "before pairing (both modes, optional).", "token"},
        {"pool", "Idle outbound connections to keep ready (dial mode, default 4).", "n"},
    });
    parser.process(app);

    const QStringList pos = parser.positionalArguments();
    const QString mode = pos.isEmpty() ? QString() : pos.first();
    if (mode == QLatin1String("dial"))
        return runDial(parser, app);
    if (mode == QLatin1String("host"))
        return runHost(parser, app);

    QTextStream(stderr) << "usage: jarvis-relay <dial|host> [options]  (see --help)\n";
    return 2;
}
