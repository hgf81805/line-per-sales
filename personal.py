"""Loopback-only personal LINE UI. Beeper operations are strictly GET-only."""
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlencode

import beeper_reader as reader


def make_handler(token, port):
    csrf = secrets.token_urlsafe(32)
    host = f'127.0.0.1:{port}'
    allowed = {}
    lock = threading.RLock()

    class PersonalHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, data, html=False):
            body = data.encode('utf-8') if html else json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.headers.get('Host') != host:
                return self.respond(403, {'error': '接続元を確認できません。127.0.0.1のURLを開いてください。'})
            if self.path not in ('/', '/index.html'):
                return self.respond(404, {'error': 'Not found'})
            page = (Path(__file__).parent / 'public/index.html').read_text()
            page = page.replace('data-local="0"', 'data-local="1"').replace('LOCAL_CSRF_PLACEHOLDER', csrf)
            self.respond(200, page, html=True)

        def do_POST(self):
            if self.headers.get('Host') != host or self.headers.get('Origin') != 'http://' + host or self.headers.get('X-CSRF-Token') != csrf:
                return self.respond(403, {'error': 'このMacのアプリ画面から操作してください。'})
            if self.path not in ('/api/chats', '/api/conversation', '/api/suggest'):
                return self.respond(404, {'error': 'このアプリに送信・既読・下書き変更のAPIはありません。'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or not 2 <= size <= 4096:
                    return self.respond(400, {'error': 'リクエスト形式を確認してください。'})
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    return self.respond(400, {'error': 'リクエスト形式を確認してください。'})
                if self.path == '/api/chats':
                    found = []
                    cursor = None
                    seen = set()
                    for _ in range(3):
                        params = {'type': 'single', 'limit': 200}
                        if cursor:
                            params.update(cursor=cursor, direction='before')
                        page = reader.http_json(reader.BEEPER_URL + '/v1/chats/search?' + urlencode(params), token=token)
                        for c in page.get('items') or []:
                            if c.get('type') != 'single' or (c.get('network') or '').lower() != 'line' or c.get('merge') or c.get('mergedIntoChatID') or not c.get('id'):
                                continue
                            if c['id'] not in seen:
                                seen.add(c['id'])
                                found.append({'id': c['id'], 'title': c.get('title') or '名称未設定', 'updated': c.get('lastActivity') or c.get('lastActivityAt') or c.get('updatedAt') or ''})
                            if len(found) == 5:
                                break
                        next_cursor = page.get('oldestCursor')
                        if len(found) == 5 or not page.get('hasMore') or not next_cursor or next_cursor == cursor:
                            break
                        cursor = next_cursor
                    with lock:
                        allowed.clear()
                        allowed.update({c['id']: c for c in found})
                    return self.respond(200, {'chats': found})
                cid = data.get('chat_id')
                with lock:
                    if not isinstance(cid, str) or cid not in allowed:
                        return self.respond(400, {'error': '一覧からLINEの1対1トークを選んでください。'})
                page = reader.message_page(token, cid)
                items = sorted(page.get('items') or [], key=reader.message_order)
                target = reader.last_inbound(items)
                # The original reply context preserves up to 20 useful text messages.
                if target:
                    context = reader.reply_context(token, cid, str(target['id']), page)
                else:
                    context = None
                if self.path == '/api/suggest':
                    if not target or context is None or str(target['id']) != data.get('message_id'):
                        return self.respond(409, {'error': '会話が更新されたか、最新が自分の発言です。「会話を読み込む」で確認してください。'})
                    return self.respond(200, {'candidates': reader.suggest_with_ollama(context)})
                if context:
                    messages = context['history'] + [context['reply_to']]
                else:
                    messages = [{'speaker': '自分' if m.get('isSender') else '相手', 'text': m['text'][:1200]} for m in items if reader.keep_message(m)][-20:]
                return self.respond(200, {'messages': messages, 'message_id': str(target['id']) if target and context else None})
            except (ValueError, TypeError):
                self.respond(400, {'error': 'データ形式を確認できませんでした。'})
            except Exception as exc:
                self.respond(502, {'error': str(exc)[:250]})

    return PersonalHandler
