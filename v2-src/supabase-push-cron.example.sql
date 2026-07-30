-- SASSHY v2.3 Web Push dispatcher.
-- The production job is already installed. Keep this template for disaster recovery.
-- Replace REPLACE_WITH_CRON_SECRET before running.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(
  'REPLACE_WITH_CRON_SECRET',
  'sasshy_push_cron_secret',
  'SASSHY Web Push dispatcher authentication'
);

select cron.schedule(
  'sasshy-push-dispatch',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://zoxahzhxqbgswzyduiuq.supabase.co/functions/v1/sasshy-push/dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'sasshy_push_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) as request_id;
  $job$
);
