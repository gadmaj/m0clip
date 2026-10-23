"""Loopback-only transport for the real noclip Ghost renderer comparison.

Reuse the importer's native BSP/pak/loose/VPK mounts, never converted GLBs.
Missing cached files use the importer's normal storage download/cache behavior.
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from import_source_bsp import BSP, MOUNTS, GAMES
from source_assets import FileSystem, VPK


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--map', choices=GAMES['neotokyo'][2], default='nt_ghost_ctg')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    cache = root / 'assets/bsp-cache'
    bsp_path = cache / f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp'
    bsp = BSP(bsp_path.read_bytes())
    loose, archives = MOUNTS['neotokyo']
    storage = 'https://z.noclip.website/'
    filesystem = FileSystem(bsp.lump(40), storage + loose,
                            [VPK(storage + name, str(cache)) for name in archives], str(cache))
    entries = set(filesystem.pak_names) | set(filesystem.loose)
    for archive in filesystem.vpks:
        entries.update(archive.entries)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            content_type = 'application/octet-stream'
            if path == '/':
                body = b'<!doctype html><canvas width="320" height="240"></canvas><script type="module" src="/reference.js"></script>'
                content_type = 'text/html'
            elif path == '/reference.js':
                body = args.bundle.read_bytes()
                content_type = 'text/javascript'
            elif path == '/index_bg.wasm':
                body = (args.reference / 'rust/pkg/index_bg.wasm').read_bytes()
                content_type = 'application/wasm'
            elif path == '/entries':
                body = json.dumps(sorted(entries)).encode()
                content_type = 'application/json'
            elif path == '/map-info':
                body = json.dumps(dict(id=args.map)).encode()
                content_type = 'application/json'
            elif path == '/map.bsp':
                body = bsp_path.read_bytes()
            elif path.startswith('/file/'):
                try:
                    body = filesystem.read(path[len('/file/'):])
                except (OSError, ValueError) as error:
                    self.send_error(500, str(error))
                    return
                if body is None:
                    self.send_error(404)
                    return
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    print(f'http://127.0.0.1:{server.server_port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
