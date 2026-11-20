#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local demo server or explicit opt-in personal LINE reader."""
import argparse
import os
import sys
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
    parser.add_argument('--replace-token', action='store_true', help='保存済みのBeeperトークンを入れ替える（--personal用）')
    parser.add_argument('--token-stdin', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.token_stdin and (not args.personal or args.replace_token):
        parser.error('--token-stdin はGUI接続用です。')
    if args.replace_token and not args.personal:
        parser.error('--replace-token は --personal と一緒に指定してください。')
    if not 1 <= args.port <= 65535:
        parser.error('ポート番号は1〜65535で指定してください。')
    handler = Handler
    cloud = None
    if args.personal:
        from personal import make_handler
        from token_store import get_token, KeychainError
        print('Beeperを起動してください。トークンはこのMacのキーチェーンで管理します。')
        try:
            token = sys.stdin.readline(8193).strip() if args.token_stdin else get_token(replace=args.replace_token)
            if not token or len(token) > 8192:
                raise KeychainError('Beeperトークンを設定画面から入力してください。')
        except KeychainError as exc:
            parser.exit(1, str(exc) + '\n')
        except (EOFError, KeyboardInterrupt):
            parser.exit(1, '\nトークンの入力を終了しました。\n')
        from cloud_relay import CloudRelay
        cloud = CloudRelay()
        handler = make_handler(token, args.port, cloud=cloud)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as exc:
        parser.exit(1, f'起動できませんでした: {exc}\n別のポートをお試しください: python3 app.py --port 8767\n')
    if cloud is not None:
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        import json
        def dispatch(action, payload):
            request = Request(f'http://127.0.0.1:{args.port}/api/' + action,
                data=json.dumps(payload).encode(), method='POST', headers={
                    'Origin': f'http://127.0.0.1:{args.port}', 'Content-Type': 'application/json',
                    'X-CSRF-Token': handler.local_csrf})
            try:
                response = urlopen(request, timeout=195)
            except HTTPError as exc:
                response = exc
            with response:
                data = json.loads(response.read(200000))
                if response.status != 200:
                    raise RuntimeError(data.get('error', 'Mac内の処理に失敗しました。'))
                return data
        cloud.dispatch = dispatch
        threading.Thread(target=cloud.restore, daemon=True).start()
    if args.token_stdin:
        print('LINE_CONNECTOR_READY', flush=True)
    url = f'http://127.0.0.1:{args.port}'
    print(f'{"個人LINE・読み取り専用" if args.personal else "営業・公式LINE デモ"}: {url}\n送信・既読・LINE側の下書き変更なし\n終了: Control + C', flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n終了しました。')
    finally:
        if cloud is not None:
            cloud.close()
        server.server_close()


if __name__ == '__main__':
    main()
