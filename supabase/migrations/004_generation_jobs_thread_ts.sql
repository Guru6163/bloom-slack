alter table generation_jobs
  add column if not exists thread_ts text;
