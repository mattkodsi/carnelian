-- Web Push subscriptions for assignment-change notifications.
-- One row per browser/device push endpoint. Written by the main function's
-- push_subscribe action; read by carnelian-canvas when a sync detects changes.
-- RLS on with no policies: only the edge functions' service connection reaches it
-- (the anon key can't), matching the rest of the carnelian schema's trust model.
--
-- VAPID keys are NOT stored here or anywhere in the repo — the private key lives
-- in carnelian.app_config.settings->'push' (set out-of-band via SQL), and the
-- public key is embedded in index.html (public by design).
create table if not exists carnelian.push_subscriptions (
  id         bigint generated always as identity primary key,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count int not null default 0
);
alter table carnelian.push_subscriptions enable row level security;
