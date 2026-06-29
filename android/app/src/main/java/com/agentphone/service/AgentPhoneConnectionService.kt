package com.agentphone.service

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle

class AgentPhoneConnectionService : ConnectionService() {
    override fun onCreateOutgoingConnection(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        return AgentPhoneConnection().apply {
            setInitializing()
            setActive()
        }
    }

    override fun onCreateIncomingConnection(connectionManagerPhoneAccount: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        return AgentPhoneConnection().apply {
            setRinging()
        }
    }
}

class AgentPhoneConnection : Connection() {
    override fun onAnswer() {
        setActive()
    }

    override fun onReject() {
        setDisconnected(android.telecom.DisconnectCause(android.telecom.DisconnectCause.REJECTED))
        destroy()
    }

    override fun onDisconnect() {
        setDisconnected(android.telecom.DisconnectCause(android.telecom.DisconnectCause.LOCAL))
        destroy()
    }
}
