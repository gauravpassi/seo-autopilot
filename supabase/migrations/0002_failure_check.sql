-- Store the "how would we know this failed" check separately from expected impact,
-- so the approvals card can show it in its own section.
alter table public.changes add column if not exists failure_check text;
