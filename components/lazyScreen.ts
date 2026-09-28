import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type Module<T> = { default: T };

export type LazyScreen<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** Fetches the screen's code ahead of its first render. */
  preload: () => void;
};

/**
 * React.lazy with a `preload` that fetches the code ahead of use. React.lazy suspends on a component's
 * first render even when its module has already arrived, which flashes the fallback, so once the module is
 * in it's handed over through a thenable that calls back at once, and React renders the screen on the
 * first frame.
 *
 * If the code can't be fetched when the screen is needed, most likely because a deploy replaced the files
 * an open page asks for, the page reloads once to pick up the current build.
 */
export function lazyScreen<T extends ComponentType<any>>(name: string, load: () => Promise<Module<T>>): LazyScreen<T> {
  const reloadKey = `lazy_screen_reload:${name}`;
  let loaded: Module<T> | undefined;
  let loading: Promise<Module<T>> | undefined;

  const fetchModule = () => (loading ??= load().then(
    module => {
      loaded = module;
      try { sessionStorage.removeItem(reloadKey); } catch { /* storage can be unavailable in private browsing */ }
      return module;
    },
    error => {
      loading = undefined; // the next attempt fetches again
      throw error;
    },
  ));

  const Screen = lazy((): Promise<Module<T>> => {
    const module = loaded;
    if (module) return { then: (resolve: (value: Module<T>) => void) => resolve(module) } as unknown as Promise<Module<T>>;
    return fetchModule().catch(async error => {
      try {
        if (!sessionStorage.getItem(reloadKey)) {
          sessionStorage.setItem(reloadKey, '1');
          window.location.reload();
          return await new Promise<never>(() => {});
        }
      } catch { /* storage can be unavailable in private browsing */ }
      throw error;
    });
  });

  return Object.assign(Screen, { preload: () => { void fetchModule().catch(() => {}); } });
}
