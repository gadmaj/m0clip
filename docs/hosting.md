# Hosting status

The requested permanent target is the user's home server. Its SSH address, user
and public hostname are not yet available; the user will check when home. No
deployment to that server has been attempted.

`deploy/home/` contains the prepared Caddy/Compose deployment. It serves the
tested `dist/` release as static files, requires no GPU, and supplies HTTPS,
cross-origin isolation and byte-range policy-pack loading. The configuration was
validated with the official Caddy container and the actual Ghost build was tested
in Chromium through that container: 77 cubemap bindings, native tone mapping, no
fog and no shader errors. A ZIP range request returned HTTP 206 with correct bytes.

The current tested release is `assets/main-C7Ii0RBv.js` (Source effects v9). The
public quick tunnel remains a temporary preview tied to this development machine.
It is not the permanent home-server deployment.

A managed Sites draft was created before the user selected the home server. It
was not published. Its ID is `appgprj_6ad536e65300819188f80a912bf5f3fc`; do not create
a duplicate if the user later requests managed hosting. The initial large Git
upload failed with HTTP 502; the remote branch remained empty. Its local checkout
is `/home/g/unitree-public-site`; an unused Worker alternative is at
`/home/g/unitree-public-site-worker`. Temporary upload environment secrets were
removed, and no application assets were uploaded to managed storage.

The native VTF/mip work in the development tree is separate from the tested v9
release. It has not been published. Finish its fallback/export and production
checks before including it in a home-server release.
