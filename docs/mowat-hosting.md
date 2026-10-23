# m0clip entry points

Canonical application: **https://m0clip.com/**
Legacy entry: **https://gadmaj.org/mowat/**

The legacy page is a fixed redirect to m0clip.com. It preserves the incoming
query and fragment with `URL` setters and `location.replace`; query fields cannot
choose another destination. Without JavaScript, the page has a visible absolute
**Open m0clip.com** link. GitHub Pages serves static HTML, so this is not an HTTP
301. The app itself defaults to Ghost when no map is specified.

## Hosting

`m0clip-tunnel.service` runs the named Cloudflare tunnel `m0clip` to the existing
Caddy origin on `127.0.0.1:4173`. Both run under the lingering user manager. The VM
must remain online. Configuration is in `deploy/development/`; credentials stay
under `~/.cloudflared/`, not in Git.

The old `unitree-public.service` Quick Tunnel remains running for old-origin
saved-file recovery. Its address is no longer the redirect destination. Avoid
restarting it: a new Quick Tunnel address is a different browser-storage origin.
Saved takes, PNGs, policies and preferences do not move to m0clip.com by changing
DNS. Open the old address, download take ZIPs/PNGs and reopen takes on the new one.

The automatic `unitree-mowat-link.timer` and its oneshot service are retired.
The timer was disabled and stopped after the fixed landing deployed. Their
installed templates were archived privately; the old polling templates and
autostart references were removed from the project. The hosting, recovery tunnel
and vitals monitor were left running.

## Publishing the landing

The landing belongs to the separate private `gadmaj/website` repository. Pages
serves its `exp` branch. The local `/home/g/website` checkout can be stale and is
not overwritten by the publisher.

The exact source files are:

- `deploy/development/mowat/index.html`
- `deploy/development/mowat/current.json`

`current.json` keeps the canonical address for older bookmarks/tools; the new
landing does not fetch it. Preview or publish with:

```sh
python3 deploy/development/publish-mowat-link.py --dry-run
python3 deploy/development/publish-mowat-link.py --publish
```

Default/`--dry-run` lists staged hashes without network requests or publication.
`--publish` first requires the canonical HTTPS HTML to match local Caddy. It then
uses a temporary Git index and the latest remote tree, changing only the two
mowat files. Normal push retries preserve concurrent unrelated website edits.
It never resets the website checkout or force-pushes the branch.

The existing website-only deploy key stays on the node at
`~/.ssh/id_ed25519_unitree_website`. Host verification uses
`~/.ssh/unitree-github-known_hosts`. The isolated publishing repository is
`~/.local/share/unitree-dev/website-publisher.git`.

## Cutover evidence, 2026-10-23

The two files were published in commit
`232647aac977e5216d8394bf7d88380dcbbf648a`; its immediate parent is
`975dd70499de1ac343bce06f56e8482aa10ecb0d`. The actual public Pages response then
contained the new fixed landing. Native Chrome then verified the actual public
redirect, exact query/hash forwarding, history replacement and JavaScript-disabled
fallback. The separate canonical application smoke verifies cycle 17 capture,
saved-file reopening and storage permission; see [hosting status](hosting.md).

Canonical TLS, isolation headers and policy ZIP byte ranges passed. The node's
router still returned old Porkbun nameservers (86400-second TTL) and no A answer,
while public resolvers returned the correct Cloudflare addresses. A live
public-DNS DoH request fetched the exact local app HTML with normal TLS
verification. After that real health proof, the owner used the existing
`publish_redirect(...)` API to publish the files. Neither app nor publisher was
patched; native Chrome's hostname pin is an explicit network qualification,
not a claim that the router cache has updated.

For rollback, retrieve the two mowat blobs from the immediate parent and publish
them through `publish_redirect(...)`, preserving later unrelated remote edits.
Do not reset or force-push `exp`. Restoring old polling would also require its
matching original implementation and an explicit operational decision.
