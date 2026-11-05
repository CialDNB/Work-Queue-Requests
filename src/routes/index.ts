// The route registry. test/isolation/uniformity.test.ts iterates this array, so a
// route that isn't registered here doesn't exist — and a registered :param route
// without a uniformityFixture fails the suite.
import { serviceIdentityRoutes } from '../auth/serviceIdentityRoutes';
import type { RouteDef } from '../framework/defineRoute';
import { aiRoutes } from './ai';
import { auditRoutes } from './audit';
import { meRoutes } from './me';
import { createMetaRoutes } from './meta';
import { notesRoutes } from './notes';
import { readLogRoutes } from './readLog';
import { settingsRoutes } from './settings';
import { tokensRoutes } from './tokens';
import { usersRoutes } from './users';

// The meta route needs the WHOLE registry (its manifest lists every route, itself included),
// so it is wired with a lazy `() => allRoutes` accessor rather than importing this barrel back
// — no import cycle, and the accessor reads `allRoutes` only at request time (fully populated
// by then), so closing over the const here is safe. See src/routes/meta.ts.
export const allRoutes: readonly RouteDef[] = [
  ...meRoutes,
  ...createMetaRoutes(() => allRoutes),
  ...notesRoutes,
  ...usersRoutes,
  ...tokensRoutes,
  // KIT-OWNED routes (src/auth/serviceIdentityRoutes.ts — they travel with /kit-upgrade). This
  // line is the one fork-owned piece: keep it, or the kit's service-identity admin is never served.
  ...serviceIdentityRoutes,
  ...auditRoutes,
  ...readLogRoutes,
  ...aiRoutes,
  ...settingsRoutes,
];
