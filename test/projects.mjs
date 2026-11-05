// The runtime manifests (docs/TESTING.md, "Put tests at the cheapest faithful layer"): reviewed
// opt-ins, one exact path per line. Every unlisted test runs in the full application in Workers,
// and so does every new one. vitest.config.ts imports these lists; scripts read them as data, so
// keep each one `export const <name> = [...]` of plain strings.
//
// Moving a file here is a reviewed change: scripts/test-runtime-boundary.mjs must find nothing in
// its transitive imports, the auth, framework, route, cron, security, isolation, audit and
// read-log suites never move (test/platform/test-projects.test.mjs), and the combined coverage
// run must stay green before and after.

// Plain Node: pure calculations with no binding, Workers API or Wrangler Text import.
export const nodeTestFiles = [
  'test/ai/mask.test.ts',
  'test/ai/pricing.test.ts',
  'test/platform/naming.test.ts',
  'test/setup/node-no-network.test.ts',
];

// A real Workers runtime with the full test bindings, but not the application's entrypoint.
export const minimalWorkersTestFiles = [
  'test/ai/sse.test.ts',
  'test/crypto/seal.test.ts',
  'test/email/templates.test.ts',
  'test/helpers/db-rename.test.ts',
  'test/helpers/db.test.ts',
  'test/helpers/migration-by-slug.test.ts',
  'test/platform/bootstrap.test.ts',
  'test/platform/log-event.test.ts',
];
