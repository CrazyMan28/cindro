// Multi-step animated Create-VM wizard. NOT a nav page — this file exports
// only <VmCreateModal>, which pages/vms.tsx (via ../pages.tsx's VmsPage)
// mounts and drives with `open`/`onClose`/`onCreated` props. Every field maps
// straight onto the REAL Proxmox qemu-create API (POST /nodes/<node>/qemu)
// through pve-api.ts — no Cindro/daemon round-trip, so this works even before
// the operator chat is connected.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js"

import * as pve from "../pve-api"
import type { PveNode, StorageContentItem, StorageSummary } from "../pve-api"

// --- static catalogs ---------------------------------------------------------

const OS_TYPES: Array<{ value: string; label: string }> = [
  { value: "l26", label: "Linux 6.x – 2.6 Kernel" },
  { value: "l24", label: "Linux 2.4 Kernel" },
  { value: "win11", label: "Windows 11 / Server 2022" },
  { value: "win10", label: "Windows 10 / Server 2016-2019" },
  { value: "win8", label: "Windows 8 / Server 2012" },
  { value: "win7", label: "Windows 7 / Server 2008 R2" },
  { value: "wxp", label: "Windows XP / Server 2003" },
  { value: "solaris", label: "Solaris / OpenSolaris" },
  { value: "other", label: "Other" },
]

const CPU_TYPES = ["host", "x86-64-v2-AES", "kvm64", "qemu64", "max"]

const BUS_TYPES: Array<{ value: "scsi" | "virtio" | "sata" | "ide"; label: string }> = [
  { value: "scsi", label: "SCSI (recommended)" },
  { value: "virtio", label: "VirtIO Block" },
  { value: "sata", label: "SATA" },
  { value: "ide", label: "IDE" },
]

const NET_MODELS = ["virtio", "e1000", "vmxnet3", "rtl8139"]

const STEPS = [
  { key: "basics", label: "Basics" },
  { key: "os", label: "OS & Media" },
  { key: "resources", label: "CPU & Memory" },
  { key: "storage", label: "Disk & Network" },
  { key: "review", label: "Review" },
] as const

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB` : `${mb} MiB`
}

// --- component ---------------------------------------------------------------

export const VmCreateModal: Component<{
  open: boolean
  onClose: () => void
  onCreated?: (vmid: number) => void
}> = (props) => {
  const [step, setStep] = createSignal(0)
  const [closing, setClosing] = createSignal(false)

  // basics
  const [nodesList, setNodesList] = createSignal<PveNode[]>([])
  const [nodesLoading, setNodesLoading] = createSignal(false)
  const [node, setNode] = createSignal("")
  const [vmid, setVmid] = createSignal<number | "">("")
  const [vmidAuto, setVmidAuto] = createSignal(true)
  const [vmidLoading, setVmidLoading] = createSignal(false)
  const [name, setName] = createSignal("")

  // os / media
  const [osType, setOsType] = createSignal("l26")
  const [useIso, setUseIso] = createSignal(true)
  const [storageList, setStorageList] = createSignal<StorageSummary[]>([])
  const [storagesLoading, setStoragesLoading] = createSignal(false)
  const [isoStorage, setIsoStorage] = createSignal("")
  const [isoItems, setIsoItems] = createSignal<StorageContentItem[]>([])
  const [isoLoading, setIsoLoading] = createSignal(false)
  const [isoVolid, setIsoVolid] = createSignal("")
  const [guestAgent, setGuestAgent] = createSignal(true)

  // cpu / memory
  const [sockets, setSockets] = createSignal(1)
  const [cores, setCores] = createSignal(2)
  const [cpuType, setCpuType] = createSignal("host")
  const [memoryMb, setMemoryMb] = createSignal(2048)
  const [ballooning, setBallooning] = createSignal(true)

  // disk / network
  const [diskStorage, setDiskStorage] = createSignal("")
  const [diskSizeGb, setDiskSizeGb] = createSignal(32)
  const [diskBus, setDiskBus] = createSignal<"scsi" | "virtio" | "sata" | "ide">("scsi")
  const [bridges, setBridges] = createSignal<string[]>([])
  const [bridgesLoading, setBridgesLoading] = createSignal(false)
  const [bridge, setBridge] = createSignal("vmbr0")
  const [netModel, setNetModel] = createSignal("virtio")
  const [vlanTag, setVlanTag] = createSignal("")
  const [firewall, setFirewall] = createSignal(false)

  // review / submit
  const [startAfterCreate, setStartAfterCreate] = createSignal(true)
  const [creating, setCreating] = createSignal(false)
  const [createErr, setCreateErr] = createSignal("")
  const [loadErr, setLoadErr] = createSignal("")

  const isoStorages = createMemo(() => storageList().filter((s) => (s.content ?? "").includes("iso")))
  const diskStorages = createMemo(() => storageList().filter((s) => {
    const c = s.content ?? ""
    return c.includes("images") || c.includes("rootdir")
  }))

  function resetAll() {
    setStep(0)
    setClosing(false)
    setName("")
    setOsType("l26")
    setUseIso(true)
    setIsoStorage("")
    setIsoItems([])
    setIsoVolid("")
    setGuestAgent(true)
    setSockets(1)
    setCores(2)
    setCpuType("host")
    setMemoryMb(2048)
    setBallooning(true)
    setDiskSizeGb(32)
    setDiskBus("scsi")
    setVlanTag("")
    setFirewall(false)
    setStartAfterCreate(true)
    setCreating(false)
    setCreateErr("")
    setLoadErr("")
    setVmidAuto(true)
  }

  async function loadNextId() {
    setVmidLoading(true)
    const r = await pve.get<string | number>("/cluster/nextid")
    setVmidLoading(false)
    if (r.ok) {
      const n = Number(r.data)
      if (Number.isFinite(n) && vmidAuto()) setVmid(n)
    }
  }

  async function loadNodes() {
    setNodesLoading(true)
    const r = await pve.nodes()
    setNodesLoading(false)
    if (!r.ok) {
      setLoadErr(`Couldn't load nodes: ${r.error}`)
      return
    }
    const list = r.data.slice().sort((a, b) => a.node.localeCompare(b.node))
    setNodesList(list)
    if (!node()) {
      const online = list.find((n) => n.status === "online") ?? list[0]
      if (online) setNode(online.node)
    }
  }

  async function loadStorages(n: string) {
    if (!n) return
    setStoragesLoading(true)
    const r = await pve.storages(n)
    setStoragesLoading(false)
    if (!r.ok) return
    setStorageList(r.data)
    const isoList = r.data.filter((s) => (s.content ?? "").includes("iso"))
    const diskList = r.data.filter((s) => {
      const c = s.content ?? ""
      return c.includes("images") || c.includes("rootdir")
    })
    if (!isoList.some((s) => s.storage === isoStorage())) setIsoStorage(isoList[0]?.storage ?? "")
    if (!diskList.some((s) => s.storage === diskStorage())) setDiskStorage(diskList[0]?.storage ?? "")
  }

  async function loadIso(n: string, storage: string) {
    if (!n || !storage) {
      setIsoItems([])
      return
    }
    setIsoLoading(true)
    const r = await pve.storageContent(n, storage, "iso")
    setIsoLoading(false)
    if (!r.ok) {
      setIsoItems([])
      return
    }
    setIsoItems(r.data)
    if (!r.data.some((i) => i.volid === isoVolid())) setIsoVolid(r.data[0]?.volid ?? "")
  }

  async function loadBridges(n: string) {
    if (!n) return
    setBridgesLoading(true)
    const r = await pve.get<Array<{ iface?: string; type?: string }>>(`/nodes/${encodeURIComponent(n)}/network`, {
      type: "bridge",
    })
    setBridgesLoading(false)
    if (!r.ok) return
    const names = r.data.map((x) => x.iface).filter((x): x is string => !!x).sort()
    setBridges(names)
    if (names.length && !names.includes(bridge())) setBridge(names[0])
  }

  // (re)load everything fresh each time the modal opens.
  createEffect(() => {
    if (props.open) {
      resetAll()
      void loadNodes()
      void loadNextId()
    }
  })

  // node changes -> reload its storages / bridges (and ISO list depends on storage).
  createEffect(() => {
    const n = node()
    if (props.open && n) {
      void loadStorages(n)
      void loadBridges(n)
    }
  })

  createEffect(() => {
    const n = node()
    const s = isoStorage()
    if (props.open && n && s && useIso()) void loadIso(n, s)
  })

  // --- validation --------------------------------------------------------------
  const basicsValid = createMemo(() => !!node() && typeof vmid() === "number" && (vmid() as number) > 0 && name().trim().length > 0)
  const osValid = createMemo(() => !useIso() || !!isoVolid() || isoItems().length === 0)
  const resourcesValid = createMemo(() => sockets() >= 1 && cores() >= 1 && memoryMb() >= 16)
  const storageValid = createMemo(() => !!diskStorage() && diskSizeGb() >= 1 && bridge().trim().length > 0)
  const stepValid = createMemo(() => {
    switch (step()) {
      case 0: return basicsValid()
      case 1: return osValid()
      case 2: return resourcesValid()
      case 3: return storageValid()
      default: return true
    }
  })

  function requestClose() {
    if (creating()) return
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      props.onClose()
    }, 180)
  }

  function next() {
    if (!stepValid()) return
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }
  function back() {
    setStep((s) => Math.max(s - 1, 0))
  }

  async function submit() {
    if (creating()) return
    setCreateErr("")
    setCreating(true)
    const n = node()
    const id = vmid()
    if (!n || typeof id !== "number") {
      setCreateErr("Missing node or VMID")
      setCreating(false)
      return
    }

    const diskKey = `${diskBus()}0`
    const params: Record<string, unknown> = {
      vmid: id,
      name: name().trim(),
      ostype: osType(),
      sockets: sockets(),
      cores: cores(),
      cpu: cpuType(),
      memory: memoryMb(),
      agent: guestAgent() ? 1 : 0,
      [diskKey]: `${diskStorage()}:${diskSizeGb()}`,
    }
    if (diskBus() === "scsi") params.scsihw = "virtio-scsi-pci"
    if (ballooning()) params.balloon = Math.max(16, Math.floor(memoryMb() / 2))

    let net = `${netModel()},bridge=${bridge().trim()}`
    if (vlanTag().trim()) net += `,tag=${vlanTag().trim()}`
    if (firewall()) net += ",firewall=1"
    params.net0 = net

    const bootOrder = [diskKey]
    if (useIso() && isoVolid()) {
      params.ide2 = `${isoVolid()},media=cdrom`
      bootOrder.push("ide2")
    }
    bootOrder.push("net0")
    params.boot = `order=${bootOrder.join(";")}`

    const r = await pve.create(`/nodes/${encodeURIComponent(n)}/qemu`, params)
    if (!r.ok) {
      setCreateErr(r.error)
      setCreating(false)
      return
    }

    if (startAfterCreate()) {
      await pve.create(`/nodes/${encodeURIComponent(n)}/qemu/${id}/status/start`, {})
    }

    setCreating(false)
    props.onCreated?.(id)
    requestClose()
  }

  return (
    <Show when={props.open}>
      <div
        class="cx-modal-backdrop"
        classList={{ closing: closing() }}
        onClick={(e) => { if (e.target === e.currentTarget) requestClose() }}
        onKeyDown={(e) => { if (e.key === "Escape") requestClose() }}
      >
        <div class="cx-modal" classList={{ closing: closing() }} role="dialog" aria-modal="true" aria-label="Create virtual machine">
          <div class="cx-modal-head">
            <div class="cx-modal-head-text">
              <div class="cx-modal-title">Create Virtual Machine</div>
              <div class="cx-modal-sub">
                {node() ? `Target node: ${node()}` : "Provision a new QEMU guest"}
              </div>
            </div>
            <button type="button" class="cx-modal-close" disabled={creating()} onClick={requestClose} aria-label="Close">✕</button>
          </div>

          <div class="cx-modal-body">
            <Show when={loadErr()}>
              <div class="cx-error-card" style={{ "margin-bottom": "14px" }}>{loadErr()}</div>
            </Show>

            <div class="cx-wizard-steps">
              <For each={STEPS}>
                {(s, i) => (
                  <>
                    <div class="cx-wizard-step" classList={{ active: step() === i(), done: step() > i() }}>
                      <div class="cx-wizard-step-dot">{step() > i() ? "✓" : i() + 1}</div>
                      <div class="cx-wizard-step-label">{s.label}</div>
                    </div>
                    <Show when={i() < STEPS.length - 1}>
                      <div class="cx-wizard-line" classList={{ done: step() > i() }} />
                    </Show>
                  </>
                )}
              </For>
            </div>

            {/* --- step 0: basics --- */}
            <Show when={step() === 0}>
              <div class="cx-wizard-panel">
                <div class="cx-wizard-grid">
                  <div class="cx-field">
                    <label class="cx-field-label">Target node</label>
                    <Show when={!nodesLoading()} fallback={<div class="cx-skel cx-skel-block" />}>
                      <div class="cx-select-wrap">
                        <select class="cx-select" value={node()} onChange={(e) => setNode(e.currentTarget.value)}>
                          <For each={nodesList()}>
                            {(n) => <option value={n.node}>{n.node}{n.status !== "online" ? ` (${n.status})` : ""}</option>}
                          </For>
                        </select>
                      </div>
                    </Show>
                  </div>
                  <div class="cx-field">
                    <label class="cx-field-label">VM name</label>
                    <input
                      class="cx-input"
                      placeholder="e.g. web-01"
                      value={name()}
                      onInput={(e) => setName(e.currentTarget.value)}
                    />
                  </div>
                  <div class="cx-field full">
                    <label class="cx-field-label">VMID</label>
                    <div class="cx-wizard-row">
                      <input
                        class="cx-input"
                        type="number"
                        min="100"
                        style={{ "max-width": "160px" }}
                        disabled={vmidAuto()}
                        value={vmid()}
                        onInput={(e) => setVmid(e.currentTarget.value === "" ? "" : Number(e.currentTarget.value))}
                      />
                      <label class="cx-switch">
                        <input
                          type="checkbox"
                          checked={vmidAuto()}
                          onChange={(e) => {
                            setVmidAuto(e.currentTarget.checked)
                            if (e.currentTarget.checked) void loadNextId()
                          }}
                        />
                        <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                        <span class="cx-switch-label">Auto-assign next free ID{vmidLoading() ? "…" : ""}</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </Show>

            {/* --- step 1: os / media --- */}
            <Show when={step() === 1}>
              <div class="cx-wizard-panel">
                <div class="cx-wizard-grid">
                  <div class="cx-field">
                    <label class="cx-field-label">Guest OS type</label>
                    <div class="cx-select-wrap">
                      <select class="cx-select" value={osType()} onChange={(e) => setOsType(e.currentTarget.value)}>
                        <For each={OS_TYPES}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                      </select>
                    </div>
                  </div>
                  <div class="cx-field">
                    <label class="cx-field-label">QEMU guest agent</label>
                    <label class="cx-switch" style={{ height: "40px" }}>
                      <input type="checkbox" checked={guestAgent()} onChange={(e) => setGuestAgent(e.currentTarget.checked)} />
                      <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                      <span class="cx-switch-label">Enable (recommended)</span>
                    </label>
                  </div>
                </div>

                <label class="cx-switch">
                  <input type="checkbox" checked={useIso()} onChange={(e) => setUseIso(e.currentTarget.checked)} />
                  <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                  <span class="cx-switch-label">Mount an installation ISO</span>
                </label>

                <Show when={useIso()}>
                  <div class="cx-wizard-grid">
                    <div class="cx-field">
                      <label class="cx-field-label">ISO storage</label>
                      <Show when={!storagesLoading()} fallback={<div class="cx-skel cx-skel-block" />}>
                        <div class="cx-select-wrap">
                          <select class="cx-select" value={isoStorage()} onChange={(e) => setIsoStorage(e.currentTarget.value)}>
                            <Show when={isoStorages().length === 0}><option value="">No ISO-capable storage found</option></Show>
                            <For each={isoStorages()}>{(s) => <option value={s.storage}>{s.storage}</option>}</For>
                          </select>
                        </div>
                      </Show>
                    </div>
                    <div class="cx-field">
                      <label class="cx-field-label">ISO image</label>
                      <Show when={!isoLoading()} fallback={<div class="cx-skel cx-skel-block" />}>
                        <div class="cx-select-wrap">
                          <select class="cx-select" value={isoVolid()} onChange={(e) => setIsoVolid(e.currentTarget.value)}>
                            <Show when={isoItems().length === 0}><option value="">No ISOs uploaded to this storage</option></Show>
                            <For each={isoItems()}>{(i) => <option value={i.volid}>{i.volid.split("/").pop()}</option>}</For>
                          </select>
                        </div>
                      </Show>
                    </div>
                  </div>
                  <div class="cx-wizard-hint">Upload ISOs from the storage's "ISO Images" content view in Proxmox first if none appear here.</div>
                </Show>
              </div>
            </Show>

            {/* --- step 2: cpu / memory --- */}
            <Show when={step() === 2}>
              <div class="cx-wizard-panel">
                <div class="cx-wizard-panel-title">Processor</div>
                <div class="cx-wizard-grid">
                  <div class="cx-field">
                    <label class="cx-field-label">Sockets</label>
                    <input class="cx-input" type="number" min="1" max="4" value={sockets()} onInput={(e) => setSockets(Math.max(1, Number(e.currentTarget.value) || 1))} />
                  </div>
                  <div class="cx-field">
                    <label class="cx-field-label">Cores</label>
                    <input class="cx-input" type="number" min="1" max="64" value={cores()} onInput={(e) => setCores(Math.max(1, Number(e.currentTarget.value) || 1))} />
                  </div>
                  <div class="cx-field full">
                    <label class="cx-field-label">CPU type</label>
                    <div class="cx-select-wrap">
                      <select class="cx-select" value={cpuType()} onChange={(e) => setCpuType(e.currentTarget.value)}>
                        <For each={CPU_TYPES}>{(c) => <option value={c}>{c}</option>}</For>
                      </select>
                    </div>
                  </div>
                </div>

                <div class="cx-wizard-panel-title">Memory</div>
                <div class="cx-field">
                  <label class="cx-field-label">RAM — {fmtMem(memoryMb())}</label>
                  <input
                    type="range" min="128" max="65536" step="128"
                    value={memoryMb()}
                    onInput={(e) => setMemoryMb(Number(e.currentTarget.value))}
                    style={{ width: "100%", "accent-color": "var(--accent)" }}
                  />
                </div>
                <label class="cx-switch">
                  <input type="checkbox" checked={ballooning()} onChange={(e) => setBallooning(e.currentTarget.checked)} />
                  <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                  <span class="cx-switch-label">Enable memory ballooning</span>
                </label>
              </div>
            </Show>

            {/* --- step 3: disk / network --- */}
            <Show when={step() === 3}>
              <div class="cx-wizard-panel">
                <div class="cx-wizard-panel-title">Disk</div>
                <div class="cx-wizard-grid">
                  <div class="cx-field">
                    <label class="cx-field-label">Storage</label>
                    <Show when={!storagesLoading()} fallback={<div class="cx-skel cx-skel-block" />}>
                      <div class="cx-select-wrap">
                        <select class="cx-select" value={diskStorage()} onChange={(e) => setDiskStorage(e.currentTarget.value)}>
                          <Show when={diskStorages().length === 0}><option value="">No image-capable storage found</option></Show>
                          <For each={diskStorages()}>{(s) => <option value={s.storage}>{s.storage}</option>}</For>
                        </select>
                      </div>
                    </Show>
                  </div>
                  <div class="cx-field">
                    <label class="cx-field-label">Size (GiB)</label>
                    <input class="cx-input" type="number" min="1" max="16384" value={diskSizeGb()} onInput={(e) => setDiskSizeGb(Math.max(1, Number(e.currentTarget.value) || 1))} />
                  </div>
                  <div class="cx-field full">
                    <label class="cx-field-label">Bus / device</label>
                    <div class="cx-select-wrap">
                      <select class="cx-select" value={diskBus()} onChange={(e) => setDiskBus(e.currentTarget.value as any)}>
                        <For each={BUS_TYPES}>{(b) => <option value={b.value}>{b.label}</option>}</For>
                      </select>
                    </div>
                  </div>
                </div>

                <div class="cx-wizard-panel-title">Network</div>
                <div class="cx-wizard-grid">
                  <div class="cx-field">
                    <label class="cx-field-label">Bridge</label>
                    <Show
                      when={!bridgesLoading()}
                      fallback={<div class="cx-skel cx-skel-block" />}
                    >
                      <Show
                        when={bridges().length > 0}
                        fallback={<input class="cx-input" value={bridge()} onInput={(e) => setBridge(e.currentTarget.value)} placeholder="vmbr0" />}
                      >
                        <div class="cx-select-wrap">
                          <select class="cx-select" value={bridge()} onChange={(e) => setBridge(e.currentTarget.value)}>
                            <For each={bridges()}>{(b) => <option value={b}>{b}</option>}</For>
                          </select>
                        </div>
                      </Show>
                    </Show>
                  </div>
                  <div class="cx-field">
                    <label class="cx-field-label">Model</label>
                    <div class="cx-select-wrap">
                      <select class="cx-select" value={netModel()} onChange={(e) => setNetModel(e.currentTarget.value)}>
                        <For each={NET_MODELS}>{(m) => <option value={m}>{m}</option>}</For>
                      </select>
                    </div>
                  </div>
                  <div class="cx-field">
                    <label class="cx-field-label">VLAN tag (optional)</label>
                    <input class="cx-input" placeholder="none" value={vlanTag()} onInput={(e) => setVlanTag(e.currentTarget.value.replace(/[^0-9]/g, ""))} />
                  </div>
                  <div class="cx-field" style={{ "justify-content": "flex-end" }}>
                    <label class="cx-switch" style={{ height: "40px" }}>
                      <input type="checkbox" checked={firewall()} onChange={(e) => setFirewall(e.currentTarget.checked)} />
                      <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                      <span class="cx-switch-label">Firewall</span>
                    </label>
                  </div>
                </div>
              </div>
            </Show>

            {/* --- step 4: review --- */}
            <Show when={step() === 4}>
              <div class="cx-wizard-panel">
                <div class="cx-review-section-label">Basics</div>
                <dl class="cx-review-list">
                  <div class="cx-review-row"><dt>Node</dt><dd>{node()}</dd></div>
                  <div class="cx-review-row"><dt>VMID</dt><dd>{vmid()}</dd></div>
                  <div class="cx-review-row"><dt>Name</dt><dd>{name()}</dd></div>
                </dl>
                <div class="cx-review-section-label">OS &amp; Media</div>
                <dl class="cx-review-list">
                  <div class="cx-review-row"><dt>OS type</dt><dd>{OS_TYPES.find((o) => o.value === osType())?.label}</dd></div>
                  <div class="cx-review-row"><dt>Boot media</dt><dd>{useIso() && isoVolid() ? isoVolid().split("/").pop() : "none"}</dd></div>
                  <div class="cx-review-row"><dt>Guest agent</dt><dd>{guestAgent() ? "enabled" : "disabled"}</dd></div>
                </dl>
                <div class="cx-review-section-label">CPU &amp; Memory</div>
                <dl class="cx-review-list">
                  <div class="cx-review-row"><dt>CPU</dt><dd>{sockets()} × {cores()} ({cpuType()})</dd></div>
                  <div class="cx-review-row"><dt>Memory</dt><dd>{fmtMem(memoryMb())}{ballooning() ? " (balloon)" : ""}</dd></div>
                </dl>
                <div class="cx-review-section-label">Disk &amp; Network</div>
                <dl class="cx-review-list">
                  <div class="cx-review-row"><dt>Disk</dt><dd>{diskStorage()}:{diskSizeGb()}G ({diskBus()})</dd></div>
                  <div class="cx-review-row"><dt>Network</dt><dd>{netModel()} on {bridge()}{vlanTag() ? ` (vlan ${vlanTag()})` : ""}{firewall() ? " · fw" : ""}</dd></div>
                </dl>

                <label class="cx-switch" style={{ "margin-top": "6px" }}>
                  <input type="checkbox" checked={startAfterCreate()} onChange={(e) => setStartAfterCreate(e.currentTarget.checked)} />
                  <span class="cx-switch-track"><span class="cx-switch-thumb" /></span>
                  <span class="cx-switch-label">Start VM after creation</span>
                </label>

                <Show when={createErr()}>
                  <div class="cx-error-card">{createErr()}</div>
                </Show>
              </div>
            </Show>
          </div>

          <div class="cx-modal-foot">
            <Show when={step() > 0}>
              <button type="button" class="cx-btn cx-btn-ghost" disabled={creating()} onClick={back}>Back</button>
            </Show>
            <div class="cx-modal-foot-spacer" />
            <button type="button" class="cx-btn cx-btn-ghost" disabled={creating()} onClick={requestClose}>Cancel</button>
            <Show
              when={step() < STEPS.length - 1}
              fallback={
                <button type="button" class="cx-btn cx-btn-primary" disabled={creating()} onClick={submit}>
                  <Show when={creating()}><span class="cx-spinner" /></Show>
                  {creating() ? "Creating…" : "Create VM"}
                </button>
              }
            >
              <button type="button" class="cx-btn cx-btn-primary" disabled={!stepValid()} onClick={next}>Next</button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default VmCreateModal
