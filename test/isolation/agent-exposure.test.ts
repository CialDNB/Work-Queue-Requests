// THE AGENT-EXPOSURE PIN. It lists, exactly, every route in the app's LIVE registry (`allRoutes`)
// that the in-app agent can call — the routes with an `agent:` block (src/framework/agentExposure.ts)
// — with what each one does and where its data goes. The test fails on ANY difference, in either
// direction: a route exposed that is not listed, a listed route no longer exposed, or a listed
// route whose effect, approval, egress, ruling or data class moved.
//
// Why: default deny keeps an unexposed route out of the agent's reach, but a route that IS exposed
// is one line in a route module, and the tool set grows with every such line. This makes each of
// them a visible, reviewed diff to a file whose only job is to say "the agent can do these things"
// — the list a reviewer, a DPO or an incident responder reads first. Changing the list is fine;
// changing it without noticing is what this stops.
//
// Why it lives in test/isolation/: like the uniformity tripwire next to it, it walks the live
// registry, so a new exposure is covered the moment it is written, and `/kit-upgrade` carries this
// directory into every fork (kit-upgrade SKILL.md step 3).
//
// ── THE PINNED LIST IS FORK-OWNED DATA ─────────────────────────────────────────────────────────
// The kit exposes NO route, so its list is empty. A fork's list is its own: on /kit-upgrade, adopt
// the kit's hunks to the mechanism below and KEEP YOUR ENTRIES in `PINNED_AGENT_EXPOSURE`. Taking
// the kit's empty list by mistake fails closed — every one of your exposures turns this red and is
// named in the failure — and never the other way round.
// ───────────────────────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentEffect,
  approvalMode,
  assertPrivateSourcesRuled,
  clientPrivateSources,
  isAgentExposed,
  readsClientClass,
} from '../../src/framework/agentExposure';
import { defineRoute, type RouteDef, type RouteSpec } from '../../src/framework/defineRoute';
import { toolName } from '../../src/framework/toolName';
import { allRoutes } from '../../src/routes';

interface PinnedExposure {
  /** The tool name the model sees (src/framework/toolName.ts). */
  tool: string;
  /** `<METHOD> <path>`. */
  route: string;
  permission: string;
  effect: AgentEffect;
  /** 'always' | 'never' | 'conditional' (a predicate) — see approvalMode(). */
  approval: 'always' | 'never' | 'conditional';
  /** Declared egress hosts, sorted. */
  egress: string[];
  /** The Linear decision (DPO ruling) that covers the route's data leaving, or null. */
  egressRuling: string | null;
  /**
   * Does the route reach client-class data? Its `needs` names a repository src/data/dataClass.ts
   * does not classify internal — or the app binds a client-class private database (AURORA_SOURCES),
   * which makes EVERY exposed route client-class, because an Aurora read is invisible to `needs`.
   */
  clientClass: boolean;
}

/**
 * EVERY route the in-app agent may call. Keep it sorted by `tool`. An entry here is a decision:
 * say in the PR why the agent needs the route, and link the `egressRuling` when there is one.
 */
const PINNED_AGENT_EXPOSURE: readonly PinnedExposure[] = [
  // The kit exposes no route to the agent. A fork lists its exposures here.
];

function exposureOf(routes: readonly RouteDef[]): PinnedExposure[] {
  return routes
    .map(({ spec }) => spec as RouteSpec<z.ZodTypeAny>)
    .filter(isAgentExposed)
    .map((spec) => {
      const agent = spec.agent ?? { effect: 'read' as const };
      return {
        tool: toolName(spec.method, spec.path),
        route: `${spec.method} ${spec.path}`,
        permission: spec.permission,
        effect: agent.effect,
        approval: approvalMode(agent),
        egress: [...(agent.egress ?? [])].sort(),
        egressRuling: agent.egressRuling ?? null,
        clientClass: readsClientClass(spec),
      };
    })
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

const HINT = [
  '',
  'THE SET OF ROUTES THE IN-APP AGENT CAN CALL HAS CHANGED.',
  '',
  'Every route with an `agent:` block is an action a model can take on a person’s behalf. If the',
  'change is intended, update PINNED_AGENT_EXPOSURE in test/isolation/agent-exposure.test.ts to',
  'match — in the same PR, so the reviewer sees the exposure itself, not just the route code. A',
  'new egressRuling or a new client-class exposure also needs the DPO ruling it names (PIA C3).',
  '',
].join('\n');

describe('agent exposure pin', () => {
  it('the live registry exposes exactly the pinned routes, as pinned', () => {
    expect(exposureOf(allRoutes), HINT).toEqual(PINNED_AGENT_EXPOSURE);
  });

  // PIA C3, the app's half (assertPrivateSourcesRuled): in an app that binds a client-class private
  // database, no route declaration can rule an Aurora read out, so every exposed route must carry an
  // egressRuling. Checked here over the live registry, so it goes red in CI rather than at the first
  // agent turn (buildAgentTools throws there too).
  it('in an app that binds a client-class private database, every exposure carries a ruling', () => {
    const hint = `client-class private sources bound: ${clientPrivateSources().join(', ') || 'none'}`;
    expect(() => assertPrivateSourcesRuled(allRoutes.map((r) => r.spec)), hint).not.toThrow();
  });

  it('the pinned list is sorted and names each tool once', () => {
    const tools = PINNED_AGENT_EXPOSURE.map((p) => p.tool);
    expect(tools).toEqual([...tools].sort((a, b) => a.localeCompare(b)));
    expect(new Set(tools).size).toBe(tools.length);
  });

  // The agent's own transcript store (migration 0006) is AGENT_FORBIDDEN_REPOSITORIES: no tool may
  // read a transcript, so the agent has no memory beyond the thread it runs in and no route hands it
  // another person's. A route that names either half in `needs` does not load, under any key.
  it('a route over the transcript store can never be exposed — it fails at load', () => {
    for (const store of ['agent', 'agentErasure'] as const) {
      let reached = false;
      expect(
        () =>
          defineRoute({
            method: 'GET',
            path: `/api/pin-fixture/${store}`,
            permission: 'notes.read',
            needs: ['notes', store],
            input: z.object({}),
            agent: { effect: 'read' },
            handler: async () => {
              reached = true;
              return {};
            },
          }),
        store,
      ).toThrow(new RegExp(`needs reaches ${store} — repositories no agent tool may touch`));
      expect(reached).toBe(false);
    }
  });

  // The mechanism, proven against a synthetic registry so the pin above is never vacuous — in the
  // kit it compares two empty lists, and this is what shows the comparison would see an exposure.
  it('projects an exposed route with every pinned fact, and skips an unexposed one', () => {
    const exposed = defineRoute({
      method: 'POST',
      path: '/api/pin-fixture/:id/send',
      permission: 'notes.write',
      needs: ['companies' as 'notes', 'notes'],
      audit: 'pin_fixture.send',
      uniformityFixture: { seed: async () => ({ id: 'x' }) },
      input: z.object({ id: z.uuid(), note: z.string().max(100) }),
      agent: {
        effect: 'external',
        needsApproval: () => true,
        egress: ['mail.example.test', 'api.example.test'],
        egressRuling: 'C36-1561',
      },
      handler: async () => ({}),
    });
    const hidden = defineRoute({
      method: 'GET',
      path: '/api/pin-fixture',
      permission: 'notes.read',
      input: z.object({}),
      handler: async () => ({}),
    });
    expect(exposureOf([hidden, exposed])).toEqual([
      {
        tool: 'post_pin_fixture_by_id_send',
        route: 'POST /api/pin-fixture/:id/send',
        permission: 'notes.write',
        effect: 'external',
        approval: 'conditional',
        egress: ['api.example.test', 'mail.example.test'],
        egressRuling: 'C36-1561',
        clientClass: true,
      },
    ]);
  });
});
