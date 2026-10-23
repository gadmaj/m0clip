# m0clip remote desktop and OMP access

The destination is `gdev-kubu`, `g@192.168.20.156`. The original computer has the
`m0clip` SSH alias and a dedicated Ed25519 key. Its public fingerprint is:

`SHA256:RVS64kvY51Rr67R8f0klNTyp865bjoGXUklqLVf8aYU`

## Outside-home access status

The home node is now enrolled in Tailscale at **100.106.8.52**. Fresh SSH
and the existing desktop protocol were verified through that route on 2026-10-19.
The `m0clip` alias selects it automatically and retains native SSH device-key
and host-key verification. The connecting computer is currently at home; a
physical off-network test remains to be performed. See [internet access](internet-access.md).

## Share the existing desktop

On the original computer, use the **m0clip remote desktop** shortcut or run
`~/.local/bin/m0clip-desktop`. It now opens the desktop already signed in on the
node's physical/Proxmox console, including its open windows. At setup this is
user `g`, logind session `2`, KDE X11 display `:0`, at 1920 × 1200.

The remote helper `deploy/access/share-console.py` selects the active `seat0`
session and authenticates to that session's X server as the same user. It looks
up the current Xauthority file on each connection instead of using the display
in the SSH/systemd environment, which can belong to a separate RDP session.
It does not create a desktop or select an arbitrary remote session. An existing,
signed-in X11 console is required. If the desktop is locked, unlock that same
desktop normally inside the viewer.

The client starts TigerVNC against a temporary local Unix socket in a private
directory, with mode 0600. Display and input traffic pass directly through the
key-authenticated SSH channel to x11vnc in inetd mode. A private socketpair adapts
SSH stdin/stdout to the duplex socket expected by x11vnc. The node opens no VNC
TCP listener, and the client opens no TCP port. SSH provides authentication and
encryption; there is no additional VNC login password. This uses the same
private key already set up on this computer. The viewer leaves the console's
resolution unchanged and permits keyboard/mouse input.

Closing the viewer ends its sharing process and SSH channel while leaving the
signed-in console desktop and its applications running. The next connection
finds the then-active console again. After a full console logout, sign into the
console before trying to share it again.

The console lookup and full RFB handshake were checked: the channel identified
`m0clip existing desktop :0` with dimensions 1920 × 1200. The viewer was then
launched on the original computer. No VNC TCP listener was present. The setup
checks did not send keyboard/mouse input or capture a desktop screenshot.

Client logs are private under `~/.local/state/m0clip-access-client/`. The remote
sharing log is `~/.local/state/m0clip-access/console-sharing.log`. Launchers and
the server helper are preserved under `deploy/access/`; x11vnc is installed from
Ubuntu's packages, and TigerVNC is already installed on the original computer.
See [x11vnc's upstream options](https://github.com/LibVNC/x11vnc/blob/master/doc/OPTIONS.md)
for display selection and inetd transport.

## SSH policy and recovery

New SSH connections as `g` require the one public key in
`/home/g/.ssh/unitree-device-authorized_keys`; password and keyboard-interactive
SSH authentication are disabled for this account. Other SSH accounts' policies
were not changed. The private key stays on the original computer at
`~/.ssh/id_ed25519_unitree_dev`, with its existing file permissions.
An SSH fingerprint identifies possession of a key, not a hardware identity.

Fresh connections with the selected key succeeded. A different key was rejected;
password SSH authentication was unavailable. The SSH policy persists across
server restarts. Original settings were backed up under
`/var/backups/unitree-device-access/`. Keep Proxmox console access for recovery.
If the client key is lost, use that console to replace the public key in the
dedicated allowlist. Do not publish the private key.

The Tailscale route provides access without opening router ports. The public
app's Cloudflare URL provides the website; it does not expose the desktop.

## Earlier RDP setup

The earlier xrdp configuration remains restricted to `127.0.0.1:3389` with TLS and
desktop login limited to the `unitree-desktop` group (only `g`), with root denied.
Direct LAN RDP was refused and tunneled TLS 1.3 was checked. The desktop shortcut
no longer uses RDP, since RDP created a separate session. Existing sessions were
not logged out during this change. The previous client script is backed up on
the original computer at
`~/.local/state/unitree-access-client/unitree-desktop-rdp.previous`.

## Persistent OMP sessions

On this node use **m0clip OMP**, **m0clip development terminal**, or:

```sh
m0clip-omp
```

This creates or attaches to the `m0clip-omp` tmux session with
`/home/g/m0clip-ts` and `deploy/development/env.sh` loaded. New servers run under
the independent user service `m0clip-omp.service`, using a private runtime socket.
The launcher records the active socket and serializes simultaneous desktop/SSH
starts. It does not fall back to a desktop-owned server if systemd fails.
Detach with **Ctrl-b, d**; reattach with `m0clip-omp`. `--prepare` starts detached
without consuming input. Use the launcher rather than a bare `tmux attach`:
the managed socket is not necessarily tmux's default socket.
Use `m0clip-omp --resume` for the saved-session picker, `--continue` for the last
saved session, or `--restore` with a saved session path/ID to recover unfinished
work. Session-selection arguments are rejected while that tmux session exists,
so a second command cannot silently replace its live writer.

The installed `~/.local/bin/m0clip-omp` is node-local and invokes
`deploy/access/m0clip-omp-local`. The separate `deploy/access/m0clip-omp` template
is for the connecting computer: it SSHes to the existing `m0clip` host and
forwards quoted OMP arguments. Do not install the SSH-client template over the
node-local wrapper. The original client machine was not reachable for updating
its shortcuts; copy the client template there through the normal trusted route.

Codex-only node launchers and desktop shortcuts were removed. The old attached
`m0clip` tmux/Codex session and shared daemon were not terminated, to avoid
discarding existing work. New project launchers use OMP, with no Codex aliases.

### Desktop-independent lifetime

On 2026-10-21, following the reported RDP-disconnect failure, the live tmux server
was found in the **m0clip development terminal desktop application scope**.
Lingering was already enabled, tmux detach-exit options were off, and XRDP's
disconnected-session killing was disabled. Available login/suspend logs did not
establish the exact historical disconnect trigger; the prior SSH-only check was
not evidence of RDP survival.

The existing server **PID 3993** and OMP writer **PID 3994** were moved live into
the independent user-manager scope `m0clip-omp.scope`, with no restart or second
development writer. Both retained their PIDs. This scope has no `PartOf` or
`BindsTo` desktop-session dependency. Check this migrated session with:

```sh
systemctl --user status m0clip-omp.scope
m0clip-omp --prepare
```

Future fresh launches use `m0clip-omp.service`, whose main PID is the actual tmux
server. A disposable real OMP instance exercised that launch path: its attaching
PTY was closed, the client exited and no clients remained, while server **11084**
and OMP **11085** stayed alive. OMP then processed typed input while detached.
An active-session `--resume` attempt was rejected without replacing the writer.
Owned smoke processes were stopped afterward; hosting stayed active.

The actual RDP connection was **not** forcibly disconnected. Closing an owned
terminal and removing desktop ownership are useful evidence, not an observed
end-to-end RDP-disconnect test.

The investigation also found **two separate interactive OMP instances**. The
development writer above uses the older saved session; auxiliary diagnostics
PID **7432** were started as bare `omp` under Bash/SSHD in `session-17.scope`.
That auxiliary process is not protected by somebody else's tmux server. Its
feature edits were stopped to avoid two writers, and its findings were handed off
on disk. Reconnect with `m0clip-omp` instead of opening another bare OMP instance.

Reattach normally with `m0clip-omp`. After a reboot, OOM kill or deliberate OMP
exit, use `m0clip-omp --resume` to select saved history, or
`m0clip-omp --restore SESSION_ID_OR_ABSOLUTE_JSONL_PATH` to resume unfinished work
and subagents. Session-selection arguments remain blocked while a live writer
exists. This is connection persistence, not reboot survival or a wake-up scheduler.

### Earlier direct-SSH guardian

The original writer predated the tmux launcher and was not forcibly reparented.
A transient `m0clip-omp-recovery.service` was armed for that exact SSH/OMP pair;
it is now inactive and is not the resumed writer's persistence mechanism.

`deploy/access/m0clip-omp-recovery` uses Linux pidfds: original OMP exit while SSH
remains live disarms it; SSH-first or simultaneous exit waits for the old writer,
then restores its exact saved session once into detached tmux. It never creates
a concurrent original writer or steals a live terminal. It has no retry loop and
does not survive reboot. Do not reuse stale PID arguments for another session.

Disposable probes checked original-first, SSH-first and simultaneous-exit gating.
A real owned OMP probe started detached and displayed its UI. The actual SSH
connection was not deliberately dropped, and an automatic restore trigger was
not observed; no stronger disconnect or reboot test is claimed.

## VM memory and resource status

Read-only checks on 2026-10-21 now show **31.3G of online memory blocks**,
128M per block and **zero offline memory**. `free -h` reports **30 GiB usable**,
**25 GiB available**, and zero swap use out of roughly 512 MiB. The earlier
16 GiB observation no longer describes this boot: the larger guest allocation
is visible.

This verifies guest-visible capacity, not a dedicated reservation on the Proxmox
host. No host memory or ballooning changes were made.

No authorized Proxmox endpoint/VMID or host configuration was reachable from
existing local inventory; no network scan or guessed host connection was made.
On the known Proxmox host, compare `qm config VMID --current`, `qm pending VMID`
and `qm status VMID --verbose`, including memory, balloon, hotplug and runtime
allocation. A 32768 MiB configured maximum alone does not prove that amount is
currently presented to this guest. Do not reboot or change ballooning blindly.


## Naming

The project display name, browser title, access commands, SSH alias, and desktop
shortcuts are **m0clip**. The active node checkout is `/home/g/m0clip-ts`; its
older directory alias and internal service/key filenames remain compatible with
running sessions. Unitree remains the manufacturer name for the actual robots.
