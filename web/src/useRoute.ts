import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal history-aware routing for the SPA — kit default (DECISIONS 2026-08-03).
 *
 * The active view is the first path segment (`/notes`, `/users`, …). Navigating with the
 * returned `navigate` pushes a real history entry, so the browser Back button walks BACK THROUGH
 * the app instead of jumping straight out to the login page (the bug you get from plain
 * `useState` tab-switching, which creates no history at all). `popstate` keeps React in sync when
 * the user presses Back/Forward or opens a deep link.
 *
 * Deliberately dependency-free: the kit hand-rolls small primitives rather than pull in a router.
 */
export function useRoute(fallback: string): [string, (id: string) => void] {
  const read = () => window.location.pathname.replace(/^\/+/, '').split('/')[0] || fallback;
  const [route, setRoute] = useState<string>(read);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bind popstate once; read closes over the stable fallback.
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((id: string) => {
    setRoute((cur) => {
      if (id !== cur) window.history.pushState(null, '', `/${id}`);
      return id;
    });
  }, []);

  return [route, navigate];
}
