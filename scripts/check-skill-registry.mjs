// Skill-artifact guard. `.claude/skills/` is the virtual team; this checks that each skill is a
// well-formed, registrable artifact — nothing else.
//
//   node scripts/check-skill-registry.mjs      # CI gate: exit 1 on a malformed skill
//
// WHAT IT CHECKS (all three are properties of the FILES, verifiable without interpretation):
//   1. every `.claude/skills/<dir>/` contains a SKILL.md
//   2. its frontmatter parses and declares a `name:`
//   3. that name equals the directory name, and is kebab-case
//   4. it declares a non-empty `description:` — the field Claude matches on, so a skill without
//      one is registered but effectively unreachable
//
// WHAT IT DELIBERATELY DOES NOT CHECK — and why, because the first cut did:
//
// An earlier version also verified the SIX documents that restate the roster (CLAUDE.md's list,
// README's harness row, the PLAYBOOKS table, PLUGIN.md's counts, the guidance doc's count, the
// plugin install card) by matching regexes against English prose. Five review rounds found real
// defects in that code every time, because the input space is unbounded: a documentation URL
// produced a phantom `/docs` skill, a YAML-quoted name read as a mismatch, moving a section to
// the end of a file broke the region match, a duplicated sentence went unchecked, and a fork
// whose own skill count differed from the kit's could only go green by writing a falsehood into
// a doc about a plugin it does not carry. The failure those checks prevented — a stale number in
// prose — is real but cosmetic; the maintenance surface was not. See DECISIONS 2026-08-06.
//
// The checks that remain are about the artifacts themselves, and NONE of the findings from those
// rounds were in this half. If a count in a document goes stale, review catches it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './kit-checks/main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SKILLS_DIR = '.claude/skills';

/** Directory names under `.claude/skills/`, sorted. Includes malformed ones on purpose — a
 *  directory with no SKILL.md is itself drift, not something to silently skip. */
export function skillDirs(root = ROOT) {
  const dir = join(root, SKILLS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * The frontmatter block's key/value pairs, or null when there is no parseable block.
 * Bounded to the text between the opening and closing `---`: an unbounded scan reads a
 * column-0 `name:` from the BODY as the declared name, which both false-passes a SKILL.md whose
 * frontmatter lacks `name:` and false-fails one that merely quotes another skill's frontmatter
 * (the skills here do that routinely).
 */
export function frontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
  if (block === undefined) return null;
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z][\w-]*):[ \t]*(.*)$/);
    // Strip surrounding quotes: `name: "qa"` is valid YAML for exactly `qa`, and comparing the
    // raw token reported a mismatch between two strings that differ only by delimiters.
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Every malformed skill artifact, as readable strings. Empty means all skills are well-formed. */
export function skillDrift(root = ROOT) {
  const drift = [];
  const dirs = skillDirs(root);
  if (dirs.length === 0)
    return [`${SKILLS_DIR}/: no skills found — the guard has nothing to check`];

  for (const dir of dirs) {
    const rel = `${SKILLS_DIR}/${dir}/SKILL.md`;
    if (!existsSync(join(root, SKILLS_DIR, dir, 'SKILL.md'))) {
      // Not "skip this directory": a skill whose SKILL.md was renamed still looks like a skill
      // to a human reading the tree, and its slash-command silently stops existing.
      drift.push(`${rel}: missing — a skill directory must contain a SKILL.md`);
      continue;
    }
    const fm = frontmatter(readFileSync(join(root, SKILLS_DIR, dir, 'SKILL.md'), 'utf8'));
    if (fm === null) {
      drift.push(`${rel}: no frontmatter block (needs \`---\` … \`---\` at the top)`);
      continue;
    }
    if (!fm.name) {
      drift.push(`${rel}: frontmatter declares no \`name:\``);
    } else if (fm.name !== dir) {
      drift.push(`${rel}: frontmatter name \`${fm.name}\` != directory \`${dir}\``);
    } else if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(fm.name)) {
      drift.push(`${rel}: name \`${fm.name}\` is not kebab-case`);
    }
    if (!fm.description) {
      // The description is what Claude matches on; without one the skill never triggers.
      drift.push(`${rel}: frontmatter declares no \`description:\``);
    }
  }
  return drift;
}

if (isMainModule(import.meta.url)) {
  const drift = skillDrift();
  if (drift.length) {
    console.error(
      `malformed skill(s) (${drift.length}):\n  ${drift.join('\n  ')}\n\n` +
        `Fix: every ${SKILLS_DIR}/<name>/SKILL.md needs frontmatter whose \`name:\` matches its\n` +
        `directory, plus a \`description:\`. See an existing skill for the shape.`,
    );
    process.exit(1);
  }
  console.log(`skill artifacts well-formed ✓ (${skillDirs().length} skills)`);
}
