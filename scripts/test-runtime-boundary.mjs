// The import check behind the runtime manifests (test/projects.mjs; docs/TESTING.md, "Put tests
// at the cheapest faithful layer"). test/platform/test-projects.test.mjs runs it over every file a
// manifest lists, and over each file those reach by a relative import. For minimal Workers it
// refuses the application's entrypoint, routes and HTTP fixture, SELF and Workflow bindings, and
// any cloudflare:test import beyond the binding helpers; for Node it also refuses Workers imports
// and globals, Wrangler Text modules and network modules. It parses TypeScript, so a multiline,
// aliased or re-exported import is read like any other, and an import it cannot read statically
// (a computed import(), require, an import.meta.glob that loads modules) is refused rather than
// skipped. A glob that reads files as text (`query: '?raw'`, or Vite's older `as: 'raw'`) runs
// nothing, so it passes (#291 review F10).
//
// It is a tripwire for an accidental move, not a proof: a crafted import can get past any static
// check. The owner's review of a change to test/projects.mjs (code-owned) is the control.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const ROOT = path.resolve(import.meta.dirname, '..');
const allowedTestImports = new Set([
  'env',
  'createExecutionContext',
  'waitOnExecutionContext',
  'fetchMock',
]);
const fullRuntimeIdentifiers = /^(?:SELF|.*_WORKFLOW|WorkflowEntrypoint|getWorkflowInstance)$/;

// `import.meta.glob(...)`, and Vite's other `import.meta.glob*` forms.
function isImportMetaGlob(node) {
  const callee = node.type === 'CallExpression' ? node.callee : undefined;
  return (
    callee?.type === 'MemberExpression' &&
    callee.object.type === 'MetaProperty' &&
    callee.object.meta.name === 'import' &&
    callee.object.property.name === 'meta' &&
    !callee.computed &&
    callee.property.name.startsWith('glob')
  );
}

// A literal options object that makes the glob read text: `query: '?raw'` or `as: 'raw'`.
function readsRawText(options) {
  if (options?.type !== 'ObjectExpression') return false;
  return options.properties.some(
    (property) =>
      property.type === 'ObjectProperty' &&
      !property.computed &&
      property.value.type === 'StringLiteral' &&
      ((propertyName(property.key) === 'query' && property.value.value === '?raw') ||
        (propertyName(property.key) === 'as' && property.value.value === 'raw')),
  );
}

const propertyName = (key) => (key.type === 'Identifier' ? key.name : key.value);

export function minimalRuntimeViolations(
  entry,
  {
    root = ROOT,
    runtime = 'workers',
    readSource = (file) => readFileSync(path.join(root, file), 'utf8'),
    exists = (file) =>
      statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() ?? false,
  } = {},
) {
  const violations = [];
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    if (
      file === 'src/index.ts' ||
      file.startsWith('src/routes/') ||
      file === 'test/helpers/http.ts'
    ) {
      violations.push(`${file}: full application entrypoint, route or HTTP fixture`);
      return;
    }
    const parsed = parse(readSource(file), {
      sourceType: 'module',
      plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx'] : [])],
    });
    const imports = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
      ) {
        if (node.importKind === 'type' || node.exportKind === 'type') return;
        const bindings = node.specifiers ?? [];
        if (
          bindings.length &&
          bindings.every(
            (element) => element.importKind === 'type' || element.exportKind === 'type',
          )
        )
          return;
        if (node.source) {
          const specifier = node.source.value;
          imports.push(specifier);
          if (specifier === 'cloudflare:test') {
            if (!bindings.length || bindings.some((binding) => binding.type !== 'ImportSpecifier'))
              violations.push(`${file}: cloudflare:test must use explicit named imports`);
            else
              for (const element of bindings) {
                if (
                  element.importKind !== 'type' &&
                  !allowedTestImports.has(element.imported.name)
                ) {
                  violations.push(
                    `${file}: full-runtime cloudflare:test import ${element.imported.name}`,
                  );
                }
              }
          }
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Import') {
        if (node.arguments.length !== 1 || node.arguments[0].type !== 'StringLiteral') {
          violations.push(`${file}: dynamic import cannot be audited statically`);
        } else {
          const specifier = node.arguments[0].value;
          if (specifier === 'cloudflare:test')
            violations.push(
              `${file}: dynamic cloudflare:test import must use explicit named imports`,
            );
          imports.push(specifier);
        }
      }
      if (isImportMetaGlob(node) && !readsRawText(node.arguments[1]))
        violations.push(
          `${file}: import.meta.glob that loads modules cannot be audited statically`,
        );
      if (
        node.type === 'TSImportEqualsDeclaration' ||
        (node.type === 'Identifier' && ['require', 'createRequire'].includes(node.name))
      )
        violations.push(`${file}: CommonJS runtime imports cannot be audited statically`);
      if (
        (node.type === 'Identifier' && fullRuntimeIdentifiers.test(node.name)) ||
        (node.type === 'StringLiteral' && fullRuntimeIdentifiers.test(node.value))
      ) {
        violations.push(`${file}: full-runtime identifier ${node.name ?? node.value}`);
      }
      if (runtime === 'node' && node.type === 'Identifier' && node.name === 'HTMLRewriter')
        violations.push(`${file}: Workers HTMLRewriter global`);
      for (const [key, value] of Object.entries(node)) {
        if (
          [
            'loc',
            'start',
            'end',
            'comments',
            'leadingComments',
            'trailingComments',
            'innerComments',
          ].includes(key)
        )
          continue;
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(parsed);
    for (const specifier of imports) {
      if (runtime === 'node' && /^(?:cloudflare|workerd):/.test(specifier))
        violations.push(`${file}: Workers import in Node project ${specifier}`);
      if (runtime === 'node' && /\.(?:md|sql)$/.test(specifier))
        violations.push(`${file}: Wrangler Text module requires Workers ${specifier}`);
      if (
        runtime === 'node' &&
        /^(?:node:)?(?:dgram|dns|http|http2|https|net|tls)(?:\/|$)/.test(specifier)
      )
        violations.push(`${file}: network module in Node project ${specifier}`);
      if (specifier === 'cloudflare:workflows') violations.push(`${file}: Workflow runtime import`);
      if (specifier === 'node:module' || /^(?:@\/|~\/|#|\/|file:)/.test(specifier))
        violations.push(`${file}: unaudited runtime import ${specifier}`);
      if (!specifier.startsWith('.') || specifier.includes('?raw') || specifier.includes('?url'))
        continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (/\.(?:md|sql|json|svg|css)$/.test(target)) continue;
      const candidates = [
        target,
        ...['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'].map(
          (suffix) => target + suffix,
        ),
      ];
      const resolved = candidates.find((candidate) => exists(candidate));
      if (!resolved) violations.push(`${file}: unresolved runtime import ${specifier}`);
      else visit(resolved);
    }
  }
  visit(entry);
  return [...new Set(violations)].sort();
}
