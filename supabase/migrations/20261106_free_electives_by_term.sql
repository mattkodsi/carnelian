-- Free Electives now lists its courses and spillover together under term headings, like Core and Concentration.
update carnelian.requirements
set spec = jsonb_set(spec, '{groupByTerm}', 'true'::jsonb)
where id = 'baker-free';

-- REAL 6595 (Collegetown Initiative Research) and REAL 6901 (Real Estate Review) are 5000-level-or-above electives
-- that no Baker requirement picked up, so they were missing from Free Electives and the 62-credit total.
insert into carnelian.satisfactions (enrollment_id, requirement_id)
select e.id, 'baker-free'
from carnelian.enrollments e
where e.term_id = 'by1fa' and e.code in ('REAL 6595', 'REAL 6901')
on conflict (enrollment_id, requirement_id) do nothing;
