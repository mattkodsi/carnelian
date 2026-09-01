-- Baker MPS-RE credit overflow: buckets are MINIMUMS, so credits earned in a bucket beyond its
-- `need` spill into Free Electives toward the 62-credit total (nothing is wasted). Verified against
-- Cornell's official MPS-RE catalog: the CST requirement is 1.5 cr but its named satisfier
-- REAL 5950 "Construction Planning and Operations" is a 3-cr course, and the catalog still totals 62
-- and prints Free Electives as "10.5 or fewer" — i.e. the extra 1.5 counts as a free elective.
--
-- The client engine (cappedCredits/overflowInto in index.html) already supported per-course caps
-- overflowing to a target; it now also caps a bucket's absorbed credits at its own `need` and spills
-- the excess to `spec.overflowTo`. This migration turns that on for the buckets that behave that way.
-- (baker-core already had overflowTo=baker-free for the repeatable REAL 5370 seminar cap.)
update carnelian.requirements
set spec = jsonb_set(spec, '{overflowTo}', '"baker-free"')
where id in ('baker-cst', 'baker-lead', 'baker-conc')
  and spec->'need'->>'type' = 'credits';
