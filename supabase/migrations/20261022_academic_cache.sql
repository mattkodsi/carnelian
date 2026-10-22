-- Last good parse of the registrar's academic calendar, shared by the wall feed
-- (and anything else that needs breaks or 7-week dates) so requests don't scrape
-- the registrar every time. One row; refreshed at most daily.
begin;
create table if not exists carnelian.academic_cache (
  id integer primary key default 1 check (id = 1),
  events jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table carnelian.academic_cache enable row level security;
revoke all on carnelian.academic_cache from public, anon, authenticated;
commit;
