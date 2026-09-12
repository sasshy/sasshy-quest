#!/usr/bin/env python3
"""Synthetic tests only. Reuses P1's fresh socket-only PostgreSQL runner; no remote DB option."""
from pathlib import Path
import importlib.util
import hashlib
import json
import pg8000.native

HERE=Path(__file__).resolve().parent
WEB=HERE.parents[2]
spec=importlib.util.spec_from_file_location('p1',HERE.parent/'p1/test_legacy_access.py')
p1=importlib.util.module_from_spec(spec); spec.loader.exec_module(p1)
OLD='synthetic-original-key-1234'
NEW='synthetic-new-random-key-5678'
OTHER='synthetic-unrelated-key-7890'
def sha(s): return hashlib.sha256(s.encode()).hexdigest()
MIGRATION=next((WEB/'supabase/migrations').glob('*_separate_workspace_credentials.sql')).read_text()

class Credentials(p1.LegacyAccess):
    # Inherit only fixtures/helpers and runner, not P1 test cases.
    def setUp(self):
        super().setUp()
        self.db.run((HERE/'live-functions.sql').read_text())
        self.db.run('revoke all on function public.sasshy_v2_ingest_voice_task(text,text,text,jsonb) from public,anon,authenticated; grant execute on function public.sasshy_v2_ingest_voice_task(text,text,text,jsonb) to service_role')
        for key,id in [(OLD,'task-a'),(OTHER,'task-b')]:
            payload={'id':id,'title':'Synthetic','notes':'Keep','status':'planned','scheduledDate':'2026-09-12','startMinute':600,'durationMin':25,'scheduleVersionId':'version-a','deletedAt':None,'sync':{'deviceId':'synthetic'},'extra':{'preserve':True}}
            self.db.run('insert into public.sasshy_v2_records(workspace_hash,record_type,id,payload) values(:hash,\'task\',:id,cast(:payload as jsonb))',hash=sha(key),id=id,payload=json.dumps(payload))
        self.before=self.business()
        self.db.run((WEB/'supabase/operations/p3-deploy.sql').read_text())

    def business(self):
        tables=['records','history','ingest_requests','schedule_history','push_subscriptions','push_deliveries']
        return [self.db.run(f'select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),\'[]\'::jsonb) from public.sasshy_v2_{t} t')[0][0] for t in tables]

    def stage(self):
        self.db.run('select sasshy_private.stage_credential(:w,:h)',w=sha(OLD),h=sha(NEW))
    def cutover(self):
        self.stage()
        self.db.run('select sasshy_private.disable_legacy_credential(:w,:h)',w=sha(OLD),h=sha(NEW))
    def denied_auth(self,role,sql):
        with self.assertRaises(pg8000.exceptions.DatabaseError) as error: self.role(role,sql)
        self.assertEqual(error.exception.args[0]['C'],'28000')

    def test_mapping_keeps_workspace_rows_and_legacy_until_cutover(self):
        self.stage()
        for role in ['anon','authenticated','service_role']:
            for key in [OLD,NEW]:
                self.assertEqual(self.role(role,f"select id from public.sasshy_v2_pull('{key}')"),[['task-a']])
        self.assertEqual(self.business(),self.before)
        self.db.run(MIGRATION)
        self.assertEqual(self.business(),self.before)

    def test_revoked_legacy_rejected_by_every_record_rpc(self):
        self.cutover()
        calls=[f"sasshy_v2_pull('{OLD}')",f"sasshy_v2_push('{OLD}','task','task-a','{{}}',false)",f"sasshy_v2_connection_info('{OLD}')"]
        for role in ['anon','authenticated','service_role']:
            for call in calls: self.denied_auth(role,'select * from public.'+call)
        calls=[f"sasshy_v2_resolve_workspace('{OLD}')",f"sasshy_v2_resolve_voice_workspace('{sha(OLD)}')",f"sasshy_v2_action_search_tasks('{OLD}','',null,null,'',false,20)",f"sasshy_v2_action_mutate_task('{OLD}','task-a',now(),'complete','{{}}')",f"sasshy_v2_ingest_task('{OLD}','synthetic-request','Synthetic','')",f"sasshy_v2_ingest_voice_task('{OLD}','synthetic-request','Synthetic',null)",f"sasshy_v2_apply_schedule_change('{OLD}','op-a','task-a',null,'{{}}',false,'{{}}')"]
        for call in calls: self.denied_auth('service_role','select * from public.'+call)
        self.assertEqual(self.business(),self.before)

    def test_new_credential_reads_writes_and_other_workspace_stays_separate(self):
        self.cutover()
        for role in ['anon','authenticated','service_role']:
            self.assertEqual(self.role(role,f"select id from public.sasshy_v2_pull('{NEW}')"),[['task-a']])
            self.assertEqual(self.role(role,f"select id from public.sasshy_v2_pull('{OTHER}')"),[['task-b']])
            self.assertEqual(self.role(role,f"select workspace_hash from public.sasshy_v2_push('{NEW}','task','task-a','{{\"id\":\"task-a\",\"title\":\"Edited\"}}',false)"),[[sha(OLD)]])
        self.assertEqual(self.role('service_role',f"select public.sasshy_v2_resolve_voice_workspace('{sha(NEW)}')"),[[sha(OLD)]])
        with self.assertRaises(pg8000.exceptions.DatabaseError):
            self.role('service_role',f"select public.sasshy_v2_action_mutate_task('{OTHER}','task-a',now(),'complete','{{}}')")

    def test_invalid_values_fail_closed(self):
        for value in ['NULL',"''","'short'","repeat('x',301)"]:
            self.denied_auth('service_role',f'select public.sasshy_v2_resolve_workspace({value})')

    def test_private_registry_and_admin_rpcs_not_client_accessible(self):
        for role in ['anon','authenticated','service_role']:
            self.denied(role,'select * from sasshy_private.workspace_credentials')
            self.denied(role,f"select sasshy_private.stage_credential('{sha(OLD)}','{sha(NEW)}')")
            self.denied(role,f"select sasshy_private.disable_legacy_credential('{sha(OLD)}','{sha(NEW)}')")
        for role in ['anon','authenticated']:
            self.denied(role,f"select public.sasshy_v2_resolve_voice_workspace('{sha(NEW)}')")

    def test_revoked_mapping_never_falls_back_or_revives(self):
        self.cutover()
        self.db.run('select sasshy_private.revoke_credential(:h)',h=sha(NEW))
        self.denied_auth('anon',f"select * from public.sasshy_v2_pull('{NEW}')")
        with self.assertRaises(pg8000.exceptions.DatabaseError): self.stage()

    def test_reassignment_and_workspace_collision_rejected(self):
        self.stage()
        with self.assertRaises(pg8000.exceptions.DatabaseError):
            self.db.run('select sasshy_private.stage_credential(:w,:h)',w=sha(OTHER),h=sha(NEW))
        with self.assertRaises(pg8000.exceptions.DatabaseError):
            self.db.run('select sasshy_private.stage_credential(:w,:h)',w=sha(OLD),h=sha(OTHER))

    def test_voice_receipt_survives_rotation(self):
        args="'synthetic-voice-request','Synthetic voice','{\"title\":\"Voice synthetic\",\"notes\":\"Keep\"}'"
        before=self.db.run(f"select public.sasshy_v2_ingest_voice_task('{OLD}',{args})")[0][0]
        self.cutover()
        after=self.role('service_role',f"select public.sasshy_v2_ingest_voice_task('{NEW}',{args})")[0][0]
        self.assertEqual(before['task']['id'],after['task']['id'])
        self.assertTrue(after['duplicate'])

# unittest discovers inherited methods; hide unrelated P1 cases without changing its runner.
for name in dir(p1.LegacyAccess):
    if name.startswith('test_'): setattr(Credentials,name,None)
p1.LegacyAccess=Credentials
if __name__=='__main__': raise SystemExit(p1.main())
