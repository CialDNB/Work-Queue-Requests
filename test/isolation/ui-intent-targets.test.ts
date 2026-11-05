// TRIPWIRE: what the in-app agent may point the user's screen at (src/ai/uiIntents.ts).
//
// Pins the protected core cannot hold on its own, because the worker imports neither web/ nor the
// route table. Each one checks the app's OWN registries against the app's OWN SPA and routes, so it
// holds in every fork unchanged (the rule's negative cases live in test/ai/ui-intents.test.ts, on
// synthetic fixtures):
//   1. Every view the agent may open (AGENT_VIEWS, src/ai/uiTargets.ts — the copy the server
//      trusts) is a view the SPA registers (web/src/views.ts), with the same permission and path,
//      in the same relative order. The agent's list is a SUBSET: a view is navigable only when it
//      opts in, so a view the SPA adds is not the agent's until someone says so. A view re-gated or
//      re-pathed on one side only fails here.
//   2. Server and SPA read the same :params from a path, and accept the same param values.
//   3. Every form the agent may prefill targets a real route that creates, with the permission the
//      form claims and fields the route accepts (prefillRouteProblems).
import { describe, expect, it } from 'vitest';
import { ID_SHAPED, pathParamNames, prefillRouteProblems } from '../../src/ai/uiIntents';
import { AGENT_FORMS, AGENT_VIEWS, type AgentForm, type AgentView } from '../../src/ai/uiTargets';
import { allRoutes } from '../../src/routes';
import { APP_VIEWS, PARAM_VALUE, pathParamNames as webPathParamNames } from '../../web/src/views';

// Read through the interface types, never the declarations' own. uiTargets.ts is app-owned, so a
// fork may declare its registries `as const`, and with no entries yet `[] as const` (or a bare
// `[]`) types an element as `never`: a loop body that reads `form.id` from it would not compile,
// and fork CI would fail here on a file it must take whole (test/platform/ui-targets-fork.test.mjs).
const agentViews: readonly AgentView[] = AGENT_VIEWS;
const agentForms: readonly AgentForm[] = AGENT_FORMS;

describe('UI-intent views ↔ the SPA view registry (drift guard)', () => {
  it('every AGENT_VIEWS entry is an APP_VIEWS entry: same id, permission and path, same order', () => {
    const web = APP_VIEWS.map(({ id, permission, path }) => ({ id, permission, path }));
    let from = 0;
    for (const { id, permission, path } of agentViews) {
      const at = web.findIndex((v) => v.id === id);
      expect(at, `'${id}' is not a view in web/src/views.ts`).toBeGreaterThanOrEqual(0);
      expect(web[at], id).toEqual({ id, permission, path });
      expect(at, `'${id}' is out of the SPA's order`).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  it('server and SPA read the same :params from a path, and accept the same param values', () => {
    for (const v of APP_VIEWS) {
      expect(pathParamNames(v.path), v.id).toEqual(webPathParamNames(v.path));
    }
    const sample = '/cases/:caseId/entries/:entry';
    expect(pathParamNames(sample)).toEqual(webPathParamNames(sample));
    expect(PARAM_VALUE.source).toBe(ID_SHAPED.source);
    expect(PARAM_VALUE.flags).toBe(ID_SHAPED.flags);
  });
});

describe('UI-intent prefill targets ↔ the route registry', () => {
  it('every opted-in form targets a real route that creates, and that it may stage', () => {
    for (const form of agentForms) {
      expect(prefillRouteProblems(form, allRoutes), form.id).toEqual([]);
    }
  });
});
