#!/usr/bin/env bash
# Install the Xiaoli Bridge from a checked-out repository on Debian 12.
# Run as root from any directory: sudo ./deploy/debian/install.sh
set -Eeuo pipefail

readonly NODE_VERSION="24.20.0"
readonly INSTALL_ROOT="/opt/xiaoli-bridge"
readonly STATE_ROOT="/var/lib/xiaoli-bridge"
readonly CONFIG_ROOT="/etc/xiaoli-bridge"
readonly SERVICE_USER="xiaoli"
readonly SERVICE_FILE="/etc/systemd/system/xiaoli-bridge.service"
script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "${script_dir}" == "${script_path}" ]]; then
  script_dir="."
fi
readonly SCRIPT_DIR="$(cd -- "${script_dir}" && pwd)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
readonly BRIDGE_SOURCE="${REPOSITORY_ROOT}/bridge"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this installer as root (for example: sudo $0)." >&2
    exit 1
  fi
}

require_debian() {
  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot verify the operating system: /etc/os-release is missing." >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "debian" || "${VERSION_ID:-}" != "12" ]]; then
    echo "This installer supports Debian 12 only; found ${PRETTY_NAME:-unknown}." >&2
    exit 1
  fi
}

node_archive_name() {
  case "$(uname -m)" in
    x86_64) printf 'linux-x64' ;;
    aarch64) printf 'linux-arm64' ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

validate_deployment_assets() {
  local unit_file="${SCRIPT_DIR}/xiaoli-bridge.service"
  local tmpdir="/var/lib/xiaoli-bridge/tmp"
  local statedir="/var/lib/xiaoli-bridge/state"
  local line has_host=0 has_mdns=0 has_tmpdir=0 has_bridge_temp=0 has_statedir=0 has_execstart=0 has_write_path=0 has_health_poll=0 has_commit_trap=0 has_signal_traps=0 has_disarm=0 has_unit_restore=0 has_move_tracking=0 has_enable_state=0
  while IFS= read -r line; do
    case "${line}" in
      "Environment=BRIDGE_HOST=127.0.0.1") has_host=1 ;;
      "Environment=BRIDGE_MDNS_ENABLED=false") has_mdns=1 ;;
      "Environment=TMPDIR=${tmpdir}") has_tmpdir=1 ;;
      "Environment=BRIDGE_TEMP_DIR=${tmpdir}") has_bridge_temp=1 ;;
      "Environment=BRIDGE_STATE_DIR=${statedir}") has_statedir=1 ;;
      "ExecStart=/usr/bin/env BRIDGE_HOST=127.0.0.1 BRIDGE_MDNS_ENABLED=false BRIDGE_TEMP_DIR=${tmpdir} BRIDGE_STATE_DIR=${statedir} TMPDIR=${tmpdir} /opt/node/bin/node /opt/xiaoli-bridge/src/server.mjs") has_execstart=1 ;;
      "ReadWritePaths=${tmpdir} ${statedir}") has_write_path=1 ;;
    esac
  done <"${unit_file}"
  while IFS= read -r line; do
    if [[ "${line}" == '    if curl --fail --silent --show-error --output /dev/null --max-time 1 http://127.0.0.1:8788/healthz; then' ]]; then
      has_health_poll=1
    fi
    if [[ "${line}" == "  trap 'rollback_commit \"\$?\"' ERR" ]]; then
      has_commit_trap=1
    fi
    if [[ "${line}" == "  trap 'rollback_commit 130' INT" ]]; then
      has_signal_traps=$((has_signal_traps + 1))
    fi
    if [[ "${line}" == "  trap 'rollback_commit 143' TERM" ]]; then
      has_signal_traps=$((has_signal_traps + 1))
    fi
    if [[ "${line}" == '  trap - ERR INT TERM' ]]; then
      has_disarm=1
    fi
    if [[ "${line}" == '        mv -- "${unit_backup}" "${SERVICE_FILE}"' ]]; then
      has_unit_restore=1
    fi
    if [[ "${line}" == '  local current_to_previous=0' ]]; then
      has_move_tracking=$((has_move_tracking + 1))
    fi
    if [[ "${line}" == '  local next_to_current=0' ]]; then
      has_move_tracking=$((has_move_tracking + 1))
    fi
    if [[ "${line}" == '  local was_enabled=0' ]]; then
      has_enable_state=1
    fi
  done <"${BASH_SOURCE[0]}"
  if (( ! has_host || ! has_mdns || ! has_tmpdir || ! has_bridge_temp || ! has_statedir || ! has_execstart || ! has_write_path || ! has_health_poll || ! has_commit_trap || has_signal_traps != 2 || ! has_disarm || ! has_unit_restore || has_move_tracking != 2 || ! has_enable_state )); then
    echo "Deployment unit must force loopback, disabled mDNS, and isolated writable temp/state paths." >&2
    exit 1
  fi
}

wait_for_bridge_health() {
  local attempt
  for attempt in {1..7}; do
    if curl --fail --silent --show-error --output /dev/null --max-time 1 http://127.0.0.1:8788/healthz; then
      return 0
    fi
    if (( attempt < 7 )); then
      sleep 1
    fi
  done
  return 1
}

install_node() {
  if [[ -x /opt/node/bin/node ]] && [[ "$(/opt/node/bin/node --version)" == "v24."* ]]; then
    return
  fi

  local platform archive base_url tmpdir expected actual
  platform="$(node_archive_name)"
  archive="node-v${NODE_VERSION}-${platform}.tar.xz"
  base_url="https://nodejs.org/dist/v${NODE_VERSION}"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf -- "${tmpdir}"' RETURN

  curl --fail --location --proto '=https' --tlsv1.2 --output "${tmpdir}/${archive}" "${base_url}/${archive}"
  curl --fail --location --proto '=https' --tlsv1.2 --output "${tmpdir}/SHASUMS256.txt" "${base_url}/SHASUMS256.txt"
  expected="$(awk -v file="${archive}" '$2 == file {print $1}' "${tmpdir}/SHASUMS256.txt")"
  actual="$(sha256sum "${tmpdir}/${archive}" | awk '{print $1}')"
  if [[ -z "${expected}" || "${actual}" != "${expected}" ]]; then
    echo "Node.js archive checksum verification failed." >&2
    exit 1
  fi

  rm -rf -- /opt/node
  tar --extract --xz --file "${tmpdir}/${archive}" --directory /opt
  mv "/opt/node-v${NODE_VERSION}-${platform}" /opt/node
  trap - RETURN
  rm -rf -- "${tmpdir}"
}

install_os_packages() {
  apt-get update
  apt-get install --yes --no-install-recommends ca-certificates caddy curl espeak-ng ffmpeg rsync
}

create_service_account_and_paths() {
  if ! getent group "${SERVICE_USER}" >/dev/null; then
    groupadd --system "${SERVICE_USER}"
  fi
  if ! id --user "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --gid "${SERVICE_USER}" --home-dir "${STATE_ROOT}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  install -d --owner=root --group=root --mode=0755 "${INSTALL_ROOT}"
  install -d --owner="${SERVICE_USER}" --group="${SERVICE_USER}" --mode=0700 "${STATE_ROOT}/tmp"
  install -d --owner="${SERVICE_USER}" --group="${SERVICE_USER}" --mode=0700 "${STATE_ROOT}/state"
  install -d --owner=root --group=root --mode=0700 "${CONFIG_ROOT}"
  if [[ ! -e "${CONFIG_ROOT}/bridge.env" ]]; then
    install --owner=root --group=root --mode=0600 /dev/null "${CONFIG_ROOT}/bridge.env"
    cat >>"${CONFIG_ROOT}/bridge.env" <<'EOF'
# Required secret values must be supplied here. Do not commit this file.
# AGENT_STACK_BASE_URL=
# AGENT_STACK_USER_API_KEY=
# AGENT_STACK_PROJECT_ID=
# ASR_AGENT_ID=
# MEDIATOR_AGENT_ID=
# DEVICE_SHARED_TOKEN=
# Optional phone-management API token: use an independent random value with
# at least 32 printable characters. Never reuse a cloud or device credential.
# MOBILE_ADMIN_TOKEN=
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8788
BRIDGE_MDNS_ENABLED=false
BRIDGE_TEMP_DIR=/var/lib/xiaoli-bridge/tmp
BRIDGE_STATE_DIR=/var/lib/xiaoli-bridge/state
TTS_PROVIDER=espeak-ng
# Set TTS_PROVIDER=xfyun and configure all three credentials for clear cloud
# Mandarin. XFYUN_TTS_VOICE defaults to x4_xiaoyan.
# XFYUN_TTS_APP_ID=
# XFYUN_TTS_API_KEY=
# XFYUN_TTS_API_SECRET=
# XFYUN_TTS_VOICE=x4_xiaoyan
# XFYUN_RTASR_APP_ID=
# XFYUN_RTASR_API_KEY=
# ASR_AGENT_ID is required only when both Xfyun values are blank.
EOF
  fi
  chown root:root "${CONFIG_ROOT}/bridge.env"
  chmod 0600 "${CONFIG_ROOT}/bridge.env"
}

deploy_bridge() {
  if [[ ! -f "${BRIDGE_SOURCE}/package.json" || ! -f "${BRIDGE_SOURCE}/package-lock.json" ]]; then
    echo "Bridge source is missing package.json or package-lock.json." >&2
    exit 1
  fi

  local next_root="${INSTALL_ROOT}.next"
  local previous_root="${INSTALL_ROOT}.previous"
  local unit_backup="${SERVICE_FILE}.previous"
  local was_active=0
  local was_enabled=0
  local had_service_file=0
  local had_app=0
  local current_to_previous=0
  local next_to_current=0
  local unit_changed=0
  local rollback_running=0

  rollback_commit() {
    local original_status="$1"
    if (( rollback_running )); then
      exit "${original_status}"
    fi
    rollback_running=1
    trap - ERR INT TERM
    set +e
    if (( was_active )); then
      systemctl stop xiaoli-bridge.service
    fi
    # Flags are set before each move. Inspect both paths so a signal between a
    # move and its bookkeeping cannot leave the live path missing.
    if (( next_to_current )) && [[ -d "${INSTALL_ROOT}" && ! -d "${next_root}" ]]; then
      rm -rf -- "${INSTALL_ROOT}"
    fi
    if (( current_to_previous )) && (( had_app )) && [[ -d "${previous_root}" && ! -d "${INSTALL_ROOT}" ]]; then
      if [[ -d "${INSTALL_ROOT}" ]]; then
        rm -rf -- "${INSTALL_ROOT}"
      fi
      if [[ -d "${previous_root}" ]]; then
        mv -- "${previous_root}" "${INSTALL_ROOT}"
      fi
    fi
    if (( unit_changed )); then
      if (( had_service_file )); then
        mv -- "${unit_backup}" "${SERVICE_FILE}"
      else
        rm -f -- "${SERVICE_FILE}"
      fi
      systemctl daemon-reload
      if (( was_enabled )); then
        systemctl enable xiaoli-bridge.service
      else
        systemctl disable xiaoli-bridge.service
      fi
    fi
    if (( was_active )); then
      systemctl start xiaoli-bridge.service
      wait_for_bridge_health
    fi
    exit "${original_status}"
  }

  rm -rf -- "${next_root}"
  install -d --owner=root --group=root --mode=0755 "${next_root}"
  # Do not copy developer credentials, generated output, or local dependencies.
  # --delete makes removals from a reviewed release take effect in the staged release.
  rsync --archive --delete --exclude='.env.local' --exclude='node_modules' --exclude='tmp' --exclude='state' "${BRIDGE_SOURCE}/" "${next_root}/"
  /opt/node/bin/npm --prefix "${next_root}" ci --omit=dev --ignore-scripts
  /opt/node/bin/node --check "${next_root}/src/server.mjs"
  chown -R root:root "${next_root}"
  chmod -R go-w "${next_root}"

  # From here through health validation, any failure restores both release and unit.
  trap 'rollback_commit "$?"' ERR
  trap 'rollback_commit 130' INT
  trap 'rollback_commit 143' TERM

  if [[ -d "${INSTALL_ROOT}" ]]; then
    had_app=1
  fi
  if [[ -e "${SERVICE_FILE}" ]]; then
    had_service_file=1
    cp --preserve=mode,ownership,timestamps "${SERVICE_FILE}" "${unit_backup}"
  else
    rm -f -- "${unit_backup}"
  fi
  if systemctl is-enabled --quiet xiaoli-bridge.service; then
    was_enabled=1
  fi
  unit_changed=1
  install --owner=root --group=root --mode=0644 "${SCRIPT_DIR}/xiaoli-bridge.service" "${SERVICE_FILE}"
  systemctl daemon-reload
  if (( was_enabled || ! had_service_file )); then
    systemctl enable xiaoli-bridge.service
  else
    systemctl disable xiaoli-bridge.service
  fi

  if systemctl is-active --quiet xiaoli-bridge.service; then
    was_active=1
    systemctl stop xiaoli-bridge.service
  fi
  rm -rf -- "${previous_root}"
  if [[ -d "${INSTALL_ROOT}" ]]; then
    current_to_previous=1
    mv -- "${INSTALL_ROOT}" "${previous_root}"
  fi
  next_to_current=1
  mv -- "${next_root}" "${INSTALL_ROOT}"
  if (( was_active )); then
    systemctl start xiaoli-bridge.service
    wait_for_bridge_health
  fi
  trap - ERR INT TERM
}

install_caddy_example() {
  if [[ "${INSTALL_CADDY_CONFIG:-0}" != "1" ]]; then
    echo "Not replacing /etc/caddy/Caddyfile. After setting DNS, re-run with INSTALL_CADDY_CONFIG=1 to install the reviewed example."
    return
  fi
  if [[ -e /etc/caddy/Caddyfile && ! -e /etc/caddy/Caddyfile.before-xiaoli ]]; then
    cp --preserve=mode,ownership,timestamps /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-xiaoli
  fi
  install --owner=root --group=root --mode=0644 "${SCRIPT_DIR}/Caddyfile.example" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

verify_installation() {
  /opt/node/bin/node --version
  caddy version
  espeak-ng --version
  ffmpeg -version | head -n 1
  systemctl cat xiaoli-bridge.service
  echo "Installed but did not start xiaoli-bridge.service. Set required values in ${CONFIG_ROOT}/bridge.env, replace bridge.example.com in /etc/caddy/Caddyfile with your DNS name, then validate and start it."
}

main() {
  require_root
  require_debian
  validate_deployment_assets
  install_os_packages
  install_node
  create_service_account_and_paths
  deploy_bridge
  install_caddy_example
  verify_installation
}

if [[ "${1:-}" == "--check-assets" ]]; then
  validate_deployment_assets
  exit 0
fi

main "$@"
