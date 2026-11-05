// DEFERRING THE READ-AUDIT FLUSH TO RESPONSE-BODY COMPLETION. Ported from CialDNB/insights
// (src/framework/readAuditStream.ts), unchanged in behaviour but for one case — a HEAD request
// flushes at once, because its body is discarded unread — and with logging moved to logEvent.
//
// `executeRoute` flushes the read ledger in the handler's `finally`. For a handler that returns a
// STREAMING response that is too early: the body goes on being written after the handler resolves
// (insights' GET /api/reports/prefetch/stream polls D1 once a second for up to 100 s; the agent
// loop's re-attachable event stream will read its turn rows the same way), and every one of those
// reads lands on a recorder that has already been closed — a counted drop, never a ledger row. The
// `d1` stream is request-scoped and a request is not over until its response is
// (docs/DATA-ROUTES.md), so the flush waits for the body.
//
// ── THE SAFETY PROPERTY, WHICH IS THE LOAD-BEARING PART ───────────────────────────────────
// readAudit.ts states "a bug here must not break reads". This module puts the ledger IN THE
// RESPONSE PATH, so it carries the matching one:
//
//     A BUG IN THE WRAPPER MUST NOT BREAK THE RESPONSE.
//
// Two halves. In deferFlushToBodyEnd: the wrapper is a pure pass-through that adds no buffering and
// no transformation, and the completion callback is guarded so a throw from the flush scheduler
// cannot poison the stream. In flushWhenBodyEnds: deferFlushToBodyEnd THROWS rather than improvise
// on a body shape it cannot handle, and the guard catches that and returns the ORIGINAL Response
// with an immediate flush — exactly the pre-deferral behaviour: reads recorded as far as they got,
// response perfect. Never the reverse.
// ──────────────────────────────────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';

/**
 * The hard timer. A body nobody ever reads must not pin a recorder for the life of the isolate,
 * so the flush happens anyway after this long — IF the isolate is still running it: nothing keeps
 * a finished request's context alive for this timer, so it is a backstop for a stuck stream, not a
 * delivery path. A body the consumer will never read (a HEAD request) is flushed at once instead
 * (flushWhenBodyEnds).
 *
 * 120 s, against the longest stream a kit app serves today (insights' 100 s prefetch stream). A
 * healthy stream always ends on its own close, cancel or error and this timer never fires for it,
 * which keeps it a backstop rather than a second, competing deadline. A route that streams longer
 * than this has its later reads dropped (counted), exactly as every stream's were before.
 */
export const READ_AUDIT_STREAM_MAX_MS = 120_000;

/**
 * The timer for this env. The override (`READ_AUDIT_STREAM_MAX_MS`) is a TEST KNOB, unset in every
 * real config, in the shape `MCP_WAITUNTIL_CAP_MS` established: anything that is not a positive
 * finite number falls back to the default rather than producing a zero or negative timeout.
 */
export function readAuditStreamTimeoutMs(env: Env): number {
  const raw = Number(env.READ_AUDIT_STREAM_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : READ_AUDIT_STREAM_MAX_MS;
}

/**
 * Return a Response that is byte-for-byte `res`, and call `onComplete` exactly once when its body
 * finishes, whichever comes first of: the body closing normally, the consumer cancelling (a
 * client disconnect), the body erroring, or `timeoutMs` elapsing.
 *
 * THROWS if the body cannot be wrapped (null, or already locked to another reader). That is the
 * signal for flushWhenBodyEnds' guard; see the header.
 */
export function deferFlushToBodyEnd(
  res: Response,
  onComplete: () => void,
  timeoutMs: number,
): Response {
  const source = res.body;
  if (!(source instanceof ReadableStream)) {
    throw new TypeError('read audit: response body is not a ReadableStream');
  }
  // Throws on an already-locked stream, before anything else has been built or scheduled.
  const reader = source.getReader();

  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      onComplete();
    } catch (err) {
      // The flush scheduler is best-effort by design and already swallows its own faults. This is
      // the terminal catch that keeps a surprise out of the response path.
      logEvent('read_audit_stream_complete_failed', { err });
    }
  };
  const timer = setTimeout(finish, timeoutMs);

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // The upstream body failed. The consumer must see that failure unchanged; the reads that
        // DID happen before it are still worth recording, so flush and then propagate.
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });

  // status / statusText / headers copied verbatim: executeRoute's audit-on-write step reads
  // `result.status` AFTER this wrapper is applied, and every header the route set (an SSE
  // content-type, `cache-control: no-store`) has to survive.
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * The read-ledger flush for a handler's result, in the one place executeRoute calls it (its
 * `finally`). Returns what the request should answer with.
 *
 *   - `result` is a Response with a ReadableStream body: the flush is deferred to the end of that
 *     body (deferFlushToBodyEnd) and the wrapped Response is returned.
 *   - anything else — a plain value (the common case: the HTTP adapter builds the envelope after
 *     executeRoute returns), a 204 with no body, or nothing at all because the handler THREW: the
 *     flush runs now and `result` comes back untouched.
 *   - the wrapper cannot be built (a locked body, anything unexpected): logged
 *     (`read_audit_stream_wrap_failed`), flushed now, and the ORIGINAL Response returned.
 *   - the request is a HEAD (`requestMethod`): flushed now and `result` returned untouched. The
 *     runtime answers HEAD by running the GET route and DISCARDING its body — unread and never
 *     cancelled (Hono: `new Response(null, res)`) — so a deferred flush would wait for the hard
 *     timer, which a finished request's context may never reach, and the handler's reads would be
 *     lost without even a drop count.
 *
 * WHOEVER CONSUMES THE RESPONSE MUST READ OR CANCEL ITS BODY — the HTTP runtime reads it, the MCP
 * adapter's unwrap reads it, and any new in-process caller of executeRoute (an agent tool invoke)
 * must too. A body dropped on the floor leaves its rows to the hard timer: a backstop for a stuck
 * stream, not a delivery path.
 *
 * THE TRIGGER IS THE BODY SHAPE, deliberately: not the content-type (which would miss a streaming
 * route that is not SSE) and not a route-level opt-in (one more thing to remember). In workerd a
 * buffered Response (`ok(data, 201)`, `new Response('…')`) also has a ReadableStream body and so also
 * takes the deferred path; that is safe, because such a body is drained promptly — by the runtime
 * over HTTP, by the MCP adapter's unwrap — and the hard timer backstops anything else.
 */
export function flushWhenBodyEnds(
  result: unknown,
  flush: () => void,
  timeoutMs: number,
  route: string,
  requestMethod: string,
): unknown {
  if (
    requestMethod !== 'HEAD' &&
    result instanceof Response &&
    result.body instanceof ReadableStream
  ) {
    try {
      return deferFlushToBodyEnd(result, flush, timeoutMs);
    } catch (err) {
      logEvent('read_audit_stream_wrap_failed', { route, err });
    }
  }
  flush();
  return result;
}
