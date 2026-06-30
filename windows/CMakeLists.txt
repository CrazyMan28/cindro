# Jarvis — Windows edition build (SELF-CONTAINED, lives entirely under windows/).
#
#   cmake -S windows -B build-win -G Ninja \
#         -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake
#   cmake --build build-win --config Release
#
# Produces build-win/jarvisd.exe (headless daemon) and build-win/jarvis-sidebar.exe
# (native Qt shell: tray + global hotkey, NO LayerShellQt).
#
# ── Isolation rule (HARD) ───────────────────────────────────────────────────
# This project NEVER edits anything under ../core, ../daemon, ../desktop, or the
# repo-root CMakeLists.txt. It REFERENCES the unmodified shared C++/QML sources
# read-only by their Linux paths, and for the handful of POSIX-only sources it
# compiles a COPY under windows/shell/ instead (excluding the original):
#
#   referenced read-only : every core/daemon source + the read-only desktop
#                          Bridge + FrameProvider + ALL desktop/qml/*.qml
#   copied + edited       : core/src/AgentDesktop.cpp     -> shell/AgentDesktop.cpp
#                           core/src/PluginSandbox.cpp    -> shell/PluginSandbox.cpp
#                           desktop/src/main.cpp          -> shell/main.cpp
#                           desktop/src/WindowController.* -> shell/WindowController.*
#   force-included shim   : shell/posix_compat.h (getuid/kill/SIGTERM/SIGKILL/pid_t)
#                           so the referenced-as-is sources compile under MSVC.

cmake_minimum_required(VERSION 3.24)

project(jarvis_windows LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

# Read-only roots in the shared Linux tree (one level up from windows/).
get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(CORE_DIR    "${REPO_ROOT}/core")
set(DAEMON_DIR  "${REPO_ROOT}/daemon")
set(DESKTOP_DIR "${REPO_ROOT}/desktop")
set(SHELL_DIR   "${CMAKE_CURRENT_SOURCE_DIR}/shell")
# Windows v2 isolation (the "beside-you" agent desktop): the reverse tunnel that
# re-exposes the in-sandbox engine on the host, plus the .wsb/.ps1 orchestration
# assets. Entirely under windows/ (the HARD isolation rule). See isolation/DESIGN.md.
set(ISOLATION_DIR "${CMAKE_CURRENT_SOURCE_DIR}/isolation")
set(RELAY_DIR     "${ISOLATION_DIR}/relay")

# Both exes land at the build-win root so windows/scripts/build.ps1 can stage them.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

# ── Dependencies ────────────────────────────────────────────────────────────
find_package(Qt6 REQUIRED COMPONENTS
    Core Gui Quick Qml QuickControls2 WebSockets Network Multimedia Sql)

qt_standard_project_setup(REQUIRES 6.5)

# libsodium + libqrencode via vcpkg. Prefer the upstream CMake config target
# (handles the SODIUM_STATIC define etc.); fall back to find_path/find_library so
# the build also works against a system/manual install.
find_package(unofficial-sodium CONFIG QUIET)
if(TARGET unofficial-sodium::sodium)
    set(SODIUM_TARGET unofficial-sodium::sodium)
else()
    find_path(SODIUM_INCLUDE_DIR sodium.h REQUIRED)
    find_library(SODIUM_LIBRARY NAMES sodium libsodium REQUIRED)
    add_library(jarvis_sodium INTERFACE)
    target_include_directories(jarvis_sodium INTERFACE ${SODIUM_INCLUDE_DIR})
    target_link_libraries(jarvis_sodium INTERFACE ${SODIUM_LIBRARY})
    set(SODIUM_TARGET jarvis_sodium)
endif()

find_path(QRENCODE_INCLUDE_DIR qrencode.h REQUIRED)
find_library(QRENCODE_LIBRARY NAMES qrencode libqrencode REQUIRED)
add_library(jarvis_qrencode INTERFACE)
target_include_directories(jarvis_qrencode INTERFACE ${QRENCODE_INCLUDE_DIR})
target_link_libraries(jarvis_qrencode INTERFACE ${QRENCODE_LIBRARY})

# Force-include the POSIX shim into every Windows TU (the C++ analogue of the
# engine's os.getuid shim). /FI on MSVC, -include on GCC/clang(-cl/MinGW).
set(POSIX_COMPAT "${SHELL_DIR}/posix_compat.h")
if(MSVC)
    set(FORCE_INCLUDE_FLAGS "/FI${POSIX_COMPAT}")
else()
    set(FORCE_INCLUDE_FLAGS "-include" "${POSIX_COMPAT}")
endif()

# ── jarvis-core (static lib) ────────────────────────────────────────────────
# The SAME source list as core/CMakeLists.txt, except AgentDesktop.cpp and
# PluginSandbox.cpp are swapped for the windows/shell/ copies (the POSIX-heavy
# originals are NOT compiled). Headers are listed so AUTOMOC emits the Q_OBJECT
# metaobjects (Brain, CodexBrain, …) exactly as the Linux core does.
add_library(jarvis-core STATIC
    ${CORE_DIR}/src/Protocol.cpp
    ${CORE_DIR}/src/Config.cpp
    ${CORE_DIR}/src/SessionStore.cpp
    ${CORE_DIR}/src/SettingsStore.cpp
    ${CORE_DIR}/src/McpRegistry.cpp
    ${CORE_DIR}/src/Connectors.cpp
    ${CORE_DIR}/src/PluginRegistry.cpp
    ${CORE_DIR}/src/PluginSigner.cpp
    ${SHELL_DIR}/PluginSandbox.cpp           # COPY (systemd -> QProcess fallback)
    ${CORE_DIR}/src/CodexParser.cpp
    ${CORE_DIR}/src/CodexBrain.cpp
    ${CORE_DIR}/src/ClaudeParser.cpp
    ${CORE_DIR}/src/ClaudeBrain.cpp
    ${CORE_DIR}/src/ApiBrain.cpp
    ${CORE_DIR}/src/MemoryStore.cpp
    ${CORE_DIR}/src/SkillStore.cpp
    ${CORE_DIR}/src/HookStore.cpp
    ${CORE_DIR}/src/AgentStore.cpp
    ${CORE_DIR}/src/DeviceRegistry.cpp
    ${CORE_DIR}/src/PairingManager.cpp
    ${CORE_DIR}/src/AuthChallengeStore.cpp
    ${CORE_DIR}/src/FcmSender.cpp
    ${SHELL_DIR}/AgentDesktop.cpp            # COPY (nested-Sway -> Windows Sandbox v2)
    ${RELAY_DIR}/ReverseTunnel.cpp           # v2 gap #2 reverse tunnel (host side)
    ${RELAY_DIR}/ReverseTunnel.h
    ${CORE_DIR}/src/VoiceService.cpp
    ${CORE_DIR}/src/VoiceProvider.cpp
    ${CORE_DIR}/src/Updater.cpp
    ${CORE_DIR}/src/VoiceLibrary.cpp
    ${CORE_DIR}/src/Scheduler.cpp
    ${CORE_DIR}/src/SshAllowList.cpp
    ${CORE_DIR}/src/AuditLog.cpp
    ${CORE_DIR}/src/InjectionGuard.cpp
    ${CORE_DIR}/src/NotifyService.cpp
    ${CORE_DIR}/src/WidgetLeaseRegistry.cpp
    # Headers (AUTOMOC) — same set as core/CMakeLists.txt.
    ${CORE_DIR}/include/jarvis/Protocol.h
    ${CORE_DIR}/include/jarvis/Config.h
    ${CORE_DIR}/include/jarvis/SessionStore.h
    ${CORE_DIR}/include/jarvis/SettingsStore.h
    ${CORE_DIR}/include/jarvis/McpRegistry.h
    ${CORE_DIR}/include/jarvis/Connectors.h
    ${CORE_DIR}/include/jarvis/PluginRegistry.h
    ${CORE_DIR}/include/jarvis/PluginSigner.h
    ${CORE_DIR}/include/jarvis/PluginSandbox.h
    ${CORE_DIR}/include/jarvis/CodexParser.h
    ${CORE_DIR}/include/jarvis/Brain.h
    ${CORE_DIR}/include/jarvis/CodexBrain.h
    ${CORE_DIR}/include/jarvis/ClaudeParser.h
    ${CORE_DIR}/include/jarvis/ClaudeBrain.h
    ${CORE_DIR}/include/jarvis/ApiBrain.h
    ${CORE_DIR}/include/jarvis/MemoryStore.h
    ${CORE_DIR}/include/jarvis/SkillStore.h
    ${CORE_DIR}/include/jarvis/HookStore.h
    ${CORE_DIR}/include/jarvis/AgentStore.h
    ${CORE_DIR}/include/jarvis/DeviceRegistry.h
    ${CORE_DIR}/include/jarvis/PairingManager.h
    ${CORE_DIR}/include/jarvis/AuthChallengeStore.h
    ${CORE_DIR}/include/jarvis/FcmSender.h
    ${CORE_DIR}/include/jarvis/AgentDesktop.h
    ${CORE_DIR}/include/jarvis/VoiceService.h
    ${CORE_DIR}/include/jarvis/VoiceProvider.h
    ${CORE_DIR}/include/jarvis/Updater.h
    ${CORE_DIR}/include/jarvis/VoiceLibrary.h
    ${CORE_DIR}/include/jarvis/Scheduler.h
    ${CORE_DIR}/include/jarvis/SshAllowList.h
    ${CORE_DIR}/include/jarvis/AuditLog.h
    ${CORE_DIR}/include/jarvis/InjectionGuard.h
    ${CORE_DIR}/include/jarvis/NotifyService.h
    ${CORE_DIR}/include/jarvis/WidgetLeaseRegistry.h
)

target_include_directories(jarvis-core
    PUBLIC  ${CORE_DIR}/include
    PRIVATE ${RELAY_DIR})            # windows/shell/AgentDesktop.cpp -> ReverseTunnel.h
target_link_libraries(jarvis-core
    PUBLIC  Qt6::Core Qt6::Sql Qt6::WebSockets Qt6::Network
    PRIVATE ${SODIUM_TARGET} jarvis_qrencode)
target_compile_features(jarvis-core PUBLIC cxx_std_20)
target_compile_options(jarvis-core PRIVATE ${FORCE_INCLUDE_FLAGS})

# Version stamp (matches core/CMakeLists.txt): the Updater compares the running
# SHA/version to `main`. PUBLIC so jarvisd + the sidebar inherit it. SHA resolved
# at configure time against the shared repo, "unknown" outside a checkout.
set(JARVIS_VERSION "0.12.5")
execute_process(
    COMMAND git -C "${REPO_ROOT}" rev-parse --short HEAD
    OUTPUT_VARIABLE JARVIS_GIT_SHA
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
if(NOT JARVIS_GIT_SHA)
    set(JARVIS_GIT_SHA "unknown")
endif()
target_compile_definitions(jarvis-core PUBLIC
    JARVIS_VERSION="${JARVIS_VERSION}"
    JARVIS_GIT_SHA="${JARVIS_GIT_SHA}")

# ── jarvisd.exe (headless daemon) ───────────────────────────────────────────
# Daemon sources are referenced read-only — they use systemctl/sway only via
# QProcess at RUNTIME (no POSIX includes), so they compile clean on MSVC and
# degrade gracefully (those programs simply don't exist on Windows).
qt_add_executable(jarvisd
    ${DAEMON_DIR}/src/main.cpp
    ${DAEMON_DIR}/src/ControlServer.cpp
    ${DAEMON_DIR}/src/DeviceServer.cpp
    ${DAEMON_DIR}/src/ControlServer.h
    ${DAEMON_DIR}/src/DeviceServer.h
)
target_include_directories(jarvisd PRIVATE ${DAEMON_DIR}/src)
target_link_libraries(jarvisd PRIVATE
    jarvis-core Qt6::Core Qt6::Network Qt6::Sql Qt6::WebSockets ${SODIUM_TARGET})
target_compile_features(jarvisd PRIVATE cxx_std_20)
target_compile_options(jarvisd PRIVATE ${FORCE_INCLUDE_FLAGS})

# ── jarvis-relay.exe (Windows v2 reverse tunnel) ────────────────────────────
# Standalone reverse-tunnel CLI. The daemon runs ReverseTunnel IN-PROCESS (host
# side, compiled into jarvis-core), but this exe is staged next to jarvis-engine.exe
# so the read-only MappedFolder exposes it at C:\engine\jarvis-relay.exe inside the
# sandbox, where bootstrap.ps1 runs it in `dial` mode (gap #2). Pure Qt Core+Network;
# console subsystem (bootstrap launches it hidden via Start-Process -WindowStyle Hidden).
qt_add_executable(jarvis-relay
    ${RELAY_DIR}/relay_main.cpp
    ${RELAY_DIR}/ReverseTunnel.cpp
    ${RELAY_DIR}/ReverseTunnel.h
)
target_include_directories(jarvis-relay PRIVATE ${RELAY_DIR})
target_link_libraries(jarvis-relay PRIVATE Qt6::Core Qt6::Network)
target_compile_features(jarvis-relay PRIVATE cxx_std_20)
target_compile_options(jarvis-relay PRIVATE ${FORCE_INCLUDE_FLAGS})

# ── jarvis-sidebar.exe (native Qt shell) ────────────────────────────────────
# Sources: the windows/shell copies of main.cpp + WindowController.{h,cpp} PLUS
# the read-only desktop Bridge + FrameProvider. The entire ~60-page UI is the
# shared desktop/qml/*.qml referenced (NOT copied) via qt_add_qml_module.
qt_add_executable(jarvis-sidebar
    ${SHELL_DIR}/main.cpp
    ${SHELL_DIR}/WindowController.cpp
    ${SHELL_DIR}/WindowController.h
    ${DESKTOP_DIR}/src/Bridge.cpp
    ${DESKTOP_DIR}/src/Bridge.h
    ${DESKTOP_DIR}/src/FrameProvider.h
)

# QML singletons (must be flagged so the generated qmldir registers them as one).
set_source_files_properties(${DESKTOP_DIR}/qml/Theme.qml
    PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
set_source_files_properties(${DESKTOP_DIR}/qml/Widgets.qml
    PROPERTIES QT_QML_SINGLETON_TYPE TRUE)

# The QML files live in ../desktop/qml (OUTSIDE this dir), so they resolve to
# ABSOLUTE paths — Qt's resource system rejects absolute-path QML sources unless
# each carries a QT_RESOURCE_ALIAS. Set it to the same "qml/<name>" in-module path
# the Linux build uses (desktop/CMakeLists.txt lists them relative as qml/<name>),
# so the resource layout + loadFromModule("JarvisSidebar","Main") are identical.
file(GLOB _jarvis_qml CONFIGURE_DEPENDS ${DESKTOP_DIR}/qml/*.qml)
foreach(_q IN LISTS _jarvis_qml)
    get_filename_component(_qn "${_q}" NAME)
    set_source_files_properties("${_q}" PROPERTIES QT_RESOURCE_ALIAS "qml/${_qn}")
endforeach()

# ArcReactor.qml has `var long` (lines 64-65). `long` is a reserved word in Qt's
# runtime QML/JS parser (rejected on <= 6.8). The Linux build is fine because
# qmlcachegen AOT-compiles the QML, but THIS build uses NO_CACHEGEN (below) so the
# QML is parsed RAW at runtime -> the whole UI tree fails to load ("ArcReactor.qml:
# Expected token 'identifier'", which bricked v0.12.4 on a clean box). We never edit
# desktop/qml — generate a renamed copy at configure time and use it instead.
set(_arc_patched "${CMAKE_CURRENT_BINARY_DIR}/qml-patched/ArcReactor.qml")
file(READ "${DESKTOP_DIR}/qml/ArcReactor.qml" _arc_src)
string(REPLACE "var long =" "var lng =" _arc_src "${_arc_src}")
string(REPLACE "(long ?"    "(lng ?"    _arc_src "${_arc_src}")
file(WRITE "${_arc_patched}" "${_arc_src}")
set_source_files_properties("${_arc_patched}" PROPERTIES QT_RESOURCE_ALIAS "qml/ArcReactor.qml")

# Reuse the shared UI verbatim — same URI ("JarvisSidebar") + same file list as
# desktop/CMakeLists.txt, referenced read-only from ../desktop/qml.
qt_add_qml_module(jarvis-sidebar
    URI JarvisSidebar
    VERSION 1.0
    # The QML lives OUTSIDE this build dir (../desktop/qml), so qmlcachegen derives
    # an output path with a ".." segment ninja can't mkdir. NO_CACHEGEN skips the
    # AOT bytecode cache — the QML is still embedded in the resource + loaded at
    # runtime (marginally slower first load; correct + reliable for the Win build).
    NO_CACHEGEN
    QML_FILES
        ${DESKTOP_DIR}/qml/Main.qml
        ${DESKTOP_DIR}/qml/AppShell.qml
        ${DESKTOP_DIR}/qml/HomePage.qml
        ${DESKTOP_DIR}/qml/AgentPeek.qml
        ${DESKTOP_DIR}/qml/NavRail.qml
        ${DESKTOP_DIR}/qml/CommandPalette.qml
        ${DESKTOP_DIR}/qml/PageHeader.qml
        ${DESKTOP_DIR}/qml/Widgets.qml
        ${DESKTOP_DIR}/qml/JarvisPanel.qml
        ${DESKTOP_DIR}/qml/ChatDelegate.qml
        ${DESKTOP_DIR}/qml/SessionsPage.qml
        ${DESKTOP_DIR}/qml/SettingsPage.qml
        ${DESKTOP_DIR}/qml/SetupWizard.qml
        ${DESKTOP_DIR}/qml/McpPage.qml
        ${DESKTOP_DIR}/qml/PluginsPage.qml
        ${DESKTOP_DIR}/qml/MemoryPage.qml
        ${DESKTOP_DIR}/qml/SkillsPage.qml
        ${DESKTOP_DIR}/qml/AgentsPage.qml
        ${DESKTOP_DIR}/qml/SlashPalette.qml
        ${DESKTOP_DIR}/qml/TodayBriefing.qml
        ${DESKTOP_DIR}/qml/ComputerPage.qml
        ${DESKTOP_DIR}/qml/CanvasPage.qml
        ${DESKTOP_DIR}/qml/WidgetsPage.qml
        ${DESKTOP_DIR}/qml/VoiceMode.qml
        ${DESKTOP_DIR}/qml/WidgetRenderer.qml
        ${DESKTOP_DIR}/qml/StandaloneWidget.qml
        ${DESKTOP_DIR}/qml/FloatingWidgetLayer.qml
        ${DESKTOP_DIR}/qml/SchedulesPage.qml
        ${DESKTOP_DIR}/qml/PhonePage.qml
        ${DESKTOP_DIR}/qml/PhoneDialerTab.qml
        ${DESKTOP_DIR}/qml/PhoneAgentsTab.qml
        ${DESKTOP_DIR}/qml/PhoneInboxTab.qml
        ${DESKTOP_DIR}/qml/PhoneHudTab.qml
        ${DESKTOP_DIR}/qml/PhoneSettingsTab.qml
        ${DESKTOP_DIR}/qml/PhoneScreeningTab.qml
        ${DESKTOP_DIR}/qml/PhoneCallOverlay.qml
        ${DESKTOP_DIR}/qml/SshPage.qml
        ${DESKTOP_DIR}/qml/ActivityPage.qml
        ${DESKTOP_DIR}/qml/BrowserPage.qml
        ${DESKTOP_DIR}/qml/SubAgentTree.qml
        ${DESKTOP_DIR}/qml/DiffReviewPanel.qml
        ${DESKTOP_DIR}/qml/DrivingOverlay.qml
        ${DESKTOP_DIR}/qml/GlowCursor.qml
        ${DESKTOP_DIR}/qml/LockGate.qml
        ${DESKTOP_DIR}/qml/TitleBar.qml
        ${DESKTOP_DIR}/qml/Theme.qml
        ${_arc_patched}
        ${DESKTOP_DIR}/qml/HudFx.qml
        ${DESKTOP_DIR}/qml/HudStatusStrip.qml
        ${DESKTOP_DIR}/qml/HudFrame.qml
)

# The generated QML type-registration unit includes the QML_ELEMENT headers by
# basename (<Bridge.h>, <WindowController.h>, <FrameProvider.h>). windows/shell is
# FIRST so WindowController.h resolves to the WINDOWS controller; desktop/src
# supplies Bridge.h + FrameProvider.h.
target_include_directories(jarvis-sidebar PRIVATE
    ${SHELL_DIR}
    ${DESKTOP_DIR}/src
)

target_link_libraries(jarvis-sidebar PRIVATE
    Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::QuickControls2
    Qt6::WebSockets Qt6::Network Qt6::Multimedia)
target_compile_features(jarvis-sidebar PRIVATE cxx_std_20)
target_compile_options(jarvis-sidebar PRIVATE ${FORCE_INCLUDE_FLAGS})

# GUI subsystem (no console window). qt_add_executable wires the Qt entry point so
# WinMain -> main() works; WIN32_EXECUTABLE selects /SUBSYSTEM:WINDOWS.
set_target_properties(jarvis-sidebar PROPERTIES WIN32_EXECUTABLE TRUE)
