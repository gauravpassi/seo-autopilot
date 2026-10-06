-- SEO Autopilot: initial schema
-- Multi-tenant ready: every row hangs off an org. Today there is one org (Upcore);
-- SaaS later only needs signup + billing on top of this.
--
-- Access model
--   * Browser (logged-in user)   -> anon key + RLS (org membership)
--   * Next.js server routes       -> service role, always scoped by org in code
--   * Local runner                -> never touches the DB; talks to /api/runner/* with a runner token

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- orgs & members
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','viewer')),
  email text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create or replace function public.can_approve(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.org_members m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner','admin','member'));
$$;

-- Org-wide settings. channels holds notification config; secret values inside it are
-- encrypted by the server (APP_ENCRYPTION_KEY) before they are stored.
create table public.org_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  channels jsonb not null default '{}'::jsonb,
  defaults jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- runners
create table public.runners (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  public_key text,                       -- SPKI PEM, used by the browser to encrypt site credentials
  token_hash text,                       -- sha256 of the runner bearer token
  registration_code_hash text,           -- sha256 of a one-time code shown in the panel
  registration_expires_at timestamptz,
  status jsonb not null default '{}'::jsonb,   -- claude / claude-seo / python health from heartbeat
  version text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- sites
create table public.sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  url text not null,                     -- canonical origin, e.g. https://www.example.com
  platform text not null check (platform in ('wordpress','shopify','repo','other')),
  runner_id uuid references public.runners(id) on delete set null,
  policy jsonb not null default '{}'::jsonb,       -- see packages/core/src/schema.ts SitePolicy
  config jsonb not null default '{}'::jsonb,       -- non-secret platform config (repo branch, shop domain, GSC property...)
  connection jsonb not null default '{}'::jsonb,   -- last connection test result from runner
  health_score int,
  last_audit_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.sites (org_id);

-- Credentials for a site, encrypted in the browser with the runner's public key.
-- The server stores ciphertext it cannot read.
create table public.site_secrets (
  site_id uuid primary key references public.sites(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  runner_id uuid not null references public.runners(id) on delete cascade,
  ciphertext jsonb not null,             -- {alg, key, iv, data} base64 fields
  hint text,                             -- non-secret hint, e.g. "app password for seo-agent"
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- jobs
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  site_id uuid references public.sites(id) on delete cascade,
  kind text not null check (kind in
    ('test_connection','audit','propose','apply','verify','rollback','monitor','custom')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  params jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  runner_id uuid references public.runners(id) on delete set null,
  schedule_id uuid,
  parent_job_id uuid references public.jobs(id) on delete set null,
  cost_usd numeric(10,4),
  cancel_requested boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);
create index on public.jobs (org_id, created_at desc);
create index on public.jobs (status, created_at) where status = 'queued';

create table public.job_logs (
  id bigserial primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  ts timestamptz not null default now(),
  level text not null default 'info' check (level in ('debug','info','warn','error','agent','tool')),
  message text not null
);
create index on public.job_logs (job_id, id);

-- ---------------------------------------------------------------- audits & findings
create table public.audits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  depth text not null default 'full',
  health_score int,
  business_type text,
  summary jsonb not null default '{}'::jsonb,
  categories jsonb not null default '[]'::jsonb,
  action_plan jsonb,
  report_md text,
  action_plan_md text,
  created_at timestamptz not null default now()
);
create index on public.audits (site_id, created_at desc);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  category text not null,
  severity text not null check (severity in ('Critical','High','Medium','Low','Info')),
  title text not null,
  description text,
  recommendation text,
  url text,
  status text not null default 'open' check (status in ('open','fix_proposed','fixed','ignored','manual')),
  created_at timestamptz not null default now()
);
create index on public.findings (audit_id);

-- ---------------------------------------------------------------- changes (proposed fixes)
create table public.changes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  audit_id uuid references public.audits(id) on delete set null,
  finding_id uuid references public.findings(id) on delete set null,
  batch_id uuid,                         -- all proposals from one propose job
  type text not null,
  target jsonb not null,                 -- {url, resource:{kind,id,handle}}
  before jsonb,                          -- value read from the live site by the runner (never by the model)
  after jsonb not null,                  -- proposed value
  rationale text,
  evidence text,
  expected_impact text,
  tier text not null check (tier in ('auto','approve','never')),
  risk_reasons text[] not null default '{}',
  status text not null default 'proposed' check (status in
    ('proposed','pending_approval','approved','rejected','blocked','expired',
     'applying','applied','verifying','verified','verify_failed','failed',
     'rolling_back','rolled_back')),
  diff_hash text not null,               -- sha256 of (type,target,after); approval binds to it
  page_metrics jsonb,                    -- {clicks28d, impressions28d, ...} at proposal time
  approved_by uuid references auth.users(id),
  approved_via text,                     -- panel | slack | whatsapp | email | policy
  approver_label text,
  decided_at timestamptz,
  decision_note text,
  applied_at timestamptz,
  verified_at timestamptz,
  verify_result jsonb,
  rollback_data jsonb,                   -- adapter-specific data needed to undo
  pr_url text,
  error text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.changes (site_id, status);
create index on public.changes (org_id, status, created_at desc);

-- Which chat message / email announced a change, so it can be updated after a decision.
create table public.approval_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  change_id uuid references public.changes(id) on delete cascade,
  batch_id uuid,
  channel text not null check (channel in ('slack','whatsapp','email')),
  external_id text,                      -- slack "channel:ts", whatsapp message id, email id
  recipient text,
  created_at timestamptz not null default now()
);

-- Single-use signed action tokens (email links). jti is the token id.
create table public.action_tokens (
  jti text primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  change_ids uuid[] not null,
  action text not null check (action in ('approve','reject')),
  recipient text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Deduplicate webhook deliveries (Slack/WhatsApp retry).
create table public.webhook_events (
  id text primary key,
  channel text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- schedules
create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  kind text not null check (kind in ('audit','propose','monitor','verify')),
  every_hours int not null check (every_hours between 1 and 2160),
  params jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- page metrics (rollback monitoring)
create table public.page_metrics (
  site_id uuid not null references public.sites(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  url text not null,
  period_end date not null,
  days int not null default 28,
  clicks int,
  impressions int,
  ctr numeric,
  position numeric,
  primary key (site_id, url, period_end, days)
);

-- ---------------------------------------------------------------- audit log
create table public.audit_log (
  id bigserial primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  actor text not null,                   -- user email, "runner:<name>", "slack:<user>", "system"
  action text not null,
  entity text,
  entity_id text,
  data jsonb,
  ts timestamptz not null default now()
);
create index on public.audit_log (org_id, ts desc);

-- ---------------------------------------------------------------- updated_at trigger
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create trigger changes_touch before update on public.changes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- atomic job claim
-- Called by the server on behalf of a runner. Also lazily enqueues due schedules
-- for that runner's sites, so schedules fire whenever the runner is online.
create or replace function public.claim_job(p_runner uuid)
returns setof public.jobs language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  s record;
begin
  select org_id into v_org from runners where id = p_runner and revoked_at is null;
  if v_org is null then return; end if;

  for s in
    select sc.* from schedules sc join sites si on si.id = sc.site_id
    where sc.enabled and sc.next_run_at <= now() and si.archived_at is null
      and si.org_id = v_org and (si.runner_id = p_runner or si.runner_id is null)
    for update of sc skip locked
  loop
    -- don't stack a scheduled job on top of an identical one still waiting
    if not exists (select 1 from jobs j where j.schedule_id = s.id and j.status in ('queued','running')) then
      insert into jobs (org_id, site_id, kind, params, schedule_id)
      values (s.org_id, s.site_id, s.kind, s.params, s.id);
    end if;
    update schedules set last_run_at = now(),
      next_run_at = now() + make_interval(hours => s.every_hours) where id = s.id;
  end loop;

  -- requeue jobs whose runner went silent for 10 minutes
  update jobs set status = 'queued', runner_id = null, started_at = null
   where status = 'running' and org_id = v_org and heartbeat_at < now() - interval '10 minutes';

  return query
  update jobs j set status = 'running', runner_id = p_runner, started_at = now(), heartbeat_at = now()
   where j.id = (
     select j2.id from jobs j2 left join sites si on si.id = j2.site_id
      where j2.status = 'queued' and j2.org_id = v_org
        and (j2.site_id is null or si.runner_id = p_runner or si.runner_id is null)
      order by j2.created_at
      for update of j2 skip locked limit 1)
  returning j.*;
end; $$;

-- First decision wins: approve/reject only while pending and unexpired, and only for the approved diff.
create or replace function public.decide_change(
  p_change uuid, p_action text, p_via text, p_label text, p_user uuid, p_note text default null)
returns public.changes language plpgsql security definer set search_path = public as $$
declare v public.changes;
begin
  update changes set
    status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    approved_via = p_via, approver_label = p_label, approved_by = p_user,
    decided_at = now(), decision_note = p_note
  where id = p_change and status = 'pending_approval'
    and (expires_at is null or expires_at > now())
  returning * into v;
  return v;  -- null when someone else decided first or it expired
end; $$;

-- ---------------------------------------------------------------- RLS
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.org_settings enable row level security;
alter table public.runners enable row level security;
alter table public.sites enable row level security;
alter table public.site_secrets enable row level security;
alter table public.jobs enable row level security;
alter table public.job_logs enable row level security;
alter table public.audits enable row level security;
alter table public.findings enable row level security;
alter table public.changes enable row level security;
alter table public.approval_messages enable row level security;
alter table public.action_tokens enable row level security;
alter table public.webhook_events enable row level security;
alter table public.schedules enable row level security;
alter table public.page_metrics enable row level security;
alter table public.audit_log enable row level security;

-- Read access for members. All writes go through server routes (service role),
-- which check membership/role in code and write the audit log.
create policy org_read on public.orgs for select using (public.is_org_member(id));
create policy member_read on public.org_members for select using (public.is_org_member(org_id));
create policy settings_read on public.org_settings for select using (public.is_org_member(org_id));
create policy runners_read on public.runners for select using (public.is_org_member(org_id));
create policy sites_read on public.sites for select using (public.is_org_member(org_id));
create policy secrets_read on public.site_secrets for select using (public.is_org_member(org_id));
create policy jobs_read on public.jobs for select using (public.is_org_member(org_id));
create policy job_logs_read on public.job_logs for select
  using (exists (select 1 from public.jobs j where j.id = job_id and public.is_org_member(j.org_id)));
create policy audits_read on public.audits for select using (public.is_org_member(org_id));
create policy findings_read on public.findings for select using (public.is_org_member(org_id));
create policy changes_read on public.changes for select using (public.is_org_member(org_id));
create policy schedules_read on public.schedules for select using (public.is_org_member(org_id));
create policy metrics_read on public.page_metrics for select using (public.is_org_member(org_id));
create policy audit_log_read on public.audit_log for select using (public.is_org_member(org_id));
-- approval_messages, action_tokens, webhook_events: server only (no policies = no client access)

-- Never expose hashes to the browser: column-level grants instead of table-level select
revoke select on public.runners from anon, authenticated;
grant select (id, org_id, name, public_key, status, version, last_seen_at, revoked_at,
              registration_expires_at, created_at)
  on public.runners to authenticated;

-- Writes always go through the server (service role). Lock the browser out of every write.
revoke insert, update, delete on all tables in schema public from anon, authenticated;

-- The privileged functions are server-only. is_org_member / can_approve are used by RLS.
revoke execute on function public.claim_job(uuid) from public, anon, authenticated;
revoke execute on function public.decide_change(uuid, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_job(uuid) to service_role;
grant execute on function public.decide_change(uuid, text, text, text, uuid, text) to service_role;
