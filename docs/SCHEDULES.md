# Scheduled / sequential work — how it works

How a Jarvis scheduled job (cron/at) runs, where its output goes, and how the user
is told. Implemented in `Scheduler` (fires) + `ControlServer::fireScheduledJob`
(runs) + `DeviceServer` (notifies).

## Create
- `schedule.create {name, cron|when, prompt, brain?, model?, profile?}` (or the
  `schedule_task` MCP tool / the phone Schedules screen / desktop Schedules page).
- `when` accepts a 5-field cron, `every 30m`, or `at 14:30`. Stored in `schedules`.
- `ScheduleRow::targetRef` (`target` param) is a free-text ref, no FK — its
  first real consumer is the Proxmox workload manager
  (`docs/PROXMOX_WORKLOAD_MANAGER.md`): a targetRef of `"proxmox-<hostname>"`
  is threaded through `fireScheduledJob` → `createSession`'s
  `scheduleTargetRef` param → `SessionRow::targetRef`, and
  `ControlServer::makeBrain`'s api-brain branch checks it to route the
  session's MCP endpoint at that agent's own tool server instead of the
  desktop engine. Any future per-target routing can follow the same pattern.

## Fire (when the cadence ticks)
`Scheduler` ticks → `ControlServer::fireScheduledJob(row)`:
1. **Creates a NEW session** (a NEW chat) titled with the job's `name`, using the
   row's brain/model/profile (else daemon defaults). **It does NOT reuse an open
   chat** — every fire is its own isolated conversation, so a recurring job builds
   a clean history per run and never collides with whatever you're typing.
2. Sends the job's `prompt` as the first turn; the brain runs it like any session.
3. The session shows up in the Sessions list (desktop + phone) and can be opened,
   continued, or deleted like any other.

## Notify the user
- The new session broadcasts `session.opened` → connected desktop/phone surfaces
  raise/refresh.
- `fireScheduledJob` ALSO sends an **FCM push** `{title:"Scheduled task started",
  body:<job name>, data:{kind:"schedule_fired", session_id}}` to every paired
  phone — so even a backgrounded phone is notified the moment the job starts.
  Tapping it deep-links into that session's chat (the phone already routes
  `session_id` deep-links).
- When the run finishes its turn, the existing `final` notification ("Task
  complete") fires.

## Summary of the answers
- **New chat or existing?** New chat (new session) per fire.
- **Notification on start?** Yes — FCM push to the phone + a `session.opened`
  raise on connected surfaces.
- **Where's the output?** In that scheduled session's transcript (openable from
  Sessions on either surface).

## Possible follow-ups (not yet built)
- A "scheduled" tag/filter in the Sessions list so recurring runs group together.
- Option to APPEND recurring runs into one rolling session instead of a new one
  per fire (a per-schedule toggle).
