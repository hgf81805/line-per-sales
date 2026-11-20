"""Loopback-only personal LINE UI. Text sending requires a short-lived confirmation ticket."""
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlencode

import beeper_reader as reader
from attio_bridge import AttioBridge, AttioError
from confirmed_send import ConfirmedSender, SendValidationError, conversation_version


def metadata_page(page):
    """Immediately discard previews, drafts and unknown fields after JSON decoding.

    This is logical disposal, not a guarantee of physical memory zeroization.
    No upstream response body is logged or persisted.
    """
    result = {'items': [], 'hasMore': bool(page.get('hasMore')),
              'oldestCursor': page.get('oldestCursor')}
    for chat in page.get('items') or []:
        safe = {key: chat.get(key) for key in (
            'id', 'title', 'type', 'network', 'lastActivity', 'lastActivityAt', 'updatedAt')
            if isinstance(chat.get(key), (str, int, float, bool))}
        safe['merge'] = bool(chat.get('merge') or chat.get('mergedIntoChatID'))
        result['items'].append(safe)
    page.clear()
    return result


def make_handler(token, port, cloud=None, sender=None, attio=None):
    attio = attio or AttioBridge()
    sender = sender or ConfirmedSender()
    csrf = secrets.token_urlsafe(32)
    host = f'127.0.0.1:{port}'
    public_origin = "https://line-per-line.netlify.app"
    pairing = {"code": None, "expires": 0, "attempts": 0}
    sessions = {}
    allowed = {}
    lock = threading.RLock()

    class PersonalHandler(BaseHTTPRequestHandler):
        local_csrf = csrf
        def log_message(self, *args):
            pass

        def respond(self, status, data, html=False):
            body = data.encode('utf-8') if html else json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            if self.headers.get('Origin') == public_origin:
                self.send_header('Access-Control-Allow-Origin', public_origin)
                self.send_header('Vary', 'Origin')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://zfwweszgsrovuiabvzye.supabase.co; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if (self.headers.get('Host') != host
                    or self.headers.get('Origin') != public_origin
                    or self.path not in ('/api/pair', '/api/chats', '/api/conversation', '/api/suggest', '/api/prepare-send', '/api/send', '/api/send-status', '/api/disconnect', '/api/attio-list', '/api/attio-linked', '/api/attio-link', '/api/attio-unlink', '/api/attio-create', '/api/attio-stage', '/api/attio-task', '/api/attio-complete')
                    or self.headers.get('Access-Control-Request-Method') != 'POST'):
                return self.respond(403, {'error': '許可されていない接続元です。'})
            requested = {h.strip().lower() for h in self.headers.get('Access-Control-Request-Headers', '').split(',') if h.strip()}
            if not requested <= {'content-type', 'x-bridge-token'}:
                return self.respond(403, {'error': '許可されていないヘッダーです。'})
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', public_origin)
            self.send_header('Access-Control-Allow-Methods', 'POST')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

        def do_GET(self):
            if self.headers.get('Host') != host:
                return self.respond(403, {'error': '接続元を確認できません。127.0.0.1のURLを開いてください。'})
            assets = {'/cloud.js': ('text/javascript; charset=utf-8', 'cloud.js'), '/cloud-config.json': ('application/json; charset=utf-8', 'cloud-config.json'), '/send.js': ('text/javascript; charset=utf-8', 'send.js'), '/attio.js': ('text/javascript; charset=utf-8', 'attio.js'), '/pipeline.js': ('text/javascript; charset=utf-8', 'pipeline.js')}
            assets['/directory.js'] = ('text/javascript; charset=utf-8', 'directory.js')
            assets.update({
                '/favicon.ico': ('image/x-icon', 'favicon.ico'),
                '/favicon.svg': ('image/svg+xml', 'favicon.svg'),
                '/favicon-32.png': ('image/png', 'favicon-32.png'),
                '/apple-touch-icon.png': ('image/png', 'apple-touch-icon.png')})
            asset_path = self.path.split('?', 1)[0]
            if asset_path in assets:
                mime, filename = assets[asset_path]
                body = (Path(__file__).parent / 'public' / filename).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                return self.wfile.write(body)
            if asset_path not in ('/', '/index.html', '/pipeline.html'):
                return self.respond(404, {'error': 'Not found'})
            filename = 'pipeline.html' if asset_path == '/pipeline.html' else 'index.html'
            page = (Path(__file__).parent / 'public' / filename).read_text()
            page = page.replace('data-local="0"', 'data-local="1"').replace('LOCAL_CSRF_PLACEHOLDER', csrf)
            self.respond(200, page, html=True)

        def do_POST(self):
            is_local = (self.headers.get('Origin') == 'http://' + host
                        and secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), csrf))
            is_public = self.headers.get('Origin') == public_origin
            bridge_token = self.headers.get('X-Bridge-Token', '')
            with lock:
                now = time.monotonic()
                for expired in [key for key, expiry in sessions.items() if expiry <= now]:
                    del sessions[expired]
                paired = is_public and bridge_token in sessions
            if self.headers.get('Host') != host or not (is_local or paired or (is_public and self.path == '/api/pair')):
                return self.respond(403, {'error': 'このMacの画面で接続コードを発行し、公開サイトから接続し直してください。'})
            routes = ('/api/attio/configure', '/api/attio/disconnect', '/api/attio/status', '/api/attio-list', '/api/attio-linked', '/api/attio-link', '/api/attio-unlink', '/api/attio-create', '/api/attio-stage', '/api/attio-task', '/api/attio-complete', '/api/prepare-send', '/api/send', '/api/send-status', '/api/chats', '/api/conversation', '/api/suggest', '/api/pair', '/api/pair-code', '/api/disconnect', '/api/cloud/status', '/api/cloud/enroll', '/api/cloud/disconnect')
            if self.path not in routes:
                return self.respond(404, {'error': 'この操作には対応していません。'})
            if (self.path == '/api/pair-code' or self.path.startswith('/api/cloud/') or self.path.startswith('/api/attio/')) and not is_local:
                return self.respond(403, {'error': '接続コードはMac内の画面で発行してください。'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or not 2 <= size <= 16384:
                    return self.respond(400, {'error': 'リクエスト形式を確認してください。'})
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    return self.respond(400, {'error': 'リクエスト形式を確認してください。'})
                if self.path == '/api/attio/configure':
                    return self.respond(200, attio.connect(data.get('token')))
                if self.path == '/api/attio/status':
                    return self.respond(200, attio.status())
                if self.path == '/api/attio/disconnect':
                    return self.respond(200, attio.disconnect())
                if self.path == '/api/attio-list':
                    return self.respond(200, attio.page(data.get('offset',0),data.get('source','deals')))
                if self.path in ('/api/attio-create','/api/attio-stage','/api/attio-task','/api/attio-complete'):
                    return self.respond(200, attio.mutate(self.path.split('-')[-1], data))
                if self.path.startswith('/api/cloud/'):
                    if cloud is None:
                        return self.respond(503, {'error': '最新版のMacアプリで起動し直してください。'})
                    if self.path == '/api/cloud/enroll':
                        return self.respond(200, cloud.enroll(data.get('email'), data.get('password')))
                    if self.path == '/api/cloud/disconnect':
                        return self.respond(200, cloud.disconnect())
                    return self.respond(200, cloud.get_status())
                if self.path == '/api/pair-code':
                    with lock:
                        pairing.update(code=secrets.token_hex(8), expires=time.monotonic() + 300, attempts=0)
                        sessions.clear()
                        return self.respond(200, {'code': pairing['code']})
                if self.path == '/api/pair':
                    with lock:
                        code = data.get('code')
                        if (not is_public or not isinstance(code, str) or pairing['code'] is None
                                or pairing['expires'] <= time.monotonic() or pairing['attempts'] >= 5
                                or not secrets.compare_digest(code, pairing['code'])):
                            pairing['attempts'] += 1
                            return self.respond(403, {'error': '接続コードが無効・期限切れです。Mac内の画面で再発行してください。'})
                        pairing['code'] = None
                        session = secrets.token_urlsafe(32)
                        sessions[session] = time.monotonic() + 8 * 3600
                        return self.respond(200, {'session': session})
                if self.path == '/api/disconnect':
                    with lock:
                        if is_local:
                            sessions.clear()
                            pairing['code'] = None
                        else:
                            sessions.pop(bridge_token, None)
                    return self.respond(200, {'ok': True})
                if self.path == '/api/chats':
                    found = []
                    cursor = None
                    seen = set()
                    for _ in range(3):
                        params = {'type': 'single', 'limit': 5}
                        if cursor:
                            params.update(cursor=cursor, direction='before')
                        page = metadata_page(reader.http_json(
                            reader.BEEPER_URL + '/v1/chats/search?' + urlencode(params), token=token))
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
                if self.path in ('/api/send','/api/send-status') and set(data) != {'ticket_id'}:
                    raise ValueError('送信確認の情報を確認してください。')
                if self.path == '/api/send-status':
                    return self.respond(200, sender.status(data.get('ticket_id')))
                if self.path == '/api/send':
                    return self.respond(200, sender.send(token, data.get('ticket_id')))
                cid = data.get('chat_id')
                with lock:
                    if not isinstance(cid, str) or cid not in allowed:
                        return self.respond(400, {'error': '一覧からLINEの1対1トークを選んでください。'})
                if self.path in ('/api/attio-linked','/api/attio-link','/api/attio-unlink'):
                    account = sender.chat(token,cid)['account_id']
                    if self.path == '/api/attio-linked':
                        return self.respond(200, attio.linked(account,cid))
                    if self.path == '/api/attio-unlink':
                        return self.respond(200, attio.unlink(account,cid))
                    return self.respond(200, attio.link(account,cid,data.get('deal_id')))
                if self.path == '/api/prepare-send':
                    return self.respond(200, sender.prepare(token, cid, data.get('text'), data.get('conversation_version')))
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
                return self.respond(200, {'messages': messages, 'message_id': str(target['id']) if target and context else None, 'conversation_version': conversation_version(page)})
            except AttioError as exc:
                self.respond(400, {'error': str(exc)})
            except SendValidationError as exc:
                self.respond(400, {'error': str(exc)})
            except (ValueError, TypeError):
                self.respond(400, {'error': 'データ形式を確認できませんでした。'})
            except Exception as exc:
                self.respond(502, {'error': str(exc)[:250]})

    return PersonalHandler
