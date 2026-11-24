from __future__ import annotations

import argparse
import os
import socket
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


def get_available_port(start_port: int) -> int:
    for port in range(start_port, 65535):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No available port found starting at {start_port}.")


CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".woff2": "font/woff2",
}


class IsolatedStaticHandler(SimpleHTTPRequestHandler):
    root_dir: Path
    root_resolved: Path

    def guess_type(self, path: str | os.PathLike) -> str:
        ext = Path(path).suffix.lower()
        return CONTENT_TYPES.get(ext, "application/octet-stream")

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def _resolve_safe_file(self) -> tuple[int, Path | None]:
        raw_path = urlsplit(self.path).path
        decoded = unquote(raw_path).lstrip("/\\")
        if not decoded:
            decoded = "index.html"

        candidate = (self.root_resolved / decoded).resolve(strict=False)

        # Block traversal and sibling-folder prefix collisions
        if not candidate.is_relative_to(self.root_resolved):
            return 403, None

        if not candidate.exists() or not candidate.is_file():
            return 404, None

        # Resolve symlinks/junctions and re-verify boundary
        real_path = candidate.resolve(strict=True)
        if not real_path.is_relative_to(self.root_resolved):
            return 403, None

        return 200, real_path

    def _serve_file(self, send_body: bool) -> None:
        status, target = self._resolve_safe_file()
        if status != 200 or target is None:
            self.send_error(status)
            return

        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if send_body:
            self.wfile.write(data)

    def do_GET(self) -> None:
        self._serve_file(send_body=True)

    def do_HEAD(self) -> None:
        self._serve_file(send_body=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local COOP/COEP static file server.")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Root directory to serve (defaults to script directory).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="Starting port number (defaults to 8080).",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not automatically open the browser on startup.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root_resolved = args.root.resolve(strict=True)
    port = get_available_port(args.port)
    url = f"http://localhost:{port}/"

    IsolatedStaticHandler.root_dir = args.root
    IsolatedStaticHandler.root_resolved = root_resolved

    server = ThreadingHTTPServer(("127.0.0.1", port), IsolatedStaticHandler)
    server.daemon_threads = True

    print(f"Serving '{root_resolved}' at {url}")
    print("Press Ctrl+C to stop server")

    if not args.no_browser:
        threading.Timer(0.15, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
