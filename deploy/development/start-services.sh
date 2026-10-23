#!/usr/bin/env bash
set -euo pipefail
UNITREE_DEPLOY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.config/systemd/user"
for unit in unitree-host.service unitree-dev.service unitree-public.service m0clip-tunnel.service m0clip-vitals.service; do
    destination="$HOME/.config/systemd/user/$unit"
    if [[ -e "$destination" ]] && ! cmp -s "$UNITREE_DEPLOY_DIR/$unit" "$destination"; then
        printf 'Existing service differs; inspect it before replacing: %s\n' "$destination" >&2
        exit 1
    fi
    install -m 644 "$UNITREE_DEPLOY_DIR/$unit" "$destination"
done
systemctl --user daemon-reload
systemctl --user enable --now unitree-host.service unitree-dev.service unitree-public.service m0clip-tunnel.service m0clip-vitals.service
