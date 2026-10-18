# Host the app on a server without graphics hardware

The server serves files. Graphics, MuJoCo physics and ONNX inference run in each
visitor's browser, so the server needs no GPU, desktop session, Node runtime or
Python installation. The app needs HTTPS and the supplied cross-origin isolation
headers for its browser WASM runtimes. Caddy supplies HTTPS and byte-range reads
for the default policy pack.

Copy the tested `dist/` directory and `deploy/home/` to the same relative locations
on the server. With Docker and Compose installed, run from the project directory:

```sh
APP_HOST=your-public-hostname.example docker compose -f deploy/home/compose.yaml up -d
```

Use a hostname whose DNS points to the server, with public ports 80 and 443
reachable. If the server already has a reverse proxy, retain the three
cross-origin headers in `Caddyfile` in that proxy's configuration and serve `dist/`
as static files instead of starting another proxy on those ports.

The current complete release needs about 1.5 GB of disk space for maps, robot
assets, WASM runtimes and the default policy pack. Visitor preferences and recorded
takes remain in each browser. Start this container on the home server itself;
it will then remain available independently of the development computer.
