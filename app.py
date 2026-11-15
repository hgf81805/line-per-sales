#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local demo server or explicit opt-in personal LINE reader."""
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
        body = b'ok' if self.path == '/healthz' else (ROOT / 'public' / 'demo.html').read_bytes()
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
    parser = argparse.ArgumentParser(description='営業デモ / 個人LINEの読み取り専用アプリ')
    parser.add_argument('--port', type=int, default=int(os.getenv('LINE_ASSISTANT_PORT', '8766')))
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--personal', action='store_true', help='Beeperで個人LINEを読み取り（送信不可）')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('ポート番号は1〜65535で指定してください。')
    handler = Handler
    if args.personal:
        import getpass
        from personal import make_handler
        print('Beeperを起動してください。トークンはこのMac内だけで使用し、保存しません。')
        token = (os.getenv('BEEPER_ACCESS_TOKEN') or getpass.getpass('Beeperアクセストークン: ')).strip()
        if not token:
            parser.exit(1, 'トークンが入力されていません。\n')
        handler = make_handler(token, args.port)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as exc:
        parser.exit(1, f'起動できませんでした: {exc}\n別のポートをお試しください: python3 app.py --port 8767\n')
    url = f'http://127.0.0.1:{args.port}'
    print(f'{"個人LINE・読み取り専用" if args.personal else "営業・公式LINE デモ"}: {url}\n送信・既読・LINE側の下書き変更なし\n終了: Control + C', flush=True)
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
