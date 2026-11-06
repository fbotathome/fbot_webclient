"""Static server for the web client (scripts/start.sh).

Like `python3 -m http.server`, but browsers must revalidate every file
(unchanged ones come back as a quick 304), so after an update the page never
mixes new modules with stale cached ones.

With --cert/--key it serves HTTPS and relays /rosbridge, /video/ and /bags/ to the
local rosbridge, web_video_server and bag recorder, so the page has one origin and
one certificate to accept: a browser only lets an HTTPS page use the camera (the
Labeler on the Steam Deck), and an HTTPS page can't open ws:// or http:// connections.
"""

import argparse
import selectors
import socket
import ssl
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HANDSHAKE_TIMEOUT_S = 10  # an idle TCP connection must not hold its thread forever
UPSTREAM_TIMEOUT_S = 5


def _pipe(client, upstream):
    """Copies bytes both ways until one side closes; one thread, as an SSL socket must not be read
    and written from two threads at once."""
    selector = selectors.DefaultSelector()
    selector.register(client, selectors.EVENT_READ)
    selector.register(upstream, selectors.EVENT_READ)
    try:
        while True:
            # Decrypted bytes already inside the SSL socket don't wake select().
            buffered = getattr(client, "pending", lambda: 0)() > 0
            sources = [key.fileobj for key, _ in selector.select(0 if buffered else None)]
            if buffered and client not in sources:
                sources.append(client)
            for source in sources:
                data = source.recv(65536)
                if not data:
                    return
                (upstream if source is client else client).sendall(data)
    except OSError:
        pass  # the browser or the service went away
    finally:
        selector.close()
        upstream.close()


class NoCacheHandler(SimpleHTTPRequestHandler):
    relays = {}  # path prefix -> (local port, path for the service)
    plain_http = False  # an http:// request on the HTTPS port: answered with a redirect

    def setup(self):
        context = self.server.ssl_context
        if context:
            # The handshake runs here, in the request's thread and under a timeout, not in accept().
            self.request.settimeout(HANDSHAKE_TIMEOUT_S)
            if self.request.recv(1, socket.MSG_PEEK) == b"\x16":  # a TLS ClientHello
                self.request = context.wrap_socket(self.request, server_side=True)
            else:
                self.plain_http = True
            self.request.settimeout(None)
        super().setup()

    def send_head(self):
        if self.plain_http:
            # Typing localhost:8080 opens http://: send the browser to the same page over HTTPS.
            self.send_response(301)
            self.send_header("Location", f"https://{self.headers.get('Host', 'localhost')}{self.path}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.plain_http:
            return super().do_GET()  # the redirect, from send_head
        for prefix, (port, path_for) in self.relays.items():
            if self.path.startswith(prefix):
                return self._relay(port, path_for(self.path))
        return super().do_GET()

    def _relay(self, port, path):
        try:
            upstream = socket.create_connection(("127.0.0.1", port), timeout=UPSTREAM_TIMEOUT_S)
        except OSError:
            self.send_error(502, f"Nothing is listening on port {port}")
            return
        upstream.settimeout(None)
        websocket = self.headers.get("Upgrade", "").lower() == "websocket"
        headers = [f"{name}: {value}" for name, value in self.headers.items()
                   if websocket or name.lower() not in ("connection", "keep-alive")]
        if not websocket:
            # Otherwise the browser sends its next request (say /index.html) down this socket to the service.
            headers.append("Connection: close")
        upstream.sendall(("\r\n".join([f"GET {path} HTTP/1.1", *headers]) + "\r\n\r\n").encode("latin-1"))
        self.close_connection = True
        _pipe(self.connection, upstream)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    ssl_context = None  # set: HTTPS (each connection is wrapped in NoCacheHandler.setup)

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError, TimeoutError)):
            return  # mostly browsers refusing the self-signed certificate until it is accepted
        super().handle_error(request, client_address)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--directory", required=True)
    parser.add_argument("--cert", help="certificate (PEM): serve HTTPS")
    parser.add_argument("--key", help="private key (PEM) of --cert")
    parser.add_argument("--rosbridge-port", type=int, help="relay /rosbridge to this port")
    parser.add_argument("--video-port", type=int, help="relay /video/ to this port (web_video_server)")
    parser.add_argument("--bag-port", type=int, help="relay /bags/ to this port (bag downloads)")
    args = parser.parse_args()

    relays = {}
    if args.rosbridge_port:
        relays["/rosbridge"] = (args.rosbridge_port, lambda path: "/")  # rosbridge's route is /
    if args.video_port:
        relays["/video/"] = (args.video_port, lambda path: path[len("/video"):])
    if args.bag_port:
        relays["/bags/"] = (args.bag_port, lambda path: path)
    handler = type("Handler", (NoCacheHandler,), {"relays": relays})

    server = Server((args.bind, args.port), partial(handler, directory=args.directory))
    if args.cert:
        server.ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server.ssl_context.load_cert_chain(args.cert, args.key)
    print(f"Serving {args.directory} on {'https' if args.cert else 'http'}://{args.bind}:{args.port}"
          + (f", relaying {', '.join(relays)}" if relays else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
