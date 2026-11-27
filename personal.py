"""Loopback-only personal LINE UI. Text sending requires a short-lived confirmation ticket."""
from uuid import UUID
from datetime import date
from concurrent.futures import ThreadPoolExecutor
import sales_assist
import followups
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
    if not isinstance(page, dict):
        raise ValueError('Beeperの一覧を読み込めませんでした。')
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


def line_chat_rows(page, chat_type='single'):
    for chat in page['items']:
        network = chat.get('network')
        chat_id = chat.get('id')
        if (chat.get('type') != chat_type or not isinstance(network, str) or network.lower() != 'line'
                or chat.get('merge') or not isinstance(chat_id, str) or not chat_id):
            continue
        yield {'id': chat_id, 'title': chat.get('title') or '名称未設定',
               'updated': chat.get('lastActivity') or chat.get('lastActivityAt') or chat.get('updatedAt') or ''}


def scan_line_chats(token, chat_type, query='', maximum=None):
    rows = {}
    cursor = None
    seen_cursors = set()
    for _ in range(5):
        params = {'type': chat_type, 'limit': 100}
        if query:
            params.update(query=query, scope='titles')
        if cursor:
            params.update(cursor=cursor, direction='before')
        page = metadata_page(reader.http_json(
            reader.BEEPER_URL + '/v1/chats/search?' + urlencode(params), token=token))
        for row in line_chat_rows(page, chat_type):
            rows.setdefault(row['id'], row)
        cursor = page['oldestCursor'] if page['hasMore'] else None
        if not cursor or cursor in seen_cursors:
            cursor = None
            break
        if maximum is not None and len(rows) >= maximum:
            break
        seen_cursors.add(cursor)
    return rows, cursor


class ChatIndex:
    """Bounded, process-local LINE metadata index and short-lived pagination state."""
    REFRESH_INTERVAL = 30
    CURSOR_PREFIX = 'line-index:'

    def __init__(self, token, chat_type='single', maximum=None):
        self.token = token
        self.chat_type = chat_type
        self.maximum = maximum
        self.lock = threading.Lock()
        self.snapshot = None
        self.cursors = {}

    def refresh(self):
        started = time.monotonic()
        rows, cursor = scan_line_chats(self.token, self.chat_type, maximum=self.maximum)
        with self.lock:
            self.snapshot = (started, rows, cursor)
            cutoff = time.monotonic()
            self.cursors = {key: value for key, value in self.cursors.items() if value[0] > cutoff}

    def run(self):
        while True:
            try:
                self.refresh()
            except (RuntimeError, ValueError, OSError):
                pass
            time.sleep(self.REFRESH_INTERVAL)

    def start(self):
        threading.Thread(target=self.run, name=f'line-{self.chat_type}-index', daemon=True).start()

    def lookup(self, cursor):
        now = time.monotonic()
        with self.lock:
            if cursor and cursor.startswith(self.CURSOR_PREFIX):
                page = self.cursors.get(cursor)
                if not page or page[0] <= now:
                    raise ValueError('一覧の取得をやり直してください。')
                return page[1:]
            if not cursor and self.snapshot and now-self.snapshot[0] <= self.REFRESH_INTERVAL*2:
                _, rows, tail = self.snapshot
                return rows, tuple(rows.values()), tail
        return None

    def continuation(self, rows, remaining, tail):
        if not remaining:
            return tail
        key = self.CURSOR_PREFIX + secrets.token_urlsafe(18)
        with self.lock:
            if len(self.cursors) >= 32:
                self.cursors.pop(next(iter(self.cursors)))
            self.cursors[key] = (time.monotonic()+180, rows, remaining, tail)
        return key


def make_handler(token, port, cloud=None, sender=None, attio=None, chat_index=None, group_index=None):
    attio = attio or AttioBridge()
    sender = sender or ConfirmedSender()
    csrf = secrets.token_urlsafe(32)
    host = f'127.0.0.1:{port}'
    public_origin = "https://line-per-line.netlify.app"
    pairing = {"code": None, "expires": 0, "attempts": 0}
    sessions = {}
    allowed = {}
    lock = threading.RLock()

    def persist_attio(result,source='deals'):
        snapshot=result
        if 'deal' in result:
            snapshot={'profile':attio.identity(),'deals':[result['deal']] if result['deal'] else []}
        result['storage']=cloud.store_attio(snapshot,source) if cloud else {'saved':False,'message':'Supabase保存にはMacアプリで起動し、リモート接続へログインしてください。'}
        return result

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
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://zfwweszgsrovuiabvzye.supabase.co; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if (self.headers.get('Host') != host
                    or self.headers.get('Origin') != public_origin
                    or self.path not in ('/api/pair', '/api/chats', '/api/conversation', '/api/suggest', '/api/prepare-send', '/api/send', '/api/send-status', '/api/disconnect', '/api/attio-list', '/api/attio-linked', '/api/attio-link', '/api/attio-unlink', '/api/attio-create', '/api/attio-stage', '/api/attio-task', '/api/attio-complete', '/api/attio-contact', '/api/attio-note', '/api/sales-assist')
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
            for script in ('official.js','marked.umd.js','note-editor.js','sales-assist.js','sales-desk.js','settings.js','followups.js','push-settings.js','line-push-worker.js'):
                assets['/'+script] = ('text/javascript; charset=utf-8', script)
            assets['/manifest.webmanifest'] = ('application/manifest+json', 'manifest.webmanifest')
            assets['/ui.css'] = ('text/css; charset=utf-8', 'ui.css')
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
            if asset_path not in ('/', '/index.html', '/pipeline.html', '/settings.html'):
                return self.respond(404, {'error': 'Not found'})
            filename = 'index.html' if asset_path == '/' else asset_path[1:]
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
            routes = ('/api/attio/configure', '/api/attio/disconnect', '/api/attio/status', '/api/attio-list', '/api/attio-linked', '/api/attio-link', '/api/attio-unlink', '/api/attio-create', '/api/attio-stage', '/api/attio-task', '/api/attio-complete', '/api/attio-contact', '/api/attio-note', '/api/sales-assist', '/api/chat-preferences', '/api/prepare-send', '/api/send', '/api/send-status', '/api/chats', '/api/conversation', '/api/suggest', '/api/pair', '/api/pair-code', '/api/disconnect', '/api/cloud/status', '/api/cloud/enroll', '/api/cloud/disconnect')
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
                if self.path == '/api/chat-preferences':
                    if not is_local:
                        return self.respond(403, {'error':'Mac内の画面から利用してください。'})
                    if not cloud or not cloud.credentials:
                        return self.respond(200, {'sync':False,'rows':[]})
                    root = '/rest/v1/line_chat_preferences'
                    if 'released' in data:
                        released = data['released']
                        if not isinstance(released,list) or not 1<=len(released)<=12:
                            raise ValueError('invalid restore batch')
                        for row in released:
                            if (not isinstance(row,dict) or set(row)!={'chat_id','deferred_at'}
                                or not isinstance(row['chat_id'],str) or not 1<=len(row['chat_id'])<=256
                                or not followups.parse_date(row['deferred_at'])):
                                raise ValueError('invalid restore row')
                        cloud.http('/rest/v1/rpc/line_restore_later', {'p_rows':released})
                    if 'rows' in data:
                        rows = data['rows']
                        if not isinstance(rows,list) or not 1 <= len(rows) <= 62:
                            raise ValueError('invalid preferences')
                        for row in rows:
                            if (not isinstance(row,dict) or set(row)-{'chat_id','kind','active','title','deferred_at','return_on'}
                                or not {'chat_id','kind','active','title'}<=set(row)
                                or row['kind'] not in ('pin','hide','later','lead','mute') or type(row['active']) is not bool
                                or not isinstance(row['chat_id'],str) or not 1 <= len(row['chat_id']) <= 256
                                or not isinstance(row['title'],str) or len(row['title']) > 200):
                                raise ValueError('invalid preference')
                            if row['kind']=='later':
                                if not followups.parse_date(row.get('deferred_at')):
                                    raise ValueError('invalid deferred date')
                                if row.get('return_on') is not None:
                                    date.fromisoformat(row['return_on'])
                            elif 'return_on' in row or 'deferred_at' in row:
                                raise ValueError('invalid preference fields')
                        merge = 'ignore-duplicates' if data.get('import') is True else 'merge-duplicates'
                        cloud.http(root+'?on_conflict=user_id,kind,chat_id',rows,
                                   headers={'Prefer':'resolution='+merge+',missing=default,return=minimal'})
                    offset = data.get('offset',0)
                    if type(offset) is not int or offset < 0:
                        raise ValueError('invalid offset')
                    rows = cloud.http(root+'?select=chat_id,kind,title,deferred_at,return_on&active=eq.true&order=kind,chat_id&limit=100&offset='+str(offset),
                                      method='GET')
                    return self.respond(200, {'sync':True,'rows':rows or []})
                if self.path == '/api/attio-note':
                    if 'note_id' not in data:
                        if not is_local or not cloud:
                            return self.respond(403, {'error':'Mac内の画面でログインしてください。'})
                        person_id = str(UUID(data.get('person_id','')))
                        workspace = str(UUID(attio.identity()['workspace_id']))
                        rows = cloud.http('/rest/v1/line_attio_records?select=notes&object_type=eq.people'
                                          '&workspace_id=eq.'+workspace+'&record_id=eq.'+person_id+'&limit=1', method='GET')
                        return self.respond(200, {'notes': rows[0]['notes'] or [] if rows else []})
                    note = attio.note(data)
                    if 'body' in data:
                        try:
                            note['cached'] = bool(cloud and cloud.http('/rest/v1/rpc/line_update_attio_note_cache', {
                                'p_workspace': attio.identity()['workspace_id'],
                                'p_person': data['person_id'], 'p_note': note
                            }))
                        except RuntimeError:
                            note['cached'] = False
                    return self.respond(200, note)
                if self.path == '/api/attio-list':
                    source=data.get('source','deals')
                    return self.respond(200, persist_attio(attio.page(data.get('offset',0),source),source))
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
                if self.path == '/api/chats' and data.get('groups') is True:
                    if set(data)-{'groups','query'} or not isinstance(data.get('query',''),str) or len(data.get('query',''))>120:
                        raise ValueError('invalid group list request')
                    query = data.get('query','').strip()
                    indexed = group_index.lookup(None) if group_index and not query else None
                    if indexed:
                        result = indexed[1][:100]
                    else:
                        groups, _ = scan_line_chats(token, 'group', query=query, maximum=100)
                        result = list(groups.values())[:100]
                    return self.respond(200, {'chats':result})
                if self.path in ('/api/conversation','/api/prepare-send') and data.get('group') is True:
                    cid = data.get('chat_id')
                    if not isinstance(cid,str) or not 1<=len(cid)<=512:
                        raise ValueError('invalid group conversation request')
                    if self.path == '/api/prepare-send':
                        if set(data)!={'chat_id','group','text','conversation_version'}:
                            raise ValueError('invalid group send request')
                        return self.respond(200,sender.prepare(token,cid,data['text'],data['conversation_version'],'group'))
                    if set(data)-{'chat_id','group','summarize','reply_purpose'}:
                        raise ValueError('invalid group conversation request')
                    sender.chat(token,cid,'group')
                    page = reader.message_page(token,cid)
                    messages = [
                        {'speaker':'自分' if row.get('isSender') is True else str(row.get('senderName') or '発言者不明')[:150],
                         'text':row['text'][:1200], 'timestamp':row.get('timestamp') or ''}
                        for row in sorted(page.get('items') or [],key=reader.message_order) if reader.keep_message(row)
                    ][-20:]
                    if data.get('summarize') is True:
                        return self.respond(200, {'summary':sales_assist.summarize_group(messages)})
                    if 'reply_purpose' in data:
                        purposes = {'schedule':'日程調整','materials':'資料送付','followup':'フォロー','thanks':'お礼'}
                        purpose = data['reply_purpose']
                        if not isinstance(purpose,str) or purpose not in purposes or not messages:
                            raise ValueError('invalid group reply purpose')
                        return self.respond(200, {'candidates':reader.suggest_with_ollama({
                            'history':messages[:-1], 'reply_to':messages[-1], 'purpose':purposes[purpose],
                            'context':'複数人が読むLINEグループへの返信案'
                        })})
                    return self.respond(200, {'messages':messages,'conversation_version':conversation_version(page)})
                if self.path == '/api/chats':
                    if 'lead_chat' in data:
                        chat_id = data['lead_chat']
                        if set(data) != {'lead_chat'} or not isinstance(chat_id,str) or not 1<=len(chat_id)<=256:
                            raise ValueError('invalid lead chat')
                        current = sender.chat(token,chat_id)
                        chat = {'id':chat_id, 'title':current['title'], 'updated':''}
                        with lock:
                            allowed[chat_id] = chat
                        return self.respond(200, {'chats':[chat]})
                    query = data.get('query','')
                    pins = data.get('pins',[])
                    if not isinstance(query,str) or len(query)>120 or not isinstance(pins,list) or len(pins)>12:
                        raise ValueError('invalid search')
                    excluded = data.get('excluded', [])
                    count = data.get('count', 5)
                    if (type(count) is not int or count not in (5,10,15) or not isinstance(excluded,list)
                            or len(excluded)>50 or any(not isinstance(item,str) or len(item)>256 for item in excluded)):
                        raise ValueError('invalid list')
                    expanded = bool(query.strip() or pins)
                    limit = max(12 if expanded else 5,count)
                    seen_exclusions = set(excluded)
                    saved_exclusions = data.get('saved_exclusions') is True and cloud and cloud.credentials
                    if saved_exclusions:
                        offset = 0
                        while True:
                            rows = cloud.http('/rest/v1/line_chat_preferences'
                                              '?select=chat_id&active=eq.true&kind=in.(hide,later,lead)'
                                              f'&order=kind,chat_id&limit=100&offset={offset}', method='GET') or []
                            seen_exclusions.update(row['chat_id'] for row in rows)
                            if len(rows) < 100:
                                break
                            offset += len(rows)
                    cursor = data.get('cursor')
                    paged = data.get('paged') is True
                    if cursor is not None and (not paged or not isinstance(cursor,str) or not cursor or len(cursor)>2048):
                        raise ValueError('invalid cursor')
                    if saved_exclusions and paged:
                        limit = count
                    indexed = chat_index.lookup(cursor) if chat_index and paged and not query.strip() else None
                    indexed_rows = indexed[0] if indexed else {}
                    continuation = cursor is not None
                    next_cursor = None
                    found = []
                    seen = set()
                    if not query.strip():
                        for pinned in pins:
                            if len(found) >= limit:
                                break
                            if not isinstance(pinned,str) or not pinned or len(pinned)>512 or pinned in seen or pinned in seen_exclusions:
                                continue
                            if pinned in indexed_rows:
                                found.append(indexed_rows[pinned])
                                seen.add(pinned)
                                continue
                            try:
                                current = sender.chat(token,pinned)
                            except (RuntimeError, ValueError, OSError):
                                continue
                            found.append({'id':pinned,'title':current['title'],'updated':''})
                            seen.add(pinned)
                    if indexed:
                        _, remaining, tail = indexed
                        for offset, row in enumerate(remaining):
                            if len(found) >= limit:
                                next_cursor = chat_index.continuation(indexed_rows, remaining[offset:], tail)
                                break
                            if row['id'] not in seen and row['id'] not in seen_exclusions:
                                found.append(row)
                                seen.add(row['id'])
                        else:
                            next_cursor = tail
                    scan_pages = 24 if saved_exclusions else 6 if count >= 10 else 3
                    for _ in range(0 if indexed else scan_pages):
                        if len(found)>=limit:
                            break
                        params = {'type': 'single', 'limit': limit-len(found) if paged else limit}
                        if query.strip():
                            params.update(query=query.strip(),scope='titles')
                        if cursor:
                            params.update(cursor=cursor, direction='before')
                        page = metadata_page(reader.http_json(
                            reader.BEEPER_URL + '/v1/chats/search?' + urlencode(params), token=token))
                        for row in line_chat_rows(page):
                            if row['id'] not in seen and row['id'] not in seen_exclusions:
                                seen.add(row['id'])
                                found.append(row)
                            if len(found) == limit:
                                break
                        older = page.get('oldestCursor')
                        next_cursor = older if page.get('hasMore') and older and older != cursor else None
                        if len(found) == limit or next_cursor is None:
                            break
                        cursor = next_cursor
                    with lock:
                        if not continuation:
                            allowed.clear()
                        allowed.update({c['id']: c for c in found})
                    result = {'chats': found}
                    if paged:
                        result['next_cursor'] = next_cursor
                    return self.respond(200, result)
                if self.path in ('/api/send','/api/send-status') and set(data) != {'ticket_id'}:
                    raise ValueError('送信確認の情報を確認してください。')
                if self.path == '/api/send-status':
                    return self.respond(200, sender.status(data.get('ticket_id')))
                if self.path == '/api/send':
                    return self.respond(200, sender.send(token, data.get('ticket_id')))
                if self.path == '/api/sales-assist':
                    mode = data.get('mode')
                    if mode == 'official-draft':
                        history = data.get('history')
                        purpose = data.get('style')
                        variants = data.get('variants', False)
                        if (set(data)-{'mode','style','history','variants'} or type(variants) is not bool or purpose not in ('consult','price','materials','receipt')
                                or not isinstance(history,list) or not 1<=len(history)<=20
                                or any(not isinstance(row,dict) or set(row)!={'direction','body'}
                                       or row['direction'] not in ('in','out') or not isinstance(row['body'],str)
                                       or len(row['body'])>1000 for row in history)):
                            raise ValueError('invalid official draft')
                        draft = sales_assist.official_draft(history, purpose, variants)
                        return self.respond(200, {('drafts' if variants else 'draft'):draft,'history_count':len(history)})
                    if mode == 'later-check':
                        entries = data.get('later')
                        if not isinstance(entries,list) or len(entries)>12:
                            raise ValueError('invalid deferred list')
                        def replied(row):
                            if not isinstance(row,dict):
                                return None
                            cid=row.get('chat_id')
                            since=followups.parse_date(row.get('deferred_at'))
                            if not isinstance(cid,str) or not 1<=len(cid)<=256 or not since:
                                return None
                            try:
                                chat=sender.chat(token,cid)
                                if followups.has_reply(sender,token,chat['account_id'],cid,since.timestamp()):
                                    return cid
                            except (RuntimeError,ValueError,OSError):
                                pass
                            return None
                        with ThreadPoolExecutor(max_workers=4) as pool:
                            ids=[cid for cid in pool.map(replied,entries) if cid]
                        return self.respond(200,{'chat_ids':ids})
                    if mode == 'agenda':
                        return self.respond(200, followups.agenda(attio,sender,token,data.get('offset',0)))
                    if mode == 'follow-plan':
                        return self.respond(200, followups.plan(attio,sender,token,data))
                    if mode == 'follow-save':
                        return self.respond(200, followups.save(attio,sender,token,data))
                if self.path == '/api/sales-assist' and data.get('mode') == 'today':
                    with lock:
                        chats = list(allowed.items())
                    ids = data.get('chat_ids')
                    if ids is not None:
                        if not isinstance(ids,list) or len(ids)>15 or any(not isinstance(cid,str) for cid in ids):
                            raise ValueError('invalid follow-up list')
                        chats = [(cid, row) for cid,row in chats if cid in ids]
                    def assess(chat_id):
                        try:
                            chat = sender.chat(token, chat_id)
                            page = reader.message_page(token, chat_id)
                            items = sorted(page.get('items') or [], key=reader.message_order)
                            crm = sales_assist.context(attio, None, chat['account_id'], chat_id)
                            reasons = sales_assist.follow_reasons(items, crm)
                            return {'chat_id': chat_id, 'reasons': reasons} if reasons else None
                        except (RuntimeError, ValueError, OSError):
                            return {'chat_id': chat_id, 'reasons': ['確認できませんでした']}
                    with ThreadPoolExecutor(max_workers=4) as pool:
                        results = list(pool.map(assess, (chat_id for chat_id, _ in chats)))
                    return self.respond(200, {'items': [item for item in results if item]})
                cid = data.get('chat_id')
                with lock:
                    if not isinstance(cid, str) or cid not in allowed:
                        return self.respond(400, {'error': '一覧からLINEの1対1トークを選んでください。'})
                if self.path == '/api/sales-assist' and data.get('mode') == 'overview':
                    chat = sender.chat(token,cid)
                    overview = sales_assist.context(attio,cloud,chat['account_id'],cid)
                    overview['notes'] = [
                        {'title': str(note.get('title',''))[:250], 'body': str(note.get('body',''))[:4000]}
                        for note in overview['notes']
                    ]
                    return self.respond(200,overview)
                if self.path == '/api/attio-contact':
                    chat = sender.chat(token,cid)
                    result = attio.contact(chat['account_id'],cid,chat['title'],data)
                    if 'profile' in result:
                        snapshot = {'profile':result.pop('profile'),'records':[result['linked']]}
                        result['storage'] = cloud.store_attio(snapshot,'people') if cloud else None
                    return self.respond(200,result)
                if self.path in ('/api/attio-linked','/api/attio-link','/api/attio-unlink'):
                    account = sender.chat(token,cid)['account_id']
                    if self.path == '/api/attio-linked':
                        return self.respond(200, persist_attio(attio.linked(account,cid)))
                    if self.path == '/api/attio-unlink':
                        return self.respond(200, attio.unlink(account,cid))
                    return self.respond(200, persist_attio(attio.link(account,cid,data.get('deal_id'))))
                if self.path == '/api/prepare-send':
                    return self.respond(200, sender.prepare(token, cid, data.get('text'), data.get('conversation_version')))
                page = reader.message_page(token, cid)
                items = sorted(page.get('items') or [], key=reader.message_order)
                if self.path == '/api/sales-assist':
                    chat = sender.chat(token, cid)
                    crm = sales_assist.context(attio, cloud, chat['account_id'], cid)
                    if data.get('mode') == 'meeting-brief':
                        return self.respond(200, sales_assist.meeting_brief(items, crm))
                    draft = data.get('draft', '')
                    if not isinstance(draft, str) or len(draft) > 1000:
                        return self.respond(400, {'error': '下書きは1,000文字以内にしてください。'})
                    result = sales_assist.generate(items, crm, data.get('style'), draft)
                    result['version'] = conversation_version(page)
                    return self.respond(200, result)
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
