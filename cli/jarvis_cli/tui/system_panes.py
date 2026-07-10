"""McpPane + PluginsPane + OutpostPane — the SYSTEM group's config/admin
screens, all thin TablePane subclasses over existing Contract-A verbs."""

from __future__ import annotations

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.widgets import DataTable, Input, RichLog, Static

from jarvis_cli.control import ControlError
from jarvis_cli.tui.screens import TablePane, spinner_guard


def _relative_time(ms: float | int | None) -> str:
    """proxmox.report's `created` is unix ms — render short + human, not epoch."""
    if not ms:
        return ""
    import time
    delta = time.time() - ms / 1000
    if delta < 60:
        return "just now"
    if delta < 3600:
        return f"{int(delta // 60)}m ago"
    if delta < 86400:
        return f"{int(delta // 3600)}h ago"
    if delta < 86400 * 30:
        return f"{int(delta // 86400)}d ago"
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


class McpPane(TablePane):
    HINT = "enter: enable/disable · r: refresh"
    COLUMNS = ("name", "transport", "tools", "enabled")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("mcp.list", {})
        return list(res.get("servers", []))

    def to_cells(self, r: dict) -> tuple:
        enabled = r.get("enabled", False)
        return (r.get("name", ""), r.get("transport", ""), str(r.get("tools_count", 0)),
                Text("on" if enabled else "off", style="green" if enabled else "bright_black"))

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "enter":
            row = self.selected()
            if row:
                try:
                    await self.client.call("mcp.set_enabled",
                                           {"id": row.get("id"), "enabled": not row.get("enabled")})
                except ControlError as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()


class PluginsPane(TablePane):
    HINT = "i: install · enter: enable/disable · x: remove · r: refresh"
    COLUMNS = ("name", "kind", "version", "installed", "enabled")

    async def fetch(self) -> list[dict]:
        res = await self.client.call("plugins.catalog", {})
        return list(res.get("plugins", []))

    def to_cells(self, r: dict) -> tuple:
        return (r.get("name", ""), r.get("kind", ""), r.get("version", ""),
                "✓" if r.get("installed") else "", "on" if r.get("enabled") else "off")

    async def on_key(self, event) -> None:
        row = self.selected()
        if event.key == "r":
            self.refresh_data()
        elif event.key == "i" and row:
            try:
                await self.client.call("plugins.install", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "enter" and row:
            try:
                await self.client.call("plugins.set_enabled",
                                       {"id": row.get("id"), "enabled": not row.get("enabled")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()
        elif event.key == "x" and row:
            try:
                await self.client.call("plugins.remove", {"id": row.get("id")})
            except ControlError as exc:
                self.notify(str(exc), severity="error")
            self.refresh_data()


class OutpostPane(TablePane):
    # p/x/r are the original pairing verbs; w/v/g/b/s are the Proxmox
    # Workload Manager additions ("p" was already taken by pair, hence "v"
    # for the VM-status toggle); o/q/i/n are the VM-scout wave. The input
    # doubles as a command line: `answer <qid> <text>` answers an agent
    # question, `pinged add <name> | <HH:MM or condition> | <action> [| vmid]`
    # / `pinged rm <id>` manage watch rules; anything else runs via exec.
    HINT = ("type a command + enter: run on selected · p: pair · x: revoke · r: refresh · "
            "w: install workload mgr · v: proxmox vm status · b: toggle blocklist (vm row) · "
            "s: restart vm — press twice to confirm · g: decision report · o: scout VMs · "
            "q: agent questions · i: VM profile (vm row) · n: pinged rules · "
            "answer/pinged commands via the input")
    COLUMNS = ("machine", "os", "status")
    VM_COLUMNS = ("vmid", "name", "status", "cores", "mem MB", "cpu%", "mem%", "blk", "pend")

    # window for the second "s" keypress that actually fires restart_vm —
    # same arm/disarm-timer shape as app.py's action_quit_confirm.
    RESTART_CONFIRM_WINDOW_S = 4.0

    DEFAULT_CSS = """
    OutpostPane #outpost-vms {
        height: auto;
        max-height: 10;
    }
    OutpostPane #outpost-report {
        height: auto;
        max-height: 8;
    }
    """

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.vm_rows: list[dict] = []
        # Which machine self.vm_rows currently reflects — the "b"/"s" handlers
        # must refuse to act if this doesn't match the CURRENTLY selected
        # machine (e.g. the user moved the cursor in #outpost-machines to a
        # different row without pressing "v" again): otherwise a stale vmid
        # from the previous machine's table gets sent for the new machine.
        self._vms_machine: str | None = None
        self._vms_visible = False
        self._report_visible = False
        self._restart_armed_vmid: int | None = None
        self._restart_confirm_timer = None
        self._scout_timer = None       # 3s poll while a scout runs
        self._scout_machine: str | None = None
        self._scout_requested_at_ms: int = 0
        self._scout_poll_attempts = 0

    def compose(self) -> ComposeResult:
        yield Static(Text(self.HINT, style="bright_black"), classes="pane-hint")
        yield Input(placeholder="command to run on the selected machine", id="outpost-exec")
        table = DataTable(cursor_type="row", id="outpost-machines")
        table.add_columns(*self.COLUMNS)
        yield table
        vm_table = DataTable(cursor_type="row", id="outpost-vms")
        vm_table.add_columns(*self.VM_COLUMNS)
        vm_table.display = False
        yield vm_table
        log = RichLog(id="outpost-report", wrap=True, markup=False)
        log.display = False
        yield log

    async def fetch(self) -> list[dict]:
        res = await self.client.call("outpost.list", {})
        return list(res.get("machines", []))

    def to_cells(self, r: dict) -> tuple:
        status = r.get("status", "")
        return (r.get("name", ""), r.get("os", ""),
                Text(status, style="green" if status == "online" else "bright_black"))

    def _vm_cells(self, r: dict) -> tuple:
        return (str(r.get("vmid", "")), r.get("name", ""), r.get("status", ""),
                str(r.get("cores", "")), str(r.get("memory_mb", "")),
                f"{r.get('cpu_pct', 0):.0f}", f"{r.get('mem_pct', 0):.0f}",
                "⛔" if r.get("blocklisted") else "", "⏳" if r.get("pending_restart") else "")

    # base TablePane.selected()/refresh_data() do a bare query_one(DataTable),
    # which breaks now that this pane has two — point both at #outpost-machines.
    def selected(self) -> dict | None:
        table = self.query_one("#outpost-machines", DataTable)
        if not self.rows or table.cursor_row is None:
            return None
        if 0 <= table.cursor_row < len(self.rows):
            return self.rows[table.cursor_row]
        return None

    def selected_vm(self) -> dict | None:
        table = self.query_one("#outpost-vms", DataTable)
        if not self.vm_rows or table.cursor_row is None:
            return None
        if 0 <= table.cursor_row < len(self.vm_rows):
            return self.vm_rows[table.cursor_row]
        return None

    @work(exclusive=True)
    async def refresh_data(self) -> None:
        import time
        self._last_refresh = time.monotonic()
        async with spinner_guard(self, self.SPINNER_ID):
            try:
                self.rows = await self.fetch()
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.rows = []
                self.notify(str(exc), severity="error", timeout=4)
        table = self.query_one("#outpost-machines", DataTable)
        table.clear()
        for row in self.rows:
            table.add_row(*self.to_cells(row))

    @work(exclusive=True)
    async def refresh_vms(self, machine: str) -> None:
        table = self.query_one("#outpost-vms", DataTable)
        # remember the selected vmid — table.clear() below resets cursor_row
        # to 0, and silently landing "s" (restart) on a different VM than the
        # one the user was actually looking at would be a real safety issue.
        armed_vmid = self.selected_vm().get("vmid") if self.selected_vm() else None
        try:
            res = await self.client.call("proxmox.status", {"machine": machine})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.vm_rows = []
            self.notify(str(exc), severity="error")
            return
        self.vm_rows = list(res.get("vms", []))
        self._vms_machine = machine
        table.clear()
        for r in self.vm_rows:
            table.add_row(*self._vm_cells(r))
        if armed_vmid is not None:
            for i, r in enumerate(self.vm_rows):
                if r.get("vmid") == armed_vmid:
                    table.cursor_coordinate = (i, 0)
                    break

    @work(exclusive=True)
    async def refresh_report(self, machine: str) -> None:
        try:
            res = await self.client.call("proxmox.report", {"machine": machine})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        log = self.query_one("#outpost-report", RichLog)
        log.clear()
        memories = res.get("memories", [])
        if not memories:
            log.write("(no decision history yet)")
        for m in memories:
            log.write(f"{_relative_time(m.get('created'))}  {m.get('text', '')}")

    def _show_log(self) -> RichLog:
        """The report RichLog doubles as the output surface for scout
        progress / questions / profiles / pinged — make it visible and
        return it."""
        log = self.query_one("#outpost-report", RichLog)
        self._report_visible = True
        log.display = True
        return log

    # ~10min safety cap @3s so a genuinely stuck/broken install doesn't poll forever.
    _SCOUT_MAX_POLL_ATTEMPTS = 200

    @work(exclusive=True)
    async def start_scout(self, machine: str) -> None:
        import time
        log = self._show_log()
        self._scout_requested_at_ms = int(time.time() * 1000)
        try:
            await self.client.call("proxmox.scout", {"machine": machine})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        log.clear()
        log.write("scout started — progress below")
        self._scout_machine = machine
        self._scout_poll_attempts = 0
        if self._scout_timer is not None:
            self._scout_timer.stop()
        self._scout_timer = self.set_interval(3.0, self._poll_scout)

    def _poll_scout(self) -> None:
        if self._scout_machine:
            self.poll_scout_status(self._scout_machine)

    @work()
    async def poll_scout_status(self, machine: str) -> None:
        try:
            res = await self.client.call("proxmox.scout_status", {"machine": machine})
        except (ControlError, ConnectionError, TimeoutError):
            return
        scout = res.get("scout", {})
        state = scout.get("state", "idle")
        log = self._show_log()
        log.clear()
        if state == "running":
            cur = scout.get("current_vmid")
            log.write(f"scouting… {scout.get('done', 0)}/{scout.get('total', 0)}"
                      + (f" — VM {cur} ({scout.get('current_name', '')})" if cur else ""))
        for r in scout.get("results", []):
            mark = "✓" if r.get("ok") else "✗"
            detail = r.get("summary") if r.get("ok") else r.get("error")
            log.write(f"{mark} VM {r.get('vmid')} ({r.get('name')}, {r.get('kind')}) — {detail}")
        self._scout_poll_attempts += 1
        # The detached runner takes a moment to boot before it writes
        # state=running — a reply whose started_at predates our request is
        # stale data from a PREVIOUS scan, not evidence this one finished.
        started_at = scout.get("started_at") or 0
        reflects_our_run = started_at >= self._scout_requested_at_ms
        still_starting = (not reflects_our_run
                          and self._scout_poll_attempts < self._SCOUT_MAX_POLL_ATTEMPTS)
        if state != "running" and not still_starting:
            log.write(f"scout {state}")
            if self._scout_timer is not None:
                self._scout_timer.stop()
                self._scout_timer = None
            self._scout_machine = None

    @work(exclusive=True)
    async def show_questions(self, machine: str) -> None:
        log = self._show_log()
        try:
            res = await self.client.call("proxmox.questions", {"machine": machine})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        log.clear()
        questions = res.get("questions", [])
        if not questions:
            log.write("(no pending agent questions)")
            return
        log.write("agent questions — reply with: answer <qid> <text>")
        for q in questions:
            where = f"VM {q.get('vmid')} · " if q.get("vmid") else ""
            opts = q.get("options") or []
            log.write(f"[{q.get('qid')}] {where}{q.get('question')}"
                      + (f"  (options: {', '.join(opts)})" if opts else ""))

    @work(exclusive=True)
    async def show_profile(self, machine: str, vmid: int) -> None:
        log = self._show_log()
        try:
            res = await self.client.call("proxmox.vm_profile",
                                         {"machine": machine, "vmid": vmid})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        log.clear()
        profile = res.get("profile", "")
        if not profile:
            log.write(f"(no profile for VM {vmid} yet — press o to scout)")
            return
        for line in profile.splitlines():
            log.write(line)

    @work(exclusive=True)
    async def show_pinged(self, machine: str) -> None:
        log = self._show_log()
        try:
            res = await self.client.call("proxmox.pinged_list", {"machine": machine})
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")
            return
        log.clear()
        rules = res.get("rules", [])
        if not rules:
            log.write("(no pinged rules — add: pinged add <name> | <HH:MM or condition> | <action> [| vmid])")
        for r in rules:
            trig = r.get("trigger") or {}
            trig_s = (f"daily {trig.get('time')}" if trig.get("type") == "schedule"
                      else f"when: {trig.get('condition', '')}")
            where = f"VM {r.get('vmid')}" if r.get("vmid") else "fleet"
            log.write(f"[{r.get('id')}] {r.get('name')} · {where} · {trig_s} → {r.get('action')}")
            checked = _relative_time(r.get("last_checked_at")) if r.get("last_checked_at") else "never"
            fired = (f" · fired {_relative_time(r.get('last_fired_at'))}"
                     if r.get("last_fired_at") else "")
            result = f" · {r.get('last_result')}" if r.get("last_result") else ""
            log.write(f"    checked {checked}{fired}{result}")
        events = res.get("events", [])
        if events:
            log.write("recent fires:")
            for ev in events[:5]:
                log.write(f"  ⚡ {ev.get('name')} — {ev.get('result')} "
                          f"({_relative_time(ev.get('fired_at'))})")

    async def _handle_command(self, machine: str, cmd: str) -> bool:
        """answer/pinged command-line intercepts. True when handled."""
        if cmd.startswith("answer "):
            parts = cmd.split(None, 2)
            if len(parts) < 3:
                self.notify("usage: answer <qid> <text>", severity="warning")
                return True
            try:
                await self.client.call("proxmox.answer", {
                    "machine": machine, "qid": parts[1], "answer": parts[2]})
                self.notify(f"answered {parts[1]}", timeout=4)
                self.show_questions(machine)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
            return True
        if cmd.startswith("pinged rm "):
            rule_id = cmd[len("pinged rm "):].strip()
            try:
                await self.client.call("proxmox.pinged_remove",
                                       {"machine": machine, "rule_id": rule_id})
                self.show_pinged(machine)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
            return True
        if cmd.startswith("pinged add "):
            # pinged add <name> | <HH:MM or condition> | <action> [| vmid]
            parts = [p.strip() for p in cmd[len("pinged add "):].split("|")]
            if len(parts) < 3:
                self.notify("usage: pinged add <name> | <HH:MM or condition> | <action> [| vmid]",
                           severity="warning")
                return True
            trigger = parts[1]
            is_time = len(trigger) in (4, 5) and ":" in trigger \
                and trigger.replace(":", "").isdigit()
            params = {"machine": machine, "name": parts[0], "action": parts[2],
                      "vmid": int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else 0,
                      "condition": "" if is_time else trigger,
                      "time": trigger if is_time else ""}
            try:
                await self.client.call("proxmox.pinged_add", params)
                self.show_pinged(machine)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
            return True
        if cmd.startswith("pinged"):
            self.show_pinged(machine)
            return True
        return False

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "outpost-exec":
            return
        cmd = event.value.strip()
        event.input.value = ""
        row = self.selected()
        if not cmd or not row:
            return
        if await self._handle_command(row["name"], cmd):
            return
        try:
            res = await self.client.call("outpost.exec",
                                         {"machine": row["name"], "cmd": cmd})
            out = res.get("output") or res.get("error") or "(no output)"
            self.notify(f"[{row['name']}] {str(out)[:400]}", timeout=12)
        except (ControlError, ConnectionError, TimeoutError) as exc:
            self.notify(str(exc), severity="error")

    async def on_key(self, event) -> None:
        if event.key == "r":
            self.refresh_data()
        elif event.key == "p":
            try:
                res = await self.client.call("outpost.pair_start", {})
                self.notify("Linux: " + res.get("install_cmd_linux", "")
                            + "  |  Windows: " + res.get("install_cmd_windows", ""),
                            timeout=20)
            except (ControlError, ConnectionError, TimeoutError) as exc:
                self.notify(str(exc), severity="error")
        elif event.key == "x":
            row = self.selected()
            if row:
                try:
                    await self.client.call("outpost.revoke", {"machine": row["name"]})
                except (ControlError, ConnectionError, TimeoutError) as exc:
                    self.notify(str(exc), severity="error")
                self.refresh_data()
        elif event.key == "w":
            row = self.selected()
            if row:
                try:
                    res = await self.client.call("outpost.install_workload",
                                                 {"machine": row["name"]})
                    self.notify(res.get("note") or f"workload manager installed on {row['name']}",
                               timeout=8)
                    # Install also opened a live scout+interview chat — jump
                    # there so the user watches it happen instead of finding
                    # out later (mirrors the Sessions tab's "open in Chat").
                    session_id = res.get("session_id") or ""
                    if session_id:
                        await self.app.open_chat(session_id, res.get("session_title", ""))
                except (ControlError, ConnectionError, TimeoutError) as exc:
                    self.notify(str(exc), severity="error")
        elif event.key == "v":
            row = self.selected()
            if row:
                self._vms_visible = not self._vms_visible
                vm_table = self.query_one("#outpost-vms", DataTable)
                vm_table.display = self._vms_visible
                if self._vms_visible:
                    self.refresh_vms(row["name"])
                    vm_table.focus()
                else:
                    self.query_one("#outpost-machines", DataTable).focus()
        elif event.key == "g":
            row = self.selected()
            if row:
                self._report_visible = not self._report_visible
                log = self.query_one("#outpost-report", RichLog)
                log.display = self._report_visible
                if self._report_visible:
                    self.refresh_report(row["name"])
        elif event.key == "o":
            row = self.selected()
            if row:
                if self._scout_machine:
                    self.poll_scout_status(self._scout_machine)
                else:
                    self.start_scout(row["name"])
        elif event.key == "q":
            row = self.selected()
            if row:
                self.show_questions(row["name"])
        elif event.key == "n":
            row = self.selected()
            if row:
                self.show_pinged(row["name"])
        elif event.key == "i" and self._vms_visible:
            row = self.selected()
            vm = self.selected_vm()
            if row and vm and row["name"] != self._vms_machine:
                self.notify("VM list is for a different machine — press v to refresh",
                           severity="warning")
            elif row and vm:
                self.show_profile(row["name"], vm.get("vmid"))
        elif event.key == "b" and self._vms_visible:
            row = self.selected()
            vm = self.selected_vm()
            if row and vm and row["name"] != self._vms_machine:
                self.notify("VM list is for a different machine — press v to refresh",
                           severity="warning")
            elif row and vm:
                vmids = [r["vmid"] for r in self.vm_rows
                        if r.get("blocklisted") and r.get("vmid") != vm.get("vmid")]
                if not vm.get("blocklisted"):
                    vmids.append(vm.get("vmid"))
                try:
                    await self.client.call("proxmox.set_blocklist",
                                           {"machine": row["name"], "vmids": vmids})
                except (ControlError, ConnectionError, TimeoutError) as exc:
                    self.notify(str(exc), severity="error")
                    return
                self.refresh_vms(row["name"])
        elif event.key == "s" and self._vms_visible:
            row = self.selected()
            vm = self.selected_vm()
            if row and vm and row["name"] != self._vms_machine:
                self._disarm_restart()
                self.notify("VM list is for a different machine — press v to refresh",
                           severity="warning")
            elif row and vm:
                vmid = vm.get("vmid")
                if self._restart_armed_vmid == vmid:
                    self._disarm_restart()
                    try:
                        await self.client.call("proxmox.restart_vm",
                                               {"machine": row["name"], "vmid": vmid})
                        self.notify(f"restarting VM {vmid}", timeout=6)
                    except (ControlError, ConnectionError, TimeoutError) as exc:
                        self.notify(str(exc), severity="error")
                    self.refresh_vms(row["name"])
                else:
                    self._restart_armed_vmid = vmid
                    self.notify(f"press s again to restart VM {vmid}", title="Restart?",
                               timeout=self.RESTART_CONFIRM_WINDOW_S)
                    self._restart_confirm_timer = self.set_timer(
                        self.RESTART_CONFIRM_WINDOW_S, self._disarm_restart)

    def _disarm_restart(self) -> None:
        self._restart_armed_vmid = None
        if self._restart_confirm_timer is not None:
            self._restart_confirm_timer.stop()
            self._restart_confirm_timer = None
