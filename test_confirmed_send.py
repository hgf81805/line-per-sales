import concurrent.futures
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import beeper_reader as reader
from confirmed_send import ConfirmedSender, conversation_version


class SendTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)/'journal.sqlite3'
        self.sender = ConfirmedSender(self.path)
        self.chat = {'id':'c0', 'type':'single', 'network':'LINE', 'accountID':'line-1', 'title':'架空の相手'}
        self.page = {'items':[{'id':'m1', 'text':'架空の質問', 'isSender':False, 'timestamp':'2026-11-20T00:00:00Z'}]}
        self.posts = []
        self.failure = False
        self.mock = patch.object(reader, 'http_json', side_effect=self.upstream)
        self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.temp.cleanup()

    def upstream(self, url, token=None, method='GET', data=None, **kwargs):
        self.assertEqual(token, 'fictional-token')
        if method == 'POST':
            self.assertTrue(url.endswith('/chats/c0/messages'))
            self.posts.append(data)
            if self.failure:
                raise RuntimeError('通信が途切れました')
            return {'chatID':'c0', 'pendingMessageID':'pending-1'}
        if url.endswith('/messages'):
            return self.page
        return self.chat

    def prepare(self):
        return self.sender.prepare('fictional-token','c0','架空の返信です',conversation_version(self.page))

    def test_prepare_returns_exact_review_without_sending(self):
        review = self.prepare()
        self.assertEqual(review['text'], '架空の返信です')
        self.assertEqual(review['title'], '架空の相手')
        self.assertEqual(review['account_id'], 'line-1')
        self.assertEqual(self.posts, [])

    def test_send_once_and_survives_restart_without_body_on_disk(self):
        review = self.prepare()
        first = self.sender.send('fictional-token', review['ticket_id'])
        self.assertEqual(first['status'], 'accepted')
        self.assertEqual(ConfirmedSender(self.path).send('fictional-token', review['ticket_id']), first)
        self.assertEqual(self.posts,[{'text':'架空の返信です'}])
        raw = self.path.read_bytes()
        self.assertNotIn('架空の返信です'.encode(),raw)
        self.assertNotIn(b'fictional-token',raw)

    def test_double_click_is_one_post(self):
        ticket = self.prepare()['ticket_id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.sender.send('fictional-token',ticket), range(2)))
        self.assertEqual(len(self.posts),1)
        self.assertEqual(results[0],results[1])

    def test_unknown_result_is_never_resent_after_restart(self):
        ticket = self.prepare()['ticket_id']
        self.failure=True
        self.assertEqual(self.sender.send('fictional-token',ticket)['status'],'unknown')
        self.failure=False
        self.assertEqual(ConfirmedSender(self.path).send('fictional-token',ticket)['status'],'unknown')
        self.assertEqual(len(self.posts),1)

    def test_status_query_never_sends_unattempted_ticket(self):
        ticket = self.prepare()['ticket_id']
        self.assertEqual(self.sender.status(ticket)['status'],'not_attempted')
        self.assertEqual(self.posts,[])

    def test_new_message_or_changed_account_requires_reapproval(self):
        for change in ['message','account']:
            ticket = self.prepare()['ticket_id']
            if change=='message':
                self.page['items'][0]['text']='変更済み'
            else:
                self.chat['accountID']='line-2'
            with self.assertRaises(ValueError):self.sender.send('fictional-token',ticket)
        self.assertEqual(self.posts,[])

    def test_group_and_non_line_chats_are_rejected(self):
        self.chat['type']='group'
        with self.assertRaises(ValueError):self.prepare()
        self.chat['type']='single'; self.chat['network']='WhatsApp'
        with self.assertRaises(ValueError):self.prepare()
        self.assertEqual(self.posts,[])

    def test_expired_or_missing_confirmation_cannot_send(self):
        ticket = self.prepare()['ticket_id']
        self.sender.tickets[ticket]['expires']=0
        with self.assertRaises(ValueError):self.sender.send('fictional-token',ticket)
        with self.assertRaises(ValueError):self.sender.send('fictional-token','unapproved-ticket-that-is-long-enough')
        self.assertEqual(self.posts,[])

    def test_disk_failure_prevents_network_send(self):
        ticket=self.prepare()['ticket_id']
        with patch.object(self.sender,'database',side_effect=OSError('disk failed')):
            with self.assertRaises(OSError):self.sender.send('fictional-token',ticket)
        self.assertEqual(self.posts,[])

if __name__ == '__main__':unittest.main()
