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
    src/DeviceRegistry.cpp
    src/PairingManager.cpp
    src/FcmSender.cpp
    src/AgentDesktop.cpp
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
    include/jarvis/DeviceRegistry.h
    include/jarvis/PairingManager.h
    include/jarvis/FcmSender.h
    include/jarvis/AgentDesktop.h
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
