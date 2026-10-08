#!/usr/bin/env python3
"""
Servidor estático do webclient. Igual ao `python3 -m http.server`, mas manda
o navegador não guardar cache — sem isso ele continua mostrando uma versão
antiga do index.html/JS depois que os arquivos mudam.

Uso: serve.py <porta> <host> <diretório>
"""

import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port, host, directory = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    handler = functools.partial(NoCacheHandler, directory=directory)
    ThreadingHTTPServer((host, port), handler).serve_forever()


if __name__ == "__main__":
    main()
