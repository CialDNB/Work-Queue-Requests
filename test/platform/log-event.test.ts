// logEvent — the closed-registry logger (src/platform/logEvent.ts), PIA condition C5.
//
// Workers Logs keep every line 7 days with no per-entry deletion, so what this module lets through
// is what the account keeps. These pin the runtime half of the control: the registry's keys and
// kinds are enforced on values that arrive at runtime (casts, `any`, data that was never meant to
// be a string), content-shaped strings become markers, and an error becomes its category.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/framework/errors';
import {
  createLogger,
  field,
  KIT_LOG_EVENTS,
  LOGS_CARRY_CLASS_ONLY,
  logEvent,
  REDACTED,
  reduceError,
} from '../../src/platform/logEvent';
import { captureLogs } from '../helpers/logs';

// A registry exercising every kind, so each screen is tested on its own field.
const probe = createLogger({
  probe: {
    level: 'warn',
    fields: {
      id: field.id,
      path: field.path,
      route: field.route,
      guid: field.guid,
      domain: field.domain,
      method: field.method,
      count: field.count,
      num: field.num,
      status: field.status,
      bool: field.bool,
      outcome: field.oneOf('sent', 'skipped'),
      err: field.err,
    },
  },
});

/** Log one probe line and return what reached the console, parsed. */
function probeLine(fields: Record<string, unknown>): Record<string, unknown> {
  const logs = captureLogs();
  try {
    probe('probe', fields as never);
  } finally {
    logs.restore();
  }
  expect(logs.lines).toHaveLength(1);
  return JSON.parse(logs.lines[0] as string) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe('logEvent — the registry fields pass', () => {
  it('writes ONE JSON line to the level’s console method: the event name plus its fields', () => {
    const logs = captureLogs();
    try {
      logEvent('route_error', {
        method: 'GET',
        path: '/api/notes/:id',
        err: new AppError(404, 'not_found', 'Not found'),
      });
      logEvent('audit_watch_clear', { scanned: 12 });
      logEvent('read_audit_events_dropped', { route: 'GET /api/notes', dropped: 3 });
    } finally {
      logs.restore();
    }
    expect(logs.events).toEqual([
      {
        event: 'route_error',
        method: 'GET',
        path: '/api/notes/:id',
        err: { name: 'AppError', code: 'not_found', status: 404 },
        level: 'error',
      },
      { event: 'audit_watch_clear', scanned: 12, level: 'info' },
      { event: 'read_audit_events_dropped', route: 'GET /api/notes', dropped: 3, level: 'warn' },
    ]);
    expect(logs.lines).toHaveLength(3); // one line per event, nothing else printed
  });

  it('keeps every kind’s legitimate values as-is', () => {
    expect(
      probeLine({
        id: 'note.create',
        path: '/auth/request',
        route: 'POST /api/users/:email/revoke-sessions',
        guid: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        domain: 'Unknown-Probe.Example',
        method: 'DELETE',
        count: 0,
        num: -1.5,
        status: 529,
        bool: false,
        outcome: 'skipped',
      }),
    ).toEqual({
      event: 'probe',
      id: 'note.create',
      path: '/auth/request',
      route: 'POST /api/users/:email/revoke-sessions',
      guid: '72f988bf-86f1-41af-91ab-2d7cd011db47',
      domain: 'unknown-probe.example', // lowercased
      method: 'DELETE',
      count: 0,
      num: -1.5,
      status: 529,
      bool: false,
      outcome: 'skipped',
    });
  });

  it('an event that declares no fields refuses every key at COMPILE time too', () => {
    // The `@ts-expect-error` lines are the assertion: `npm run typecheck` fails if the type ever
    // accepts them again (an unused directive is an error). The runtime drops the keys regardless.
    const logs = captureLogs();
    try {
      // @ts-expect-error — email_skipped_no_binding declares no fields; `to` is the old leak shape
      logEvent('email_skipped_no_binding', { to: 'alice@client.example', subject: 's' });
      // @ts-expect-error — the same for every field-less event
      logEvent('audit_alert_schedule_failed', { err: new Error('x') });
      logEvent('email_skipped_no_binding', {});
      logEvent('email_skipped_no_binding');
      // @ts-expect-error — and an event WITH fields still refuses a key it did not declare
      logEvent('email_send_failed', { err: new Error('x'), to: 'alice@client.example' });
    } finally {
      logs.restore();
    }
    expect(logs.events.map((e) => e._dropped_keys ?? 0)).toEqual([2, 1, 0, 0, 1]);
    logs.expectAbsent('alice');
  });

  it('omits an absent (undefined) field and logs an event with no fields as its name alone', () => {
    expect(probeLine({ id: undefined, count: 1 })).toEqual({ event: 'probe', count: 1 });
    const logs = captureLogs();
    try {
      logEvent('audit_alert_schedule_failed');
    } finally {
      logs.restore();
    }
    expect(logs.lines).toEqual(['{"event":"audit_alert_schedule_failed"}']);
  });
});

describe('logEvent — content never passes', () => {
  it('rejects an EMAIL in every string kind', () => {
    const email = 'alice.smith@client.example';
    const line = probeLine({
      id: email,
      path: `/api/users/${email}`,
      route: `GET /api/users/${email}`,
      guid: email,
      domain: email,
    });
    expect(line).toMatchObject({
      id: REDACTED.email,
      path: REDACTED.email,
      route: REDACTED.email,
      guid: REDACTED.email,
      domain: REDACTED.email,
    });
    expect(JSON.stringify(line)).not.toContain('alice');
  });

  it('rejects a URL — a magic link, a query string, a bare www host', () => {
    const link = 'https://app.cialdnb.ai/auth/verify?token=3f9a0c2b7d';
    expect(probeLine({ id: link, domain: link }).id).toBe(REDACTED.url);
    expect(probeLine({ path: '/auth/verify?token=3f9a0c2b7d' }).path).toBe(REDACTED.url);
    expect(probeLine({ id: 'token=3f9a0c2b7d' }).id).toBe(REDACTED.url);
    expect(probeLine({ domain: 'www.example.com' }).domain).toBe(REDACTED.url);
    expect(probeLine({ route: 'GET /x#frag' }).route).toBe(REDACTED.url);
    expect(JSON.stringify(probeLine({ id: link, path: link }))).not.toContain('3f9a0c2b7d');
  });

  it('rejects FREE TEXT — a message, a prompt, a sentence with a name in it', () => {
    const text = 'Cannot summarize the note for Maria Silva';
    const line = probeLine({ id: text, path: `/api/${text}`, domain: text, guid: text });
    expect(line).toMatchObject({
      id: REDACTED.text,
      path: REDACTED.text,
      domain: REDACTED.text,
      guid: REDACTED.long, // a GUID is 36 characters; the cap fires before the text screen
    });
    expect(JSON.stringify(line)).not.toContain('Maria');
    // A route is the one kind with a space in it — but only METHOD + one path, never a sentence.
    expect(probeLine({ route: 'GET /api/notes please' }).route).toBe(REDACTED.format);
  });

  it('caps length: an over-long value is a marker, not a truncation', () => {
    const line = probeLine({ id: `a${'x'.repeat(64)}`, path: `/${'a'.repeat(200)}` });
    expect(line).toMatchObject({ id: REDACTED.long, path: REDACTED.long });
  });

  it('rejects identifier-shaped values that are really NUMBERS — a CPF, a DUNS, a record id', () => {
    // An id must start with a letter, which a national id or DUNS never does, and a bare run of
    // 9+ digits is refused before the shape is even checked…
    expect(probeLine({ id: '123.456.789-09' }).id).toBe(REDACTED.format);
    expect(probeLine({ id: '150483782' }).id).toBe(REDACTED.number);
    // …and a route PATTERN never carries a long digit run (`:duns` stands in for it).
    expect(probeLine({ path: '/api/reports/by-duns/150483782' }).path).toBe(REDACTED.number);
    expect(probeLine({ route: 'GET /api/reports/by-duns/150483782' }).route).toBe(REDACTED.number);
  });

  it('rejects CREDENTIAL shapes in every string kind — the kit bearer, API keys, JWTs, digests', () => {
    const bearer = `t_${'0123456789abcdef'.repeat(2)}01234567`; // `t_` + 40 hex, src/auth/tokens.ts
    const shapes = [
      bearer,
      'sk-ant-api03-abcdefABCDEF0123456789abcdefABCD',
      ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'),
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXJpYSJ9.sig', // a short JWT still passes the 64 cap
      'da39a3ee5e6b4b0d3255bfef95601890afd80709', // a 40-hex digest
      'Xk7pQ2mN9vR4tY8wZ3bC6dF1', // a mixed letter-and-digit run with no separators
    ];
    for (const value of shapes) {
      expect(probeLine({ id: value }).id, value).toBe(REDACTED.secret);
    }
    expect(probeLine({ path: `/api/tokens/${bearer}` }).path).toBe(REDACTED.secret);
    expect(probeLine({ domain: `${'ab12'.repeat(6)}.example` }).domain).toBe(REDACTED.secret);
    expect(reduceError(Object.assign(new Error('x'), { code: bearer }))).toEqual({
      name: 'Error',
      code: REDACTED.secret,
    });
  });

  it('rejects a 9+ digit run anywhere — a CPF, a CNPJ, a DUNS behind a letter — and a long numeric code', () => {
    expect(probeLine({ id: 'x12345678909' }).id).toBe(REDACTED.number);
    expect(probeLine({ id: 'duns:150483782' }).id).toBe(REDACTED.number);
    expect(reduceError(Object.assign(new Error('x'), { code: 12345678909 }))).toEqual({
      name: 'Error',
      code: REDACTED.number,
    });
    expect(reduceError(Object.assign(new Error('x'), { code: 'cpf_12345678909' }))).toEqual({
      name: 'Error',
      code: REDACTED.number,
    });
  });

  it('keeps the operational identifiers those screens must not eat', () => {
    for (const id of [
      'gateway_2009',
      'overloaded_error',
      'claude-haiku-4-5-20251001', // a dated model snapshot: an 8-digit run
      'undeclared_repo:notes',
      'SQLITE_CONSTRAINT_UNIQUE',
      'read_audit_declared_writes_failed',
      'skipped',
    ]) {
      expect(probeLine({ id }).id, id).toBe(id);
    }
    expect(reduceError(Object.assign(new Error('x'), { code: 10013 }))).toEqual({
      name: 'Error',
      code: 10013,
    });
    expect(reduceError(Object.assign(new Error('x'), { code: -999_999 }))).toMatchObject({
      code: -999_999,
    });
  });

  it('holds each kind to its shape', () => {
    expect(probeLine({ guid: 'not-a-guid' }).guid).toBe(REDACTED.format);
    expect(probeLine({ domain: 'bad_domain!' }).domain).toBe(REDACTED.format);
    expect(probeLine({ method: 'BREW' }).method).toBe(REDACTED.enum);
    expect(probeLine({ route: 'BREW /coffee' }).route).toBe(REDACTED.format);
    expect(probeLine({ path: 'relative/path' }).path).toBe(REDACTED.format);
    expect(probeLine({ id: 'has"quote' }).id).toBe(REDACTED.format);
  });

  it('rejects a value of the wrong TYPE, and an enum value nobody declared', () => {
    const line = probeLine({
      id: 42,
      count: -1,
      num: Number.NaN,
      status: 99,
      bool: 'true',
      outcome: 'bounced',
    });
    expect(line).toMatchObject({
      id: REDACTED.type,
      count: REDACTED.type,
      num: REDACTED.type,
      status: REDACTED.type,
      bool: REDACTED.type,
      outcome: REDACTED.enum,
    });
    expect(probeLine({ count: 1.5 }).count).toBe(REDACTED.type);
    expect(probeLine({ id: { toString: () => 'alice@x.example' } }).id).toBe(REDACTED.type);
  });

  it('DROPS keys the registry does not declare, and counts them — the value never appears', () => {
    const logs = captureLogs();
    try {
      logEvent('email_send_failed', {
        err: new Error('x'),
        to: 'alice@client.example',
        subject: 'Your login link',
      } as never);
    } finally {
      logs.restore();
    }
    expect(logs.events).toEqual([
      { event: 'email_send_failed', err: { name: 'Error' }, _dropped_keys: 2, level: 'error' },
    ]);
    logs.expectAbsent('alice', 'login link', '"to"', '"subject"');
  });

  it('refuses an event the registry does not know — without echoing its name', () => {
    const logs = captureLogs();
    try {
      (logEvent as (event: string, fields?: unknown) => void)('alice@client.example asked', {
        err: new Error('boom'),
      });
    } finally {
      logs.restore();
    }
    expect(logs.events).toEqual([
      { event: 'log_event_rejected', reason: 'unknown_event', level: 'error' },
    ]);
    logs.expectAbsent('alice', 'boom');
  });

  it('ignores inherited keys: a registry lookup is own-property only', () => {
    const logs = captureLogs();
    try {
      (logEvent as (event: string) => void)('toString');
      probe('probe', { constructor: 'x' } as never);
    } finally {
      logs.restore();
    }
    expect(logs.events.map((e) => e.event)).toEqual(['log_event_rejected', 'probe']);
    expect(logs.events[1]).toEqual({ event: 'probe', _dropped_keys: 1, level: 'warn' });
  });
});

describe('logEvent — an error becomes its CATEGORY', () => {
  it('keeps name, code and status; never the message, stack or cause', () => {
    const err = new Error('UNIQUE constraint failed: users.email = alice@client.example', {
      cause: new Error('https://app.test/auth/verify?token=abc123'),
    });
    expect(reduceError(err)).toEqual({ name: 'Error' });
    const line = JSON.stringify(probeLine({ err }));
    expect(line).not.toContain('alice');
    expect(line).not.toContain('constraint');
    expect(line).not.toContain('abc123');
    expect(line).not.toContain('at '); // no stack frames
  });

  it('keeps an AppError’s code and status, a DOMException’s name, a Node-style code', () => {
    expect(reduceError(new AppError(429, 'ai_budget_daily', 'AI budget limit reached'))).toEqual({
      name: 'AppError',
      code: 'ai_budget_daily',
      status: 429,
    });
    expect(reduceError(new DOMException('The operation timed out.', 'TimeoutError'))).toMatchObject(
      { name: 'TimeoutError' },
    );
    expect(reduceError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({
      name: 'Error',
      code: 'ECONNRESET',
    });
    class ProviderError extends Error {
      override name = 'ProviderError';
      status = 503;
    }
    expect(reduceError(new ProviderError('upstream said: Maria'))).toEqual({
      name: 'ProviderError',
      status: 503,
    });
  });

  it('screens name and code too — they are strings a thrower controls', () => {
    const err = Object.assign(new Error('x'), {
      name: 'Error for alice@client.example',
      code: 'see https://x.example/?token=1',
      status: 9000,
    });
    expect(reduceError(err)).toEqual({ name: REDACTED.email, code: REDACTED.url });
  });

  it('handles thrown non-errors and hostile objects without throwing', () => {
    expect(reduceError('alice@client.example')).toEqual({ name: 'thrown_string' });
    expect(reduceError(42)).toEqual({ name: 'thrown_number' });
    expect(reduceError(null)).toEqual({ name: 'thrown_null' });
    expect(reduceError(undefined)).toEqual({ name: 'thrown_undefined' });
    expect(reduceError({ message: 'alice@client.example' })).toEqual({ name: 'unnamed' });
    const hostile = {
      get name(): string {
        throw new Error('getter');
      },
      get code(): string {
        throw new Error('getter');
      },
    };
    expect(reduceError(hostile)).toEqual({ name: 'unnamed' });
  });
});

describe('logEvent — never throws', () => {
  it('a field whose getter throws becomes a marker; the line still goes out', () => {
    const fields = {
      get id(): string {
        throw new Error('alice@client.example');
      },
      count: 2,
    };
    expect(probeLine(fields)).toEqual({ event: 'probe', id: REDACTED.unreadable, count: 2 });
  });

  it('a broken console cannot break the caller', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(() => logEvent('audit_fail_alert_failed')).not.toThrow();
  });

  it('non-object fields are ignored rather than trusted', () => {
    expect(probeLine('alice@client.example' as never)).toEqual({ event: 'probe' });
  });
});

describe('LOGS_CARRY_CLASS_ONLY — the alert texts’ pointer to the logs', () => {
  it('says what the logs hold and how to get the detail, not "see wrangler tail"', () => {
    expect(LOGS_CARRY_CLASS_ONLY).toContain('error class only');
    expect(LOGS_CARRY_CLASS_ONLY).toContain('reproduce locally');
    expect(LOGS_CARRY_CLASS_ONLY).not.toContain('wrangler tail');
  });
});

describe('createLogger — definition-time guard', () => {
  it('builds an app’s own closed registry with the same checks', () => {
    const appLog = createLogger({
      sync_failed: {
        level: 'error',
        fields: { source: field.id, rows: field.count, err: field.err },
      },
    });
    const logs = captureLogs();
    try {
      appLog('sync_failed', { source: 'crm', rows: 3, err: new Error('row for alice@x.example') });
    } finally {
      logs.restore();
    }
    expect(logs.events).toEqual([
      { event: 'sync_failed', source: 'crm', rows: 3, err: { name: 'Error' }, level: 'error' },
    ]);
  });

  it('throws on a malformed registry, so it fails at import — never on a request', () => {
    expect(() => createLogger({ 'bad name': { level: 'warn', fields: {} } })).toThrow(/event name/);
    expect(() => createLogger({ ok: { level: 'warn', fields: { event: field.id } } })).toThrow(
      /reserved/,
    );
    expect(() => createLogger({ ok: { level: 'warn', fields: { _n: field.count } } })).toThrow(
      /reserved/,
    );
    expect(() =>
      createLogger({ ok: { level: 'warn', fields: { who: field.oneOf('alice@x.example') } } }),
    ).toThrow(/unsafe enum/);
    expect(() =>
      createLogger({ ok: { level: 'warn', fields: { who: field.oneOf('free text') } } }),
    ).toThrow(/unsafe enum/);
  });

  it('the kit registry itself passes the guard, and every event has a valid level', () => {
    expect(() => createLogger(KIT_LOG_EVENTS)).not.toThrow();
    for (const spec of Object.values(KIT_LOG_EVENTS)) {
      expect(['info', 'warn', 'error']).toContain(spec.level);
    }
  });
});
