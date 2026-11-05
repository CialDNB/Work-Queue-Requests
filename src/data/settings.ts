// Mutable platform settings (key→JSON). Today: alerting overrides edited in-app —
// additional recipients + the Slack channel — that layer over the ALERT_EMAIL /
// ALERT_WEBHOOK_URL env defaults (A4) — and the login policy (entra-only). Add more
// setting keys here as the kit grows.

export interface AlertingSettings {
  /** Extra alert-email recipients, added ON TOP of the ALERT_EMAIL env default. */
  recipients: string[];
  /** Slack incoming-webhook URL; when set, overrides the ALERT_WEBHOOK_URL env default. */
  slackWebhookUrl: string | null;
}

export interface LoginSettings {
  /**
   * When true (and Entra SSO is FULLY configured), magic links are switched off and
   * Microsoft sign-in is the only way in. Deliberately ignored while SSO is missing
   * or misconfigured — a config mistake must never brick every login path, and magic
   * links are a sanctioned method, so availability wins that conflict.
   */
  entraOnly: boolean;
}

const ALERTING_KEY = 'alerting';
const LOGIN_KEY = 'login';

function parseAlerting(json: string): AlertingSettings | null {
  try {
    const v = JSON.parse(json) as Partial<AlertingSettings>;
    return {
      recipients: Array.isArray(v.recipients)
        ? v.recipients.filter((x): x is string => typeof x === 'string')
        : [],
      slackWebhookUrl:
        typeof v.slackWebhookUrl === 'string' && v.slackWebhookUrl ? v.slackWebhookUrl : null,
    };
  } catch {
    return null; // corrupt row → behave as "no override" (env defaults apply)
  }
}

export function settingsRepo(db: D1Database) {
  return {
    async getAlerting(): Promise<AlertingSettings | null> {
      const row = await db
        .prepare('SELECT value_json FROM app_settings WHERE key = ?')
        .bind(ALERTING_KEY)
        .first<{ value_json: string }>();
      return row ? parseAlerting(row.value_json) : null;
    },

    async setAlerting(value: AlertingSettings, actor: string): Promise<void> {
      const json = JSON.stringify({
        recipients: value.recipients,
        slackWebhookUrl: value.slackWebhookUrl,
      });
      await upsert(db, ALERTING_KEY, json, actor);
    },

    async getLogin(): Promise<LoginSettings | null> {
      const row = await db
        .prepare('SELECT value_json FROM app_settings WHERE key = ?')
        .bind(LOGIN_KEY)
        .first<{ value_json: string }>();
      if (!row) return null;
      try {
        const v = JSON.parse(row.value_json) as Partial<LoginSettings>;
        return { entraOnly: v.entraOnly === true };
      } catch {
        return null; // corrupt row → behave as "no policy" (both login methods work)
      }
    },

    async setLogin(value: LoginSettings, actor: string): Promise<void> {
      await upsert(db, LOGIN_KEY, JSON.stringify({ entraOnly: value.entraOnly }), actor);
    },
  };
}

async function upsert(db: D1Database, key: string, json: string, actor: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(key, json, actor.toLowerCase())
    .run();
}
