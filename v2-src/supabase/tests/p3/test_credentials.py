#!/usr/bin/env python3
"""Synthetic tests only. Creates a fresh socket-only PostgreSQL cluster; no remote DB option."""
from pathlib import Path
import argparse
import os
import subprocess
import tempfile
import unittest
import hashlib
import json
import pg8000.native

HERE=Path(__file__).resolve().parent
WEB=HERE.parents[2]
OLD='synthetic-original-key-1234'
NEW='synthetic-new-random-key-5678'
OTHER='synthetic-unrelated-key-7890'
def sha(s): return hashlib.sha256(s.encode()).hexdigest()
MIGRATION=next((WEB/'supabase/migrations').glob('*_separate_workspace_credentials.sql')).read_text()

class Credentials(unittest.TestCase):
    socket_path = None
    serial = 0
    def setUp(self):
        type(self).serial += 1
        self.name = f'p3_test_{self.serial}'
        admin = pg8000.native.Connection('postgres', unix_sock=self.socket_path, database='postgres')
        admin.run(f'create database {self.name}')
        admin.close()
        self.db = pg8000.native.Connection('postgres', unix_sock=self.socket_path, database=self.name)
        self.db.run((HERE/'fixture.sql').read_text())
        self.db.run((WEB/'supabase-setup.sql').read_text())
        self.db.run((WEB/'supabase-calendar-history.sql').read_text())
        self.db.run((HERE/'live-functions.sql').read_text())
        self.db.run('revoke all on function public.sasshy_v2_ingest_voice_task(text,text,text,jsonb) from public,anon,authenticated; grant execute on function public.sasshy_v2_ingest_voice_task(text,text,text,jsonb) to service_role')
        for key,id in [(OLD,'task-a'),(OTHER,'task-b')]:
            payload={'id':id,'title':'Synthetic','notes':'Keep','status':'planned','scheduledDate':'2026-09-12','startMinute':600,'durationMin':25,'scheduleVersionId':'version-a','deletedAt':None,'sync':{'deviceId':'synthetic'},'extra':{'preserve':True}}
            self.db.run('insert into public.sasshy_v2_records(workspace_hash,record_type,id,payload) values(:hash,\'task\',:id,cast(:payload as jsonb))',hash=sha(key),id=id,payload=json.dumps(payload))
        self.before=self.business()
        self.db.run((WEB/'supabase/operations/p3-deploy.sql').read_text())

    def tearDown(self):
        self.db.close()
        admin = pg8000.native.Connection('postgres', unix_sock=self.socket_path, database='postgres')
        admin.run(f'drop database {self.name}')
        admin.close()

    def role(self,name,sql):
        self.db.run('begin')
        try:
            self.db.run(f'set local role {name}')
            return self.db.run(sql)
        finally: self.db.run('rollback')

    def denied(self,role,sql):
        with self.assertRaises(pg8000.exceptions.DatabaseError) as error: self.role(role,sql)
        self.assertEqual(error.exception.args[0]['C'],'42501')

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

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', type=Path, required=True)
    args = parser.parse_args()
    bin_dir = args.pg_bin.resolve()
    env = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
    with tempfile.TemporaryDirectory(prefix='sasshy-p3-', dir='/tmp') as temporary:
        root = Path(temporary)
        data = root/'data'
        def command(name, *options):
            result = subprocess.run([str(bin_dir/name), *map(str,options)], env=env,
                                    capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError(result.stdout+result.stderr)
            return result.stdout
        print(command('postgres', '--version').strip(), flush=True)
        command('initdb', '-D', data, '-U', 'p3_test_super', '--auth=trust', '--no-locale', '--encoding=UTF8')
        started = False
        try:
            # A fresh private directory and no TCP listener. No external DB credentials used.
            command('pg_ctl','-D',data,'-l',root/'server.log','-o',
                    f"-c listen_addresses='' -c unix_socket_directories='{root}' -c unix_socket_permissions=0700",'-w','start')
            started = True
            Credentials.socket_path = str(root/'.s.PGSQL.5432')
            db = pg8000.native.Connection('p3_test_super', unix_sock=Credentials.socket_path, database='postgres')
            db.run('create role postgres login superuser; create role anon; create role authenticated; create role service_role bypassrls')
            db.close()
            result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Credentials))
            return 0 if result.wasSuccessful() else 1
        finally:
            if started:
                command('pg_ctl','-D',data,'-m','immediate','-w','stop')
            elif (root/'server.log').exists():
                print((root/'server.log').read_text())

if __name__ == '__main__':
    raise SystemExit(main())
