-- Matt's extra time on exams and quizzes. app_config.settings.extra_time holds the factor
-- (e.g. 1.5) that stretches each item's standard length in the app, the Google sync, and
-- the TV feed. An item whose time is already his own slot opts out with extra_time = false.
alter table carnelian.assignments add column if not exists extra_time boolean;
