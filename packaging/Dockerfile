# The image the Linux and Windows installers are built in (packaging/build.sh).
# Ubuntu 22.04, so the .deb and .rpm run on the same glibc the release
# workflow's ubuntu-22.04 runner targets; the Windows setup is cross-built
# with cargo-xwin (clang, lld, llvm-rc) and NSIS.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git pkg-config xz-utils \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf \
      rpm \
      clang lld llvm nsis nasm cmake \
    && rm -rf /var/lib/apt/lists/*

# Node 22, for the Tauri CLI.
RUN curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz \
      | tar -xJ -C /usr/local --strip-components=1

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
      --target x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin \
    && rm -rf /opt/cargo/registry \
    && chmod -R a+rwX /opt/cargo /opt/rustup
