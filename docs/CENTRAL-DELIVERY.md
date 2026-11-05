# Central delivery — work-queue-requests

This app is a **DB Israel application**. Its deployment target is `dbisrael`
(`npm run deployment-target`), and the central DB Israel pipeline,
`CialDNB/il-paved-road-deployment`, builds and releases it.

**It is not enrolled or deployed until the platform enrolls it.** Until then nothing is released,
and the release caller's comment about the workflow-path ruleset is not true yet.

- **Staging:** `https://work-queue-requests.staging.dbisrael.ai`. After enrollment, each merge to `main` releases
  it.
- **Production:** the **Promote to production** link on a staging release, once the platform
  enables production, after go-live sign-off (docs/GO-LIVE.md, "DB Israel apps").
- **Configuration:** the central catalog entry `catalog/apps/work-queue-requests.json` declares the Worker's
  bindings, variables, secrets, schedules and hostnames, and every release reads them back exactly.
  `wrangler.jsonc` and `wrangler.staging.jsonc` here are for local development and tests only;
  central delivery ignores them. A new schedule, resource, variable or secret is a catalog PR first
  (`/add-job`, "DB Israel apps").
- **The CIAL paths refuse this app:** `npm run deploy`, `deploy:staging`, `provision` and the
  remote `db:*` scripts stop, the Provision and Deploy production workflows refuse, and CI's
  `deploy-staging` skips.

## Two files to leave alone

- `.github/workflows/il-paved-road-release.yml`, the release caller. Central accepts it byte for byte (CRLF read as LF): never
  edit, reformat, wrap or delete it. After enrollment only an org admin can change a workflow file.
- `.paved-road/deployment.json`, the deployment marker. A target change is a reviewed migration, never an
  edit.

## Getting it live

1. Link or create the Linear project.
2. Push to `CialDNB/<repo>`, merge the bootstrap PR at once, and protect `main` (PR and CI).
3. Send the platform owner the identity block `/new-app` collected and the
   `npm run central:proposal` output, and ask for source access (both GitHub App installations)
   and the catalog PR.
4. The platform onboards the app (plan, apply, the resource receipt) and enrolls it (the rulesets,
   the audit of every ref, the secret grant). Until enrollment, the `il-paved-road-release` run on
   `main` is expected to be red.
5. Someone with DB Israel Cloudflare access sets each declared runtime secret's value on the
   receipt's Worker. Every release stops until then.
6. A platform operator runs `seed-owner` with the first owner's sign-in email.
7. From then on, each merge to `main` releases `https://work-queue-requests.staging.dbisrael.ai`.

## Don't create

- `CLOUDFLARE_API_TOKEN` or `DEPLOY_ENABLED` on this repository: they belong to the CIAL
  pipeline, and CI's deployment-target guard goes red on either;
- any `IL_PAVEDROAD_*` repository secret or variable: a repository secret shadows the
  organization's;
- `production/*` tags (the Promote link makes them);
- GitHub environments;
- a Worker secret the catalog does not declare (the release's read-back fails on it).

## Open decisions

`npm run central:proposal` prints the draft catalog entry and the owner's decisions: sign-in,
AI, email alerts, schedules, backups, optional Worker secrets, ingress and health, and Workers
invocation logs. It writes nothing.
