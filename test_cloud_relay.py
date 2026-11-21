import json
import unittest
from unittest.mock import Mock, patch

from cloud_relay import CloudRelay, CloudError


class CloudRelayTest(unittest.TestCase):
    def setUp(self):
        self.relay = CloudRelay()
        self.relay.dispatch = Mock(return_value={'chats': []})

    def test_only_selected_read_actions_are_dispatched(self):
        for action, payload in [('chats', {}), ('conversation', {'chat_id': 'listed'}), ('suggest', {'chat_id': 'listed', 'message_id': 'latest'})]:
            self.assertEqual(self.relay.execute_job({'action': action, 'payload': payload}), {'chats': []})
        for action in ['send', 'read', 'draft', '../send', '/api/chats']:
            with self.assertRaises(CloudError):
                self.relay.execute_job({'action': action, 'payload': {}})
        self.assertEqual(self.relay.dispatch.call_count, 3)

    def test_remote_payload_cannot_supply_credentials_or_urls(self):
        for payload in [{'token': 'injected'}, {'url': 'http://evil.example'}, {'chat_id': 'x', 'headers': {}}]:
            with self.assertRaises(CloudError):
                self.relay.execute_job({'action': 'conversation', 'payload': payload})
        self.relay.dispatch.assert_not_called()

    def test_disconnect_blocks_publication_and_dispatch(self):
        self.relay.stop_event.set()
        with self.assertRaises(CloudError):
            self.relay.execute_job({'action': 'chats', 'payload': {}})
        self.relay.dispatch.assert_not_called()

    def test_session_is_keychain_only_and_anonymous_is_rejected(self):
        self.relay.credentials = {'device_id': 'fictional-device'}
        session = {'user': {'id': 'fictional-owner', 'email': 'example@example.invalid'}, 'access_token': 'access', 'refresh_token': 'refresh'}
        with patch('cloud_relay.save_token') as save:
            self.relay.set_session(session)
            stored = json.loads(save.call_args.args[0])
            self.assertEqual(stored['refresh_token'], 'refresh')
            self.assertNotIn('access_token', stored)
            self.assertNotIn('password', stored)
            self.assertNotIn('beeper', stored)
        with self.assertRaises(CloudError):
            self.relay.set_session({**session, 'user': {'id': 'anonymous', 'is_anonymous': True}})

    def test_local_enrollment_creates_separate_auth_session(self):
        with patch.object(self.relay, 'http', return_value={'user': {'id': 'owner'}, 'access_token': 'a', 'refresh_token': 'r'}) as http, patch('cloud_relay.save_token'), patch.object(self.relay, 'start'):
            result = self.relay.enroll('test@example.invalid', 'fictional-password')
            self.assertNotIn('refresh_token', result)
            self.assertNotIn('access_token', result)
            self.assertEqual(http.call_args.args[0], '/auth/v1/token?grant_type=password')
            self.assertFalse(http.call_args.kwargs['auth'])

    def test_attio_persistence_uses_owner_record_key_and_display_allowlist(self):
        self.relay.credentials={'user_id':'owner'}
        record={'id':'11111111-1111-4111-8111-111111111111','name':'Test company','detail':'example.invalid','token':'never store','description':'private'}
        result={'profile':{'workspace_id':'22222222-2222-4222-8222-222222222222'},'records':[record]}
        with patch.object(self.relay,'access_token',return_value='secret'),patch.object(self.relay,'http') as http:
            for _ in range(2):self.assertTrue(self.relay.store_attio(result,'companies')['saved'])
            rows=http.call_args.args[1]
            self.assertEqual(rows[0]['user_id'],'owner')
            self.assertEqual(rows[0]['record_id'],record['id'])
            self.assertEqual(rows[0]['data'],{'name':'Test company','detail':'example.invalid'})
            self.assertIn('on_conflict=user_id,workspace_id,object_type,record_id',http.call_args.args[0])
            self.assertNotIn('secret',str(rows))
            http.side_effect=CloudError('offline')
            self.assertFalse(self.relay.store_attio(result,'companies')['saved'])

    def test_attio_persistence_without_login_does_not_claim_success(self):
        with patch.object(self.relay,'http') as http:
            self.assertFalse(self.relay.store_attio({},'companies')['saved'])
            http.assert_not_called()

if __name__ == '__main__':
    unittest.main()
