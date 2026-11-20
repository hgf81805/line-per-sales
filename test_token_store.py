import io
import os
import unittest
from unittest.mock import patch
import token_store


class TokenStoreTest(unittest.TestCase):
    @patch.dict(os.environ, {'BEEPER_ACCESS_TOKEN': 'env-value'})
    def test_environment_is_not_persisted(self):
        with patch.object(token_store, 'load_token') as load, patch.object(token_store, 'save_token') as save:
            self.assertEqual(token_store.get_token(), 'env-value')
            load.assert_not_called()
            save.assert_not_called()

    @patch.dict(os.environ, {}, clear=True)
    def test_saved_token_never_prompts(self):
        with patch.object(token_store, 'load_token', return_value='saved-value'), patch('getpass.getpass') as prompt, patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(token_store.get_token(), 'saved-value')
            prompt.assert_not_called()
            self.assertNotIn('saved-value', output.getvalue())

    @patch.dict(os.environ, {}, clear=True)
    def test_locked_keychain_is_not_overwritten(self):
        with patch.object(token_store, 'load_token', side_effect=token_store.KeychainError('locked')), patch('getpass.getpass') as prompt, patch.object(token_store, 'save_token') as save:
            with self.assertRaises(token_store.KeychainError):
                token_store.get_token()
            prompt.assert_not_called()
            save.assert_not_called()

    @patch.dict(os.environ, {}, clear=True)
    def test_replacement_is_saved_without_logging_secret(self):
        with patch('getpass.getpass', return_value='new-secret'), patch.object(token_store, 'save_token') as save, patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(token_store.get_token(replace=True), 'new-secret')
            save.assert_called_once_with('new-secret')
            self.assertNotIn('new-secret', output.getvalue())

if __name__ == '__main__':
    unittest.main()
