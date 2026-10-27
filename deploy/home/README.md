# Static hosting with Docker and Caddy

The server serves files. Graphics, MuJoCo physics and ONNX inference run in each
visitor's browser, so the server needs no GPU, desktop session, Node runtime or
Python installation. The app needs HTTPS and the supplied cross-origin isolation
headers for its browser WASM runtimes. Caddy supplies HTTPS and byte-range reads
for large assets.

Copy your `dist/` build and `deploy/home/` to the same relative locations
on the server. With Docker and Compose installed, run from the project directory:

```sh
APP_HOST=your-public-hostname.example docker compose -f deploy/home/compose.yaml up -d
```

Use a hostname whose DNS points to the server, with public ports 80 and 443
reachable. If the server already has a reverse proxy, retain the three
cross-origin headers in `Caddyfile` in that proxy's configuration and serve `dist/`
as static files instead of starting another proxy on those ports.

Size the server's storage for the maps, characters, robot assets and policy
packs you choose to deploy. Visitor preferences, takes and screenshots stay in
each browser; this container does not provide cloud storage for them.
