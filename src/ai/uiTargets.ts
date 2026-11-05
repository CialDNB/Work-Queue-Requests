// THE AGENT'S UI TARGETS — the app-owned half of the UI-intent registry. src/ai/uiIntents.ts is the
// kit-owned half: the tool schemas, the permission filter and the per-turn cap, all built from the
// two tables here. Both files are protected core, because what the model may point the user's
// screen at is a security surface, but this one is YOURS after the first adoption — like the app
// section of PERMISSIONS in src/auth/permissions.ts. On /kit-upgrade keep your entries and skip the
// kit's, even when blob provenance says your copy is an unmodified kit version (the kit-upgrade
// skill says so): a kit entry taken whole would widen what the agent reaches in YOUR app without a
// decision of yours. uiIntents.ts can then be taken whole.
//
// Both tables are DEFAULT-DENY. Nothing is a target until an entry here says so, and the entry is
// the control: a code-owner reviews each one. The checks below it are backstops that catch the
// common mistakes, not a proof that an entry is safe.
//
//   AGENT_VIEWS  The views the agent may OPEN (ui_navigate), each an explicit opt-in:
//                `agentNavigable: true`. Each entry repeats its web/src/views.ts entry's id,
//                permission and path, in the same relative order;
//                test/isolation/ui-intent-targets.test.ts fails on any difference. A view the SPA
//                registers but this list does not is simply not navigable. A view gated by a
//                permission no agent may target (NON_DELEGABLE — tokens, users.manage, settings,
//                audit, the read ledger, service identities — or the agent family) is refused at
//                module load: the agent never walks the user to the page that mints a key.
//   AGENT_FORMS  The forms the agent may PREFILL (never submit), each an explicit opt-in:
//                `agentPrefill: true`. Prefill only ever CREATES: the target is a POST route with no
//                :params whose audit action ends in `create`, on a view with no :params, gated by a
//                permission an agent may target, with bounded string fields that are content, not
//                a record id. Checked at module load (assertUiTargets in uiIntents.ts) and against
//                the live route table by the isolation tripwire (prefillRouteProblems). What those
//                checks cannot see — a create that grants access, a free-text field that names a
//                person — is the reviewer's call on the entry.
import { z } from 'zod';
import type { PermissionKey } from '../auth/permissions';

export interface AgentView {
  /** The view id: the SPA's first path segment, and the value `ui_navigate` names. */
  readonly id: string;
  /** The permission that shows the view. `ui_navigate` to it is dropped for a caller without it. */
  readonly permission: PermissionKey;
  /** URL template, as in web/src/views.ts. A `:name` segment is a `ui_navigate` param. */
  readonly path: string;
  /** The explicit opt-in. A view is navigable only when its entry says so. */
  readonly agentNavigable: true;
}

export interface AgentForm {
  /** The form id `ui_prefill` names, e.g. `notes.create`. */
  readonly id: string;
  /** The AGENT_VIEWS id of the view the form lives on (the SPA opens it to show the form). */
  readonly view: string;
  /**
   * The route the form submits to, byte-identical to its defineRoute method and path. The type
   * admits every mutating method so a wrong entry typechecks and is refused, by name, at load.
   */
  readonly route: {
    readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly path: string;
  };
  /** That route's permission. A prefill is dropped for a caller who could not submit it. */
  readonly permission: PermissionKey;
  /** The explicit opt-in. A form is prefillable only when its entry says so. */
  readonly agentPrefill: true;
  /**
   * The fields the agent may fill — each one opted in by being listed. Each is a string with a
   * `max` no looser than the route's own, and CONTENT (a title, a body), never a field that picks
   * a record or a person. The user sees and edits every value before submitting.
   */
  readonly fields: Readonly<Record<string, z.ZodString>>;
}

// Typed as the interfaces, not `as const`: with no entries the declaration still reads as a list
// of views and forms (`: readonly AgentView[] = []`), which is how to list none.
export const AGENT_VIEWS: readonly AgentView[] = [
  // The kit's one navigable view: the golden-example feature. The Settings views (API keys,
  // service identities, users, audit, read log, alerting) are not listed: most are gated by a
  // non-delegable permission and refused anyway, and Users is where people are invited and
  // re-roled.
  { id: 'notes', permission: 'notes.read', path: '/notes', agentNavigable: true },
];

export const AGENT_FORMS: readonly AgentForm[] = [
  // The kit's one prefillable form: the agent drafts a note, the user reads it, edits it and
  // decides whether to save. Limits match POST /api/notes.
  {
    id: 'notes.create',
    view: 'notes',
    route: { method: 'POST', path: '/api/notes' },
    permission: 'notes.write',
    agentPrefill: true,
    fields: { title: z.string().min(1).max(200), body: z.string().max(20_000) },
  },
];
