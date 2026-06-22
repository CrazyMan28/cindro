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

find_package(Qt6 REQUIRED COMPONENTS Core Sql WebSockets)

add_library(jarvis-core STATIC
    src/Protocol.cpp
    src/Config.cpp
    src/SessionStore.cpp
    src/CodexParser.cpp
    src/CodexBrain.cpp
    # Headers listed so AUTOMOC processes the Q_OBJECT types (Brain, CodexBrain),
    # generating their staticMetaObject + vtable into this static lib.
    include/jarvis/Protocol.h
    include/jarvis/Config.h
    include/jarvis/SessionStore.h
    include/jarvis/CodexParser.h
    include/jarvis/Brain.h
    include/jarvis/CodexBrain.h
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
