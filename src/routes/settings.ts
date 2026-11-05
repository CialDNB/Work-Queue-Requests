// Platform settings, editable in-app by admins. First setting: alerting overrides
// (A4) — extra recipients + the Slack channel — that layer over the ALERT_EMAIL /
// ALERT_WEBHOOK_URL env defaults; src/cron/alert.ts reads the merge.
//
// The stored Slack webhook is a credential: GET never returns it (only whether one is
// set), and PUT only accepts HTTPS Slack incoming-webhook URLs (SSRF guard). Because
// GET no longer echoes the URL, PUT treats an OMITTED slackWebhookUrl as "leave as-is";
// '' or null clears it.
import { z } from 'zod';
import { entraFullyEnabled } from '../auth/oidc';
import { isSlackWebhook, parseRecipients } from '../cron/alert';
import type { Db } from '../data';
import { getSecret } from '../env';
import { defineRoute } from '../framework/defineRoute';
import { ok } from '../framework/envelope';
import { AppError } from '../framework/errors';

const alertingInput = z.object({
  recipients: z.array(z.email().max(254)).max(20).default([]),
  // Omitted → keep the stored channel; '' or null → clear it; a URL → set/replace it.
  slackWebhookUrl: z.union([z.url().max(2048), z.literal(''), z.null()]).optional(),
});

/**
 * The allowed tenants that no Microsoft sign-in has completed FROM on this app — the
 * entra-only guard's proof, asked per tenant. A redirect URI or an expired secret breaks
 * the shared registration for every tenant at once, but admin consent is granted per
 * tenant (docs/runbooks/entra-sso-setup.md, Part 2): a CIAL sign-in proves nothing about
 * D&B Israel's consent. Asking about the CURRENT allowlist also means a sign-in from a
 * tenant since removed from it no longer counts. One LIMIT-1 probe per tenant; the
 * allowlist is a handful of directories.
 */
async function unprovenTenants(
  audit: Db['audit'],
  allowedTenants: readonly string[],
): Promise<string[]> {
  const proven = await Promise.all(
    allowedTenants.map((tid) => audit.hasSuccessfulLogin('entra_oidc', tid)),
  );
  return allowedTenants.filter((_, i) => !proven[i]);
}

export const settingsRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/settings/alerting',
    permission: 'settings.manage',
    summary: 'Read in-app alerting overrides and the env defaults they layer over',
    input: z.object({}),
    handler: async (ctx) => {
      const stored = await ctx.db.settings.getAlerting();
      return ok({
        recipients: stored?.recipients ?? [],
        // Never expose the stored webhook URL — it's a credential. Only signal presence.
        slackWebhookConfigured: Boolean(stored?.slackWebhookUrl),
        env_defaults: {
          recipients: parseRecipients(ctx.env.ALERT_EMAIL),
          slack_configured: Boolean(await getSecret(ctx.env.ALERT_WEBHOOK_URL)),
        },
      });
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/settings/alerting',
    permission: 'settings.manage',
    audit: 'settings.alerting.update',
    summary: 'Set in-app alerting overrides — extra recipients + Slack channel',
    input: alertingInput,
    handler: async (ctx, input) => {
      const recipients = [...new Set(input.recipients.map((e) => e.toLowerCase()))];

      let webhook: string | null;
      if (input.slackWebhookUrl === undefined) {
        // Omitted: keep whatever is already stored (GET never handed the URL back).
        webhook = (await ctx.db.settings.getAlerting())?.slackWebhookUrl ?? null;
      } else if (input.slackWebhookUrl) {
        // Set/replace: the admin-supplied URL is an SSRF primitive (the cron POSTs to
        // it), so it must be an HTTPS Slack incoming-webhook.
        if (!isSlackWebhook(input.slackWebhookUrl)) {
          throw new AppError(
            400,
            'invalid_webhook',
            'Slack webhook must be an https://hooks.slack.com/ URL',
          );
        }
        webhook = input.slackWebhookUrl;
      } else {
        webhook = null; // '' or null clears the override
      }

      await ctx.db.settings.setAlerting(
        { recipients, slackWebhookUrl: webhook },
        ctx.principal.email,
      );
      ctx.setAuditTarget('alerting');
      return ok({ recipients, slackWebhookConfigured: Boolean(webhook) });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/settings/login',
    permission: 'settings.manage',
    summary: 'Read the login policy (entra-only) and whether Entra SSO is usable',
    input: z.object({}),
    handler: async (ctx) => {
      const [stored, unproven] = await Promise.all([
        ctx.db.settings.getLogin(),
        // null while SSO is not fully configured: there is no allowlist to prove.
        entraFullyEnabled(ctx.env).then((cfg) =>
          cfg === null ? null : unprovenTenants(ctx.db.audit, cfg.allowedTenants),
        ),
      ]);
      const entraConfigured = unproven !== null;
      return ok({
        entraOnly: stored?.entraOnly === true,
        // Whether the stored policy is actually IN FORCE right now (it is ignored while
        // SSO is misconfigured — availability over policy; see src/auth/routes.ts).
        entraOnlyEffective: stored?.entraOnly === true && entraConfigured,
        entraConfigured,
        // Has a Microsoft sign-in completed here from EVERY allowed tenant? PUT refuses to
        // enable without it. False while SSO is not fully configured.
        entraProven: unproven !== null && unproven.length === 0,
        // The allowed tenants still without one (public directory ids, not people), so the
        // Settings hint can name them. Empty while SSO is not fully configured.
        entraUnprovenTenants: unproven ?? [],
      });
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/settings/login',
    permission: 'settings.manage',
    audit: 'settings.login.update',
    summary: 'Set the login policy — entra-only switches magic links off for this app',
    input: z.object({ entraOnly: z.boolean() }),
    handler: async (ctx, input) => {
      // Disabling is always allowed, so neither guard can trap an admin trying to recover.
      if (input.entraOnly) {
        // Refuse to ENABLE the policy while SSO can't actually mint sessions — an admin
        // would lock every user (themselves included) out of the app with one click. This
        // check runs first: with SSO unconfigured the login page hides the Microsoft button,
        // so "sign in with Microsoft once" would be advice nobody can follow. If SSO
        // degrades AFTER enabling, the runtime guard in /auth/request ignores the policy
        // rather than bricking logins.
        const cfg = await entraFullyEnabled(ctx.env);
        if (cfg === null) {
          throw new AppError(
            400,
            'entra_not_configured',
            'Microsoft sign-in is not fully configured for this app (client id, tenant allowlist, and secret are all required) — enable it before turning magic links off',
          );
        }
        // Complete config is NOT a working flow. entraFullyEnabled() sees the client id,
        // tenants and secret, never a redirect URI missing from the shared registration
        // (AADSTS50011), an expired shared secret, or a tenant without admin consent — each
        // leaves the config valid and ends round trips at Microsoft. So also require PROOF:
        // a Microsoft sign-in that has completed on this app (the audit row oidc.ts writes
        // only after minting a session) from EVERY allowed tenant, since consent is per
        // tenant. See DECISIONS 2026-10-10.
        const unproven = await unprovenTenants(ctx.db.audit, cfg.allowedTenants);
        if (unproven.length > 0) {
          throw new AppError(
            400,
            'entra_never_completed',
            `No Microsoft sign-in has completed on this app yet from tenant ${unproven.join(', ')} — have a user from each of these tenants sign in with Microsoft once, or remove the tenant from ENTRA_ALLOWED_TENANTS, before turning magic links off`,
          );
        }
      }
      await ctx.db.settings.setLogin({ entraOnly: input.entraOnly }, ctx.principal.email);
      ctx.setAuditTarget('login');
      return ok({ entraOnly: input.entraOnly });
    },
  }),
];
