import json
import re
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import parse_qs, urlsplit

import personal


class PersonalTest(unittest.TestCase):
    def test_discard_unneeded_chat_fields(self):
        raw = {'items': [{'id': 'c0', 'title': '相手', 'type': 'single', 'network': 'LINE',
                          'preview': {'text': 'private preview'},
                          'draft': {'text': 'private draft'},
                          'futureField': {'text': 'private future field'}}],
               'hasMore': True, 'oldestCursor': 'opaque', 'unexpected': 'private root field'}
        safe = personal.metadata_page(raw)
        self.assertEqual(raw, {})
        self.assertEqual(set(safe), {'items', 'hasMore', 'oldestCursor'})
        self.assertEqual(set(safe['items'][0]), {'id', 'title', 'type', 'network', 'merge'})
        self.assertNotIn('private', json.dumps(safe))

    def setUp(self):
        self.calls = []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), personal.make_handler('test-token', 1))
        self.server.RequestHandlerClass = personal.make_handler('test-token', self.server.server_port)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.mock = patch.object(personal.reader, 'http_json', side_effect=self.upstream)
        self.mock.start()
        with urlopen(self.url) as res:
            self.html = res.read().decode()
        self.csrf = re.search("csrf='([^']+)'", self.html)[1]
        self.items = [{'id': 'm1', 'text': 'こんにちは', 'isSender': False, 'timestamp': '2026-11-01T00:00:00Z'}]

    def tearDown(self):
        self.mock.stop()
        self.server.shutdown()
        self.server.server_close()

    def upstream(self, url, token=None, method='GET', data=None, **kwargs):
        self.calls.append((url, method, data))
        if '/chats/search?' in url:
            return {'items': [
                {'id': 'other', 'type': 'single', 'network': 'WhatsApp'},
                {'id': 'group', 'type': 'group', 'network': 'LINE'},
                {'id': 'merged', 'type': 'single', 'network': 'LINE', 'merge': True},
            ] + [{'id': f'c{i}', 'title': '<相手>', 'type': 'single', 'network': 'LINE', 'lastActivity': '2026-11-01T00:00:00Z', 'lastMessage': 'must not be returned'} for i in range(7)]}
        if url.endswith('/messages'):
            return {'items': self.items}
        if url.endswith('/api/generate'):
            self.assertIsNone(token)
            return {'response': json.dumps({'candidates': ['丁寧な候補', '親しい候補', '簡潔な候補']})}
        raise AssertionError('Unexpected upstream URL')

    def api(self, path, body=None, **headers):
        req = Request(self.url + '/api/' + path, method='POST', data=json.dumps(body or {}).encode(), headers={
            'Content-Type': 'application/json', 'Origin': self.url, 'X-CSRF-Token': self.csrf, **headers})
        try:
            res = urlopen(req)
        except HTTPError as e:
            res = e
        with res:
            return res.status, json.loads(res.read())

    def test_initial_page_and_metadata_only(self):
        self.assertIn('data-local="1"', self.html)
        self.assertNotIn('test-token', self.html)
        self.assertEqual(self.calls, [])
        status, data = self.api('chats')
        self.assertEqual(status, 200)
        self.assertEqual(len(data['chats']), 5)
        self.assertEqual(set(data['chats'][0]), {'id', 'title', 'updated'})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1], 'GET')
        self.assertNotIn('must not be returned', json.dumps(data))

    def test_saved_exclusions_fill_display_and_reserve_across_pages(self):
        cloud = Mock()
        cloud.http.side_effect = lambda path, **_: [
            {'chat_id': f'c{i}'} for i in (range(100) if path.endswith('=0') else range(100, 120))
        ]
        self.server.RequestHandlerClass = personal.make_handler('test-token', self.server.server_port, cloud=cloud)
        with urlopen(self.url) as response:
            self.csrf = re.search("csrf='([^']+)'", response.read().decode())[1]

        def page(url, **_):
            params = parse_qs(urlsplit(url).query)
            start = int(params.get('cursor', ['0'])[0])
            end = min(start + int(params['limit'][0]), 135)
            return {'items': [{'id': f'c{i}', 'type': 'single', 'network': 'LINE'}
                              for i in range(start, end)],
                    'hasMore': end < 135, 'oldestCursor': str(end)}

        with patch.object(personal.reader, 'http_json', side_effect=page):
            status, first = self.api('chats', {'count': 10, 'paged': True, 'saved_exclusions': True})
            self.assertEqual(status, 200)
            self.assertEqual([row['id'] for row in first['chats']], [f'c{i}' for i in range(120, 130)])
            status, reserve = self.api('chats', {'count': 5, 'paged': True, 'saved_exclusions': True,
                                                 'cursor': first['next_cursor']})
            self.assertEqual(status, 200)
            self.assertEqual([row['id'] for row in reserve['chats']], [f'c{i}' for i in range(130, 135)])
        self.assertEqual(cloud.http.call_count, 4)
        self.assertTrue(all(kwargs['method'] == 'GET' for _, kwargs in cloud.http.call_args_list))

    def test_history_and_local_generation(self):
        self.api('chats')
        status, data = self.api('conversation', {'chat_id': 'c0'})
        self.assertEqual(status, 200)
        self.assertEqual(data['messages'][0]['text'], 'こんにちは')
        status, generated = self.api('suggest', {'chat_id': 'c0', 'message_id': data['message_id']})
        self.assertEqual(status, 200)
        self.assertEqual(len(generated['candidates']), 3)
        for url, method, payload in self.calls:
            if ':23373' in url:
                self.assertEqual(method, 'GET')
            else:
                self.assertTrue(url.startswith('http://127.0.0.1:11434/'))
                self.assertEqual(json.loads(payload['prompt'])['reply_to']['text'], 'こんにちは')

    def test_stale_reply_and_own_message(self):
        self.api('chats')
        self.assertEqual(self.api('suggest', {'chat_id': 'c0', 'message_id': 'old'})[0], 409)
        self.items[0]['isSender'] = True
        self.assertIsNone(self.api('conversation', {'chat_id': 'c0'})[1]['message_id'])
        self.assertEqual(self.api('suggest', {'chat_id': 'c0', 'message_id': 'm1'})[0], 409)
        self.assertFalse(any('/api/generate' in c[0] for c in self.calls))

    def test_public_pairing_is_one_use_and_revocable(self):
        origin = 'https://line-per-line.netlify.app'
        self.assertEqual(self.api('chats', Origin=origin)[0], 403)
        self.assertEqual(self.api('pair-code', Origin=origin)[0], 403)
        code = self.api('pair-code')[1]['code']
        self.assertEqual(self.api('pair', {'code': code}, Origin='https://evil.example')[0], 403)
        status, data = self.api('pair', {'code': code}, Origin=origin)
        self.assertEqual(status, 200)
        session = data['session']
        self.assertNotEqual(session, 'test-token')
        self.assertEqual(self.api('pair', {'code': code}, Origin=origin)[0], 403)
        headers = {'Origin': origin, 'X-Bridge-Token': session}
        self.assertEqual(self.api('chats', **headers)[0], 200)
        self.assertEqual(self.api('conversation', {'chat_id': 'c0'}, **headers)[0], 200)
        self.assertEqual(self.api('send', **headers)[0], 400)
        self.api('disconnect')
        self.assertEqual(self.api('chats', **headers)[0], 403)

    def test_public_pairing_expires_and_locks_after_failures(self):
        origin = 'https://line-per-line.netlify.app'
        code = self.api('pair-code')[1]['code']
        with patch.object(personal.time, 'monotonic', return_value=10**12):
            self.assertEqual(self.api('pair', {'code': code}, Origin=origin)[0], 403)
        code = self.api('pair-code')[1]['code']
        for _ in range(5):
            self.assertEqual(self.api('pair', {'code': 'bad'}, Origin=origin)[0], 403)
        self.assertEqual(self.api('pair', {'code': code}, Origin=origin)[0], 403)

    def test_cors_preflight_only_allows_named_site(self):
        def preflight(origin, requested='content-type,x-bridge-token'):
            req = Request(self.url + '/api/chats', method='OPTIONS', headers={
                'Origin': origin, 'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': requested})
            try:
                return urlopen(req)
            except HTTPError as exc:
                return exc
        with preflight('https://line-per-line.netlify.app') as res:
            self.assertEqual(res.status, 204)
            self.assertEqual(res.headers['Access-Control-Allow-Origin'], 'https://line-per-line.netlify.app')
        with preflight('https://evil.example') as res:
            self.assertEqual(res.status, 403)
            self.assertIsNone(res.headers.get('Access-Control-Allow-Origin'))
        self.assertEqual(self.calls, [])

    def test_no_write_routes_and_cross_origin(self):
        for path in ['read', 'draft', 'unknown']:
            self.assertEqual(self.api(path)[0], 404)
        self.assertEqual(self.api('send')[0], 400)
        self.assertEqual(self.api('chats', Origin='https://evil.example')[0], 403)
        self.assertEqual(self.api('cloud/enroll', {'email': 'a', 'password': 'b'}, Origin='https://line-per-line.netlify.app')[0], 403)
        self.assertEqual(self.api('cloud/status')[0], 503)
        self.assertEqual(self.api('chats', **{'X-CSRF-Token': 'bad'})[0], 403)
        self.assertEqual(self.api('chats', Host='evil.example')[0], 403)
        self.assertEqual(self.api('conversation', {'chat_id': 'unlisted'})[0], 400)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
