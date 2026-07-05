// SETTINGS main-screen cards — pure render of the PhoneSettingsTab.qml
// sections (Twilio status, user number, SMS agent, call screening with
// carrier forwarding codes, PSTN allowlist, add-agent, war room). All
// state/actions live in SettingsTab.tsx.

import { For, Show } from "solid-js"

import { theme } from "../../theme"
import { forwardingCodes } from "../api"
import { Chip, Section } from "../ui"

export interface SettingsCardsProps {
  twilioConfigured: () => boolean
  fromNumber: () => string
  userNumber: () => string
  screeningOn: () => boolean
  voiceProfile: () => string
  smsEnabled: () => boolean
  smsAgentExt: () => string
  transport: () => string
  inboundExt: () => string
  screeningExt: () => string
  allowlist: () => Array<{ num: string; lbl: string }>
  alSelected: () => number
  onAlSelect: (i: number) => void
}

export function SettingsCards(props: SettingsCardsProps) {
  const codes = () => forwardingCodes(props.fromNumber())
  return (
    <scrollbox flexGrow={1}>
      <Section title="TWILIO STATUS" />
      <box flexDirection="row" gap={2}>
        <text fg={props.twilioConfigured() ? theme.success : theme.danger}>
          {props.twilioConfigured() ? "Configured" : "Not configured"}
        </text>
        <text fg={theme.text}>{props.fromNumber() || "—"}</text>
        <text fg={theme.violet}>{props.voiceProfile()}</text>
        <text fg={props.screeningOn() ? theme.accent : theme.textFaint} selectable={false}>
          Screening {props.screeningOn() ? "ON" : "OFF"}
        </text>
      </box>

      <Section title="USER PHONE NUMBER" />
      <text fg={props.userNumber() ? theme.text : theme.textFaint}>
        {props.userNumber() || "(not set — u to set)"}
      </text>

      <Section title="TEXT YOUR AGENT (SMS)" />
      <box flexDirection="row" gap={2}>
        <Chip label={props.smsEnabled() ? "ON" : "OFF"} on={props.smsEnabled()} />
        <text fg={theme.textMuted}>
          {props.smsEnabled()
            ? `agent ext ${props.smsAgentExt() || "—"} answers your texts`
            : "inbound texts just land in your inbox"}
        </text>
      </box>

      <Section title="CALL SCREENING" />
      <box flexDirection="row" gap={1}>
        <Chip label="TWILIO (ANYWHERE)" on={props.transport() === "twilio"} />
        <Chip label="BLUETOOTH RELAY (M507)" on={props.transport() === "relay"} />
        <text fg={theme.textMuted}>
          auto-screen {props.screeningOn() ? "ON" : "OFF"} · inbound ext {props.inboundExt() || "—"}{" "}
          · screener ext {props.screeningExt() || "—"}
        </text>
      </box>

      <Show when={props.transport() === "twilio"}>
        <text fg={theme.textMuted} wrapMode="word">
          Carrier forwarding (one-time setup) — dial a code on your phone; undo with ##002#.
        </text>
        <Show when={codes().placeholder}>
          <text fg={theme.amber} wrapMode="word">
            ⚠ No Twilio number configured — codes below show the +15551234567 PLACEHOLDER, do
            not dial them as-is.
          </text>
        </Show>
        <box flexDirection="row" gap={2}>
          <For each={codes().gsm}>
            {(c) => (
              <text fg={theme.accent} selectable={false}>
                {`${c.lbl}: ${c.code}`}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2}>
          <For each={codes().vz}>
            {(c) => (
              <text fg={theme.accent} selectable={false}>
                {`${c.lbl}: ${c.code}`}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.transport() === "relay"}>
        <text fg={theme.amber} wrapMode="word">
          M507 Bluetooth relay — pair in system settings. Calls are auto-answered and audio
          routes to the puck; no carrier forwarding needed.
        </text>
      </Show>

      <Section title="PSTN ALLOWLIST" />
      <For each={props.allowlist()} fallback={<text fg={theme.textFaint}>No numbers allowlisted</text>}>
        {(row, i) => (
          <box
            flexDirection="row"
            gap={1}
            backgroundColor={i() === props.alSelected() ? theme.surfaceStrong : undefined}
            onMouseDown={() => props.onAlSelect(i())}
          >
            <text fg={theme.text}>{row.num}</text>
            <Show when={row.lbl}>
              <text fg={theme.textFaint}>{row.lbl}</text>
            </Show>
          </box>
        )}
      </For>

      <Section title="ADD NEW AGENT" />
      <text fg={theme.textMuted} wrapMode="word">
        n — mint an extension + token and register an inbound agent.
      </text>

      <Section title="WAR ROOM" />
      <text fg={theme.textMuted} wrapMode="word">
        w — RED ALERT broadcasts to every agent and opens a war-room thread.
      </text>
    </scrollbox>
  )
}
