/**
 * Row types mirroring supabase/migrations/0001_init.sql (snake_case, as returned by PostgREST).
 * Timestamps are ISO strings; numeric columns may come back as strings (numeric) or numbers.
 */
import type {
  ChangeStatus,
  ChangeType,
  JobKind,
  PageMetrics,
  Platform,
  SealedEnvelope,
  Tier,
} from "@seo-autopilot/core";

export type Role = "owner" | "admin" | "member" | "viewer";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type FindingSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";
export type FindingStatus = "open" | "fix_proposed" | "fixed" | "ignored" | "manual";
export type ApprovalChannel = "slack" | "whatsapp" | "email";
export type ApprovedVia = "panel" | "slack" | "whatsapp" | "email" | "policy";
export type LogLevel = "debug" | "info" | "warn" | "error" | "agent" | "tool";

export interface Org {
  id: string;
  name: string;
  created_at: string;
}

export interface OrgMember {
  org_id: string;
  user_id: string;
  role: Role;
  email: string | null;
  created_at: string;
}

export interface Runner {
  id: string;
  org_id: string;
  name: string;
  public_key: string | null;
  /** Never selected by the browser (column grants); present only on admin reads. */
  token_hash?: string | null;
  registration_code_hash?: string | null;
  registration_expires_at: string | null;
  status: RunnerStatus | Record<string, never>;
  version: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface RunnerStatus {
  claude?: { ok: boolean; version?: string; auth?: string | boolean };
  claude_seo?: { ok: boolean; version?: string; path?: string };
  python?: { ok: boolean; version?: string };
  busy?: boolean;
  job_id?: string;
}

export interface Site {
  id: string;
  org_id: string;
  name: string;
  url: string;
  platform: Platform;
  runner_id: string | null;
  policy: Record<string, unknown>;
  config: Record<string, unknown>;
  connection: SiteConnection | Record<string, never>;
  health_score: number | null;
  last_audit_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface SiteConnection {
  ok?: boolean;
  details?: Record<string, unknown>;
  warnings?: string[];
  capabilities?: ChangeType[];
  tested_at?: string;
}

export interface SiteSecretRow {
  site_id: string;
  org_id: string;
  runner_id: string;
  ciphertext: SealedEnvelope;
  hint: string | null;
  updated_at: string;
}

export interface Job {
  id: string;
  org_id: string;
  site_id: string | null;
  kind: JobKind;
  status: JobStatus;
  params: Record<string, unknown>;
  result: unknown;
  error: string | null;
  runner_id: string | null;
  schedule_id: string | null;
  parent_job_id: string | null;
  cost_usd: number | string | null;
  cancel_requested: boolean;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
}

export interface JobLog {
  id: number;
  job_id: string;
  ts: string;
  level: LogLevel;
  message: string;
}

export interface Audit {
  id: string;
  org_id: string;
  site_id: string;
  job_id: string | null;
  depth: string;
  health_score: number | null;
  business_type: string | null;
  summary: Record<string, unknown>;
  categories: Array<Record<string, unknown>>;
  action_plan: unknown;
  report_md: string | null;
  action_plan_md: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  org_id: string;
  site_id: string;
  audit_id: string;
  category: string;
  severity: FindingSeverity;
  title: string;
  description: string | null;
  recommendation: string | null;
  url: string | null;
  status: FindingStatus;
  created_at: string;
}

export interface Change {
  id: string;
  org_id: string;
  site_id: string;
  audit_id: string | null;
  finding_id: string | null;
  batch_id: string | null;
  type: ChangeType;
  target: { url: string; resource?: { kind: string; id?: string; handle?: string; file?: string } };
  before: unknown;
  after: unknown;
  rationale: string | null;
  evidence: string | null;
  expected_impact: string | null;
  failure_check?: string | null;
  tier: Tier;
  risk_reasons: string[];
  status: ChangeStatus;
  diff_hash: string;
  page_metrics: PageMetrics | null;
  approved_by: string | null;
  approved_via: ApprovedVia | null;
  approver_label: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  verified_at: string | null;
  verify_result: unknown;
  rollback_data: unknown;
  pr_url: string | null;
  error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalMessage {
  id: string;
  org_id: string;
  change_id: string | null;
  batch_id: string | null;
  channel: ApprovalChannel;
  external_id: string | null;
  recipient: string | null;
  created_at: string;
}

export interface ActionTokenRow {
  jti: string;
  org_id: string;
  change_ids: string[];
  action: "approve" | "reject";
  recipient: string;
  expires_at: string;
  used_at: string | null;
}

export interface Schedule {
  id: string;
  org_id: string;
  site_id: string;
  kind: "audit" | "propose" | "monitor" | "verify";
  every_hours: number;
  params: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
}

export interface PageMetricsRow {
  site_id: string;
  org_id: string;
  url: string;
  period_end: string;
  days: number;
  clicks: number | null;
  impressions: number | null;
  ctr: number | string | null;
  position: number | string | null;
}

export interface AuditLogRow {
  id: number;
  org_id: string;
  actor: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  data: Record<string, unknown> | null;
  ts: string;
}

// ------------------------------------------------------------------ org_settings.channels
export type NotifyKind = "pending_approval" | "verify_failed" | "rolled_back" | "job_failed" | "traffic_alert";
export const NOTIFY_KINDS: NotifyKind[] = [
  "pending_approval",
  "verify_failed",
  "rolled_back",
  "job_failed",
  "traffic_alert",
];

/** Stored shape (secrets encrypted with APP_ENCRYPTION_KEY, "v1:iv:data"). */
export interface StoredChannels {
  slack?: {
    enabled?: boolean;
    bot_token_enc?: string;
    signing_secret_enc?: string;
    channel_id?: string;
    team_id?: string;
    approvers?: string[];
  };
  whatsapp?: {
    enabled?: boolean;
    phone_number_id?: string;
    access_token_enc?: string;
    app_secret_enc?: string;
    verify_token?: string;
    template_name?: string;
    template_language?: string;
    approvers?: string[];
    /** Last inbound message time per approver (E.164 digits, no "+") — drives the 24h window. */
    last_inbound?: Record<string, string>;
  };
  email?: {
    enabled?: boolean;
    provider?: "resend" | "smtp";
    api_key_enc?: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_user?: string;
    smtp_pass_enc?: string;
    from?: string;
    approvers?: string[];
    digest?: boolean;
  };
  notify_on?: NotifyKind[];
}

export interface OrgSettings {
  org_id: string;
  channels: StoredChannels;
  defaults: Record<string, unknown>;
  updated_at: string;
}

/** Channels with secrets decrypted (server-only). */
export interface ResolvedChannels {
  slack: null | {
    enabled: boolean;
    bot_token: string;
    signing_secret: string;
    channel_id: string;
    team_id?: string;
    approvers: string[];
  };
  whatsapp: null | {
    enabled: boolean;
    phone_number_id: string;
    access_token: string;
    app_secret: string;
    verify_token: string;
    template_name: string;
    template_language: string;
    approvers: string[];
    last_inbound: Record<string, string>;
  };
  email: null | {
    enabled: boolean;
    provider: "resend" | "smtp";
    api_key: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_user?: string;
    smtp_pass?: string;
    from: string;
    approvers: string[];
    digest: boolean;
  };
  notify_on: NotifyKind[];
}

/** Input/edit shape for the settings form. Secret fields: "__unchanged__" keeps the stored value. */
export interface ChannelsInput {
  slack?: {
    enabled: boolean;
    bot_token: string;
    signing_secret: string;
    channel_id: string;
    team_id?: string;
    approvers: string[];
  };
  whatsapp?: {
    enabled: boolean;
    phone_number_id: string;
    access_token: string;
    app_secret: string;
    verify_token: string;
    template_name: string;
    template_language?: string;
    approvers: string[];
  };
  email?: {
    enabled: boolean;
    provider: "resend" | "smtp";
    api_key: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_user?: string;
    smtp_pass?: string;
    from: string;
    approvers: string[];
    digest: boolean;
  };
  notify_on?: NotifyKind[];
}
export type ChannelsView = ChannelsInput;
export const UNCHANGED = "__unchanged__";

export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
