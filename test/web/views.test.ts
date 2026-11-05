import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/auth/permissions';
import { READ_LOG_VIEW_PATH } from '../../src/cron/reportToRegistry';
import { APP_VIEWS, pathParamNames, viewHref } from '../../web/src/views';

// The SPA's view registry (web/src/views.ts). App.tsx builds its navigation from it, so a malformed
// entry is a broken tab or a dead deep link; these pin the rules the router depends on.

describe('web view registry (web/src/views.ts)', () => {
  it('view ids are unique', () => {
    const ids = APP_VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each path's first segment IS the view id (useRoute reads the view from it)", () => {
    for (const v of APP_VIEWS) {
      expect(v.path.split('/')[1], v.id).toBe(v.id);
      expect(v.path === `/${v.id}` || v.path.startsWith(`/${v.id}/`), v.id).toBe(true);
    }
  });

  it('path segments are identifiers or :params, with no param named twice', () => {
    for (const v of APP_VIEWS) {
      for (const segment of v.path.split('/').slice(1)) {
        expect(segment, v.id).toMatch(/^(:[A-Za-z][A-Za-z0-9_]*|[a-z0-9][a-z0-9-]*)$/);
      }
      const names = pathParamNames(v.path);
      expect(new Set(names).size, v.id).toBe(names.length);
    }
  });

  it('every view is gated by a real permission key, and names its menu and label', () => {
    for (const v of APP_VIEWS) {
      expect(Object.hasOwn(PERMISSIONS, v.permission), `${v.id}: ${v.permission}`).toBe(true);
      expect(['feature', 'settings']).toContain(v.section);
      expect(v.label.trim().length, v.id).toBeGreaterThan(0);
    }
  });

  // useRoute reads the view from the first path segment only, and App.tsx makes every entry a nav
  // tab that pushes `/<id>`. A `:param` view would render its page with no params, at a URL that
  // does not match its template — so none is registered until useRoute carries params (P3).
  it('no view has a :param path yet (useRoute routes by the first segment only)', () => {
    for (const v of APP_VIEWS) expect(pathParamNames(v.path), v.id).toEqual([]);
  });

  // The fleet registry's `activity_url` deep link (src/cron/reportToRegistry.ts). web/ cannot
  // import from src/, so the constant and the tab were kept in step by a comment only; the
  // registry lets a test hold them together.
  it('READ_LOG_VIEW_PATH is the path of the read-ledger view', () => {
    const readLog = APP_VIEWS.filter((v) => v.permission === 'readLog.read');
    expect(readLog.map((v) => v.path)).toEqual([READ_LOG_VIEW_PATH]);
  });
});

describe('view URLs (pathParamNames / viewHref)', () => {
  it('reads param names in order', () => {
    expect(pathParamNames('/notes')).toEqual([]);
    expect(pathParamNames('/cases/:caseId/history/:entry')).toEqual(['caseId', 'entry']);
  });

  it('a view without params is its path', () => {
    for (const v of APP_VIEWS) {
      if (pathParamNames(v.path).length === 0) expect(viewHref(v)).toBe(v.path);
    }
  });

  it('fills each param with an identifier-shaped value, one segment each', () => {
    expect(viewHref({ path: '/cases/:id' }, { id: 'c-42' })).toBe('/cases/c-42');
    expect(viewHref({ path: '/cases/:id/history' }, { id: 'A_1-b' })).toBe('/cases/A_1-b/history');
    expect(viewHref({ path: '/cases/:id' }, { id: 'x'.repeat(64) })).toBe(
      `/cases/${'x'.repeat(64)}`,
    );
  });

  // encodeURIComponent leaves '.' and '..' as they are, so a dot-segment param would escape its
  // view (`/cases/../history` resolves to `/history`), and '' gives a trailing-slash path. The
  // helper takes the server's rule for a param (src/ai/uiIntents.ts): an identifier, or no URL.
  it('refuses a param that is empty, a dot segment, or not an identifier', () => {
    for (const id of [
      '',
      '.',
      '..',
      'a/b?c',
      '../admin',
      'a.b',
      '-x',
      'has space',
      'x'.repeat(65),
    ]) {
      expect(viewHref({ path: '/cases/:id/history' }, { id }), JSON.stringify(id)).toBeNull();
    }
  });

  it('refuses a missing, an extra, or a misnamed param', () => {
    expect(viewHref({ path: '/cases/:id' })).toBeNull();
    expect(viewHref({ path: '/cases/:id' }, { id: 'x', other: 'y' })).toBeNull();
    expect(viewHref({ path: '/cases/:id' }, { caseId: 'x' })).toBeNull();
    expect(viewHref({ path: '/notes' }, { id: 'x' })).toBeNull();
  });
});
