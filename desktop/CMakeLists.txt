cmake_minimum_required(VERSION 3.20)
project(jarvis-sidebar LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2 WebSockets Network Multimedia)
find_package(LayerShellQt REQUIRED)

qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(jarvis-sidebar
    src/main.cpp
    src/Bridge.cpp
    src/Bridge.h
    src/FrameProvider.h
    src/WindowController.cpp
    src/WindowController.h
)

# Theme.qml is a QML singleton (declares `pragma Singleton`); flag it so the
# generated qmldir registers it as one.
set_source_files_properties(qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
# Widgets.qml exposes shared inline components and is consumed as `Widgets.X{}`,
# so it must be a singleton too.
set_source_files_properties(qml/Widgets.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)

# Bundle the QML as a proper module so main.cpp can loadFromModule("JarvisSidebar","Main").
qt_add_qml_module(jarvis-sidebar
    URI JarvisSidebar
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/AppShell.qml
        qml/HomePage.qml
        qml/AgentPeek.qml
        qml/NavRail.qml
        qml/CommandPalette.qml
        qml/PageHeader.qml
        qml/Widgets.qml
        qml/JarvisPanel.qml
        qml/ChatDelegate.qml
        qml/SessionsPage.qml
        qml/SettingsPage.qml
        qml/McpPage.qml
        qml/PluginsPage.qml
        qml/MemoryPage.qml
        qml/SkillsPage.qml
        qml/AgentsPage.qml
        qml/SlashPalette.qml
        qml/TodayBriefing.qml
        qml/ComputerPage.qml
        qml/CanvasPage.qml
        qml/WidgetsPage.qml
        qml/VoiceMode.qml
        qml/WidgetRenderer.qml
        qml/StandaloneWidget.qml
        qml/FloatingWidgetLayer.qml
        qml/SchedulesPage.qml
        qml/PhonePage.qml
        qml/PhoneDialerTab.qml
        qml/PhoneAgentsTab.qml
        qml/PhoneInboxTab.qml
        qml/PhoneHudTab.qml
        qml/PhoneSettingsTab.qml
        qml/SshPage.qml
        qml/ActivityPage.qml
        qml/BrowserPage.qml
        qml/SubAgentTree.qml
        qml/DiffReviewPanel.qml
        qml/DrivingOverlay.qml
        qml/GlowCursor.qml
        qml/LockGate.qml
        qml/TitleBar.qml
        qml/Theme.qml
        qml/ArcReactor.qml
        qml/HudFx.qml
        qml/HudStatusStrip.qml
        qml/HudFrame.qml
)

# The generated QML type-registration unit includes the QML_ELEMENT headers by
# basename (e.g. <Bridge.h>), so the directory holding them must be on the
# include path or registration of `Bridge` fails to compile.
target_include_directories(jarvis-sidebar PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(jarvis-sidebar PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Quick
    Qt6::Qml
    Qt6::QuickControls2
    Qt6::WebSockets
    Qt6::Network
    Qt6::Multimedia
    LayerShellQt::Interface
)

# GUI integration smoke test: load the FULL UI offscreen (every page instantiated
# via Main.qml), verify the QML tree renders + survives a settle window, exit 0.
# Catches QML load/runtime regressions in CI (ctest), not just a compile.
add_test(NAME gui_selftest COMMAND jarvis-sidebar --selftest)
set_tests_properties(gui_selftest PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_FORCE_STDERR_LOGGING=1"
    TIMEOUT 30)

# Session-reconcile regression test (QtQuick.Test): drives the chat-transcript /
# session state machine (the onSessionIdChanged reconciler + submit/startNewChat +
# live/history guards) across every transition that historically desynced —
# + New, open-other, delete-current, stale history, foreign Chrome event, and the
# first-message-survives-create race. Pure logic, no daemon needed.
find_program(QMLTESTRUNNER NAMES qmltestrunner-qt6 qmltestrunner)
if(QMLTESTRUNNER)
    add_test(NAME session_reconcile
             COMMAND ${QMLTESTRUNNER} -input ${CMAKE_CURRENT_SOURCE_DIR}/tests/tst_session_reconcile.qml)
    set_tests_properties(session_reconcile PROPERTIES
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
        TIMEOUT 30)
endif()
