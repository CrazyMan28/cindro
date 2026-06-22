# jarvisd: the headless Jarvis daemon. Serves the Contract A control WebSocket,
# owns sessions + brains, and persists normalized events via jarvis-core.

cmake_minimum_required(VERSION 3.21)

if(NOT DEFINED PROJECT_NAME)
    project(jarvisd LANGUAGES CXX)
endif()

set(CMAKE_AUTOMOC ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS Core Network Sql WebSockets)

# libsodium via pkg-config (no CMake config package shipped on Fedora).
find_package(PkgConfig REQUIRED)
pkg_check_modules(SODIUM REQUIRED IMPORTED_TARGET libsodium)

# When built standalone (not via the superbuild), pull in jarvis-core.
if(NOT TARGET jarvis-core)
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../core
                     ${CMAKE_CURRENT_BINARY_DIR}/jarvis-core-build)
endif()

add_executable(jarvisd
    src/main.cpp
    src/ControlServer.cpp
    src/DeviceServer.cpp
)

target_link_libraries(jarvisd
    PRIVATE
        jarvis-core
        Qt6::Core
        Qt6::Network
        Qt6::Sql
        Qt6::WebSockets
        PkgConfig::SODIUM
)

target_compile_features(jarvisd PRIVATE cxx_std_20)
