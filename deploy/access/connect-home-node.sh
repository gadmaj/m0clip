#!/usr/bin/env bash
# Run as g on gdev-kubu, from its console or while connected to the home LAN.
set -euo pipefail
if [[ "$(id -un)" != g || "$(hostname -s)" != gdev-kubu ]]; then
    printf 'Run this as user g on the Ubuntu guest gdev-kubu.\n' >&2
    exit 1
fi
expected='SHA256:RVS64kvY51Rr67R8f0klNTyp865bjoGXUklqLVf8aYU'
actual="$(ssh-keygen -lf "$HOME/.ssh/unitree-device-authorized_keys" | awk '{print $2}')"
if [[ "$actual" != "$expected" ]]; then
    printf 'The existing device-key allowlist differs; inspect SSH before proceeding.\n' >&2
    exit 1
fi
ssh_settings="$(sudo /usr/sbin/sshd -T -C user=g,host=gdev-kubu,addr=100.64.0.1)"
printf '%s\n' "$ssh_settings" | python3 -c '
import sys
settings=set(sys.stdin.read().splitlines())
required={"authenticationmethods publickey", "passwordauthentication no",
          "kbdinteractiveauthentication no",
          "authorizedkeysfile .ssh/unitree-device-authorized_keys"}
if not required.issubset(settings):
    raise SystemExit("SSH no longer has the expected device-key policy; inspect it before proceeding.")
'
if ! command -v tailscale >/dev/null 2>&1; then
    installer="$(mktemp)"
    trap 'rm -f -- "$installer"' EXIT
    curl --proto '=https' --tlsv1.2 -fsSL https://tailscale.com/install.sh -o "$installer"
    sudo sh "$installer"
fi
sudo systemctl enable --now tailscaled
printf 'Sign in to the SAME Tailscale account used on your connecting computer.\n'
sudo tailscale up --ssh=false --accept-dns=false --accept-routes=false --shields-up=false --hostname=gdev-kubu
printf '\nHome node connected. Native OpenSSH still requires the existing device key.\n'
tailscale ip -4
