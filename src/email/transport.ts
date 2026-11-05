// The email transport seam. Today: Cloudflare Email Service via the EMAIL binding
// (sender domain must be onboarded once per zone: `wrangler email sending enable
// cialdnb.ai` — a platform task, see docs/RESOURCES.md). Swapping providers (Resend,
// SES, …) means changing THIS file only — callers never see the provider.
//
// FAIL-OPEN BY DESIGN: if the binding is absent (tests, un-provisioned staging) or the
// send fails, we log and return an outcome instead of throwing — auth flows must keep
// working while email setup is pending, and callers decide what to do with 'skipped'.
// The log carries the outcome and the error CATEGORY only — never the recipient, the subject
// or the error text (which can quote the address): PIA C5, src/platform/logEvent.ts.
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailOutcome = 'sent' | 'skipped' | 'failed';

export async function sendEmail(env: Env, mail: OutboundEmail): Promise<EmailOutcome> {
  if (!env.EMAIL) {
    logEvent('email_skipped_no_binding');
    return 'skipped';
  }
  try {
    await env.EMAIL.send({
      to: mail.to,
      from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return 'sent';
  } catch (err) {
    logEvent('email_send_failed', { err });
    return 'failed';
  }
}
