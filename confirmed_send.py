"""Explicit two-step text sending with a durable at-most-once attempt journal."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from urllib.parse import quote

import beeper_reader as reader


def conversation_version(page):
    values = [{k: item.get(k) for k in ('id','text','isSender','timestamp','editedTimestamp','isDeleted','isHidden')}
              for item in sorted(page.get('items') or [], key=reader.message_order)]
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class SendValidationError(ValueError):
    pass


class ConfirmedSender:
    def __init__(self, journal=None):
        self.journal = Path(journal) if journal else Path.home() / 'Library/Application Support/つながる営業/send-journal.sqlite3'
        self.tickets = {}
        self.lock = threading.RLock()

    def database(self):
        self.journal.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.journal, timeout=10, isolation_level=None)
        os.chmod(self.journal, 0o600)
        connection.execute('create table if not exists attempts (ticket text primary key, status text not null, pending_id text, created real not null)')
        connection.execute('create table if not exists accepted_targets (ticket text primary key, account text not null, chat text not null, accepted_at real not null)')
        return connection

    def receipt(self, ticket):
        if not self.journal.exists():
            return None
        with closing(self.database()) as db:
            row = db.execute('select status,pending_id from attempts where ticket=?', (ticket,)).fetchone()
        return {'status': row[0], 'pending_message_id': row[1]} if row else None

    def accepted_target(self, ticket):
        self.status(ticket)
        if not self.journal.exists():
            return None
        with closing(self.database()) as db:
            row = db.execute('select account,chat,accepted_at from accepted_targets where ticket=?',(ticket,)).fetchone()
        return row

    def chat(self, token, cid, chat_type='single'):
        chat = reader.http_json(reader.BEEPER_URL + '/v1/chats/' + quote(cid, safe=''), token=token)
        if (chat.get('id') != cid or chat.get('type') != chat_type or (chat.get('network') or '').lower() != 'line'
                or chat.get('merge') or chat.get('mergedIntoChatID') or not chat.get('accountID')):
            raise SendValidationError('LINEのトークを選び直してください。' if chat_type=='group' else 'LINEの1対1トークを選び直してください。')
        return {'chat_id': cid, 'title': chat.get('title') or '名称未設定', 'account_id': chat['accountID']}

    def prepare(self, token, cid, text, version, chat_type='single'):
        if not isinstance(text, str) or not text.strip() or len(text) > 1000:
            raise SendValidationError('本文は1〜1000文字で入力してください。')
        if not isinstance(version, str) or conversation_version(reader.message_page(token, cid)) != version:
            raise SendValidationError('会話が更新されています。会話を読み込み直してから確認してください。')
        target = self.chat(token, cid, chat_type)
        with self.lock:
            now = time.monotonic()
            self.tickets = {k: v for k,v in self.tickets.items() if v['expires'] > now}
            if len(self.tickets) >= 100:
                raise SendValidationError('確認待ちの操作が多すぎます。しばらく待ってください。')
            ticket = secrets.token_urlsafe(32)
            self.tickets[ticket] = {**target, 'text': text, 'version': version, 'chat_type': chat_type, 'expires': now + 300}
        return {**target, 'text': text, 'ticket_id': ticket, 'expires_in': 300}

    def status(self, ticket):
        if not isinstance(ticket, str) or not 20 <= len(ticket) <= 100:
            raise SendValidationError('送信確認の情報がありません。')
        return self.receipt(ticket) or {'status': 'not_attempted', 'pending_message_id': None}

    def send(self, token, ticket):
        if not isinstance(ticket, str) or not 20 <= len(ticket) <= 100:
            raise SendValidationError('先に宛先と本文の確認画面を開いてください。')
        with self.lock:
            previous = self.receipt(ticket)
            if previous:
                return previous  # A retry checks the journal; it never repeats the Beeper POST.
            approved = self.tickets.get(ticket)
            if not approved or approved['expires'] <= time.monotonic():
                raise SendValidationError('送信確認が期限切れです。本文と宛先を確認し直してください。')
            cid = approved['chat_id']
            current = self.chat(token, cid, approved['chat_type'])
            if current != {k: approved[k] for k in ('chat_id','title','account_id')}:
                raise SendValidationError('宛先または送信元が変更されています。確認し直してください。')
            if conversation_version(reader.message_page(token, cid)) != approved['version']:
                raise SendValidationError('会話が更新されています。読み込み直してから送信を確認してください。')
            # Commit an irreversible attempt marker BEFORE touching the network. A crash after
            # this point is uncertain, never an invitation to repeat the POST.
            with closing(self.database()) as db:
                cursor = db.execute('insert or ignore into attempts(ticket,status,created) values (?, ?, ?)', (ticket,'unknown',time.time()))
                if cursor.rowcount != 1:
                    return self.receipt(ticket)
            try:
                response = reader.http_json(reader.BEEPER_URL + '/v1/chats/' + quote(cid, safe='') + '/messages',
                                            token=token, method='POST', data={'text': approved['text']}, timeout=30)
                pending = response.get('pendingMessageID')
                if response.get('chatID') != cid or not isinstance(pending, str) or not pending:
                    return {'status': 'unknown', 'pending_message_id': None}
                with closing(self.database()) as db:
                    db.execute('begin immediate')
                    try:
                        db.execute('update attempts set status=?,pending_id=? where ticket=?', ('accepted',pending,ticket))
                        db.execute('insert into accepted_targets values(?,?,?,?)',
                                   (ticket,current['account_id'],cid,time.time()))
                        db.commit()
                    except Exception:
                        db.rollback()
                        raise
                self.tickets.pop(ticket, None)
                return {'status': 'accepted', 'pending_message_id': pending}
            except Exception:
                # Keep the durable unknown marker even on HTTP errors; never risk duplicate delivery.
                return {'status': 'unknown', 'pending_message_id': None}
