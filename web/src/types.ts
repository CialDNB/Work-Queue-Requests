export interface Me {
  email: string;
  name: string | null;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  auth_method: string;
  permissions: string[];
}

export interface Note {
  id: string;
  title: string;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface NotePage {
  items: Note[];
  next_cursor: string | null;
}

export interface UserRow {
  email: string;
  name: string | null;
  role: Me['role'];
  added_by: string | null;
  added_at: string;
  disabled_at: string | null;
}

export interface AuditRow {
  id: number;
  actor_email: string;
  action: string;
  target: string | null;
  payload_json: string | null;
  ip: string | null;
  created_at: string;
}

/** Opaque paging position for the read ledger. BOTH halves are required — see src/data/readLog.ts. */
export interface ReadLogCursor {
  created_at: string;
  id: string;
}

export interface ReadLogRow {
  id: string;
  request_id: string;
  principal: string;
  /**
   * Which stream: this app's own D1, a private database behind the aurora seam, or an upstream
   * HTTP source read through `ctx.readUpstream()` (PIA C15).
   */
  kind: 'aurora' | 'd1' | 'upstream';
  route: string;
  /** aurora: the registered source name. d1: the repository name. upstream: the source name. */
  source: string;
  source_class: 'client' | 'internal';
  /** Schema-qualified view (aurora only — a D1 or upstream read declares none). */
  view: string | null;
  /** aurora: the registered query id. d1: the repository method name. upstream: the read id. */
  query_name: string | null;
  /** The DECLARED identifier projection's NAME, never a bound value (Decision D6). */
  target: string | null;
  /** `null` means ATTEMPTED — the read started and its outcome is unknown. `0` means empty. */
  row_count: number | null;
  created_at: string;
}

export interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  /** Every token expires (at most 90 days after it is minted). */
  expires_at: string;
  revoked_at: string | null;
  /** The permission keys the token may use; null = a legacy token from before scopes existed. */
  scopes: string[] | null;
}

/** A machine principal (an ETL, an integration) — never a user, never able to sign in. */
export interface ServiceIdentity {
  id: number;
  slug: string;
  /** svc-<slug>@<app>.invalid — what the audit log and read log attribute its actions to. */
  identifier: string;
  name: string;
  /** The ONE permission key it may exercise. */
  scope: string;
  custodian_email: string;
  custodian_active: boolean;
  /** Whether its tokens work right now. */
  status: 'active' | 'disabled' | 'custodian_inactive' | 'scope_not_grantable';
  disabled_at: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  live_tokens: number;
  next_expiry: string | null;
  last_used_at: string | null;
}

export interface AlertingConfig {
  recipients: string[];
  // The stored webhook is a credential and is never sent to the client — only whether
  // one is configured. To change it, POST a new URL (or clear it); see SettingsPage.
  slackWebhookConfigured: boolean;
  env_defaults: { recipients: string[]; slack_configured: boolean };
}
