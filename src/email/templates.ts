// Branded transactional emails. The design is ported from Atlas (D&B Israel's planning app)
// and generalized to any kit app: an Outlook-safe, table-based shell with INLINE styles only
// (no <style> block, no web fonts, no remote images — the things email clients strip or use to
// track), a CIAL D&B blue gradient header carrying the app's wordmark, and a plaintext fallback
// on every email. Build new transactional emails with shell()/button()/h2()/p(); never inline
// raw HTML in a route or cron.
import type { OutboundEmail } from './transport';

// Palette + type. Inline-only because email clients ignore <style> and external CSS.
const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
const BRAND = '#0050F0';
const GRADIENT = 'linear-gradient(115deg,#0050f0,#00d2ff)';
const NAVY = '#0F172A';
const DANGER = '#B91C1C'; // header for security alerts — reads as urgent, not routine ops
const INK = '#1B2542';
const INK2 = '#4B5870';
const MUT = '#6B7280';
const LINE = '#DDE5FF';

/** Escape for safe interpolation into the HTML body (dynamic values are never trusted). */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface ShellOpts {
  appName: string;
  body: string;
  /** Header background; defaults to the CIAL D&B blue gradient. Pass NAVY for ops/alert mail. */
  header?: string;
}

/** The branded wrapper: gradient header + app wordmark, white body card, muted footer. */
function shell(opts: ShellOpts): string {
  const name = esc(opts.appName);
  const headerBg = opts.header ?? GRADIENT;
  const wordmark = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle;padding-right:8px;"><div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.22);text-align:center;line-height:28px;"><span style="display:inline-block;width:12px;height:5px;border-radius:9999px;background:#ffffff;vertical-align:middle;"></span></div></td>
    <td style="vertical-align:middle;font-family:${FONT};font-weight:800;font-size:16px;color:#ffffff;letter-spacing:-0.01em;">${name}</td>
  </tr></table>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#EEF1F8;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF1F8;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${LINE};">
      <tr><td style="background:${headerBg};padding:24px 28px;">${wordmark}</td></tr>
      <tr><td style="padding:28px;">${opts.body}</td></tr>
    </table>
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;"><tr>
      <td style="padding:16px 28px;font-family:${FONT};font-size:11px;line-height:1.6;color:${MUT};text-align:center;">${name} · CIAL Dun &amp; Bradstreet</td>
    </tr></table>
  </td></tr>
</table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:11px;background:${BRAND};">
    <a href="${esc(href)}" style="display:inline-block;font-family:${FONT};font-size:14px;font-weight:800;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:11px;">${esc(label)}</a>
  </td></tr></table>`;
}

const h2 = (t: string): string =>
  `<h1 style="margin:0 0 14px;font-family:${FONT};font-weight:800;font-size:20px;line-height:1.25;color:${INK};letter-spacing:-0.01em;">${esc(t)}</h1>`;
const p = (html: string, color: string = INK2): string =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:14px;line-height:1.6;color:${color};">${html}</p>`;

/** Magic-link login email. `appName` is the display name; `link` is the verify URL. */
export function magicLinkEmail(appName: string, link: string, to: string): OutboundEmail {
  const body = [
    h2(`Log in to ${appName}`),
    p('Click the button below to log in. This link works once and expires in 15 minutes.'),
    `<div style="margin:0 0 16px;">${button(link, `Log in to ${appName}`)}</div>`,
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">If the button does not work, paste this link into your browser:<br><span style="color:${BRAND};word-break:break-all;">${esc(link)}</span></p>`,
    `<div style="height:1px;background:${LINE};margin:0 0 14px;"></div>`,
    `<p style="margin:0;font-family:${FONT};font-size:11px;line-height:1.6;color:${MUT};">You are receiving this because someone requested a login link for this address. If it was not you, you can safely ignore it.</p>`,
  ].join('\n');
  const text = [
    `Log in to ${appName}`,
    '',
    'Click to log in (works once, expires in 15 minutes):',
    link,
    '',
    "If you didn't request this, you can ignore this email.",
  ].join('\n');
  return { to, subject: `Log in to ${appName}`, text, html: shell({ appName, body }) };
}

/**
 * Cron-failure alert email. Returns the body only; the caller adds `to` (the cron fans it out
 * to every recipient). Uses the NAVY header to read as an ops alert, not a user-facing message.
 */
export function cronFailureEmail(
  appName: string,
  appEnv: string,
  failures: ReadonlyArray<{ task: string; error?: string | null }>,
): Omit<OutboundEmail, 'to'> {
  const rows = failures
    .map(
      (f) =>
        `<tr><td style="padding:0 0 9px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(f.task)}</strong> — ${esc(f.error ?? 'failed')}</td></tr>`,
    )
    .join('\n');
  const body = [
    h2(`Cron failure on ${appName}`),
    p(
      `The daily ops cron reported ${failures.length} failed task(s) in <strong style="color:${INK};">${esc(appEnv)}</strong>.`,
    ),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">The same errors are kept in the <code>cron_heartbeat_done</code> audit row, and <code>/_health</code> shows the heartbeat. Workers Logs carry each task's name and error class only.</p>`,
  ].join('\n');
  const text = [
    `${appName} (${appEnv}) — the daily ops cron reported failures:`,
    '',
    ...failures.map((f) => `• ${f.task}: ${f.error ?? 'failed'}`),
    '',
    'The same errors are kept in the `cron_heartbeat_done` audit row, and /_health shows the ' +
      "heartbeat. Workers Logs carry each task's name and error class only.",
  ].join('\n');
  return {
    subject: `[${appName}/${appEnv}] cron failure: ${failures.length} task(s)`,
    text,
    html: shell({ appName, header: NAVY, body }),
  };
}

/** The findings shape the digest email renders (mirrors src/cron/auditAnomalyDigest.ts). */
export interface AuditDigestFindings {
  refusalFloods: ReadonlyArray<{ domain: string; count: number }>;
  firstSeenIpLogins: ReadonlyArray<{ actor: string; ip: string }>;
  sensitiveCounts: ReadonlyArray<{ action: string; count: number }>;
  capped: boolean;
}

/**
 * Daily audit-anomaly digest email. Body only; the cron adds `to` per recipient. NAVY header —
 * this is an ops/security digest, not a user-facing message. Only sent on a NON-empty digest
 * (a quiet day sends nothing), so it always has at least one section. Unlike the Slack text,
 * this goes to operator inboxes, so it may carry the app's own low-sensitivity detail (domains,
 * actor emails, IPs) — but never any audit payload_json blob.
 */
export function auditDigestEmail(
  appName: string,
  appEnv: string,
  f: AuditDigestFindings,
  windowHours: number,
): Omit<OutboundEmail, 'to'> {
  const sections: string[] = [];
  const textLines: string[] = [];

  if (f.refusalFloods.length > 0) {
    const rows = f.refusalFloods
      .map(
        (r) =>
          `<tr><td style="padding:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(String(r.count))}</strong> magic-link refusals at <strong style="color:${INK};">${esc(r.domain)}</strong></td></tr>`,
      )
      .join('\n');
    sections.push(
      `<p style="margin:0 0 8px;font-family:${FONT};font-weight:800;font-size:14px;color:${INK};">Magic-link refusal floods</p>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    );
    textLines.push('Magic-link refusal floods:');
    for (const r of f.refusalFloods) textLines.push(`  • ${r.count} refusals at ${r.domain}`);
    textLines.push('');
  }

  if (f.firstSeenIpLogins.length > 0) {
    const rows = f.firstSeenIpLogins
      .map(
        (l) =>
          `<tr><td style="padding:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(l.actor)}</strong> from a new IP <span style="color:${MUT};">${esc(l.ip)}</span></td></tr>`,
      )
      .join('\n');
    sections.push(
      `<p style="margin:0 0 8px;font-family:${FONT};font-weight:800;font-size:14px;color:${INK};">First-seen-IP logins</p>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    );
    textLines.push('First-seen-IP logins:');
    for (const l of f.firstSeenIpLogins) textLines.push(`  • ${l.actor} from ${l.ip}`);
    textLines.push('');
  }

  if (f.sensitiveCounts.length > 0) {
    const rows = f.sensitiveCounts
      .map(
        (s) =>
          `<tr><td style="padding:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(String(s.count))}×</strong> ${esc(s.action)}</td></tr>`,
      )
      .join('\n');
    sections.push(
      `<p style="margin:0 0 8px;font-family:${FONT};font-weight:800;font-size:14px;color:${INK};">Sensitive mutations</p>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    );
    textLines.push('Sensitive mutations:');
    for (const s of f.sensitiveCounts) textLines.push(`  • ${s.count}× ${s.action}`);
    textLines.push('');
  }

  if (f.capped) {
    const note =
      'The 24h window hit its row cap — counts are a lower bound. Review the audit log directly.';
    sections.push(
      `<p style="margin:0 0 16px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">${esc(note)}</p>`,
    );
    textLines.push(note, '');
  }

  const body = [
    h2(`Audit digest for ${appName}`),
    p(
      `Security-relevant activity in the last <strong style="color:${INK};">${esc(String(windowHours))}h</strong> in <strong style="color:${INK};">${esc(appEnv)}</strong>. This runs only when there is something to report.`,
    ),
    ...sections,
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">Full detail is in the audit log; see also <code>/_health</code>.</p>`,
  ].join('\n');

  const text = [
    `${appName} (${appEnv}) — audit digest, last ${windowHours}h:`,
    '',
    ...textLines,
    'Full detail is in the audit log.',
  ].join('\n');

  return {
    subject: `[${appName}/${appEnv}] audit digest`,
    text,
    html: shell({ appName, header: NAVY, body }),
  };
}

/** One token nearing its forced expiry (mirrors src/cron/tokenExpiry.ts). */
export interface TokenExpiryNoticeRow {
  prefix: string;
  name: string;
  owner: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** UTC calendar days from this run's date to the expiry date: 14, 7, 3 or 1. */
  daysLeft: number;
}

/**
 * Token-expiry notice (PIA C8: every token now expires, at most 90 days after it was minted, and
 * legacy tokens at upgrade + 90 days). Ops mail — NAVY header — to the alert recipients: a machine
 * integration whose token lapses fails with a bare 401, so the warning goes where someone will
 * rotate it. Names the token by prefix and name, never the secret.
 */
export function tokenExpiryEmail(
  appName: string,
  appEnv: string,
  rows: readonly TokenExpiryNoticeRow[],
  /** How many tokens are due in all; `rows` may list fewer (the cron caps the list). */
  total: number = rows.length,
): Omit<OutboundEmail, 'to'> {
  const when = (d: number): string => (d === 1 ? 'tomorrow' : `in ${d} days`);
  const unlisted = Math.max(0, total - rows.length);
  const moreNote =
    unlisted > 0
      ? `${unlisted} more token(s) are due and not listed here — list them all with the query in the runbook, section 1.`
      : '';
  const html = rows
    .map(
      (r) =>
        `<tr><td style="padding:0 0 9px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(r.name)}</strong> <code>${esc(r.prefix)}…</code> — ${esc(r.owner)}<br><span style="color:${MUT};">expires ${esc(when(r.daysLeft))} (${esc(r.expiresAt)} UTC) · last used ${esc(r.lastUsedAt ?? 'never')}</span></td></tr>`,
    )
    .join('\n');
  const body = [
    h2(`API tokens expiring on ${appName}`),
    p(
      `${total} API token(s) in use in <strong style="color:${INK};">${esc(appEnv)}</strong> will stop working soon. Tokens cannot be extended: mint a replacement, switch the integration over, then revoke the old one.`,
    ),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${html}</table>`,
    ...(moreNote ? [p(esc(moreNote))] : []),
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">Runbook: <code>docs/runbooks/machine-token-rotation.md</code>. You get this at 14, 7, 3 and 1 day(s) out.</p>`,
  ].join('\n');
  const text = [
    `${appName} (${appEnv}) — API tokens nearing expiry:`,
    '',
    ...rows.map(
      (r) =>
        `• ${r.name} (${r.prefix}…) owned by ${r.owner}: expires ${when(r.daysLeft)} (${r.expiresAt} UTC), last used ${r.lastUsedAt ?? 'never'}`,
    ),
    ...(moreNote ? ['', moreNote] : []),
    '',
    'Tokens cannot be extended: mint a replacement, switch over, revoke the old one.',
    'Runbook: docs/runbooks/machine-token-rotation.md',
  ].join('\n');
  return {
    subject: `[${appName}/${appEnv}] ${total} API token(s) expiring soon`,
    text,
    html: shell({ appName, header: NAVY, body }),
  };
}

/** One SERVICE identity's token nearing expiry (src/cron/tokenExpiry.ts). */
export interface ServiceTokenNoticeRow {
  /** The identity's display name and its svc-…@….invalid identifier. */
  identity: string;
  identifier: string;
  tokenName: string;
  prefix: string;
  custodian: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** WHOLE days left at this run, 0–13 (0 = less than 24 hours) — by the clock, not by date. */
  daysLeft: number;
}

/** A service identity whose custodian is no longer an active user — its tokens are refused. */
export interface OrphanedServiceIdentityRow {
  identity: string;
  identifier: string;
  custodian: string;
  liveTokens: number;
  lastUsedAt: string | null;
}

/**
 * A service identity whose ONE scope no service may hold any more (a later kit or app change made
 * the key non-delegable, or removed it) — its tokens are refused, and only a new identity fixes it.
 */
export interface StrandedServiceIdentityRow {
  identity: string;
  identifier: string;
  scope: string;
  custodian: string;
  liveTokens: number;
  lastUsedAt: string | null;
}

// Whole days left (the service digest counts by the clock): never "tomorrow" — 1 day and 20 hours
// may well be the day after.
const whenLeft = (d: number): string =>
  d === 0 ? 'within 24 hours' : d === 1 ? 'in 1 day' : `in ${d} days`;

function serviceTokenHtml(r: ServiceTokenNoticeRow, withCustodian: boolean): string {
  const custodian = withCustodian ? ` · custodian ${esc(r.custodian)}` : '';
  return `<tr><td style="padding:0 0 9px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(r.identity)}</strong> <code>${esc(r.identifier)}</code><br>token <strong style="color:${INK};">${esc(r.tokenName)}</strong> <code>${esc(r.prefix)}…</code> expires ${esc(whenLeft(r.daysLeft))} (${esc(r.expiresAt)} UTC)<br><span style="color:${MUT};">last used ${esc(r.lastUsedAt ?? 'never')}${custodian}</span></td></tr>`;
}

function serviceTokenText(r: ServiceTokenNoticeRow, withCustodian: boolean): string {
  const custodian = withCustodian ? `, custodian ${r.custodian}` : '';
  return `• ${r.identity} (${r.identifier}): token ${r.tokenName} (${r.prefix}…) expires ${whenLeft(r.daysLeft)} (${r.expiresAt} UTC), last used ${r.lastUsedAt ?? 'never'}${custodian}`;
}

const STRANDED_HINT =
  'No custodian change can fix these: create a new identity with a scope a service may hold, move the integration to it, then disable this one and revoke its tokens.';

const ROTATE_HINT =
  'A service token cannot be extended: mint a replacement under Settings → Service identities, deploy it to the integration, then revoke the old one.';

/**
 * The daily SERVICE-IDENTITY digest (src/cron/tokenExpiry.ts) to the alert recipients: every used
 * service token within 14 days of expiry — named with its identity and CUSTODIAN, the person
 * accountable for rotating it — and every identity whose custodian is no longer an active user,
 * whose tokens are therefore being refused right now. Ops mail (NAVY). Never a secret.
 */
export function serviceIdentityDigestEmail(
  appName: string,
  appEnv: string,
  due: readonly ServiceTokenNoticeRow[],
  /** How many service tokens are due in all; `due` may list fewer (the cron caps the list). */
  total: number,
  orphans: readonly OrphanedServiceIdentityRow[],
  stranded: readonly StrandedServiceIdentityRow[] = [],
): Omit<OutboundEmail, 'to'> {
  const unlisted = Math.max(0, total - due.length);
  const strandedHtml = stranded
    .map(
      (o) =>
        `<tr><td style="padding:0 0 9px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(o.identity)}</strong> <code>${esc(o.identifier)}</code><br><span style="color:${MUT};">scope <code>${esc(o.scope)}</code> can no longer be held by a service identity · ${o.liveTokens} live token(s) refused · custodian ${esc(o.custodian)} · last used ${esc(o.lastUsedAt ?? 'never')}</span></td></tr>`,
    )
    .join('\n');
  const moreNote =
    unlisted > 0
      ? `${unlisted} more service token(s) are due and not listed here — see Settings → Service identities.`
      : '';
  const orphanHtml = orphans
    .map(
      (o) =>
        `<tr><td style="padding:0 0 9px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(o.identity)}</strong> <code>${esc(o.identifier)}</code><br><span style="color:${MUT};">custodian ${esc(o.custodian)} is no longer an active user · ${o.liveTokens} live token(s) refused · last used ${esc(o.lastUsedAt ?? 'never')}</span></td></tr>`,
    )
    .join('\n');
  const body = [
    h2(`Service identities on ${appName}`),
    ...(orphans.length > 0
      ? [
          p(
            `<strong style="color:${INK};">${orphans.length} service identit${orphans.length === 1 ? 'y has' : 'ies have'} no active custodian</strong>, so every one of their tokens is being REFUSED in <strong style="color:${INK};">${esc(appEnv)}</strong>. Hand each to a new custodian (tokens work again at once) or disable it.`,
          ),
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${orphanHtml}</table>`,
        ]
      : []),
    ...(stranded.length > 0
      ? [
          p(
            `<strong style="color:${INK};">${stranded.length} service identit${stranded.length === 1 ? 'y holds' : 'ies hold'} a scope no service may hold any more</strong> (a kit or app change made the key non-delegable, or removed it), so every one of their tokens is being REFUSED in <strong style="color:${INK};">${esc(appEnv)}</strong>. ${esc(STRANDED_HINT)}`,
          ),
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${strandedHtml}</table>`,
        ]
      : []),
    ...(due.length > 0
      ? [
          p(
            `${total} service token(s) in use in <strong style="color:${INK};">${esc(appEnv)}</strong> expire within 14 days. ${esc(ROTATE_HINT)}`,
          ),
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${due.map((r) => serviceTokenHtml(r, true)).join('\n')}</table>`,
        ]
      : []),
    ...(moreNote ? [p(esc(moreNote))] : []),
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">Runbook: <code>docs/runbooks/service-identities.md</code>. You get this every day while anything above is true.</p>`,
  ].join('\n');
  const text = [
    `${appName} (${appEnv}) — service identities:`,
    ...(orphans.length > 0
      ? [
          '',
          `No active custodian — every token REFUSED (${orphans.length}):`,
          ...orphans.map(
            (o) =>
              `• ${o.identity} (${o.identifier}): custodian ${o.custodian} is no longer an active user; ${o.liveTokens} live token(s) refused, last used ${o.lastUsedAt ?? 'never'}`,
          ),
          'Hand each to a new custodian, or disable it.',
        ]
      : []),
    ...(stranded.length > 0
      ? [
          '',
          `Scope no service may hold any more — every token REFUSED (${stranded.length}):`,
          ...stranded.map(
            (o) =>
              `• ${o.identity} (${o.identifier}): scope ${o.scope} can no longer be held by a service identity; ${o.liveTokens} live token(s) refused, custodian ${o.custodian}, last used ${o.lastUsedAt ?? 'never'}`,
          ),
          STRANDED_HINT,
        ]
      : []),
    ...(due.length > 0
      ? ['', `Expiring within 14 days (${total}):`, ...due.map((r) => serviceTokenText(r, true))]
      : []),
    ...(moreNote ? ['', moreNote] : []),
    '',
    ROTATE_HINT,
    'Runbook: docs/runbooks/service-identities.md',
  ].join('\n');
  const parts = [
    ...(orphans.length > 0 ? [`${orphans.length} without a custodian`] : []),
    ...(stranded.length > 0 ? [`${stranded.length} with a scope no service may hold`] : []),
    ...(total > 0 ? [`${total} token(s) expiring`] : []),
  ];
  return {
    subject: `[${appName}/${appEnv}] Service identities: ${parts.join(', ')}`,
    text,
    html: shell({ appName, header: NAVY, body }),
  };
}

/**
 * Sent at once when a person who is the custodian of working service identities is DISABLED: from
 * the next request every token of those identities is refused (the fail-closed custodian rule), so
 * the owners hear it now rather than at the next daily digest. Ops mail (NAVY). Never a secret.
 */
export function custodianDisabledEmail(
  appName: string,
  appEnv: string,
  custodian: string,
  identities: readonly OrphanedServiceIdentityRow[],
): Omit<OutboundEmail, 'to'> {
  const n = identities.length;
  const noun = n === 1 ? 'service identity' : 'service identities';
  const rows = identities
    .map(
      (o) =>
        `<tr><td style="padding:0 0 9px;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK2};"><strong style="color:${INK};">${esc(o.identity)}</strong> <code>${esc(o.identifier)}</code><br><span style="color:${MUT};">${o.liveTokens} live token(s) now refused · last used ${esc(o.lastUsedAt ?? 'never')}</span></td></tr>`,
    )
    .join('\n');
  const hint =
    'Hand each to a new custodian under Settings → Service identities (its tokens work again at once, nothing to re-mint), or disable it if it should stop.';
  const body = [
    h2(`Service identities stopped on ${appName}`),
    p(
      `${esc(custodian)} was just disabled in <strong style="color:${INK};">${esc(appEnv)}</strong>. They were the custodian of the ${n} ${noun} below, so every one of their tokens is being REFUSED from now on. ${esc(hint)}`,
    ),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">Runbook: <code>docs/runbooks/service-identities.md</code> (Custodian leaves). The daily digest repeats this until it is fixed.</p>`,
  ].join('\n');
  const text = [
    `${appName} (${appEnv}) — ${custodian} was just disabled. They were the custodian of ${n} ${noun}; every token of these is REFUSED from now on:`,
    '',
    ...identities.map(
      (o) =>
        `• ${o.identity} (${o.identifier}): ${o.liveTokens} live token(s) now refused, last used ${o.lastUsedAt ?? 'never'}`,
    ),
    '',
    hint,
    'Runbook: docs/runbooks/service-identities.md (Custodian leaves)',
  ].join('\n');
  return {
    subject: `[${appName}/${appEnv}] ${n} ${noun} stopped: ${n === 1 ? 'its' : 'their'} custodian was disabled`,
    text,
    html: shell({ appName, header: NAVY, body }),
  };
}

/**
 * The CUSTODIAN's own copy: only the service tokens of identities they are accountable for, so
 * the person who has to rotate hears about it directly — not only the alert inbox.
 */
export function serviceTokenCustodianEmail(
  appName: string,
  appEnv: string,
  due: readonly ServiceTokenNoticeRow[],
): Omit<OutboundEmail, 'to'> {
  const body = [
    h2(`Your service identity tokens on ${appName}`),
    p(
      `You are the custodian of the service identit${new Set(due.map((r) => r.identifier)).size === 1 ? 'y' : 'ies'} below. ${due.length} of their token(s) in <strong style="color:${INK};">${esc(appEnv)}</strong> expire within 14 days. ${esc(ROTATE_HINT)} An owner or admin can do it for you.`,
    ),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${due.map((r) => serviceTokenHtml(r, false)).join('\n')}</table>`,
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUT};">Runbook: <code>docs/runbooks/service-identities.md</code>. You get this every day until the token is rotated.</p>`,
  ].join('\n');
  const text = [
    `${appName} (${appEnv}) — service identity tokens you are the custodian of, expiring within 14 days:`,
    '',
    ...due.map((r) => serviceTokenText(r, false)),
    '',
    ROTATE_HINT,
    'Runbook: docs/runbooks/service-identities.md',
  ].join('\n');
  return {
    subject: `[${appName}/${appEnv}] ${due.length} service token(s) you are custodian of expire soon`,
    text,
    html: shell({ appName, header: NAVY, body }),
  };
}

/** One row of the control-plane tripwire alert (src/cron/auditWatch.ts). */
export interface AuditAlertEvent {
  when: string;
  actor: string;
  actorType: string;
  actorIp: string;
  action: string;
  resource: string;
  result: string;
}

/**
 * Sent by the control-plane tripwire when an infrastructure change to this app's resources was
 * made outside the sanctioned deploy pipeline. Returns the body only (no `to` — the cron supplies
 * it). DANGER header so it reads as urgent. Pure renderer: reads only the event rows it is handed.
 * `appName` is the display name; `host` is the app's hostname (for the "what changed" line).
 */
export function securityAlertEmail(opts: {
  appName: string;
  host: string;
  events: ReadonlyArray<AuditAlertEvent>;
}): Omit<OutboundEmail, 'to'> {
  const { appName, host, events } = opts;
  const n = events.length;
  const noun = `unsanctioned change${n === 1 ? '' : 's'}`;
  const cell = `font-family:${FONT};font-size:12px;line-height:1.5;color:${INK2};padding:7px 10px 7px 0;vertical-align:top;border-bottom:1px solid ${LINE};`;
  const rows = events
    .map(
      (e) => `<tr>
      <td style="${cell}white-space:nowrap;">${esc(e.when)}</td>
      <td style="${cell}"><strong style="color:${INK};">${esc(e.actor)}</strong><br><span style="color:${MUT};font-size:11px;">${esc(e.actorType)} · ${esc(e.actorIp)}</span></td>
      <td style="${cell}">${esc(e.action)}<br><span style="color:${MUT};font-size:11px;">${esc(e.resource)}${e.result === 'failed' ? ' · failed' : ''}</span></td>
    </tr>`,
    )
    .join('\n');
  const body = [
    h2(`${n} ${noun} to ${appName} infrastructure`),
    p(
      `A control-plane change to <strong style="color:${INK};">${esc(host)}</strong> was recorded in the Cloudflare Audit Log from an actor that is <strong style="color:${INK};">not</strong> the sanctioned deploy pipeline.`,
    ),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    p(
      `If this was you (an expected manual deploy), no action is needed. If it was not, treat any at-rest sealing key (<strong style="color:${INK};">SEAL_KEY</strong>) as potentially exposed: rotate it and re-seal, and review who holds Workers-deploy access.`,
      INK2,
    ),
    `<p style="margin:0;font-family:${FONT};font-size:11px;line-height:1.6;color:${MUT};">Automated control-plane watch · this is a detective alert and cannot by itself prevent a key read.</p>`,
  ].join('\n');
  const text = [
    `${appName} security alert — ${n} ${noun} on ${host}`,
    '',
    ...events.map(
      (e) =>
        `• ${e.when} — ${e.actor} (${e.actorType}, ${e.actorIp}) — ${e.action} on ${e.resource}${e.result === 'failed' ? ' [failed]' : ''}`,
    ),
    '',
    `These changes to ${appName} infrastructure were NOT made by the sanctioned deploy pipeline.`,
    'If this was not you, treat any SEAL_KEY as potentially exposed: rotate it and review Workers-deploy access.',
  ].join('\n');
  return {
    subject: `⚠ ${appName} security alert — ${n} ${noun}`,
    text,
    html: shell({ appName, header: DANGER, body }),
  };
}
