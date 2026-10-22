-- A course's own cancelled classes, on top of the registrar's breaks:
-- [{"date": "2026-11-05", "reason": "CREC conference"}, ...]. The app, the Google sync,
-- and the TV feed leave those sessions out and show a notice in their place.
alter table carnelian.enrollments add column if not exists no_class jsonb not null default '[]'::jsonb;
