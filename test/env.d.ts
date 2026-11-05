// Makes `import { env } from 'cloudflare:test'` carry the app's Env shape.
// vitest-pool-workers types `env` as the global Cloudflare.Env interface, so we
// merge the app Env into it here (test-only augmentation).
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
