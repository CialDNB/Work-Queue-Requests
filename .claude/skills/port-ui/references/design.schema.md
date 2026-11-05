# `.paved-road/design.json` - v1

The machine-readable half of a design contract. Written by `/port-ui` Phase 1, read by:

- the `warn-design-drift` hook, which is silent unless `mode` is `"port"`;
- `parity.mjs`, which reads `screens` and `viewports`;
- every later session, as "where is the original, and what does it map to".

```jsonc
{
  "version": 1,
  "mode": "port",                       // "port" (look comes from a source app) | "greenfield"
  "source": {
    "name": "Original App",
    "path": "../original-app/frontend",  // local checkout, RELATIVE to the repo root (an absolute
                                         // path names your machine, and can contain the kit's name)
    "repo": "org/original-app",          // where it lives, for people without the checkout
    "ref": "3f2c1a9…",                   // the full commit SHA the port was taken from (a SHA
                                         // pins it; a branch name moves, and can trip verify:bootstrap
                                         // when it contains the kit's own name)
    "runUrl": "http://localhost:5175",   // where it runs locally (how to start it: the contract)
    "data": "synthetic",                 // REQUIRED for parity: the original runs on synthetic
                                         // (or scrubbed) data, never its real database
  },
  "contract": "docs/design/DESIGN-CONTRACT.md",
  "theme": "web/src/theme/",            // the ONLY place raw colours/fonts belong
  "viewports": [
    { "width": 1440, "height": 900 },
    { "width": 390, "height": 844 },
  ],
  "screens": [
    // One per screen-map row. Paths are concrete per side: the two apps run on different
    // databases, so ids never line up. waitFor (optional) is a CSS selector that means "loaded".
    { "id": "dashboard", "label": "Dashboard", "source": "/", "target": "/dashboard", "waitFor": ".kpis" },
    { "id": "board", "source": "/positions/abc123", "target": "/positions/p_1" },
  ],
}
```

Rules:

- The real file is **strict JSON**: no comments, no trailing commas. The example above is
  annotated for reading only. An unparseable file is treated as absent.
- `version` is the number `1`. On any other version the `warn-design-drift` hook stays silent,
  and the parity runner refuses to run.
- `mode` is required. The hook and the parity runner act only on `"port"`.
- `source.data` is `"synthetic"`: the original runs on synthetic or scrubbed data for the port
  (/port-ui Phase 0). It is an attestation, and the parity runner refuses to shoot the source
  without it, because the screenshots go to a subagent and a published report.
- `screens[].id` is unique and kebab-case (it names the screenshot files). `source` and `target`
  are paths on each app's own origin (`/…`), never full or protocol-relative URLs, and contain no
  backslash or control character (a browser reads `/\host/x` and `/<tab>/host/x` as `//host/x`,
  another host); the base URLs are passed to the parity runner on the command line. The runner
  refuses a file that breaks either rule, and checks each path again when it navigates.
- No value may contain the kit's own name (`paved-road`, as in a checkout under a
  `…/paved-road-apps/` folder or a branch name): in a bootstrapped app `verify:bootstrap` scans
  this file like any other app file, and fails on it with a fix hint about bootstrap renames
  that does not apply. Use a repo-relative `source.path` and a commit SHA for `source.ref`.
- Store no secrets, cookies or real data here, and never put a credential on the command line
  either (shell history, `ps`). The parity runner takes them from the environment only:
  `PORT_UI_TARGET_LOGIN` (a magic-link verify URL), `PORT_UI_TARGET_COOKIE` and
  `PORT_UI_SOURCE_COOKIE` (`name=value; …`), each set by command substitution
  (`PORT_UI_TARGET_COOKIE="$(…)"`), never typed as a literal. It refuses a credential passed as a
  flag.
