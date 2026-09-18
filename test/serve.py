"""The test server. `python3 -m http.server` keeps a listen queue of five, so
when Chrome asks for the page's eleven files at once some connections are reset
and a script silently never loads -- the page then fails with "startGame is not
defined" or a half-initialised main.js. A longer queue stops that."""
import http.server, socketserver, sys

class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    allow_reuse_address = True

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

Server(("", int(sys.argv[1]) if len(sys.argv) > 1 else 8765), Quiet).serve_forever()
