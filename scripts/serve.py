"""Static server for the web client (scripts/start.sh).

Like `python3 -m http.server`, but browsers must revalidate every file
(unchanged ones come back as a quick 304), so after an update the page never
mixes new modules with stale cached ones.
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.bind, args.port), partial(NoCacheHandler, directory=args.directory))
    print(f"Serving {args.directory} on {args.bind}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
