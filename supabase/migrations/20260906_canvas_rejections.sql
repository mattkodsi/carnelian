-- Preserve feed UIDs removed by rejection or deletion, including older clients.
-- Apply before deploying the updated Canvas function. No data is deleted.
begin;
create table if not exists carnelian.canvas_rejections (
  ext_uid text primary key,
  rejected_at timestamptz not null default now()
);
alter table carnelian.canvas_rejections enable row level security;
revoke all on carnelian.canvas_rejections from public, anon, authenticated;

create or replace function carnelian.remember_canvas_rejection()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if old.source = 'canvas' and old.ext_uid is not null then
    perform pg_advisory_xact_lock(hashtextextended(old.ext_uid, 60906));
    insert into carnelian.canvas_rejections (ext_uid) values (old.ext_uid)
    on conflict (ext_uid) do nothing;
  end if;
  return old;
end;
$$;
revoke all on function carnelian.remember_canvas_rejection() from public;
drop trigger if exists remember_canvas_rejection on carnelian.assignments;
create trigger remember_canvas_rejection before delete on carnelian.assignments
for each row execute function carnelian.remember_canvas_rejection();

-- Also protect against an old importer or a sync already holding a stale snapshot.
create or replace function carnelian.skip_rejected_canvas_assignment()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if new.source = 'canvas' and new.ext_uid is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.ext_uid, 60906));
  end if;
  if new.source = 'canvas' and exists (
    select 1 from carnelian.canvas_rejections where ext_uid = new.ext_uid
  ) then return null; end if;
  return new;
end;
$$;
revoke all on function carnelian.skip_rejected_canvas_assignment() from public;
drop trigger if exists skip_rejected_canvas_assignment on carnelian.assignments;
create trigger skip_rejected_canvas_assignment before insert or update of ext_uid on carnelian.assignments
for each row execute function carnelian.skip_rejected_canvas_assignment();
commit;
