import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

// Staging + local dev don't send login email yet (the central sender is being onboarded). The
// link is never logged (PIA C5); an address opted in via MAGIC_LINK_OUTBOX finds it in the app's
// short-lived KV outbox instead (GUIDEBOOK "First login"). Show a hint there, never in prod.
function isPreProd(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h.startsWith('staging-');
}

// Minimal shape of the Turnstile script's global (loaded in index.html). Present only when
// the widget is enabled; the login flow works untouched when it's absent.
interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
    },
  ) => string;
  reset: (widget?: string | HTMLElement) => void;
  remove: (widget: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const MAX_SCRIPT_POLLS = 25; // ~5s at 200ms — then surface a "couldn't load" error, stop polling

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function Login() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [siteKey, setSiteKey] = useState('');
  const [entraEnabled, setEntraEnabled] = useState(false);
  const [entraOnly, setEntraOnly] = useState(false);
  const [entraDomains, setEntraDomains] = useState<string[]>([]);
  const [token, setToken] = useState('');
  const [challengeUnavailable, setChallengeUnavailable] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef('');

  // Public login config — empty site key means the bot-challenge is disabled; SSO only
  // renders when the server says it's configured (fail quiet: an error hides the button
  // and, deliberately, falls back to showing the magic-link form even if the app is
  // entra-only — the server enforces the policy, the client only mirrors it).
  useEffect(() => {
    api
      .loginConfig()
      .then((cfg) => {
        setSiteKey(cfg.turnstile_site_key);
        setEntraEnabled(cfg.entra_enabled === true);
        setEntraOnly(cfg.entra_only === true);
        setEntraDomains(Array.isArray(cfg.entra_domains) ? cfg.entra_domains : []);
      })
      .catch(() => {
        setSiteKey('');
        setEntraEnabled(false);
        setEntraOnly(false);
        setEntraDomains([]);
      });
  }, []);

  // Render the Turnstile widget once the site key and the script are both available. The
  // script is loaded ON DEMAND here (not in index.html) so a disabled app never contacts
  // challenges.cloudflare.com. Then poll briefly for window.turnstile; give up (with a
  // surfaced error) rather than polling forever if it's blocked (ad-blocker, CSP, offline).
  useEffect(() => {
    if (!siteKey) return;
    setChallengeUnavailable(false);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }

    const tryRender = () => {
      if (cancelled) return;
      if (window.turnstile && widgetRef.current) {
        widgetIdRef.current = window.turnstile.render(widgetRef.current, {
          sitekey: siteKey,
          callback: (t) => setToken(t),
          'error-callback': () => setToken(''),
          'expired-callback': () => setToken(''),
        });
      } else if (attempts++ < MAX_SCRIPT_POLLS) {
        timer = setTimeout(tryRender, 200);
      } else {
        setChallengeUnavailable(true);
      }
    };
    tryRender();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
    };
  }, [siteKey]);

  // Where the SSO entry points. Plain GET navigations on purpose: a form POST that
  // 302s off-origin would trip the CSP form-action 'self' pin; a link/location
  // navigation doesn't. The server re-sanitizes return_to and shape-checks login_hint.
  function oidcLoginUrl(loginHint?: string): string {
    const params = new URLSearchParams({
      return_to: window.location.pathname + window.location.search + window.location.hash,
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `/auth/oidc/login?${params.toString()}`;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const typed = email.trim();
    // Smart steering: an address on an SSO domain goes to Microsoft (pre-filled via
    // login_hint) instead of round-tripping an email. UX only — the same address may
    // still use a magic link via a direct request unless the app is entra-only.
    const domain = typed.toLowerCase().split('@')[1] ?? '';
    if (entraEnabled && domain && entraDomains.includes(domain)) {
      window.location.assign(oidcLoginUrl(typed.toLowerCase()));
      return;
    }
    setState('sending');
    try {
      await api.requestLink(typed, token);
      setState('sent');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      setState('error');
      // Turnstile tokens are single-use — clear the spent one (so submit re-disables), THEN
      // re-arm the widget. Clearing first means a fast re-fired callback (managed widget) sets
      // the fresh token last and isn't clobbered.
      setToken('');
      if (siteKey && window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
      }
    }
  }

  // An address on an SSO domain submits as a redirect to Microsoft, not an email send.
  const typedDomain = email.trim().toLowerCase().split('@')[1] ?? '';
  const steersToEntra = entraEnabled && typedDomain !== '' && entraDomains.includes(typedDomain);

  // When the challenge is enabled, block submit until it's solved — except when the
  // submit is a steer to Microsoft (Turnstile guards the email send; Microsoft runs
  // its own bot defenses on the SSO leg).
  const challengePending = Boolean(siteKey) && !token && !steersToEntra;

  return (
    <div className="centered">
      <div className="card login">
        <div className="brand big">
          <span className="brand-mark" />
          Work Queue Requests
        </div>
        {state === 'sent' ? (
          <>
            <p>
              If that address is registered, a login link is on its way. It expires in 15 minutes
              and works once.
            </p>
            {isPreProd() && (
              <p className="muted">
                On staging and local dev no email is sent yet, and the link is never logged. If your
                address is opted in, fetch it from the app's outbox with{' '}
                <code>wrangler kv key get</code> — see the GUIDEBOOK "First login".
              </p>
            )}
          </>
        ) : entraEnabled && entraOnly ? (
          // Entra-only policy: magic links are off for this app (the server enforces it;
          // this view just doesn't offer a dead form).
          <>
            <p className="muted">This app uses Microsoft sign-in.</p>
            <a className="btn-microsoft" href={oidcLoginUrl()}>
              <MicrosoftMark />
              Sign in with Microsoft
            </a>
          </>
        ) : (
          <form onSubmit={submit}>
            {entraEnabled && (
              <>
                <a className="btn-microsoft" href={oidcLoginUrl()}>
                  <MicrosoftMark />
                  Sign in with Microsoft
                </a>
                <div className="login-divider" aria-hidden="true">
                  <span>or</span>
                </div>
              </>
            )}
            <p className="muted">Log in with your work email — no password, just a magic link.</p>
            <input
              type="email"
              required
              placeholder="you@cialdnb.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {siteKey && <div ref={widgetRef} className="turnstile" />}
            <button type="submit" disabled={state === 'sending' || challengePending}>
              {state === 'sending'
                ? 'Sending…'
                : steersToEntra
                  ? 'Continue with Microsoft'
                  : 'Email me a login link'}
            </button>
            {challengeUnavailable && (
              <p className="error">
                Couldn't load the verification challenge. Refresh the page to try again.
              </p>
            )}
            {state === 'error' && <p className="error">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
