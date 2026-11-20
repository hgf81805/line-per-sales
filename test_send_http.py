import json
import re
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request,urlopen

import personal
from confirmed_send import ConfirmedSender

class SendHttpTest(unittest.TestCase):
    def test_conversation_review_confirm_and_replay(self):
        sends=[]
        def upstream(url, token=None, method='GET', data=None, **kwargs):
            if method=='POST':
                sends.append((url,data));return {'chatID':'c0','pendingMessageID':'p0'}
            if '/search?' in url:
                return {'items':[{'id':'c0','title':'架空の相手','network':'LINE','type':'single'}]}
            if url.endswith('/messages'):
                return {'items':[{'id':'m0','text':'架空の会話','isSender':False,'timestamp':'2026-11-20T00:00:00Z'}]}
            return {'id':'c0','title':'架空の相手','network':'LINE','type':'single','accountID':'fictional-line'}
        with tempfile.TemporaryDirectory() as directory, patch.object(personal.reader,'http_json',side_effect=upstream):
            sender=ConfirmedSender(Path(directory)/'ledger.sqlite')
            with ThreadingHTTPServer(('127.0.0.1',0),personal.make_handler('fictional',1,sender=sender)) as server:
                server.RequestHandlerClass=personal.make_handler('fictional',server.server_port,sender=sender)
                threading.Thread(target=server.serve_forever,daemon=True).start()
                base=f'http://127.0.0.1:{server.server_port}'
                with urlopen(base) as response: csrf=re.search("csrf='([^']+)'",response.read().decode())[1]
                def api(action,payload):
                    request=Request(base+'/api/'+action,data=json.dumps(payload).encode(),method='POST',headers={'Content-Type':'application/json','Origin':base,'X-CSRF-Token':csrf})
                    with urlopen(request) as response:return json.loads(response.read())
                api('chats',{})
                history=api('conversation',{'chat_id':'c0'})
                self.assertEqual(sends,[])
                review=api('prepare-send',{'chat_id':'c0','text':'架空の返信です','conversation_version':history['conversation_version']})
                self.assertEqual(review['title'],'架空の相手')
                self.assertEqual(sends,[])
                self.assertEqual(api('send-status',{'ticket_id':review['ticket_id']})['status'],'not_attempted')
                receipt=api('send',{'ticket_id':review['ticket_id']})
                self.assertEqual(receipt['status'],'accepted')
                self.assertEqual(api('send',{'ticket_id':review['ticket_id']}),receipt)
                self.assertEqual(len(sends),1)
                self.assertEqual(sends[0][1],{'text':'架空の返信です'})
                server.shutdown()

if __name__=='__main__':unittest.main()
