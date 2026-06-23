# Jarvis Plugin Marketplace (Wave 7 backend)

A Jarvis plugin is a small **signed package** that adds a capability to the
brains: an MCP server, a skill, or both. The daemon **verifies the Ed25519
signature before install**, records the verdict + the permissions it granted,
and launches MCP plugins **sandboxed** under exactly those permissions.

## Package layout

A package is a directory (or a `.tar.gz` of one) containing `jarvis-plugin.toml`
plus its payload:

```
hello-mcp/
  jarvis-plugin.toml        # the signed manifest
  skill/SKILL.md            # payload (skill body, scripts, ...)
```

### `jarvis-plugin.toml`

```toml
id          = "hello-mcp"
name        = "Hello MCP"
author      = "Jarvis Labs"
version     = "1.0.0"
kind        = "both"               # "mcp" | "skill" | "both"
description = "..."
permissions = ["filesystem:/tmp/hello-mcp", "network:api.hello.test"]

signature   = "ed25519:<keyId>:<base64 sig>"   # written by `jarvis-plugin sign`

[mcp]                              # for kind = mcp | both
transport = "stdio"                # "stdio" (sandbox-launched) | "http" (a URL)
command   = "hello-mcp --stdio"    # stdio: the launcher argv
# url     = "https://host/mcp/"    # http:  the endpoint instead of `command`
env_keys  = ["HELLO_TOKEN"]        # only these env vars cross the sandbox

[skill]                            # for kind = skill | both
path = "skill/SKILL.md"            # relative path to the SKILL.md payload
```

### Permission grammar

| permission           | grant                                                        |
|----------------------|-------------------------------------------------------------|
| `computer-use`       | may drive the desktop (highest tier — always needs approval) |
| `filesystem:<path>`  | read-write to `<path>` (`ReadWritePaths=<path>`)             |
| `network:<host>`     | network access (otherwise `PrivateNetwork=yes` isolates it)  |

The signature covers the **id, identity, transport/endpoint, skill path,
env_keys, permissions, and a SHA-256 of the payload** — tampering any of them
(including the payload) breaks verification.

## Signing & verification

Signing is **Ed25519** (libsodium in the daemon, `cryptography` in the CLI).
The canonical, signature-free byte string is identical on both sides
(`core/src/PluginSigner.cpp` ⟷ `tools/jarvis-plugin`), so a package signed by
the CLI verifies in the daemon.

Trusted publisher public keys live in `~/.config/jarvis/plugin_keys.json`:

```json
{ "keys": { "<keyId>": { "pubkey": "<base64>", "name": "..." } } }
```

`keyId` = first 16 hex of `sha256(pubkey)`.

## Install gating (daemon, Contract A `plugins.*`)

1. `plugins.catalog` returns each entry with `verified` + `permissions`.
2. `plugins.install{id}` **verifies first**. If the plugin is unverified
   (no trusted signature) **or** requests `computer-use`, it returns
   `{needs_approval:true, approval_tier:"biometric", permissions:[...]}`.
   Re-call with `{id, approve:true}` to confirm (biometric tier on the device).
   The verdict + granted permissions are persisted.
3. `plugins.set_enabled{id,true}` activates the capability:
   - **stdio MCP** → launched **sandboxed** (`systemd-run --user --scope` with
     `ProtectHome=read-only`, `ReadWritePaths` from `filesystem:` perms,
     `PrivateNetwork=yes` unless a `network:` perm exists, env scrubbed to the
     declared `env_keys`; a constrained `QProcess` fallback when systemd-run is
     unavailable). The PID is tracked; disable tears it down **by PID** (never
     pkill-by-name).
   - **http MCP** → a URL+bearer MCP server added to the registry for the brains.
   - **skill** → its `SKILL.md` is dropped into the skills dir (`plugin/<id>/`).

## CLI — `tools/jarvis-plugin`

Runs via `uv` (PEP 723 inline deps; resolves `cryptography` on first run).

```
./tools/jarvis-plugin keygen  --out keys/jarvis-labs        # Ed25519 keypair (.key 0600 / .pub)
./tools/jarvis-plugin pack    <dir> [-o out.tar.gz]         # tar.gz a package
./tools/jarvis-plugin sign    <pkg> --key keys/jarvis-labs.key
./tools/jarvis-plugin verify  <pkg> [--keys plugin_keys.json]
./tools/jarvis-plugin publish <pkg> <catalog-dir>          # add a signed entry to the catalog
```

`<pkg>` is a package dir or a `.tar.gz`. `publish` writes `<catalog>/<id>.toml`
(the flat manifest the daemon reads), copies the payload to `<catalog>/<id>/`
(so the daemon hashes the same bytes the publisher signed), and updates
`<catalog>/index.json`.

## Sample signed plugin

`plugins/sample-src/hello-mcp/` is signed by the demo publisher key
(`plugins/keys/jarvis-labs.pub`; the private `.key` is gitignored) and published
to `plugins/catalog/` (`hello-mcp.toml` + `hello-mcp/skill/SKILL.md` +
`index.json`). Add the publisher key to `~/.config/jarvis/plugin_keys.json` and:

```
./tools/jarvis-plugin verify plugins/sample-src/hello-mcp   # -> VERIFIED
```

## Tests

`ctest -R plugin_sign_verify` (in `build/`): sign→verify OK; tampered manifest
fails; tampered payload fails; unknown signing key fails; the sandbox plan
derives `ReadWritePaths`/`PrivateNetwork` from the declared permissions.
