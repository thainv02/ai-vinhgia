import { useEffect, useState } from 'react';

export type Route = { name: 'list' } | { name: 'new' } | { name: 'plan'; id: number } | { name: 'tool' } | { name: 'clips' } | { name: 'clip'; id: number };

/** Đường dẫn dạng hash (#/, #/new, #/plan/12, #/tools/remove-logo, #/clips, #/clips/5): listener LAN chỉ cần phục vụ một trang planner.html. */
export function parseHash(hash: string): Route {
  const m = /^#\/plan\/(\d+)$/.exec(hash);
  if (m) return { name: 'plan', id: Number(m[1]) };
  const c = /^#\/clips\/(\d+)$/.exec(hash);
  if (c) return { name: 'clip', id: Number(c[1]) };
  if (hash === '#/clips') return { name: 'clips' };
  if (hash === '#/new') return { name: 'new' };
  if (hash === '#/tools/remove-logo') return { name: 'tool' };
  return { name: 'list' };
}

export const hrefOf = (route: Route): string =>
  route.name === 'plan'
    ? `#/plan/${route.id}`
    : route.name === 'new'
      ? '#/new'
      : route.name === 'tool'
        ? '#/tools/remove-logo'
        : route.name === 'clips'
          ? '#/clips'
          : route.name === 'clip'
            ? `#/clips/${route.id}`
            : '#/';

export function navigate(route: Route): void {
  window.location.hash = hrefOf(route);
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
