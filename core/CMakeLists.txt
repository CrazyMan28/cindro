# jarvis-core: C++20 static library shared by jarvisd and the desktop sidebar.
# Provides protocol types (Contracts A & B), SQLite SessionStore, the Brain
# interface + CodexBrain, the pure codex JSONL parser, and config loading.

cmake_minimum_required(VERSION 3.21)

# Allow building this directory standalone (e.g. for the parser ctest) as well
# as via the top-level superbuild.
if(NOT DEFINED PROJECT_NAME)
    project(jarvis_core LANGUAGES CXX)
endif()

set(CMAKE_AUTOMOC ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS Core Sql WebSockets Network)

# libsodium (ed25519 device identity + signature verify) and libqrencode
# (pairing QR SVG) — both via pkg-config (no CMake config packages on Fedora).
find_package(PkgConfig REQUIRED)
pkg_check_modules(SODIUM REQUIRED IMPORTED_TARGET libsodium)
pkg_check_modules(QRENCODE REQUIRED IMPORTED_TARGET libqrencode)

add_library(jarvis-core STATIC
    src/Protocol.cpp
    src/Config.cpp
    src/SessionStore.cpp
    src/SettingsStore.cpp
    src/McpRegistry.cpp
    src/Connectors.cpp
    src/PluginRegistry.cpp
    src/PluginSigner.cpp
    src/PluginSandbox.cpp
    src/CodexParser.cpp
    src/CodexBrain.cpp
    src/ClaudeParser.cpp
    src/ClaudeBrain.cpp
    src/ApiBrain.cpp
    src/MemoryStore.cpp
    src/SkillStore.cpp
    src/HookStore.cpp
    src/AgentStore.cpp
    src/DeviceRegistry.cpp
    src/PairingManager.cpp
    src/AuthChallengeStore.cpp
    src/FcmSender.cpp
    src/AgentDesktop.cpp
    src/VoiceService.cpp
    src/VoiceProvider.cpp
    # Cross-platform self-update: runs packaging/update.sh (Linux) /
    # windows/scripts/update.ps1 (Windows) and parses their check/apply JSON.
    src/Updater.cpp
    # Named cloned-voice library (record/upload, name, set-default) — the manifest
    # + reference clips under ~/.config/jarvis/voices/.
    src/VoiceLibrary.cpp
    # Wave 8 co-worker ops backend: scheduler (cron/at), SSH allow-list, audit
    # log + prompt-injection gate, desktop notifications.
    src/Scheduler.cpp
    src/SshAllowList.cpp
    src/AuditLog.cpp
    src/InjectionGuard.cpp
    src/NotifyService.cpp
    # Live-widget viewer-lease registry (battery gating: a live widget only runs
    # while a desktop/phone viewer or a home-screen pin is watching it).
    src/WidgetLeaseRegistry.cpp
    # Headers listed so AUTOMOC processes the Q_OBJECT types (Brain, CodexBrain),
    # generating their staticMetaObject + vtable into this static lib.
    include/jarvis/Protocol.h
    include/jarvis/Config.h
    include/jarvis/SessionStore.h
    include/jarvis/SettingsStore.h
    include/jarvis/McpRegistry.h
    include/jarvis/Connectors.h
    include/jarvis/PluginRegistry.h
    include/jarvis/PluginSigner.h
    include/jarvis/PluginSandbox.h
    include/jarvis/CodexParser.h
    include/jarvis/Brain.h
    include/jarvis/CodexBrain.h
    include/jarvis/ClaudeParser.h
    include/jarvis/ClaudeBrain.h
    include/jarvis/ApiBrain.h
    include/jarvis/MemoryStore.h
    include/jarvis/SkillStore.h
    include/jarvis/HookStore.h
    include/jarvis/AgentStore.h
    include/jarvis/DeviceRegistry.h
    include/jarvis/PairingManager.h
    include/jarvis/AuthChallengeStore.h
    include/jarvis/FcmSender.h
    include/jarvis/AgentDesktop.h
    include/jarvis/VoiceService.h
    include/jarvis/VoiceProvider.h
    include/jarvis/Updater.h
    include/jarvis/VoiceLibrary.h
    include/jarvis/Scheduler.h
    include/jarvis/SshAllowList.h
    include/jarvis/AuditLog.h
    include/jarvis/InjectionGuard.h
    include/jarvis/NotifyService.h
    include/jarvis/WidgetLeaseRegistry.h
)

target_include_directories(jarvis-core
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(jarvis-core
    PUBLIC
        Qt6::Core
        Qt6::Sql
        Qt6::WebSockets
        Qt6::Network
    PRIVATE
        PkgConfig::SODIUM
        PkgConfig::QRENCODE
)

target_compile_features(jarvis-core PUBLIC cxx_std_20)

# --- version stamp --------------------------------------------------------
# JARVIS_VERSION + JARVIS_GIT_SHA compile constants: the Updater compares the
# running SHA/version to `main`. PUBLIC so jarvisd, the desktop, and the unit
# tests all inherit the same identity. The SHA is resolved at configure time
# (falls back to "unknown" outside a git checkout).
set(JARVIS_VERSION "0.12.0")
execute_process(
    COMMAND git -C "${CMAKE_CURRENT_SOURCE_DIR}" rev-parse --short HEAD
    OUTPUT_VARIABLE JARVIS_GIT_SHA
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
if(NOT JARVIS_GIT_SHA)
    set(JARVIS_GIT_SHA "unknown")
endif()
target_compile_definitions(jarvis-core PUBLIC
    JARVIS_VERSION="${JARVIS_VERSION}"
    JARVIS_GIT_SHA="${JARVIS_GIT_SHA}")

# --- tests ----------------------------------------------------------------
enable_testing()

set(JARVIS_CODEX_SAMPLE
    "${CMAKE_CURRENT_SOURCE_DIR}/../spikes/codex_jsonl_sample.jsonl"
    CACHE FILEPATH "Codex JSONL sample fed to the parser test")

add_executable(codex_parser_test tests/codex_parser_test.cpp)
target_link_libraries(codex_parser_test PRIVATE jarvis-core Qt6::Core)
target_compile_definitions(codex_parser_test
    PRIVATE JARVIS_CODEX_SAMPLE="${JARVIS_CODEX_SAMPLE}")

add_test(NAME codex_parser_test
         COMMAND codex_parser_test "${JARVIS_CODEX_SAMPLE}")

# Contract C core: DeviceRegistry (ed25519 pair/verify/revoke) + PairingManager
# (6-digit code lifecycle + QR SVG). Links libsodium directly for keygen/sign.
add_executable(device_registry_test tests/device_registry_test.cpp)
target_link_libraries(device_registry_test
    PRIVATE jarvis-core Qt6::Core PkgConfig::SODIUM)

add_test(NAME device_registry_test COMMAND device_registry_test)

# 2FA + fingerprint cross-device unlock core: AuthChallengeStore lifecycle
# (create -> pending; approve -> approved + single-use; ttl expiry; deny;
# unknown id reports "expired"). Pure logic, no sockets. Links libsodium for the
# randombytes id mint.
add_executable(auth_challenge_test tests/auth_challenge_test.cpp)
target_link_libraries(auth_challenge_test
    PRIVATE jarvis-core Qt6::Core PkgConfig::SODIUM)
add_test(NAME auth_challenge_test COMMAND auth_challenge_test)

# Wave 5 intelligence backend tests.
# ClaudeBrain parser: captured `claude --output-format stream-json` sample +
# synthetic tool turn -> Contract B normalized sequence.
set(JARVIS_CLAUDE_SAMPLE
    "${CMAKE_CURRENT_SOURCE_DIR}/../spikes/claude_stream_json_sample.jsonl"
    CACHE FILEPATH "Claude stream-json sample fed to the parser test")

add_executable(claude_parser_test tests/claude_parser_test.cpp)
target_link_libraries(claude_parser_test PRIVATE jarvis-core Qt6::Core)
target_compile_definitions(claude_parser_test
    PRIVATE JARVIS_CLAUDE_SAMPLE="${JARVIS_CLAUDE_SAMPLE}")
add_test(NAME claude_parser_test
         COMMAND claude_parser_test "${JARVIS_CLAUDE_SAMPLE}")

# ClaudeBrain argv shape: asserts the prompt is an isolated trailing positional
# after `--` (guards the prior --add-dir variadic-swallow regression).
add_executable(claude_buildargs_test tests/claude_buildargs_test.cpp)
target_link_libraries(claude_buildargs_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME claude_buildargs_test COMMAND claude_buildargs_test)

# CodexBrain drive-mode argv: forces danger-full-access + approval_policy=never
# so codex can actually call MCP tools headless (coder path stays workspace-write).
add_executable(codex_buildargs_test tests/codex_buildargs_test.cpp)
target_link_libraries(codex_buildargs_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME codex_buildargs_test COMMAND codex_buildargs_test)

# ApiBrain function-calling (agentic tool) loop — PURE LOGIC of the OpenAI-
# compatible (openai/mistral/ollama) tool loop with no live engine: MCP
# tools/list -> OpenAI tools[] conversion, streamed tool_calls accumulation
# across fragmented SSE deltas -> a complete {id,name,arguments}, and
# finish_reason detection.
add_executable(api_brain_tools_test tests/api_brain_tools_test.cpp)
target_link_libraries(api_brain_tools_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME api_brain_tools_test COMMAND api_brain_tools_test)

# MemoryStore: add + FTS5 search + replace + remove roundtrip (temp DB).
add_executable(memory_store_test tests/memory_store_test.cpp)
target_link_libraries(memory_store_test PRIVATE jarvis-core Qt6::Core Qt6::Sql)
add_test(NAME memory_store_test COMMAND memory_store_test)

# SkillStore: frontmatter parse + create (self-authoring) + invoke (template
# render) roundtrip (temp skills root).
add_executable(skill_store_test tests/skill_store_test.cpp)
target_link_libraries(skill_store_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME skill_store_test COMMAND skill_store_test)

# AgentStore: frontmatter parse + create (self-authoring) + list/get/read +
# overwrite-in-place + claude-format serialize + remove (temp agents root).
add_executable(agent_store_test tests/agent_store_test.cpp)
target_link_libraries(agent_store_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME agent_store_test COMMAND agent_store_test)

# VoiceProvider: provider enumeration always includes voxtral(available); a local
# provider with no binary/model gracefully falls back to voxtral (no crash); and
# SettingsStore round-trips stt_provider/tts_provider through saveConfig->load
# against a QTemporaryDir HOME (with bad values normalized to "voxtral").
add_executable(voice_provider_test tests/voice_provider_test.cpp)
target_link_libraries(voice_provider_test PRIVATE jarvis-core Qt6::Core Qt6::Network)
add_test(NAME voice_provider_test COMMAND voice_provider_test)

# VoiceLibrary: named cloned-voice manifest CRUD against a QTemporaryDir HOME —
# seed-from-disk (jarvice_ref.* -> "Jarvis" default), create/list/set-default,
# slug + create-or-replace by slug, removal repairs the default, raw (no-ffmpeg)
# storage, and clip-path resolution. Hermetic (raw .wav bytes; no ffmpeg/network).
add_executable(voice_library_test tests/voice_library_test.cpp)
target_link_libraries(voice_library_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME voice_library_test COMMAND voice_library_test)

# SettingsStore: auth-lock is ON by default (no-brick) on a FRESH config; the
# default + an explicit user OFF round-trip through saveConfig->load against a
# QTemporaryDir HOME (a config missing the key still reads ON).
add_executable(settings_store_test tests/settings_store_test.cpp)
target_link_libraries(settings_store_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME settings_store_test COMMAND settings_store_test)

# HookStore: Claude-Code-style lifecycle hooks — matcher routing, the
# exit-code/stdout block+inject protocol, and CRUD round-trip through
# hooks.json against a QTemporaryDir HOME (real hook scripts, hermetic).
add_executable(hook_store_test tests/hook_store_test.cpp)
target_link_libraries(hook_store_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME hook_store_test COMMAND hook_store_test)

# Wave 8 co-worker ops backend tests.
# Scheduler: cron / "every Nm" / "at HH:MM" next-run calculation + a temp-DB
# create/tick fire roundtrip.
add_executable(scheduler_test tests/scheduler_test.cpp)
target_link_libraries(scheduler_test PRIVATE jarvis-core Qt6::Core Qt6::Sql)
add_test(NAME scheduler_test COMMAND scheduler_test)

# Google connectors framework: a connector row (stdio, disabled, env JSON) is
# stored + listed with name "google-calendar", enabled==false, env round-trips,
# and toJson() omits env/token. Pure store-level proof (mirrors memory_store_test).
add_executable(connectors_test tests/connectors_test.cpp)
target_link_libraries(connectors_test PRIVATE jarvis-core Qt6::Core Qt6::Sql)
add_test(NAME connectors_test COMMAND connectors_test)

# SshAllowList: a non-allow-listed host is rejected with host_not_allowed and
# ssh is never spawned; allow_add/remove persistence roundtrip.
add_executable(ssh_allowlist_test tests/ssh_allowlist_test.cpp)
target_link_libraries(ssh_allowlist_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME ssh_allowlist_test COMMAND ssh_allowlist_test)

# InjectionGuard: a known-bad injection string flags risky; benign text does not.
add_executable(injection_guard_test tests/injection_guard_test.cpp)
target_link_libraries(injection_guard_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME injection_guard_test COMMAND injection_guard_test)

# WidgetLeaseRegistry: viewer-lease lifecycle (touch/TTL/clear/clearSource/wipe)
# that gates live-widget work for battery. Pure file-store proof (tmp dir).
add_executable(widget_lease_test tests/widget_lease_test.cpp)
target_link_libraries(widget_lease_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME widget_lease_test COMMAND widget_lease_test)

# Wave 7 plugin marketplace backend test.
# PluginSigner: sign a manifest+payload -> verify ok against a trusted key;
# a tampered manifest fails; an unknown signing key fails; the sandbox plan
# derives confinement from declared permissions. Links libsodium directly.
add_executable(plugin_sign_verify tests/plugin_sign_verify_test.cpp)
target_link_libraries(plugin_sign_verify
    PRIVATE jarvis-core Qt6::Core PkgConfig::SODIUM)
add_test(NAME plugin_sign_verify COMMAND plugin_sign_verify)

# Comprehensive HookStore test: all events, every matcher variant (exact/list/
# regex/star/empty), every block/inject protocol path (exit 2, decision:block,
# continue:false, permissionDecision:deny), multiple hooks/groups, timeout kill,
# non-fatal errors, CRUD round-trips, matchKey routing (tool/source/agent-type).
add_executable(hook_store_comprehensive_test
    tests/hook_store_comprehensive_test.cpp)
target_link_libraries(hook_store_comprehensive_test
    PRIVATE jarvis-core Qt6::Core)
add_test(NAME hook_store_comprehensive_test
         COMMAND hook_store_comprehensive_test)

# Updater PURE LOGIC: parse the platform script's check JSON {current,latest,
# behind} and the version/SHA compare (behind vs up-to-date), incl. null fields,
# the script-behind override, and runningSha fallback. No process/network.
add_executable(updater_test tests/updater_test.cpp)
target_link_libraries(updater_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME updater_test COMMAND updater_test)

# Comprehensive SettingsStore test: agent_mode/wake_notify/permission_level
# (plan/build/coworker, silent/ping/always, high/medium/low) + invalid->default
# normalisation, all persist via saveConfig+reload, UNRELATED config.toml keys
# preserved, defaults-when-absent, desktop PIN hashing not plaintext, API key
# set/clear + apiKeysSet().
add_executable(settings_modes_comprehensive_test
    tests/settings_modes_comprehensive_test.cpp)
target_link_libraries(settings_modes_comprehensive_test
    PRIVATE jarvis-core Qt6::Core)
add_test(NAME settings_modes_comprehensive_test
         COMMAND settings_modes_comprehensive_test)
