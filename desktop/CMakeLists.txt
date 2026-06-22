cmake_minimum_required(VERSION 3.20)
project(jarvis-sidebar LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2 WebSockets)
find_package(LayerShellQt REQUIRED)

qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(jarvis-sidebar
    src/main.cpp
    src/Bridge.cpp
    src/Bridge.h
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
        qml/NavRail.qml
        qml/PageHeader.qml
        qml/Widgets.qml
        qml/JarvisPanel.qml
        qml/ChatDelegate.qml
        qml/SessionsPage.qml
        qml/SettingsPage.qml
        qml/McpPage.qml
        qml/PluginsPage.qml
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
    LayerShellQt::Interface
)
