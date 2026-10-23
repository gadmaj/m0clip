# Stable playpen entry point

Public address: <https://gadmaj.org/mowat>

The application repository is [gadmaj/m0clip](https://github.com/gadmaj/m0clip)
and its workspace is `/home/g/m0clip-ts`. This entry point belongs to the separate
website repository, so its `/mowat` URL remains unchanged. The redirect's display
name was updated in `exp` commit `a16d2598a0410e85729508e5c8bf23597eefb62e`.
The application was released with an in-place Caddy reload, retaining the active
tunnel address. Public Chromium and HTTP checks passed after the rename.

The website is gadmaj/website on GitHub. Pages currently serves the exp branch.
Its node checkout is /home/g/website. The initial page commit is
3ad69a100002fd5f1aa0ddfd2b7ccffa3546fbd5.

## How the address stays current

The redirect fetches the published
[current.json](https://gadmaj.org/mowat/current.json)
with a unique query string and browser caching disabled. The repository is private,
so visitors read this public Pages copy rather than authenticated raw GitHub files.
It accepts only HTTPS trycloudflare.com destinations, preserves incoming query
parameters and URL fragments, and defaults to Ghost.

On the node, unitree-mowat-link.timer checks every 30 seconds and after reboot.
Its oneshot service runs deploy/development/publish-mowat-link.py. This reads only
the running public tunnel's invocation, verifies that the public URL serves the
same HTML as local Caddy, and confirms the tunnel did not restart during that check.
It publishes only mowat/current.json to exp through an isolated bare repository,
~/.local/share/unitree-dev/website-publisher.git. Normal pushes are retried if a
concurrent website edit arrives. Other website paths are preserved.

Successful publication is recorded in
~/.local/state/unitree-mowat-link/published.json. An unchanged invocation makes
no GitHub request or commit. New addresses are normally committed within one polling interval after becoming
healthy. GitHub Pages then deploys the new manifest, usually within another minute
or two. Cold tunnels and cache propagation can add time. The previous destination
can remain visible during this deployment interval.

The node must be online to serve MoWAT. The stable entry page and last published
address remain available on GitHub when the node is offline.

## Credentials and operations

A separate key, ~/.ssh/id_ed25519_unitree_website, has write access only to
gadmaj/website. The private half stays on the node. The broader GitHub login was
not copied. GitHub deploy-key ID 166904112 is titled
"MoWAT automatic live link (gdev-kubu)". GitHub's published Ed25519 host key is
pinned in ~/.ssh/unitree-github-known_hosts.

On the node:

- Check the timer: systemctl --user status unitree-mowat-link.timer
- Read updates: journalctl --user -u unitree-mowat-link.service -n 20
- Check without publishing: python3 deploy/development/publish-mowat-link.py --dry-run
- Publish now: systemctl --user start unitree-mowat-link.service

User lingering keeps hosting and the timer independent of SSH, desktop and Codex
sessions. deploy/development/start-services.sh installs the service templates.
If Pages moves branches, update the publisher's BRANCH to match the Pages source. If the deploy key is revoked, replace the repository-specific key.

Git checks cover changing only the manifest, skipping unchanged URLs and preserving
concurrent edits. Chrome checks cover fresh manifest lookup, query/fragment forwarding, unavailable
manifests and invalid destinations. This entry point uses the existing
app release and Quick Tunnel; it does not add an uptime guarantee.

References:
[GitHub deploy keys](https://docs.github.com/en/rest/deploy-keys/deploy-keys),
[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Verified on 2026-10-19

A real public-tunnel restart was detected and committed automatically in 34.4
seconds (commit 51850d7456c350f4cee88c6a2aca06b088563482). GitHub Pages
successfully deployed the final page in commit
515d82d4f516196b2503c37260f1572fdb00ce98. Public HTML and JSON matched
the node, and Chrome followed gadmaj.org/mowat to the new tunnel address.
The actual tunnel HTML also matched local Caddy. Destination rendering was
intercepted during the redirect check; this task did not repeat full map-render
tests or change the app release.
