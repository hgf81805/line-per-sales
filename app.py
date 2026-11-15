#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fictional sales / LINE reply demo. No Beeper, LINE, or AI network calls."""
import argparse
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import webbrowser

ROOT = Path(__file__).resolve().parent


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/', '/index.html', '/healthz'):
            self.send_error(404)
            return
        body = b'ok' if self.path == '/healthz' else (ROOT / 'public' / 'index.html').read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8' if self.path == '/healthz' else 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        # All demo actions run in this browser. Network connections are prohibited.
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description='営業一覧・公式LINE返信の架空データデモ')
    parser.add_argument('--port', type=int, default=int(os.getenv('LINE_ASSISTANT_PORT', '8766')))
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('ポート番号は1〜65535で指定してください。')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as exc:
        parser.exit(1, f'起動できませんでした: {exc}\n別のポートをお試しください: python3 app.py --port 8767\n')
    url = f'http://127.0.0.1:{args.port}'
    print(f'営業・公式LINE デモ: {url}\n架空データのみ・実送信なし・外部接続なし\n終了: Control + C', flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n終了しました。')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
