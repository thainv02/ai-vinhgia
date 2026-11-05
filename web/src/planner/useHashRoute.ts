import { useEffect, useState } from 'react';

export type Route =
  | { name: 'list' }
  | { name: 'new' }
  | { name: 'plan'; id: number }
  | { name: 'tool' }
  | { name: 'clips' }
  | { name: 'clip'; id: number }
  | { name: 'auto' }
  | { name: 'autoNew' }
  | { name: 'autoProject'; id: number };

/** Đường dẫn dạng hash (#/, #/new, #/plan/12, #/tools/remove-logo, #/clips, #/clips/5, #/auto, #/auto/new, #/auto/7): listener LAN chỉ cần phục vụ một trang planner.html. */
export function parseHash(hash: string): Route {
  const a = /^#\/auto\/(\d+)$/.exec(hash);
  if (a) return { name: 'autoProject', id: Number(a[1]) };
  if (hash === '#/auto') return { name: 'auto' };
  if (hash === '#/auto/new') return { name: 'autoNew' };
  const m = /^#\/plan\/(\d+)$/.exec(hash);
  if (m) return { name: 'plan', id: Number(m[1]) };
  const c = /^#\/clips\/(\d+)$/.exec(hash);
  if (c) return { name: 'clip', id: Number(c[1]) };
  if (hash === '#/clips') return { name: 'clips' };
  if (hash === '#/new') return { name: 'new' };
  if (hash === '#/tools/remove-logo') return { name: 'tool' };
  return { name: 'list' };
}

export function hrefOf(route: Route): string {
  switch (route.name) {
    case 'plan':
      return `#/plan/${route.id}`;
    case 'new':
      return '#/new';
    case 'tool':
      return '#/tools/remove-logo';
    case 'clips':
      return '#/clips';
    case 'clip':
      return `#/clips/${route.id}`;
    case 'auto':
      return '#/auto';
    case 'autoNew':
      return '#/auto/new';
    case 'autoProject':
      return `#/auto/${route.id}`;
    default:
      return '#/';
  }
}

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
