-- Canvas .ics deadline sync.
-- ext_uid = the Canvas VEVENT UID, so re-syncs update in place instead of
-- duplicating. Written only by the server sync (kept out of the client COLS
-- allow-list). Partial unique index so many rows may have a null ext_uid
-- (manual/PDF-sourced items) while feed-owned ones stay unique.
alter table carnelian.assignments
  add column if not exists ext_uid text;
create unique index if not exists assignments_ext_uid_uidx
  on carnelian.assignments (ext_uid) where ext_uid is not null;

-- Locked config for the Canvas feed (mirrors gcal_config). feed_url is a bearer
-- secret and lives only here, server-side.
create table if not exists carnelian.canvas_config (
  id            int primary key default 1,
  feed_url      text,
  cron_secret   text,   -- shared secret for the nightly pg_cron → edge-function call (DB-only)
  last_sync_at  timestamptz,
  last_result   jsonb,
  updated_at    timestamptz default now()
);
alter table carnelian.canvas_config add column if not exists cron_secret text;
insert into carnelian.canvas_config (id) values (1) on conflict (id) do nothing;
-- Generate the cron secret once (stays server-side; never committed or logged).
update carnelian.canvas_config
  set cron_secret = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
  where id = 1 and cron_secret is null;
