-- "Counts toward": which degree a course's grade and credits count toward.
-- null = automatic (the term's career decides; a course applied to a Baker requirement
-- also counts toward Baker GPA). 'undergrad' | 'grad' | 'both' override it.
-- Separate from in_as, which only marks A&S college credit.
alter table carnelian.enrollments
  add column if not exists counts_toward text
  check (counts_toward in ('undergrad', 'grad', 'both'));

-- A&S courses taken during a Baker term previously reached the undergrad total through in_as;
-- keep them there explicitly now that in_as no longer implies undergrad.
update carnelian.enrollments e set counts_toward = 'undergrad'
from carnelian.terms t
where t.id = e.term_id and t.career = 'grad' and e.in_as and e.counts_toward is null;
