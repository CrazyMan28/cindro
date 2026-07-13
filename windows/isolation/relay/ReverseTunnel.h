#pragma once

// ReverseTunnel -- Windows v2 reachability (DESIGN.md gap #2).
//
// The agent's computer-use engine runs INSIDE an isolated desktop (a Windows
// Sandbox / NAT'd Hyper-V guest). It binds 0.0.0.0:<port> in there, but the host
// daemon must reach it at 127.0.0.1:<port> -- the address AgentDesktop::engineBase()
// returns and the brain's MCP config bakes in. A Sandbox is on a NAT'd network the
// host cannot dial INBOUND, so we invert it: the in-sandbox side dials OUT to the
// host (reachable via the sandbox's default gateway), and the host pairs each
// inbound daemon connection with one waiting sandbox connection, then splices bytes
// both ways. The result is a transparent TCP forwarder -- video (/video/mjpeg),
// MCP (/mcp) and health (/health,/ready) all flow over it unchanged.
//
// Pure Qt Network (QTcpServer/QTcpSocket) -- compiles anywhere Qt6::Network does
// (the Linux cross-check builds it even though only a real Windows box with a
// Sandbox can exercise it end to end).
//
//   host side (this process, used by AgentDesktop):  ReverseTunnel
//   sandbox side (jarvis-relay.exe `dial`, run by bootstrap.ps1):  TunnelDialer

#include <QHostAddress>
#include <QObject>
#include <QPointer>
#include <QQueue>

QT_BEGIN_NAMESPACE
class QTcpServer;
class QTcpSocket;
QT_END_NAMESPACE

namespace jarvis {

// Bidirectional byte pump between two connected sockets. Owns both sockets and
// deletes itself (and them) when either side closes or errors.
class SocketBridge : public QObject {
    Q_OBJECT
public:
    SocketBridge(QTcpSocket *a, QTcpSocket *b, QObject *parent = nullptr);

private:
    void pump(QTcpSocket *from, QTcpSocket *to);
    void tearDown();
    QPointer<QTcpSocket> m_a;
    QPointer<QTcpSocket> m_b;
    bool m_dead = false;
};

// Host side of the reverse tunnel: re-expose the in-sandbox engine at a host
// loopback port. Pools sandbox-initiated connections and pairs them FIFO with
// inbound daemon connections.
class ReverseTunnel : public QObject {
    Q_OBJECT
public:
    explicit ReverseTunnel(QObject *parent = nullptr);
    ~ReverseTunnel() override;

    // Listen on 127.0.0.1:publicPort (daemon/engineBase() side) and
    // 0.0.0.0:rendezvousPort (the in-sandbox dialer dials here via the host
    // gateway). Returns false if either listener fails to bind.
    bool start(quint16 publicPort, quint16 rendezvousPort);
    void stop();

    bool isListening() const;
    quint16 publicPort() const { return m_publicPort; }
    quint16 rendezvousPort() const { return m_rendezvousPort; }

    // How long a daemon connection waits for a sandbox tunnel before we give up
    // and close it (ms). Generous: the sandbox may still be booting.
    void setPairTimeoutMs(int ms) { m_pairTimeoutMs = ms; }

    // AUTH GATE (jarvis#104 Codex review follow-up): the rendezvous listener binds
    // 0.0.0.0 so the sandbox's NAT'd dialer can reach it via the host gateway --
    // which also means any device on the same LAN can open a TCP connection to
    // it. Without this, pairing was FIFO with no verification: a LAN peer that
    // connected before the real in-sandbox relay would get paired with the
    // host's own client (which sends the session bearer in its first HTTP
    // request), leaking it, or just blackhole readiness by never responding.
    // Set to the session's bearer so every rendezvous connection must present it
    // as its first line before being admitted to the pairing pool; anything
    // else (wrong token, no token, timeout) is dropped before it ever touches
    // m_idleTunnels. Empty (the default) preserves the old unauthenticated
    // behavior, used only by the standalone `jarvis-relay host` diagnostic CLI
    // when run without --bearer.
    void setExpectedHandshake(const QString &token) { m_expectedHandshake = token; }

private slots:
    void onPublicConnection();
    void onRendezvousConnection();

private:
    void tryPair();
    void dropDead();
    void admitRendezvousTunnel(QTcpSocket *tunnel);

    QTcpServer *m_public = nullptr;     // 127.0.0.1:<publicPort> (daemon side)
    QTcpServer *m_rendezvous = nullptr; // 0.0.0.0:<rendezvousPort> (sandbox side)
    QQueue<QPointer<QTcpSocket>> m_waitingClients; // daemon conns awaiting a tunnel
    QQueue<QPointer<QTcpSocket>> m_idleTunnels;     // sandbox conns awaiting a client
    quint16 m_publicPort = 0;
    quint16 m_rendezvousPort = 0;
    int m_pairTimeoutMs = 60000;
    QString m_expectedHandshake;
};

// Sandbox side of the reverse tunnel. Run by jarvis-relay.exe in `dial` mode
// (launched by bootstrap.ps1 inside the box). Keeps a small pool of outbound
// connections to the host rendezvous endpoint; when the host pairs one (first
// inbound byte) it lazily dials the local engine and splices the two.
class TunnelDialer : public QObject {
    Q_OBJECT
public:
    explicit TunnelDialer(QObject *parent = nullptr);

    // host:rendezvousPort = the host gateway rendezvous (where to dial OUT);
    // engineHost:enginePort = the local engine inside the box (127.0.0.1:<port>);
    // poolSize = idle outbound connections kept ready for instant pairing.
    void start(const QHostAddress &host, quint16 rendezvousPort,
               const QHostAddress &engineHost, quint16 enginePort,
               int poolSize = 4);

    // AUTH GATE: the token this dialer presents as the first line on every newly
    // dialed rendezvous connection, matching ReverseTunnel::setExpectedHandshake()
    // on the host. Must be set BEFORE start() dials the initial pool. Empty (the
    // default) sends no handshake, matching a host with no expected token set.
    void setHandshakeToken(const QString &token) { m_handshakeToken = token; }

private:
    void replenish();
    void onTunnelActivated(QTcpSocket *tunnel);
    void retireBeforeActivation(QTcpSocket *tunnel);

    QHostAddress m_host;
    QHostAddress m_engineHost;
    quint16 m_rendezvousPort = 0;
    quint16 m_enginePort = 0;
    int m_poolSize = 4;
    int m_outstanding = 0; // connecting-or-idle tunnels not yet activated
    QString m_handshakeToken;
};

} // namespace jarvis
