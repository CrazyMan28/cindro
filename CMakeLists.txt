# Jarvis — top-level CMake superbuild.
# Builds the three C++ components: jarvis-core (static lib), jarvisd (daemon),
# and cindro-sidebar (desktop UI). Other components (computer-use, extension,
# android, plugins, kde-applet, packaging) have their own toolchains and are
# not driven by this file.
#
# Build:   cmake -S . -B build -G Ninja && cmake --build build
# Test:    ctest --test-dir build --output-on-failure
cmake_minimum_required(VERSION 3.24)

project(jarvis CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

enable_testing()

add_subdirectory(core)
add_subdirectory(daemon)
add_subdirectory(desktop)
