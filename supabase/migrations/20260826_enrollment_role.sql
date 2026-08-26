-- Course "role": normal coursework (null/'course'), a paid TA position (no credit/GPA/transcript),
-- a for-credit TA/teaching-experience course, or an audit (transcript with grade V, no credit/GPA).
alter table carnelian.enrollments
  add column if not exists role text;
alter table carnelian.enrollments
  drop constraint if exists enrollments_role_chk,
  add constraint enrollments_role_chk check (role is null or role in ('course','ta_paid','ta_credit','audit'));
