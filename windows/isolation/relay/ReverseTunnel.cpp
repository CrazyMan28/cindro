#include "ReverseTunnel.h"

#include <QDebug>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>

// DIAG: both sides of the pairing logic below were completely silent (no
// qDebug/qWarning anywhere in this file) until issue-104 debugging needed to
// distinguish "the sandbox-side dial never reaches the host" from "it reaches the
// host but pairing itself never completes" -- a raw TCP probe from bootstrap.ps1
// proved the rendezvous port IS reachable, yet /health still timed out, so the
// remaining fault has to be visible only from inside this pairing state machine.
// Left in permanently (stderr-only, negligible cost) since this is genuinely
// useful ongoing operability logging for a component that had none.

namespace jarvis {

// ===========================================================================
// SocketBridge
// ===========================================================================
SocketBridge::SocketBridge(QTcpSocket *a, QTcpSocket *b, QObject *parent)
    : QObject(parent), m_a(a), m_b(b)
{
    // Own both sockets so their lifetime is the bridge's.
    a->setParent(this);
    b->setParent(this);

    connect(a, &QTcpSocket::readyRead, this, [this]() { pump(m_a, m_b); });
    connect(b, &QTcpSocket::readyRead, this, [this]() { pump(m_b, m_a); });
    connect(a, &QTcpSocket::disconnected, this, [this]() { tearDown(); });
    connect(b, &QTcpSocket::disconnected, this, [this]() { tearDown(); });
    connect(a, &QAbstractSocket::errorOccurred, this, [this]() { tearDown(); });
    connect(b, &QAbstractSocket::errorOccurred, this, [this]() { tearDown(); });

    // Drain anything already buffered before the readyRead wiring (e.g. the first
    // HTTP request that arrived while the pairing was being set up). Writing to a
    // still-connecting peer is fine -- QAbstractSocket buffers and flushes on
    // connect.
    pump(m_a, m_b);
    pump(m_b, m_a);
}

void SocketBridge::pump(QTcpSocket *from, QTcpSocket *to)
{
    if (!from || !to)
        return;
    const QByteArray chunk = from->readAll();
    if (!chunk.isEmpty() && to->state() != QAbstractSocket::UnconnectedState)
        to->write(chunk);
}

void SocketBridge::tearDown()
{
    if (m_dead)
        return;
    m_dead = true;
    // Final flush of anything still buffered before we close.
    if (m_a && m_b) {
        pump(m_a, m_b);
        pump(m_b, m_a);
    }
    if (m_a) {
        m_a->disconnect(this);
        m_a->close();
    }
    if (m_b) {
        m_b->disconnect(this);
        m_b->close();
    }
    deleteLater();
}

// ===========================================================================
// ReverseTunnel (host side)
// ===========================================================================
ReverseTunnel::ReverseTunnel(QObject *parent) : QObject(parent) {}

ReverseTunnel::~ReverseTunnel()
{
    stop();
}

bool ReverseTunnel::start(quint16 publicPort, quint16 rendezvousPort)
{
    stop();
    m_publicPort = publicPort;
    m_rendezvousPort = rendezvousPort;

    m_public = new QTcpServer(this);
    connect(m_public, &QTcpServer::newConnection, this,
            &ReverseTunnel::onPublicConnection);
    // Loopback only: the daemon (and engineBase()) reach the engine at
    // 127.0.0.1:<publicPort>. Never exposed off-box.
    if (!m_public->listen(QHostAddress::LocalHost, publicPort)) {
        qWarning() << "ReverseTunnel: failed to bind public 127.0.0.1:" << publicPort
                   << m_public->errorString();
        stop();
        return false;
    }

    m_rendezvous = new QTcpServer(this);
    connect(m_rendezvous, &QTcpServer::newConnection, this,
            &ReverseTunnel::onRendezvousConnection);
    // AnyIPv4 so the in-sandbox dialer can reach it via the host gateway (the
    // sandbox sees the host on its NAT subnet, not on loopback).
    if (!m_rendezvous->listen(QHostAddress::AnyIPv4, rendezvousPort)) {
        qWarning() << "ReverseTunnel: failed to bind rendezvous 0.0.0.0:" << rendezvousPort
                   << m_rendezvous->errorString();
        stop();
        return false;
    }
    qDebug() << "ReverseTunnel: listening public 127.0.0.1:" << publicPort
             << "rendezvous 0.0.0.0:" << rendezvousPort;
    return true;
}

void ReverseTunnel::stop()
{
    if (m_public) {
        m_public->close();
        m_public->deleteLater();
        m_public = nullptr;
    }
    if (m_rendezvous) {
        m_rendezvous->close();
        m_rendezvous->deleteLater();
        m_rendezvous = nullptr;
    }
    while (!m_waitingClients.isEmpty()) {
        if (QTcpSocket *s = m_waitingClients.dequeue())
            s->deleteLater();
    }
    while (!m_idleTunnels.isEmpty()) {
        if (QTcpSocket *s = m_idleTunnels.dequeue())
            s->deleteLater();
    }
}

bool ReverseTunnel::isListening() const
{
    return m_public && m_public->isListening() && m_rendezvous &&
           m_rendezvous->isListening();
}

void ReverseTunnel::onPublicConnection()
{
    while (m_public && m_public->hasPendingConnections()) {
        QTcpSocket *client = m_public->nextPendingConnection();
        client->setParent(this);
        m_waitingClients.enqueue(client);
        qDebug() << "ReverseTunnel: public client connected from"
                 << client->peerAddress().toString() << "waitingClients="
                 << m_waitingClients.size() << "idleTunnels=" << m_idleTunnels.size();
        // If no tunnel turns up in time, close the client rather than hang.
        QPointer<QTcpSocket> guard(client);
        QTimer::singleShot(m_pairTimeoutMs, this, [this, guard]() {
            if (guard && m_waitingClients.contains(guard)) {
                m_waitingClients.removeOne(guard);
                guard->close();
                guard->deleteLater();
            }
        });
        // A client that gives up and disconnects EARLY (e.g. a short-timeout
        // caller like httpGetOk()'s per-attempt 1000ms budget for /health)
        // would otherwise sit as a dead entry at the head of the strict-FIFO
        // m_waitingClients queue until the full m_pairTimeoutMs (the whole
        // cold-boot budget) elapses -- dropDead() only prunes null QPointers,
        // not merely-disconnected-but-not-yet-deleted sockets. The NEXT idle
        // tunnel that becomes available would then get wasted pairing with
        // this zombie instead of a real, still-waiting request, starving it.
        // Mirrors admitRendezvousTunnel()'s equivalent idle-tunnel cleanup.
        connect(client, &QAbstractSocket::disconnected, this, [this, guard]() {
            if (guard && m_waitingClients.contains(guard)) {
                m_waitingClients.removeOne(guard);
                guard->deleteLater();
            }
        });
    }
    tryPair();
}

void ReverseTunnel::onRendezvousConnection()
{
    while (m_rendezvous && m_rendezvous->hasPendingConnections()) {
        QTcpSocket *tunnel = m_rendezvous->nextPendingConnection();
        tunnel->setParent(this);
        qDebug() << "ReverseTunnel: rendezvous tunnel connected from"
                 << tunnel->peerAddress().toString();

        if (m_expectedHandshake.isEmpty()) {
            // No token configured (standalone `jarvis-relay host` diagnostic CLI
            // run without --bearer) -- admit unconditionally, matching the old
            // unauthenticated behavior.
            admitRendezvousTunnel(tunnel);
            continue;
        }

        // See setExpectedHandshake()'s header for why this gate exists. Every
        // connection must present the correct token as its first line, within a
        // short timeout, before it is ever added to m_idleTunnels.
        QPointer<QTcpSocket> guard(tunnel);
        auto *timeout = new QTimer(tunnel);
        timeout->setSingleShot(true);
        connect(timeout, &QTimer::timeout, this, [this, guard]() {
            if (!guard)
                return;
            qWarning() << "ReverseTunnel: rendezvous connection from"
                       << guard->peerAddress().toString()
                       << "never presented a handshake token -- dropped";
            guard->disconnect(this);
            guard->close();
            guard->deleteLater();
        });
        timeout->start(5000);
        auto checkHandshake = [this, guard, timeout]() {
            if (!guard || !guard->canReadLine())
                return;
            const QString line = QString::fromUtf8(guard->readLine()).trimmed();
            timeout->stop();
            timeout->deleteLater();
            guard->disconnect(this); // drop this handshake handler either way
            if (line != m_expectedHandshake) {
                qWarning() << "ReverseTunnel: rendezvous connection from"
                           << guard->peerAddress().toString()
                           << "presented an invalid handshake token -- dropped";
                guard->close();
                guard->deleteLater();
                return;
            }
            admitRendezvousTunnel(guard.data());
        };
        connect(tunnel, &QTcpSocket::readyRead, this, checkHandshake);
        // A tunnel that disconnects mid-handshake (never admitted) would
        // otherwise leak: it's parented to `this` and nothing else ever calls
        // deleteLater() on it once it's neither in m_idleTunnels nor reached by
        // the readyRead/timeout handlers above (both of which disconnect(this)
        // on completion, removing this lambda's connection too).
        connect(tunnel, &QAbstractSocket::disconnected, this, [guard, timeout]() {
            if (timeout)
                timeout->deleteLater();
            if (guard)
                guard->deleteLater();
        });
        // Drain anything already buffered before the readyRead wiring above --
        // same issue SocketBridge's constructor already works around (see its
        // header): Qt only emits readyRead for data that arrives AFTER a
        // receiver is connected, so a handshake line that arrived fast enough
        // (a LAN/NAT hop is quick) to already be sitting in the socket's buffer
        // by the time nextPendingConnection() handed us this socket would
        // otherwise never trigger checkHandshake() above -- silently rejecting
        // a perfectly legitimate sandbox relay connection once the 5s timeout
        // fires. Found via two real end-to-end test failures immediately after
        // this handshake was added (intermittent /health and /ready timeouts).
        checkHandshake();
    }
    tryPair();
}

void ReverseTunnel::admitRendezvousTunnel(QTcpSocket *tunnel)
{
    if (!tunnel)
        return;
    // If an idle tunnel drops before it is paired, drop it from the pool.
    QPointer<QTcpSocket> guard(tunnel);
    connect(tunnel, &QTcpSocket::disconnected, this, [this, guard]() {
        if (guard && m_idleTunnels.contains(guard)) {
            m_idleTunnels.removeOne(guard);
            guard->deleteLater();
            qDebug() << "ReverseTunnel: idle tunnel disconnected before pairing";
        }
    });
    m_idleTunnels.enqueue(tunnel);
    tryPair();
}

void ReverseTunnel::dropDead()
{
    // Purge any QPointers nulled by a deleteLater between events.
    while (!m_waitingClients.isEmpty() && m_waitingClients.head().isNull())
        m_waitingClients.dequeue();
    while (!m_idleTunnels.isEmpty() && m_idleTunnels.head().isNull())
        m_idleTunnels.dequeue();
}

void ReverseTunnel::tryPair()
{
    dropDead();
    while (!m_waitingClients.isEmpty() && !m_idleTunnels.isEmpty()) {
        QPointer<QTcpSocket> client = m_waitingClients.dequeue();
        QPointer<QTcpSocket> tunnel = m_idleTunnels.dequeue();
        if (!client) {
            if (tunnel)
                m_idleTunnels.prepend(tunnel); // tunnel still usable; requeue
            continue;
        }
        if (!tunnel) {
            m_waitingClients.prepend(client); // client still waiting; requeue
            continue;
        }
        // Hand both sockets to a self-owning bridge; drop our disconnected hook
        // on the tunnel first so the bridge fully owns its lifetime.
        tunnel->disconnect(this);
        qDebug() << "ReverseTunnel: paired client<->tunnel";
        new SocketBridge(client.data(), tunnel.data(), this);
    }
}

// ===========================================================================
// TunnelDialer (sandbox side)
// ===========================================================================
TunnelDialer::TunnelDialer(QObject *parent) : QObject(parent) {}

void TunnelDialer::start(const QHostAddress &host, quint16 rendezvousPort,
                         const QHostAddress &engineHost, quint16 enginePort,
                         int poolSize)
{
    m_host = host;
    m_rendezvousPort = rendezvousPort;
    m_engineHost = engineHost;
    m_enginePort = enginePort;
    m_poolSize = poolSize > 0 ? poolSize : 1;
    replenish();
}

void TunnelDialer::replenish()
{
    while (m_outstanding < m_poolSize) {
        auto *tunnel = new QTcpSocket(this);
        ++m_outstanding;

        connect(tunnel, &QTcpSocket::readyRead, this,
                [this, tunnel]() { onTunnelActivated(tunnel); });
        connect(tunnel, &QAbstractSocket::errorOccurred, this,
                [this, tunnel](QAbstractSocket::SocketError) {
                    qWarning() << "TunnelDialer: tunnel connect/IO error:"
                               << tunnel->errorString();
                    retireBeforeActivation(tunnel);
                });
        connect(tunnel, &QTcpSocket::disconnected, this,
                [this, tunnel]() { retireBeforeActivation(tunnel); });
        connect(tunnel, &QTcpSocket::connected, this, [this, tunnel]() {
            qDebug() << "TunnelDialer: tunnel connected to"
                     << tunnel->peerAddress().toString() << ":" << tunnel->peerPort();
            // AUTH HANDSHAKE: present the session bearer as the first line so the
            // host's ReverseTunnel can verify this connection is really the
            // in-sandbox relay before admitting it to the pairing pool -- see
            // ReverseTunnel::onRendezvousConnection()'s header. No-op (old,
            // unauthenticated behavior) if no token was configured.
            if (!m_handshakeToken.isEmpty())
                tunnel->write(m_handshakeToken.toUtf8() + "\n");
        });

        tunnel->connectToHost(m_host, m_rendezvousPort);
    }
}

void TunnelDialer::onTunnelActivated(QTcpSocket *tunnel)
{
    if (!tunnel)
        return;
    // First inbound byte == the host paired this tunnel with a daemon client.
    // Hand it off to a bridge that splices it to a freshly dialed engine socket.
    // Detach our own handlers so retireBeforeActivation / readyRead can't double-fire.
    tunnel->disconnect(this);
    --m_outstanding;
    qDebug() << "TunnelDialer: tunnel activated (paired by host); dialing engine"
             << m_engineHost.toString() << ":" << m_enginePort;

    auto *engine = new QTcpSocket(this);
    engine->connectToHost(m_engineHost, m_enginePort);
    // Bridge now; bytes buffered on `tunnel` flush to `engine` once it connects
    // (and writes to `engine` while it is still connecting are buffered by Qt).
    new SocketBridge(tunnel, engine, this);

    // Keep the idle pool full so the next pairing is instant.
    replenish();
}

void TunnelDialer::retireBeforeActivation(QTcpSocket *tunnel)
{
    if (!tunnel)
        return;
    tunnel->disconnect(this);
    if (m_outstanding > 0)
        --m_outstanding;
    tunnel->deleteLater();
    // Retry to restore the pool (e.g. the host rendezvous not up yet). Schedule
    // so a connection storm backs off a tick instead of spinning.
    QTimer::singleShot(500, this, [this]() { replenish(); });
}

} // namespace jarvis
