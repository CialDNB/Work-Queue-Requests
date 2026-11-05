// Capture what the Worker prints, the way Workers Logs would keep it. Every console method is
// silenced and recorded — not only the ones logEvent uses — so a leak through a stray
// console.log/debug would still show up in `text` and fail a no-content assertion.
//
//   const logs = captureLogs();
//   try { …exercise… } finally { logs.restore(); }
//   expect(logs.named('route_error')[0]?.err).toEqual({ name: 'Error' });
//   logs.expectAbsent('alice@client.example', 'token=');
import { expect, vi } from 'vitest';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof METHODS)[number];

/** One parsed logEvent line: `{ event, ...fields }`, plus the console method it went to. */
export type LoggedEvent = Record<string, unknown> & { event: string; level: ConsoleMethod };

export interface CapturedLogs {
  /** Every line, every method, each call's arguments stringified and joined. */
  readonly lines: string[];
  /** The lines that parsed as logEvent records, in order. */
  readonly events: LoggedEvent[];
  /** Events with this name. */
  named(event: string): LoggedEvent[];
  /** Fails if any captured line contains any of `needles` (case-insensitive). */
  expectAbsent(...needles: string[]): void;
  restore(): void;
}

function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export function captureLogs(): CapturedLogs {
  const lines: string[] = [];
  const events: LoggedEvent[] = [];
  const spies = METHODS.map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      const line = args.map(stringify).join(' ');
      lines.push(line);
      if (args.length === 1 && typeof args[0] === 'string') {
        try {
          const parsed = JSON.parse(args[0]) as unknown;
          if (parsed && typeof parsed === 'object' && 'event' in parsed) {
            events.push({ ...(parsed as { event: string }), level });
          }
        } catch {
          // not a logEvent line — kept in `lines` only
        }
      }
    }),
  );
  return {
    lines,
    events,
    named: (event) => events.filter((e) => e.event === event),
    expectAbsent(...needles) {
      for (const needle of needles) {
        const hit = lines.find((l) => l.toLowerCase().includes(needle.toLowerCase()));
        expect(hit, `log line leaked ${JSON.stringify(needle)}`).toBeUndefined();
      }
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/**
 * The logEvent names in a console spy's recorded calls, in order — for tests that spy one console
 * method directly (`eventNames(errorSpy.mock.calls)`). A call that is not a logEvent line maps to
 * its raw first argument, so a stray `console.error('x', …)` still shows up as `x`.
 */
export function eventNames(calls: readonly (readonly unknown[])[]): string[] {
  return calls.map((args) => {
    const first = args[0];
    if (typeof first !== 'string') return String(first);
    try {
      const parsed = JSON.parse(first) as { event?: unknown };
      return typeof parsed.event === 'string' ? parsed.event : first;
    } catch {
      return first;
    }
  });
}

/**
 * The logEvent records in a console spy's recorded calls, parsed, in order — for tests that spy one
 * console method directly and assert a record's fields (`loggedEvents(errorSpy.mock.calls)`). A
 * call that is not a single logEvent line is skipped; `eventNames` shows those.
 */
export function loggedEvents(
  calls: readonly (readonly unknown[])[],
): (Record<string, unknown> & { event: string })[] {
  const records: (Record<string, unknown> & { event: string })[] = [];
  for (const args of calls) {
    if (args.length !== 1 || typeof args[0] !== 'string') continue;
    try {
      const parsed = JSON.parse(args[0]) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { event?: unknown }).event === 'string'
      ) {
        records.push(parsed as Record<string, unknown> & { event: string });
      }
    } catch {
      // not a logEvent line
    }
  }
  return records;
}
