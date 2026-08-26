-- Repurpose the dormant (empty) carnelian.assignments table for the deadlines
-- feature: structured naming fields + scheduling + review/done state.
alter table carnelian.assignments
  add column if not exists kind           text,
  add column if not exists series         text,
  add column if not exists number         int,
  add column if not exists descriptor     text,
  add column if not exists override_title text,
  add column if not exists due_time       time,
  add column if not exists duration_min   int,
  add column if not exists status         text not null default 'active',
  add column if not exists source         text not null default 'manual',
  add column if not exists done           boolean not null default false;

-- Guard the small controlled vocabularies at the DB level.
alter table carnelian.assignments
  drop constraint if exists assignments_status_chk,
  add  constraint assignments_status_chk check (status in ('pending','active','done'));
alter table carnelian.assignments
  drop constraint if exists assignments_source_chk,
  add  constraint assignments_source_chk check (source in ('manual','canvas'));
