// THE CARRIED ARMING TESTS, RUN AS A FORK THAT BINDS A CLIENT-CLASS SOURCE RUNS THEM.
//
// test/ai/agent-arming.test.ts rides /kit-upgrade unchanged, and in a fork it reads that fork's own
// AURORA_SOURCES. The kit's table is empty, so a case that holds only on an empty table stays green
// here and turns the fork red on its next upgrade (pre-merge review of #262: Insights and arena-go
// bind `c360_ro` as client). This file runs the whole carried file again under the table such a
// fork ships. Kit-only: test/platform is not in /kit-upgrade's diff set.
import { describe, expect, it, vi } from 'vitest';
import { AURORA_SOURCES } from '../../src/data/aurora';
import { clientPrivateSources } from '../../src/framework/agentExposure';
import '../ai/agent-arming.test';

// Insights and arena-go both bind `c360_ro` as client; arena-go also binds `ret1_ro` as internal.
// Inline (vi.hoisted), not imported: anything that loads the route framework would load this module.
const { FORK_SOURCES } = vi.hoisted(() => ({
  FORK_SOURCES: Object.freeze({ ret1_ro: 'internal', c360_ro: 'client' }),
}));

vi.mock('../../src/data/aurora', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/data/aurora')>()),
  AURORA_SOURCES: FORK_SOURCES,
}));

describe('fork shape: the app binds a client-class private database', () => {
  it('runs the carried tests under that table (the mock took)', () => {
    expect(AURORA_SOURCES).toEqual({ ret1_ro: 'internal', c360_ro: 'client' });
    expect(clientPrivateSources()).toEqual(['c360_ro']);
  });
});
