# Prebuilt CI image for the self-hosted Linux runner: fedora:44 with ALL of the
# jarvis Linux build deps baked in, so linux-ci + linux-release never re-download
# them (matches the dev box's Qt 6.11 / layer-shell-qt 6.7). Built + pushed once to
# ghcr.io/crazyman28/jarvis-ci; the runner pulls it once and Docker caches it, so a
# CI run goes from "download 552 MB of Qt6 every time" to "instant, build only".
FROM fedora:44
RUN dnf -y install \
      gcc-c++ cmake ninja-build pkgconf-pkg-config git tar gzip xz \
      curl file findutils which patchelf \
      qt6-qtbase-devel qt6-qtdeclarative-devel qt6-qtquickcontrols2-devel \
      qt6-qtwebsockets-devel qt6-qtmultimedia-devel qt6-qtsvg-devel \
      qt6-qtwayland qt6-qtwayland-devel layer-shell-qt-devel \
      extra-cmake-modules libsodium-devel qrencode-devel \
      python3 python3-pip python3-devel python3-pytest \
      desktop-file-utils fuse fuse-libs xcb-util-cursor \
      mesa-libGL-devel mesa-libEGL-devel \
 && dnf clean all
LABEL org.opencontainers.image.source=https://github.com/CrazyMan28/jarvis
