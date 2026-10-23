# m0clip access from outside home

The home node `gdev-kubu` is enrolled in Tailscale at **100.106.8.52**.
A fresh key-authenticated SSH connection over the Tailscale route succeeded on
2026-10-19. SSH and Tailscale are enabled at boot on the node; the connecting
computer's private-network user service is also enabled.

Use the **m0clip remote desktop** or **m0clip SSH terminal** shortcut on the
connecting computer. The node now uses persistent OMP, not Codex:

```sh
ssh -t m0clip /home/g/.local/bin/m0clip-omp
~/.local/bin/m0clip-desktop
```

Detach OMP with **Ctrl-b, d** without stopping it. The remote-client launcher
template is `deploy/access/m0clip-omp`; the original connecting computer's
assistant shortcuts were not reachable for updating during the node migration.

The `m0clip` SSH alias selects the online `gdev-kubu` Tailscale peer through
`~/.local/bin/m0clip-route`. It retains the server's pinned host key and this
computer's existing Ed25519 device key. If the private-network peer is absent,
it can fall back to the original home LAN address, `192.168.20.156`.
The old `unitree-dev` alias is retained for compatibility with existing sessions.

The existing-console desktop handshake was checked over this route. This
verifies the VPN transport while the client is physically at home; a separate
physical off-network test has not yet been performed. Both computers must be
online and connected to the same Tailscale account.

## Network configuration

The home node uses the system `tailscaled` service. Tailscale SSH is disabled;
native OpenSSH still requires the allowlisted device key. No router port
forwarding, exit node, subnet advertisement, DNS replacement, or accepted subnet
routes are required.

The connecting computer uses Tailscale 1.104.1 in userspace networking through
the enabled user service `unitree-private-network.service`. Its retained binary,
state, and socket locations are under `~/.local/share/unitree-private-network/`,
`~/.local/state/unitree-private-network/`, and the corresponding runtime directory.
These internal paths retain the existing enrollment. They are not project names.
Incoming tailnet connections to this laptop are blocked with shields-up.

The **m0clip connect from anywhere** shortcut opens sign-in explicitly in Google
Chrome if reauthentication is needed. The **m0clip finish home access** shortcut
reruns the original home bootstrap. That bootstrap is preserved in the private
`gadmaj/website` repository on branch `exp`, at
`.github/unitree-access/connect-home-node.sh`. Do not rerun enrollment just to
connect normally.

The home node's currently reported Tailscale device-key expiry is
2027-04-18 03:50:35 UTC. Review its key-expiry setting in Tailscale's Machines
page for unattended access; reauthentication may otherwise be required then.
The separate SSH device key remains required.

See [remote desktop and OMP access](remote-access.md) for desktop behavior,
systemd-owned OMP sessions, disconnect-test limits and saved-session recovery.
