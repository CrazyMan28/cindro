"""The full-power proxmox_* operator tools — everything the Proxmox GUI can do.

This is the SECOND, separate MCP catalog (proxmox-operator-mcp, :8800) that the
interactive dashboard's Jarvis drives. Unlike tools_proxmox (the restricted,
autonomous tuning agent — no power/create/delete tools, ever), this catalog can
create/clone/delete VMs, power them, snapshot, back up, manage storage/network,
LXC, and migrate — plus a generic `proxmox_api` passthrough so ANY Proxmox API
call is reachable.

Safety here is NOT "omit the dangerous tools" (this catalog intentionally has
them). It is the permission gate: every mutating tool is gated by the daemon's
interactive operatorGate (ask/allow/deny) BEFORE it is ever called, and this
server independently refuses any standing `deny` rule via guarded_write() as a
backstop. Read tools and the local board tools run free. Each tool's docstring
carries its risk tier so the model (and the approval card) can explain itself.
"""

from typing import Any

from mcp.server.fastmcp import FastMCP

from proxmox_mcp import operator_store
from proxmox_mcp import proxmox_ops_operator as ops


def register(mcp: FastMCP) -> list[str]:
    def _node(node: str) -> str:
        return node or ops.node()

    # --- VM lifecycle --------------------------------------------------------

    @mcp.tool()
    async def proxmox_vm_list() -> dict[str, Any]:
        """List every guest across the cluster (QEMU VMs + LXC containers) with
        node, vmid, name, status, and live cpu/mem. Read-only."""
        return ops.read("/cluster/resources", {"type": "vm"})

    @mcp.tool()
    async def proxmox_vm_status(vmid: int, node: str = "") -> dict[str, Any]:
        """Current runtime status/metrics of one VM. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/qemu/{vmid}/status/current")

    @mcp.tool()
    async def proxmox_vm_config_get(vmid: int, node: str = "") -> dict[str, Any]:
        """Full config of one VM (cores, memory, disks, net, ...). Read-only."""
        return ops.read(f"/nodes/{_node(node)}/qemu/{vmid}/config")

    @mcp.tool()
    async def proxmox_vm_create(vmid: int, name: str = "", cores: int = 0,
                                memory_mb: int = 0, ostype: str = "",
                                extra: dict | None = None, node: str = "") -> dict[str, Any]:
        """Create a new QEMU VM (risk: medium). `extra` passes any additional
        Proxmox `qm create` API fields (e.g. {"net0":"virtio,bridge=vmbr0",
        "scsi0":"local-lvm:32","ide2":"local:iso/x.iso,media=cdrom"})."""
        # `extra` is model-controlled, so merge it FIRST and let the explicit,
        # approved fields win — otherwise extra:{"vmid":999} would override the
        # vmid the approval card + policy backstop matched (pvesh would create a
        # different VM than the one the user authorized).
        params: dict[str, Any] = dict(extra or {})
        params["vmid"] = vmid
        if name:
            params["name"] = name
        if cores:
            params["cores"] = cores
        if memory_mb:
            params["memory"] = memory_mb
        if ostype:
            params["ostype"] = ostype
        return ops.guarded_write("proxmox_vm_create", {"vmid": vmid}, "create",
                                 f"/nodes/{_node(node)}/qemu", params)

    @mcp.tool()
    async def proxmox_vm_clone(vmid: int, newid: int, name: str = "",
                               full: bool = False, target_storage: str = "",
                               node: str = "") -> dict[str, Any]:
        """Clone an existing VM/template into a new vmid (risk: medium)."""
        params: dict[str, Any] = {"newid": newid, "full": 1 if full else 0}
        if name:
            params["name"] = name
        if target_storage:
            params["storage"] = target_storage
        return ops.guarded_write("proxmox_vm_clone", {"vmid": vmid}, "create",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/clone", params)

    @mcp.tool()
    async def proxmox_vm_delete(vmid: int, purge: bool = True,
                                node: str = "") -> dict[str, Any]:
        """Permanently DELETE a VM and (by default) purge its disks + job refs
        (risk: HIGH — irreversible)."""
        params = {"purge": 1 if purge else 0, "destroy-unreferenced-disks": 1}
        return ops.guarded_write("proxmox_vm_delete", {"vmid": vmid}, "delete",
                                 f"/nodes/{_node(node)}/qemu/{vmid}", params)

    @mcp.tool()
    async def proxmox_vm_power(vmid: int, action: str, node: str = "") -> dict[str, Any]:
        """Change a VM's power state. action ∈ start|stop|shutdown|reboot|reset|
        suspend|resume. risk: medium (start/resume) to HIGH (stop/reset — hard
        power-off, may lose data)."""
        verbs = {"start", "stop", "shutdown", "reboot", "reset", "suspend", "resume"}
        if action not in verbs:
            return {"ok": False, "error": f"action must be one of {sorted(verbs)}"}
        return ops.guarded_write("proxmox_vm_power", {"vmid": vmid, "verb": action},
                                 "create",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/status/{action}")

    @mcp.tool()
    async def proxmox_vm_config_set(vmid: int, params: dict, node: str = "") -> dict[str, Any]:
        """Update VM config fields (cores, memory, net0, disks, ...) — the
        pending/live `qm set` (risk: medium)."""
        return ops.guarded_write("proxmox_vm_config_set", {"vmid": vmid}, "set",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/config", params or {})

    @mcp.tool()
    async def proxmox_vm_migrate(vmid: int, target_node: str, online: bool = True,
                                 node: str = "") -> dict[str, Any]:
        """Migrate a VM to another cluster node (risk: HIGH)."""
        params = {"target": target_node, "online": 1 if online else 0}
        return ops.guarded_write("proxmox_vm_migrate", {"vmid": vmid}, "create",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/migrate", params)

    # --- Snapshots -----------------------------------------------------------

    @mcp.tool()
    async def proxmox_snapshot_list(vmid: int, node: str = "") -> dict[str, Any]:
        """List a VM's snapshots. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/qemu/{vmid}/snapshot")

    @mcp.tool()
    async def proxmox_snapshot_create(vmid: int, name: str, description: str = "",
                                      vmstate: bool = False, node: str = "") -> dict[str, Any]:
        """Take a snapshot (risk: medium)."""
        params: dict[str, Any] = {"snapname": name, "vmstate": 1 if vmstate else 0}
        if description:
            params["description"] = description
        return ops.guarded_write("proxmox_snapshot_create", {"vmid": vmid}, "create",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/snapshot", params)

    @mcp.tool()
    async def proxmox_snapshot_rollback(vmid: int, name: str, node: str = "") -> dict[str, Any]:
        """Roll a VM back to a snapshot (risk: HIGH — discards changes since)."""
        return ops.guarded_write("proxmox_snapshot_rollback", {"vmid": vmid}, "create",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/snapshot/{name}/rollback")

    @mcp.tool()
    async def proxmox_snapshot_delete(vmid: int, name: str, node: str = "") -> dict[str, Any]:
        """Delete a snapshot (risk: HIGH — irreversible)."""
        return ops.guarded_write("proxmox_snapshot_delete", {"vmid": vmid}, "delete",
                                 f"/nodes/{_node(node)}/qemu/{vmid}/snapshot/{name}")

    # --- Backup / restore ----------------------------------------------------

    @mcp.tool()
    async def proxmox_backup_list(storage: str, node: str = "") -> dict[str, Any]:
        """List backup archives on a storage. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/storage/{storage}/content",
                        {"content": "backup"})

    @mcp.tool()
    async def proxmox_backup_create(vmid: int, storage: str, mode: str = "snapshot",
                                    compress: str = "zstd", node: str = "") -> dict[str, Any]:
        """Create a vzdump backup of a VM (risk: medium). Backups run for minutes;
        if the client call times out this returns {status:"running", upid, ...}
        (NOT a failure) — poll proxmox_task_status with the upid until it's done,
        never re-run it."""
        params = {"vmid": vmid, "storage": storage, "mode": mode, "compress": compress}
        return ops.guarded_write("proxmox_backup_create", {"vmid": vmid}, "create",
                                 f"/nodes/{_node(node)}/vzdump", params)

    # --- Storage / ISO -------------------------------------------------------

    @mcp.tool()
    async def proxmox_storage_list(node: str = "") -> dict[str, Any]:
        """List storages on a node. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/storage")

    @mcp.tool()
    async def proxmox_storage_content(storage: str, content: str = "",
                                      node: str = "") -> dict[str, Any]:
        """List a storage's content (optionally filtered: iso|backup|images|
        vztmpl|...). Read-only."""
        return ops.read(f"/nodes/{_node(node)}/storage/{storage}/content",
                        {"content": content} if content else None)

    @mcp.tool()
    async def proxmox_iso_list(storage: str, node: str = "") -> dict[str, Any]:
        """List ISO images on a storage. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/storage/{storage}/content",
                        {"content": "iso"})

    @mcp.tool()
    async def proxmox_iso_download(storage: str, url: str, filename: str = "",
                                   node: str = "") -> dict[str, Any]:
        """Download an ISO from a URL directly onto a storage (risk: medium)."""
        params: dict[str, Any] = {"content": "iso", "url": url}
        if filename:
            params["filename"] = filename
        return ops.guarded_write("proxmox_iso_download", {}, "create",
                                 f"/nodes/{_node(node)}/storage/{storage}/download-url", params)

    # --- Network / firewall --------------------------------------------------

    @mcp.tool()
    async def proxmox_network_list(node: str = "") -> dict[str, Any]:
        """List a node's network interfaces/bridges. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/network")

    @mcp.tool()
    async def proxmox_firewall_get(node: str = "") -> dict[str, Any]:
        """Read a node's firewall options. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/firewall/options")

    # --- LXC containers ------------------------------------------------------

    @mcp.tool()
    async def proxmox_ct_list(node: str = "") -> dict[str, Any]:
        """List LXC containers on a node. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/lxc")

    @mcp.tool()
    async def proxmox_ct_config_get(vmid: int, node: str = "") -> dict[str, Any]:
        """Full config of one LXC container. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/lxc/{vmid}/config")

    @mcp.tool()
    async def proxmox_ct_power(vmid: int, action: str, node: str = "") -> dict[str, Any]:
        """Change an LXC container's power state. action ∈ start|stop|shutdown|
        reboot|suspend|resume. risk: medium–HIGH."""
        verbs = {"start", "stop", "shutdown", "reboot", "suspend", "resume"}
        if action not in verbs:
            return {"ok": False, "error": f"action must be one of {sorted(verbs)}"}
        return ops.guarded_write("proxmox_ct_power", {"vmid": vmid, "verb": action},
                                 "create",
                                 f"/nodes/{_node(node)}/lxc/{vmid}/status/{action}")

    @mcp.tool()
    async def proxmox_ct_delete(vmid: int, purge: bool = True, node: str = "") -> dict[str, Any]:
        """Permanently DELETE an LXC container (risk: HIGH — irreversible)."""
        return ops.guarded_write("proxmox_ct_delete", {"vmid": vmid}, "delete",
                                 f"/nodes/{_node(node)}/lxc/{vmid}", {"purge": 1 if purge else 0})

    # --- Node / cluster ------------------------------------------------------

    @mcp.tool()
    async def proxmox_node_list() -> dict[str, Any]:
        """List cluster nodes. Read-only."""
        return ops.read("/nodes")

    @mcp.tool()
    async def proxmox_node_status(node: str = "") -> dict[str, Any]:
        """A node's status: cpu, memory, load, uptime, ksm. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/status")

    @mcp.tool()
    async def proxmox_cluster_status() -> dict[str, Any]:
        """Cluster/quorum status. Read-only."""
        return ops.read("/cluster/status")

    # --- Tasks / UPID --------------------------------------------------------

    @mcp.tool()
    async def proxmox_task_status(upid: str, node: str = "") -> dict[str, Any]:
        """Status of a long-running task by UPID (returned by create/power/etc.).
        Poll this until stopped. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/tasks/{upid}/status")

    @mcp.tool()
    async def proxmox_task_log(upid: str, node: str = "") -> dict[str, Any]:
        """Log lines of a task by UPID. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/tasks/{upid}/log")

    @mcp.tool()
    async def proxmox_tasks_recent(node: str = "") -> dict[str, Any]:
        """Recent tasks on a node. Read-only."""
        return ops.read(f"/nodes/{_node(node)}/tasks")

    # --- Generic passthrough — "everything the GUI can do" -------------------

    @mcp.tool()
    async def proxmox_api(method: str, path: str,
                          params: dict | None = None) -> dict[str, Any]:
        """Call ANY Proxmox API endpoint. `method` ∈ GET|POST|PUT|DELETE,
        `path` is an API path like "/nodes/pve/qemu/100/config". GET is
        read-only and runs free; POST/PUT/DELETE are mutating and gated by the
        permission policy (risk: depends on the call — treat as HIGH). This is
        the escape hatch that makes every GUI action reachable even without a
        dedicated tool above."""
        m = (method or "").upper()
        if not operator_store.is_mutating_method(m):
            return ops.read(path, params)
        verb = ops.PVESH_VERB.get(m)
        if not verb:
            return {"ok": False, "error": f"unsupported method {method!r}"}
        return ops.guarded_write("proxmox_api", {"method": m}, verb, path, params)

    # --- Dashboard board (Home grid + Tasks) — local, free -------------------

    @mcp.tool()
    async def proxmox_dashboard_layout_get() -> dict[str, Any]:
        """Read the Home widget grid the user sees. Read-only."""
        return operator_store.load_layout()

    @mcp.tool()
    async def proxmox_dashboard_layout_set(tiles: list) -> dict[str, Any]:
        """Replace the Home widget grid (the SAME grid the user drags/resizes) —
        add/move/remove tiles. `tiles` is the FULL tile list. Local only, not a
        Proxmox change, so it runs free.

        Each tile is an object:
            {"id": "cpu1", "type": <type>, "title": "CPU",
             "grid": {"x": 0, "y": 0, "w": 3, "h": 3},
             "node": "pve",        # optional — scopes node/storage tiles
             "content": {...}}      # optional — only note/gauge use it

        The board is 12 columns wide; grid.x/y are the top-left cell (0-based),
        grid.w/h the span in cells. Use the `grid` object — NOT flat
        col/row/width/height.

        `type` MUST be one of these renderers (anything else shows a placeholder):
            cpu_usage       — live CPU ring gauge for a node
            vm_status       — running/stopped VMs + containers
            node_stats      — a node's cpu/mem/load/uptime
            node_load       — a node's 1/5/15-minute load averages
            storage         — per-storage usage bars
            cluster_status  — nodes online, guests running, health
            recent_backups  — latest backup archives
            tasks_board     — the Tasks Kanban counts + open items
            note            — freeform text (content: "" or {"text": "..."})
            gauge           — a custom ring (content: {value, max, label})

        A good starter board: cluster_status (4x3), vm_status (5x4),
        storage (4x3), node_stats (4x3), recent_backups (4x4), tasks_board (4x4).
        """
        return operator_store.save_layout({"tiles": tiles})

    @mcp.tool()
    async def proxmox_tasks_list() -> dict[str, Any]:
        """Read the Tasks Kanban board. Read-only."""
        return operator_store.load_tasks()

    @mcp.tool()
    async def proxmox_task_create(title: str, detail: str = "",
                                  status: str = "todo") -> dict[str, Any]:
        """Add a task to the board (status ∈ todo|doing|done). Local, free."""
        return operator_store.create_task(title, detail, status)

    @mcp.tool()
    async def proxmox_task_update(task_id: str, title: str = "", detail: str = "",
                                  status: str = "") -> dict[str, Any]:
        """Update/move a task (e.g. status→done). Local, free. Empty fields are
        left unchanged."""
        updated = operator_store.update_task(
            task_id,
            title=title or None,
            detail=detail or None,
            status=status or None,
        )
        return updated or {"ok": False, "error": f"no task {task_id!r}"}

    return [
        "proxmox_vm_list", "proxmox_vm_status", "proxmox_vm_config_get",
        "proxmox_vm_create", "proxmox_vm_clone", "proxmox_vm_delete",
        "proxmox_vm_power", "proxmox_vm_config_set", "proxmox_vm_migrate",
        "proxmox_snapshot_list", "proxmox_snapshot_create",
        "proxmox_snapshot_rollback", "proxmox_snapshot_delete",
        "proxmox_backup_list", "proxmox_backup_create",
        "proxmox_storage_list", "proxmox_storage_content", "proxmox_iso_list",
        "proxmox_iso_download", "proxmox_network_list", "proxmox_firewall_get",
        "proxmox_ct_list", "proxmox_ct_config_get", "proxmox_ct_power",
        "proxmox_ct_delete", "proxmox_node_list", "proxmox_node_status",
        "proxmox_cluster_status", "proxmox_task_status", "proxmox_task_log",
        "proxmox_tasks_recent", "proxmox_api", "proxmox_dashboard_layout_get",
        "proxmox_dashboard_layout_set", "proxmox_tasks_list",
        "proxmox_task_create", "proxmox_task_update",
    ]
