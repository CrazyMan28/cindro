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
    src/PluginRegistry.cpp
    src/CodexParser.cpp
    src/CodexBrain.cpp
    src/ClaudeParser.cpp
    src/ClaudeBrain.cpp
    src/ApiBrain.cpp
    src/MemoryStore.cpp
    src/SkillStore.cpp
    src/DeviceRegistry.cpp
    src/PairingManager.cpp
    src/FcmSender.cpp
    src/AgentDesktop.cpp
    src/VoiceService.cpp
    # Wave 8 co-worker ops backend: scheduler (cron/at), SSH allow-list, audit
    # log + prompt-injection gate, desktop notifications.
    src/Scheduler.cpp
    src/SshAllowList.cpp
    src/AuditLog.cpp
    src/InjectionGuard.cpp
    src/NotifyService.cpp
    # Headers listed so AUTOMOC processes the Q_OBJECT types (Brain, CodexBrain),
    # generating their staticMetaObject + vtable into this static lib.
    include/jarvis/Protocol.h
    include/jarvis/Config.h
    include/jarvis/SessionStore.h
    include/jarvis/SettingsStore.h
    include/jarvis/McpRegistry.h
    include/jarvis/PluginRegistry.h
    include/jarvis/CodexParser.h
    include/jarvis/Brain.h
    include/jarvis/CodexBrain.h
    include/jarvis/ClaudeParser.h
    include/jarvis/ClaudeBrain.h
    include/jarvis/ApiBrain.h
    include/jarvis/MemoryStore.h
    include/jarvis/SkillStore.h
    include/jarvis/DeviceRegistry.h
    include/jarvis/PairingManager.h
    include/jarvis/FcmSender.h
    include/jarvis/AgentDesktop.h
    include/jarvis/VoiceService.h
    include/jarvis/Scheduler.h
    include/jarvis/SshAllowList.h
    include/jarvis/AuditLog.h
    include/jarvis/InjectionGuard.h
    include/jarvis/NotifyService.h
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

# MemoryStore: add + FTS5 search + replace + remove roundtrip (temp DB).
add_executable(memory_store_test tests/memory_store_test.cpp)
target_link_libraries(memory_store_test PRIVATE jarvis-core Qt6::Core Qt6::Sql)
add_test(NAME memory_store_test COMMAND memory_store_test)

# SkillStore: frontmatter parse + create (self-authoring) + invoke (template
# render) roundtrip (temp skills root).
add_executable(skill_store_test tests/skill_store_test.cpp)
target_link_libraries(skill_store_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME skill_store_test COMMAND skill_store_test)

# Wave 8 co-worker ops backend tests.
# Scheduler: cron / "every Nm" / "at HH:MM" next-run calculation + a temp-DB
# create/tick fire roundtrip.
add_executable(scheduler_test tests/scheduler_test.cpp)
target_link_libraries(scheduler_test PRIVATE jarvis-core Qt6::Core Qt6::Sql)
add_test(NAME scheduler_test COMMAND scheduler_test)

# SshAllowList: a non-allow-listed host is rejected with host_not_allowed and
# ssh is never spawned; allow_add/remove persistence roundtrip.
add_executable(ssh_allowlist_test tests/ssh_allowlist_test.cpp)
target_link_libraries(ssh_allowlist_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME ssh_allowlist_test COMMAND ssh_allowlist_test)

# InjectionGuard: a known-bad injection string flags risky; benign text does not.
add_executable(injection_guard_test tests/injection_guard_test.cpp)
target_link_libraries(injection_guard_test PRIVATE jarvis-core Qt6::Core)
add_test(NAME injection_guard_test COMMAND injection_guard_test)
