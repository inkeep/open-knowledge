#!/usr/bin/env bash
set -euo pipefail

# One-time pre-ship verification for packaged Linux terminals. Run both Fedora
# rows on matching native hosts, then run one Debian 11 row to anchor the
# Electron-inherited glibc generation documented for Linux:
#
#   ./scripts/smoke-linux-terminal-package.sh \
#     --image fedora:41 --arch x86_64 --package dist-desktop/OpenKnowledge-x86_64.rpm
#   ./scripts/smoke-linux-terminal-package.sh \
#     --image fedora:41 --arch aarch64 --package dist-desktop/OpenKnowledge-aarch64.rpm
#   ./scripts/smoke-linux-terminal-package.sh \
#     --image debian:11 --arch x86_64 --package dist-desktop/OpenKnowledge-amd64.deb
#
# These are deliberate one-time package rows, not recurring CI. The recurring
# rpm metadata guard remains electron-builder-linux-depends-parity.test.ts.
#
# Chromium first launches with its normal sandbox. In containers where user
# namespaces prevent startup, OK_CONTAINER_SANDBOX=auto retries once with
# --no-sandbox. Set OK_CONTAINER_SANDBOX=require to prohibit that fallback, or
# OK_CONTAINER_SANDBOX=disable to use --no-sandbox immediately.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
DRIVER_PATH="$SCRIPT_DIR/smoke-linux-terminal-package.py"

usage() {
  printf '%s\n' \
    'Usage:' \
    '  smoke-linux-terminal-package.sh --image IMAGE --arch ARCH --package PATH' \
    '' \
    'Images: fedora:41 for rpm, debian:11 or ubuntu:20.04 for deb.' \
    'Architectures: x86_64 or aarch64 (amd64 and arm64 aliases are accepted).'
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

normalize_arch() {
  case "$1" in
    x86_64 | amd64)
      printf 'x86_64\n'
      ;;
    aarch64 | arm64)
      printf 'aarch64\n'
      ;;
    *)
      fail "unsupported architecture '$1'; expected x86_64 or aarch64"
      ;;
  esac
}

docker_platform() {
  case "$1" in
    x86_64) printf 'linux/amd64\n' ;;
    aarch64) printf 'linux/arm64\n' ;;
  esac
}

resolve_package_path() {
  local input=$1
  [[ -f "$input" ]] || fail "package artifact not found: $input"
  [[ -s "$input" ]] || fail "package artifact is empty: $input"
  local directory
  directory=$(cd "$(dirname "$input")" && pwd -P)
  printf '%s/%s\n' "$directory" "$(basename "$input")"
}

wait_for_debugger() {
  local attempts_remaining=40
  while ((attempts_remaining > 0)); do
    if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
    attempts_remaining=$((attempts_remaining - 1))
  done
  return 1
}

stop_app() {
  pkill -TERM -u ok-smoke >/dev/null 2>&1 || true
  sleep 1
  pkill -KILL -u ok-smoke >/dev/null 2>&1 || true
}

launch_app() {
  local executable=$1
  local sandbox=$2
  local -a flags=(
    --disable-gpu
    --remote-debugging-address=127.0.0.1
    --remote-debugging-port=9222
    '--remote-allow-origins=*'
    --user-data-dir=/tmp/ok-smoke-user-data
  )
  if [[ "$sandbox" == disable ]]; then
    flags+=(--no-sandbox)
  fi

  runuser -u ok-smoke -- env \
    HOME=/home/ok-smoke \
    DISPLAY=:99 \
    OK_DESKTOP_E2E_SMOKE=1 \
    "$executable" \
    "${flags[@]}" \
    'openknowledge://open?project=%2Ftmp%2Fok-smoke-project&doc=start' \
    >/tmp/openknowledge-smoke.log 2>&1 &
}

install_container_dependencies() {
  local image=$1
  local artifact=$2
  case "$image" in
    fedora:*)
      [[ "$artifact" == *.rpm ]] || fail "Fedora rows require an .rpm artifact"
      dnf install -y \
        "$artifact" \
        curl \
        procps-ng \
        python3-websocket-client \
        shadow-utils \
        util-linux \
        xorg-x11-server-Xvfb
      ;;
    debian:* | ubuntu:*)
      [[ "$artifact" == *.deb ]] || fail "Debian/Ubuntu rows require a .deb artifact"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y \
        "$artifact" \
        curl \
        passwd \
        procps \
        python3-websocket \
        util-linux \
        xvfb
      ;;
    *)
      fail "unsupported image '$image'; use fedora:41, debian:11, or ubuntu:20.04"
      ;;
  esac
}

inside_container() {
  local image=$1
  local requested_arch=$2
  local artifact=$3
  local sandbox_mode=${OK_CONTAINER_SANDBOX:-auto}

  case "$sandbox_mode" in
    auto | require | disable) ;;
    *) fail "OK_CONTAINER_SANDBOX must be auto, require, or disable" ;;
  esac

  local actual_arch
  actual_arch=$(normalize_arch "$(uname -m)")
  [[ "$actual_arch" == "$requested_arch" ]] ||
    fail "container architecture is $actual_arch, expected $requested_arch"

  install_container_dependencies "$image" "$artifact"
  command -v openknowledge >/dev/null 2>&1 ||
    fail "installed package did not provide the openknowledge executable"

  useradd --create-home --shell /bin/bash ok-smoke
  install -d -o ok-smoke -g ok-smoke \
    /tmp/ok-smoke-project/.ok/local \
    /tmp/ok-smoke-user-data
  printf "content:\n  dir: '.'\n" >/tmp/ok-smoke-project/.ok/config.yml
  printf 'terminal:\n  enabled: true\n' >/tmp/ok-smoke-project/.ok/local/config.yml
  printf '# Container terminal smoke\n' >/tmp/ok-smoke-project/start.md
  chown -R ok-smoke:ok-smoke /tmp/ok-smoke-project /tmp/ok-smoke-user-data

  Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
  local xvfb_pid=$!
  trap 'stop_app; kill "$xvfb_pid" >/dev/null 2>&1 || true' EXIT

  local launch_mode=$sandbox_mode
  if [[ "$launch_mode" == auto ]]; then
    launch_mode=require
  fi
  printf 'Launching installed app with sandbox mode: %s\n' "$launch_mode"
  launch_app "$(command -v openknowledge)" "$launch_mode"

  if ! wait_for_debugger; then
    if [[ "$sandbox_mode" != auto ]]; then
      tail -80 /tmp/openknowledge-smoke.log >&2 || true
      fail "installed app never exposed its debugging endpoint"
    fi
    printf '%s\n' 'Sandboxed launch did not start; retrying once with --no-sandbox.'
    stop_app
    launch_app "$(command -v openknowledge)" disable
    if ! wait_for_debugger; then
      tail -80 /tmp/openknowledge-smoke.log >&2 || true
      fail "installed app did not start even with --no-sandbox"
    fi
  fi

  runuser -u ok-smoke -- python3 /tmp/smoke-linux-terminal-package.py
  printf 'PASS: installed %s package launched and completed a packaged PTY echo round-trip\n' "$requested_arch"
}

host_main() {
  local image=''
  local arch=''
  local package=''
  while (($# > 0)); do
    case "$1" in
      --image)
        (($# >= 2)) || fail '--image requires a value'
        image=$2
        shift 2
        ;;
      --arch)
        (($# >= 2)) || fail '--arch requires a value'
        arch=$2
        shift 2
        ;;
      --package)
        (($# >= 2)) || fail '--package requires a value'
        package=$2
        shift 2
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) fail "unknown argument: $1" ;;
    esac
  done

  [[ -n "$image" ]] || fail '--image is required'
  [[ -n "$arch" ]] || fail '--arch is required'
  [[ -n "$package" ]] || fail '--package is required'
  local normalized_arch
  normalized_arch=$(normalize_arch "$arch")
  local absolute_package
  absolute_package=$(resolve_package_path "$package")
  command -v docker >/dev/null 2>&1 ||
    fail 'docker is unavailable; run these one-time package rows on a Docker host'
  [[ -f "$DRIVER_PATH" ]] || fail "PTY smoke driver not found: $DRIVER_PATH"

  local extension=${absolute_package##*.}
  local container_artifact="/tmp/OpenKnowledge.$extension"

  if ! docker pull --platform "$(docker_platform "$normalized_arch")" "$image"; then
    fail "container image unavailable: $image ($(docker_platform "$normalized_arch"))"
  fi

  docker run --rm \
    --platform "$(docker_platform "$normalized_arch")" \
    --mount "type=bind,src=$absolute_package,dst=$container_artifact,readonly" \
    --mount "type=bind,src=$SCRIPT_DIR/smoke-linux-terminal-package.sh,dst=/tmp/smoke-linux-terminal-package.sh,readonly" \
    --mount "type=bind,src=$DRIVER_PATH,dst=/tmp/smoke-linux-terminal-package.py,readonly" \
    --env "OK_CONTAINER_SANDBOX=${OK_CONTAINER_SANDBOX:-auto}" \
    "$image" \
    bash /tmp/smoke-linux-terminal-package.sh \
      --inside "$image" "$normalized_arch" "$container_artifact"
}

if [[ "${1:-}" == --inside ]]; then
  (($# == 4)) || fail 'internal invocation requires image, architecture, and artifact'
  inside_container "$2" "$3" "$4"
else
  host_main "$@"
fi
