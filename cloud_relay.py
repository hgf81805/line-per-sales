"""Outbound, authenticated relay. Beeper credentials never leave this Mac."""
import json
import platform
import threading
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from token_store import load_token, save_token, delete_token

CLOUD_SERVICE = b'jp.line-per-sales.cloud'
CONFIG = json.loads((Path(__file__).parent / 'public/cloud-config.json').read_text())


class CloudError(RuntimeError):
    pass


class CloudRelay:
    def __init__(self):
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.credentials = None
        self.session = None
        self.dispatch = None
        self.worker = None
        self.heartbeat = None
        self.status = {'enabled': False, 'connected': False, 'email': '', 'error': ''}

    def http(self, path, data=None, method='POST', auth=True, headers=None):
        if not path.startswith(('/auth/v1/', '/rest/v1/')):
            raise CloudError('許可されていないクラウド接続先です。')
        request_headers = {'apikey': CONFIG['key'], 'Content-Type': 'application/json', **(headers or {})}
        if auth:
            request_headers['Authorization'] = 'Bearer ' + self.access_token()
        body = None if data is None else json.dumps(data).encode()
        request = Request(CONFIG['url'] + path, data=body, method=method, headers=request_headers)
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read(250000)
            return json.loads(raw) if raw else None
        except HTTPError as exc:
            # Do not log upstream request bodies, passwords, sessions or conversation content.
            if exc.code in (400, 401, 403) and path.startswith('/auth/v1/'):
                raise CloudError('ログインを確認できません。メール・パスワードとメール確認の完了を確認してください。') from None
            raise CloudError(f'クラウド接続エラー（HTTP {exc.code}）。再接続してください。') from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise CloudError('クラウドに接続できません。インターネット接続を確認してください。') from None

    def access_token(self):
        with self.lock:
            if self.session and self.session['expires_at'] > time.time() + 60:
                return self.session['access_token']
            if not self.credentials:
                raise CloudError('このMacのリモート接続を設定してください。')
            session = self.http('/auth/v1/token?grant_type=refresh_token',
                                {'refresh_token': self.credentials['refresh_token']}, auth=False)
            self.set_session(session)
            return self.session['access_token']

    def set_session(self, session):
        user = session.get('user') or {}
        if user.get('is_anonymous') or not user.get('id') or not session.get('refresh_token'):
            raise CloudError('メールで登録したアカウントでログインしてください。')
        self.session = {**session, 'expires_at': time.time() + session.get('expires_in', 3600)}
        self.credentials.update(refresh_token=session['refresh_token'], user_id=user['id'], email=user.get('email', ''))
        save_token(json.dumps(self.credentials), service=CLOUD_SERVICE)

    def enroll(self, email, password):
        if any(worker and worker.is_alive() for worker in (self.worker, self.heartbeat)):
            raise CloudError('先にこのMacのリモート接続を解除してください。')
        if not isinstance(email, str) or not isinstance(password, str) or len(email) > 320 or len(password) > 1024:
            raise CloudError('ログイン情報を確認してください。')
        session = self.http('/auth/v1/token?grant_type=password', {'email': email, 'password': password}, auth=False)
        with self.lock:
            self.credentials = {'device_id': str(uuid.uuid4())}
            self.set_session(session)
        self.start()
        return self.get_status()

    def restore(self):
        try:
            raw = load_token(service=CLOUD_SERVICE)
            if raw:
                self.credentials = json.loads(raw)
                self.start()
        except Exception:
            self.status['error'] = '保存したリモート接続を復元できません。Mac内の画面で接続し直してください。'

    def start(self):
        self.stop_event.clear()
        self.status.update(enabled=True, connected=False, email=self.credentials.get('email', ''), error='')
        self.heartbeat = threading.Thread(target=self.heartbeats, daemon=True)
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.heartbeat.start()
        self.worker.start()

    def get_status(self):
        with self.lock:
            return dict(self.status)

    def store_attio(self, result, source):
        """Persist only display fields, under this Mac's authenticated owner."""
        if not self.credentials or self.stop_event.is_set():
            return {'saved':False,'message':'Supabase保存にはMac内の画面でリモート接続へログインしてください。'}
        try:
            if source not in ('deals','companies','people'):
                raise ValueError('source')
            workspace=str(uuid.UUID(result['profile']['workspace_id']))
            records=result.get('deals',[]) if source=='deals' else result['records']
            fields={'name','url','stage_id','stage','stage_since','owner_id','value','currency'} if source=='deals' else {'name','detail','job_title','url'}
            self.access_token()
            with self.lock:
                owner=self.credentials['user_id']
            fetched_at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
            rows=[{'user_id':owner,'workspace_id':workspace,'object_type':source,
                   'record_id':str(uuid.UUID(record['id'])),
                   'data':{key:record[key] for key in fields if key in record},'fetched_at':fetched_at} for record in records]
            if rows:
                self.http('/rest/v1/line_attio_records?on_conflict=user_id,workspace_id,object_type,record_id',rows,
                          headers={'Prefer':'resolution=merge-duplicates,return=minimal'})
            return {'saved':True,'count':len(rows),'fetched_at':fetched_at}
        except Exception:
            return {'saved':False,'message':'Attioの取得は成功しましたがSupabaseへの保存に失敗しました。接続を確認して再取得してください。'}

    def publish_heartbeat(self):
        with self.lock:
            device_id = self.credentials['device_id']
            user_id = self.credentials['user_id']
        result = self.http('/rest/v1/line_remote_devices?on_conflict=id', {
            'id': device_id, 'user_id': user_id, 'name': platform.node()[:100] or 'Mac',
            'capabilities': ['read', 'confirmed-send-v1', 'attio-crm-v1', 'attio-directory-v1'],
            'last_seen': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'enabled': True,
        }, headers={'Prefer': 'resolution=merge-duplicates,return=minimal'})
        with self.lock:
            if not self.stop_event.is_set():
                self.status.update(connected=True, error='')
        return result

    def heartbeats(self):
        while not self.stop_event.is_set():
            try:
                self.access_token()
                self.publish_heartbeat()
            except Exception as exc:
                with self.lock:
                    self.status.update(connected=False, error=str(exc) if isinstance(exc, CloudError) else 'リモート接続の設定を確認してください。')
            self.stop_event.wait(15)

    def execute_job(self, job):
        action, payload = job.get('action'), job.get('payload')
        if action not in ('chats', 'conversation', 'suggest', 'prepare-send', 'send', 'send-status', 'attio-list', 'attio-linked', 'attio-link', 'attio-unlink', 'attio-create', 'attio-stage', 'attio-task', 'attio-complete') or not isinstance(payload, dict):
            raise CloudError('この操作には対応していません。')
        # Do not forward arbitrary URL paths, headers, Beeper tokens or unknown arguments.
        permitted = {'chats': set(), 'conversation': {'chat_id'}, 'suggest': {'chat_id', 'message_id'}, 'prepare-send': {'chat_id','text','conversation_version'}, 'send': {'ticket_id'}, 'send-status': {'ticket_id'}, 'attio-list': {'offset','source'}, 'attio-linked': {'chat_id'}, 'attio-link': {'chat_id','deal_id'}, 'attio-unlink': {'chat_id'}, 'attio-create': {'name','owner_id','stage_id','operation_id','confirmed'}, 'attio-stage': {'deal_id','stage_id','expected_stage_id','operation_id','confirmed'}, 'attio-task': {'deal_id','owner_id','content','deadline','operation_id','confirmed'}, 'attio-complete': {'deal_id','task_id','operation_id','confirmed'}}[action]
        if set(payload) - permitted or (action in ('prepare-send','send','send-status') and set(payload) != permitted):
            raise CloudError('操作の入力が不正です。')
        if self.stop_event.is_set() or not self.dispatch:
            raise CloudError('Macの接続が停止しています。')
        return self.dispatch(action, payload)

    def run(self):
        while not self.stop_event.is_set():
            try:
                if not self.status['connected']:
                    self.stop_event.wait(2)
                    continue
                jobs = self.http('/rest/v1/rpc/line_claim_job', {'p_device_id': self.credentials['device_id']})
                for job in jobs or []:
                    failed = False
                    try:
                        result = self.execute_job(job)
                    except Exception as exc:
                        failed = True
                        result = {'error': str(exc) if isinstance(exc, (CloudError, RuntimeError)) else 'Mac内の処理に失敗しました。'}
                    if not self.stop_event.is_set():
                        self.http('/rest/v1/rpc/line_finish_job', {
                            'p_job_id': job['id'], 'p_claim_id': job['claim_id'],
                            'p_result': result, 'p_error': failed,
                        })
            except Exception:
                with self.lock:
                    self.status.update(connected=False, error='クラウドへの接続を再試行しています。')
            self.stop_event.wait(3)

    def disconnect(self):
        self.stop_event.set()
        # A request already sent can finish, but its result will never be published after disconnect.
        for worker in (self.heartbeat, self.worker):
            if worker:
                worker.join(timeout=1)
        with self.lock:
            if self.credentials:
                device_id = self.credentials['device_id']
                try:
                    self.http('/rest/v1/line_remote_devices?id=eq.' + device_id, method='DELETE')
                except CloudError:
                    # A failed remote delete does not keep this Mac connected; heartbeat expires in 60s.
                    pass
            delete_token(service=CLOUD_SERVICE)
            self.credentials = None
            self.session = None
            self.status = {'enabled': False, 'connected': False, 'email': '', 'error': ''}
        return self.get_status()

    def close(self):
        self.stop_event.set()
