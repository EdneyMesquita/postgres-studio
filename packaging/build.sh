#!/usr/bin/env bash
# Builds the Linux (.deb, .rpm) and Windows (NSIS setup) installers locally,
# in the packaging/Dockerfile image, into packaging/out/ under the names the
# site serves. The macOS .dmg is built on a Mac (`npm run tauri build --
# --target universal-apple-darwin`). Nothing here publishes anything.
#
#   packaging/build.sh [linux] [windows]     # both when none is given
#
# The frontend is built once on the host; cargo runs in the container with
# its own target directory (src-tauri/target/docker), JOBS jobs and a memory
# and CPU ceiling, so the desktop stays usable.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -n1)
IMAGE=postgres-studio-builder
OUT=packaging/out
JOBS=${JOBS:-6}
WHAT=("$@")
[ ${#WHAT[@]} -eq 0 ] && WHAT=(linux windows)

docker build -q -t "$IMAGE" packaging >/dev/null
npm run build >/dev/null
mkdir -p "$OUT" src-tauri/target/docker-home

# The frontend is already in dist/.
NO_FRONTEND='{"build":{"beforeBuildCommand":""}}'
run() {
  docker run --rm --memory=10g --memory-swap=10g --cpus="$JOBS" --user "$(id -u):$(id -g)" \
    -e HOME=/src/src-tauri/target/docker-home -e CARGO_TARGET_DIR=/src/src-tauri/target/docker \
    -e CARGO_BUILD_JOBS="$JOBS" -v "$PWD:/src" -v "$HOME/.cargo/registry:/opt/cargo/registry" \
    -w /src "$IMAGE" "$@"
}

for what in "${WHAT[@]}"; do
  case "$what" in
    linux)
      run npx tauri build --bundles deb,rpm --config "$NO_FRONTEND"
      B=src-tauri/target/docker/release/bundle
      cp "$B/deb/Postgres Studio_${VERSION}_amd64.deb" "$OUT/postgres-studio_${VERSION}_amd64.deb"
      cp "$B/rpm/Postgres Studio-${VERSION}-1.x86_64.rpm" "$OUT/postgres-studio-${VERSION}-1.x86_64.rpm"
      ;;
    windows)
      run npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis \
        --config "$NO_FRONTEND"
      B=src-tauri/target/docker/x86_64-pc-windows-msvc/release/bundle
      cp "$B/nsis/Postgres Studio_${VERSION}_x64-setup.exe" "$OUT/postgres-studio_${VERSION}_x64-setup.exe"
      ;;
    *) echo "unknown target: $what (linux or windows)" >&2; exit 1 ;;
  esac
done
ls -la "$OUT"
