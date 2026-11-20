import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock,patch
from uuid import uuid4

from attio_bridge import AttioBridge,AttioError

WORK='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
DEAL='11111111-1111-4111-8111-111111111111'
OWNER='22222222-2222-4222-8222-222222222222'
LEAD='33333333-3333-4333-8333-333333333333'
ACTIVE='44444444-4444-4444-8444-444444444444'
TASK='55555555-5555-4555-8555-555555555555'

class AttioTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'links.sqlite'
        self.bridge=AttioBridge(self.path);self.bridge.profile={'workspace_id':WORK,'workspace_name':'Test Attio'}
        self.writes=[];self.current_stage=LEAD;self.open_tasks=[]
        self.bridge.http=Mock(side_effect=self.api)

    def tearDown(self):self.tmp.cleanup()

    def record(self):
        return {'id':{'record_id':DEAL},'web_url':'https://app.attio.com/test/deals/'+DEAL,'values':{
            'name':[{'value':'架空の案件'}],
            'stage':[{'status':{'id':{'status_id':self.current_stage},'title':'Lead'},'active_from':'2026-11-20T00:00:00Z'}],
            'owner':[{'referenced_actor_id':OWNER}]}}

    def api(self,path,body=None,method='GET',**kwargs):
        if path=='/v2/self':return {'active':True,'workspace_id':WORK,'workspace_name':'Test Attio'}
        if path.endswith('/statuses'):return {'data':[{'id':{'status_id':LEAD},'title':'Lead'},{'id':{'status_id':ACTIVE},'title':'In Progress'}]}
        if path=='/v2/workspace_members':return {'data':[{'id':{'workspace_member_id':OWNER},'first_name':'Test','last_name':'Owner'}]}
        if path.endswith('/query'):return {'data':[self.record()]}
        if path.startswith('/v2/tasks?'):return {'data':self.open_tasks}
        if method in ('POST','PUT','PATCH'):
            self.writes.append((path,body,method))
            return {'data':{'id':{'task_id':TASK}}} if '/tasks' in path else {'data':self.record()}
        return {'data':self.record()}

    def command(self,**fields):return {'operation_id':str(uuid4()),'confirmed':True,**fields}

    def test_list_and_link_are_read_only_in_attio(self):
        result=self.bridge.page();self.assertEqual(result['deals'][0]['stage_id'],LEAD)
        self.assertEqual(result['members'][0]['id'],OWNER)
        self.bridge.link('line-account','chat',DEAL)
        self.assertEqual(self.bridge.linked('line-account','chat')['deal']['id'],DEAL)
        self.assertIsNone(self.bridge.linked('other-account','chat')['deal'])
        self.bridge.unlink('line-account','chat')
        self.assertIsNone(self.bridge.linked('line-account','chat')['deal'])
        self.assertEqual(self.writes,[])

    def test_no_mutation_without_confirmation(self):
        with self.assertRaises(AttioError):self.bridge.mutate('stage',{'deal_id':DEAL,'stage_id':ACTIVE})
        self.assertEqual(self.writes,[])

    def test_directory_returns_only_display_fields_and_validates_source(self):
        company={'id':{'record_id':DEAL},'web_url':'https://app.attio.com/test/company','values':{
            'name':[{'value':'Test company'}],'domains':[{'domain':'example.invalid'}],
            'description':[{'value':'Do not transfer this field'}]}}
        self.bridge.http=Mock(return_value={'data':[company]})
        result=self.bridge.page(50,'companies')
        self.assertEqual(result['source'],'companies')
        self.assertEqual(result['records'][0]['detail'],'example.invalid')
        self.assertNotIn('description',str(result))
        self.assertEqual(self.bridge.http.call_args.args[0],'/v2/objects/companies/records/query')
        self.assertEqual(self.bridge.http.call_args.args[1]['offset'],50)
        person={'id':{'record_id':DEAL},'values':{'name':[{'full_name':'Test person'}],
            'email_addresses':[{'email_address':'test@example.invalid'}],'job_title':[{'value':'Sales'}]}}
        self.bridge.http.return_value={'data':[person]}
        result=self.bridge.page(source='people')
        self.assertEqual(result['records'][0]['name'],'Test person')
        self.assertEqual(result['records'][0]['job_title'],'Sales')
        self.bridge.http.reset_mock()
        with self.assertRaises(AttioError):self.bridge.page(source='../tasks')
        self.bridge.http.assert_not_called()

    def test_stage_changes_only_stage_and_checks_current_value(self):
        data=self.command(deal_id=DEAL,stage_id=ACTIVE,expected_stage_id=LEAD)
        self.bridge.mutate('stage',data)
        self.assertEqual(self.writes[0][1],{'data':{'values':{'stage':[{'status':ACTIVE}]}}})
        self.current_stage=ACTIVE
        with self.assertRaises(AttioError):self.bridge.mutate('stage',self.command(deal_id=DEAL,stage_id=LEAD,expected_stage_id=LEAD))
        self.assertEqual(len(self.writes),1)

    def test_create_replay_after_restart_is_not_duplicated(self):
        data=self.command(name='架空の新案件',owner_id=OWNER,stage_id=LEAD)
        first=self.bridge.mutate('create',data)
        restored=AttioBridge(self.path);restored.profile=self.bridge.profile;restored.http=self.bridge.http
        self.assertEqual(restored.mutate('create',data),first)
        self.assertEqual(len(self.writes),1)
        self.assertNotIn('架空の新案件'.encode(),self.path.read_bytes())

    def test_unknown_write_is_not_replayed(self):
        data=self.command(name='架空の新案件',owner_id=OWNER,stage_id=LEAD)
        original=self.bridge.http.side_effect
        def fail(path,body=None,method='GET',**kwargs):
            if path=='/v2/objects/deals/records':raise AttioError('timeout')
            return original(path,body,method,**kwargs)
        self.bridge.http.side_effect=fail
        with self.assertRaises(AttioError):self.bridge.mutate('create',data)
        self.bridge.http.side_effect=original
        with self.assertRaises(AttioError):self.bridge.mutate('create',data)
        self.assertEqual(self.writes,[])

    def test_next_action_is_linked_and_uses_explicit_owner(self):
        self.bridge.mutate('task',self.command(deal_id=DEAL,owner_id=OWNER,content='架空の連絡',deadline='2026-12-01T00:00:00Z'))
        body=self.writes[0][1]['data']
        self.assertEqual(body['linked_records'],[{'target_object':'deals','target_record_id':DEAL}])
        self.assertEqual(body['assignees'][0]['referenced_actor_id'],OWNER)
        self.open_tasks=[{'id':{'task_id':TASK},'content_plaintext':'existing','assignees':[{'referenced_actor_id':OWNER}]}]
        with self.assertRaises(AttioError):self.bridge.mutate('task',self.command(deal_id=DEAL,owner_id=OWNER,content='duplicate',deadline=None))
        self.assertEqual(len(self.writes),1)

    def test_invalid_ids_and_unrelated_tasks_cannot_be_updated(self):
        with self.assertRaises(AttioError):self.bridge.deal('../../people')
        with self.assertRaises(AttioError):self.bridge.mutate('complete',self.command(deal_id=DEAL,task_id=TASK))
        self.assertEqual(self.writes,[])

    def test_token_is_saved_only_to_keychain(self):
        with patch('attio_bridge.save_token') as save:
            result=self.bridge.connect('fictional-api-secret')
            save.assert_called_once()
            self.assertNotIn('fictional-api-secret',str(result))
        self.assertEqual(self.writes,[])

if __name__=='__main__':unittest.main()
