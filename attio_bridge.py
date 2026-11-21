"""Attio CRM integration. Credentials stay in this Mac's Keychain."""
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID

from token_store import load_token, save_token, delete_token

SERVICE = b'jp.line-per-sales.attio'

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class AttioError(RuntimeError):
    pass

def uuid(value):
    try:return str(UUID(value))
    except (ValueError, TypeError, AttributeError):raise AttioError('案件・担当者の選択を確認してください。') from None

def stage_id(value):
    status=value.get('status') or {}
    ident=status.get('id') or {}
    return ident.get('status_id') if isinstance(ident,dict) else ident

def slim_deal(record):
    values=record.get('values') or {}
    first=lambda key:(values.get(key) or [{}])[0]
    stage=first('stage')
    return {'id':record['id']['record_id'],'name':first('name').get('value') or '名称未設定',
            'stage_id':stage_id(stage),'stage':(stage.get('status') or {}).get('title') or '未設定',
            'stage_since':stage.get('active_from'),'owner_id':first('owner').get('referenced_actor_id'),'url':record.get('web_url'),
            'value':first('value').get('currency_value'),'currency':first('value').get('currency_code')}

def slim_directory(record,source):
    values=record.get('values') or {}
    first=lambda key:(values.get(key) or [{}])[0]
    if source=='people':
        name=first('name').get('full_name') or ' '.join(filter(None,(first('name').get('first_name'),first('name').get('last_name'))))
        detail=first('email_addresses').get('email_address') or ''
    else:
        name=first('name').get('value')
        detail=first('domains').get('domain') or ''
    result={'id':record['id']['record_id'],'name':name or detail or '名称未設定',
            'detail':detail,'job_title':first('job_title').get('value') if source=='people' else None,
            'url':record.get('web_url')}
    if source=='people':
        result.update({
            'emails': [entry['email_address'] for entry in values.get('email_addresses', []) if entry.get('email_address')],
            'phones': [entry.get('original_phone_number') or entry['phone_number'] for entry in values.get('phone_numbers', []) if entry.get('original_phone_number') or entry.get('phone_number')],
            'description': first('description').get('value'),
            'created_at': record.get('created_at') or first('created_at').get('value'),
        })
    return result

class AttioBridge:
    def __init__(self, path=None):
        self.path=Path(path) if path else Path.home()/'Library/Application Support/つながる営業/attio-links.sqlite3'
        self.token=None
        self.profile=None
        self.lock=threading.RLock()

    def db(self):
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        db=sqlite3.connect(self.path,timeout=10,isolation_level=None)
        os.chmod(self.path,0o600)
        db.execute('create table if not exists links (workspace text, account text, chat text, deal text not null, primary key(workspace,account,chat))')
        db.execute('create table if not exists operations (workspace text, operation text, fingerprint text, status text, result_id text, primary key(workspace,operation))')
        return db

    def http(self,path,body=None,method='GET',token=None):
        if not path.startswith('/v2/') or '://' in path or '..' in path:
            raise AttioError('Attioの接続先が不正です。')
        if token is None:
            if self.token is None:self.token=load_token(service=SERVICE)
            token=self.token
        if not token:raise AttioError('Mac内の設定画面でAttioのAPIトークンを登録してください。')
        req=Request('https://api.attio.com'+path,method=method,
                    data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
                    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json'})
        try:
            with build_opener(NoRedirect()).open(req,timeout=25) as response:raw=response.read(2000000)
            return json.loads(raw) if raw else {}
        except HTTPError as exc:
            messages={401:'Attioトークンが無効です。',403:'Attioトークンの権限が不足しています。',429:'Attioの利用上限です。時間をおいて更新してください。'}
            raise AttioError(messages.get(exc.code,f'Attio通信エラー（HTTP {exc.code}）。更新して結果を確認してください。')) from None
        except (URLError,TimeoutError,OSError,ValueError):
            raise AttioError('Attioからの応答を確認できません。変更結果はAttio側でも確認してください。') from None

    def identity(self):
        if self.profile is None:
            info=self.http('/v2/self')
            if not info.get('active') or not info.get('workspace_id'):raise AttioError('有効なAttioワークスペースのトークンを登録してください。')
            self.profile={key:info.get(key) for key in ('workspace_id','workspace_name','workspace_slug')}
        return dict(self.profile)

    def connect(self,token):
        if not isinstance(token,str) or not token.strip() or len(token)>8192:raise AttioError('AttioのAPIトークンを入力してください。')
        token=token.strip()
        info=self.http('/v2/self',token=token)
        if not info.get('active') or not info.get('workspace_id'):raise AttioError('Attioトークンを確認してください。')
        self.http('/v2/objects/deals/attributes/stage/statuses',token=token)
        save_token(token,service=SERVICE)
        self.token=token;self.profile={key:info.get(key) for key in ('workspace_id','workspace_name','workspace_slug')}
        return {'connected':True,**self.profile}

    def disconnect(self):
        with self.lock:
            delete_token(service=SERVICE)
            self.token=None;self.profile=None
        return {'connected':False}

    def stages(self):
        return [{'id':s['id']['status_id'],'title':s['title']} for s in self.http('/v2/objects/deals/attributes/stage/statuses').get('data',[]) if not s.get('is_archived')]

    def members(self):
        return [{'id':m['id']['workspace_member_id'],'name':(m.get('first_name','')+' '+m.get('last_name','')).strip() or m.get('email_address') or '担当者'} for m in self.http('/v2/workspace_members').get('data',[])]

    def page(self,offset=0,source='deals'):
        if not isinstance(offset,int) or not 0<=offset<=100000:raise AttioError('一覧ページを確認してください。')
        if source not in ('deals','companies','people'):raise AttioError('取得するデータの種類を選んでください。')
        profile=self.identity()
        records=self.http('/v2/objects/'+source+'/records/query',{'limit':50,'offset':offset,'sorts':[{'attribute':'created_at','direction':'desc'}]},'POST').get('data',[])
        if source!='deals':
            return {'source':source,'profile':profile,'records':[slim_directory(r,source) for r in records],
                    'offset':offset,'has_more':len(records)==50}
        return {'profile':profile,'stages':self.stages(),'members':self.members(),
                'deals':[slim_deal(r) for r in records],'offset':offset,'has_more':len(records)==50}

    def deal(self,deal_id):
        return slim_deal(self.http('/v2/objects/deals/records/'+uuid(deal_id))['data'])

    def tasks(self,deal_id,owner=None):
        params={'linked_object':'deals','linked_record_id':uuid(deal_id),'is_completed':'false','limit':50}
        if owner:params['assignee']=uuid(owner)
        query=urlencode(params)
        rows=self.http('/v2/tasks?'+query).get('data',[])
        return [{'id':t['id']['task_id'],'content':t.get('content_plaintext',''),
                 'deadline':t.get('deadline_at'),'assignees':[a.get('referenced_actor_id') for a in t.get('assignees',[])]} for t in rows]

    def linked(self,account,chat):
        workspace=self.identity()['workspace_id']
        if not self.path.exists():return {'deal':None,'tasks':[]}
        with closing(self.db()) as db:row=db.execute('select deal from links where workspace=? and account=? and chat=?',(workspace,account,chat)).fetchone()
        return {'deal':self.deal(row[0]),'tasks':self.tasks(row[0])} if row else {'deal':None,'tasks':[]}

    def link(self,account,chat,deal_id):
        deal=self.deal(deal_id)
        workspace=self.identity()['workspace_id']
        with closing(self.db()) as db:
            db.execute('insert into links values(?,?,?,?) on conflict(workspace,account,chat) do update set deal=excluded.deal',(workspace,account,chat,deal['id']))
        return {'deal':deal,'tasks':self.tasks(deal['id'])}

    def status(self):
        try:
            return {'connected':True,**self.identity()}
        except AttioError:
            return {'connected':False}

    def unlink(self,account,chat):
        workspace=self.identity()['workspace_id']
        if self.path.exists():
            with closing(self.db()) as db:db.execute('delete from links where workspace=? and account=? and chat=?',(workspace,account,chat))
        return {'deal':None,'tasks':[]}

    def mutate(self,kind,data):
        if data.get('confirmed') is not True:raise AttioError('変更内容を確認してから保存してください。')
        operation=uuid(data.get('operation_id'))
        workspace=self.identity()['workspace_id']
        fingerprint=hashlib.sha256(json.dumps({'kind':kind,**data},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            with closing(self.db()) as db:
                previous=db.execute('select fingerprint,status,result_id from operations where workspace=? and operation=?',(workspace,operation)).fetchone()
                if previous:
                    if previous[0]!=fingerprint:raise AttioError('操作の内容が変更されています。確認し直してください。')
                    if previous[1]!='accepted':raise AttioError('前回の登録結果が不明です。自動再実行せず、Attio側で確認してください。')
                    return {'saved':True,'id':previous[2]}
            path,body,method,result_key=self.validate_mutation(kind,data)
            with closing(self.db()) as db:
                db.execute('insert into operations values(?,?,?,?,?)',(workspace,operation,fingerprint,'unknown',None))
            try:
                response=self.http(path,{'data':body},method)
                result_id=response['data']['id'][result_key]
                with closing(self.db()) as db:db.execute('update operations set status=?,result_id=? where workspace=? and operation=?',('accepted',result_id,workspace,operation))
                return {'saved':True,'id':result_id}
            except Exception:
                raise AttioError('登録結果が不明です。二重登録を避けるため自動再実行しません。Attio側で確認してください。') from None

    def validate_mutation(self,kind,data):
        if kind in ('create','stage'):
            stage=uuid(data.get('stage_id'))
            if stage not in {s['id'] for s in self.stages()}:raise AttioError('営業工程を選び直してください。')
        if kind=='create':
            name=data.get('name');owner=uuid(data.get('owner_id'))
            if not isinstance(name,str) or not name.strip() or len(name)>200:raise AttioError('案件名は1〜200文字で入力してください。')
            if owner not in {m['id'] for m in self.members()}:raise AttioError('担当者を選び直してください。')
            return '/v2/objects/deals/records',{'values':{'name':name.strip(),'stage':[{'status':stage}],'owner':{'referenced_actor_type':'workspace-member','referenced_actor_id':owner}}},'POST','record_id'
        if kind=='stage':
            deal=self.deal(data.get('deal_id'))
            if deal['stage_id']!=data.get('expected_stage_id'):raise AttioError('Attio側で工程が更新されています。一覧を更新して確認し直してください。')
            return '/v2/objects/deals/records/'+deal['id'],{'values':{'stage':[{'status':stage}]}},'PUT','record_id'
        if kind=='task':
            deal=self.deal(data.get('deal_id'));owner=uuid(data.get('owner_id'));content=data.get('content')
            if not isinstance(content,str) or not content.strip() or len(content)>1000:raise AttioError('次のアクションを1〜1000文字で入力してください。')
            if owner not in {m['id'] for m in self.members()}:raise AttioError('担当者を選び直してください。')
            if any(owner in task['assignees'] for task in self.tasks(deal['id'],owner)):raise AttioError('この担当者には未完了の次アクションがあります。先に確認・完了してください。')
            deadline=data.get('deadline')
            if deadline:
                try:
                    parsed=datetime.fromisoformat(deadline.replace('Z','+00:00'))
                    if parsed.tzinfo is None:raise ValueError()
                except (AttributeError,ValueError):raise AttioError('期限の日時を確認してください。') from None
            return '/v2/tasks',{'content':content.strip(),'format':'plaintext','deadline_at':deadline or None,'is_completed':False,
                               'linked_records':[{'target_object':'deals','target_record_id':deal['id']}],
                               'assignees':[{'referenced_actor_type':'workspace-member','referenced_actor_id':owner}]},'POST','task_id'
        if kind=='complete':
            deal_id=uuid(data.get('deal_id'));task_id=uuid(data.get('task_id'))
            if task_id not in {t['id'] for t in self.tasks(deal_id)}:raise AttioError('この案件の未完了アクションを選択してください。')
            return '/v2/tasks/'+task_id,{'is_completed':True},'PATCH','task_id'
        raise AttioError('対応していない営業操作です。')
