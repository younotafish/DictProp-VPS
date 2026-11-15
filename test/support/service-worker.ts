import vm from 'node:vm';

// A stand-in for the browser around public/sw.js: in-memory Cache Storage, a scripted network, and install, activate
// and fetch events that keep the lifetime rules the worker depends on. The worker runs unmodified in a vm context.

export const ORIGIN = 'https://dictprop.online';

type RequestLike = string | { url: string };

/** A request's URL as the worker's own calls resolve it: against its origin, without the fragment. */
function urlOf(request: RequestLike): URL {
  const url = new URL(typeof request === 'string' ? request : request.url, `${ORIGIN}/`);
  url.hash = '';
  return url;
}

interface StoredResponse {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
}

/** One cache, keyed by URL. Like the browser's, put reads the response body to the end and match returns copies. */
export class MemoryCache {
  private readonly entries = new Map<string, StoredResponse>();
  /** The paths whose puts have completed, in order. */
  readonly stored: string[] = [];

  async match(request: RequestLike): Promise<Response | undefined> {
    const entry = this.entries.get(urlOf(request).href);
    if (!entry) return undefined;
    return new Response(entry.body.slice(0), { status: entry.status, statusText: entry.statusText, headers: entry.headers });
  }

  async put(request: RequestLike, response: Response): Promise<void> {
    const url = urlOf(request);
    const body = await response.arrayBuffer();
    this.entries.set(url.href, { body, status: response.status, statusText: response.statusText, headers: [...response.headers] });
    this.stored.push(url.pathname);
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map(url => new Request(url));
  }

  async delete(request: RequestLike): Promise<boolean> {
    return this.entries.delete(urlOf(request).href);
  }

  /** The paths it holds, sorted. */
  paths(): string[] {
    return [...this.entries.keys()].map(url => new URL(url).pathname).sort();
  }

  /** The text stored under a path, or undefined. */
  async text(path: string): Promise<string | undefined> {
    return (await this.match(path))?.text();
  }
}

/** Cache Storage: named caches in creation order. */
export class MemoryCacheStorage {
  private readonly byName = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.byName.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.byName.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.byName.keys()];
  }

  async has(name: string): Promise<boolean> {
    return this.byName.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.byName.delete(name);
  }

  /** The first match across every cache, in creation order. */
  async match(request: RequestLike): Promise<Response | undefined> {
    for (const cache of this.byName.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }

  /** The cache names, sorted. */
  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript',
  css: 'text/css',
  wasm: 'application/wasm',
  json: 'application/json',
  png: 'image/png',
  html: 'text/html',
};

/** The content type a server sends for a path. */
export const contentTypeOf = (path: string): string =>
  CONTENT_TYPES[path.endsWith('/') ? 'html' : path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/** The server: scripted responses by path, 404 for anything else, and a switch for going offline. */
export class FakeNetwork {
  online = true;
  /** Every request the worker made, in order. */
  readonly requests: { path: string; init?: RequestInit }[] = [];
  private readonly routes = new Map<string, () => Response>();

  serve(path: string, body: string, init: ResponseInit = {}): void {
    this.routes.set(path, () => new Response(body, { headers: { 'content-type': contentTypeOf(path) }, ...init }));
  }

  /** Stops serving everything, as a deploy replaces the whole build. */
  clear(): void {
    this.routes.clear();
  }

  readonly fetch = async (request: RequestLike, init?: RequestInit): Promise<Response> => {
    const { pathname } = urlOf(request);
    // A copy, since the worker's object comes from its own realm and wouldn't deep-equal one a test writes.
    this.requests.push({ path: pathname, init: init && { ...init } });
    if (!this.online) throw new TypeError('Failed to fetch');
    return this.routes.get(pathname)?.() ?? new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };

  /** The paths requested so far. */
  paths(): string[] {
    return this.requests.map(request => request.path);
  }
}

/** What the worker did with one event. */
export interface DispatchedEvent {
  /** The promises the worker passed to waitUntil, in order. */
  readonly extensions: Promise<unknown>[];
  /** Its answer to a fetch, or undefined when it let the browser go to the network itself. */
  readonly response: Promise<Response> | undefined;
  /** Settles once everything extending the event's lifetime has: respondWith's promise and every waitUntil. */
  settled(): Promise<void>;
}

type Listener = (event: object) => void;

/**
 * Dispatches an event the way the browser does: respondWith only during dispatch, and waitUntil during dispatch or
 * while a promise already extending the event (respondWith's among them) is pending, else InvalidStateError.
 */
function dispatch(listener: Listener | undefined, fields: object): DispatchedEvent {
  if (!listener) throw new Error('sw.js has no listener for this event');
  const lifetime: Promise<unknown>[] = [];
  const extensions: Promise<unknown>[] = [];
  let pending = 0;
  let dispatching = true;
  let response: Promise<Response> | undefined;
  const extend = (promise: Promise<unknown>) => {
    pending += 1;
    lifetime.push(promise);
    const release = () => queueMicrotask(() => { pending -= 1; });
    promise.then(release, release);
  };
  listener({
    ...fields,
    waitUntil(promise: unknown) {
      if (!dispatching && pending === 0) throw new DOMException('The event has already finished', 'InvalidStateError');
      const extension = Promise.resolve(promise);
      extensions.push(extension);
      extend(extension);
    },
    respondWith(answer: unknown) {
      if (!dispatching || response) throw new DOMException('respondWith is too late or repeated', 'InvalidStateError');
      response = Promise.resolve(answer) as Promise<Response>;
      extend(response);
    },
  });
  dispatching = false;
  return {
    extensions,
    response,
    async settled() {
      for (let seen = 0; seen < lifetime.length;) {
        const batch = lifetime.slice(seen);
        seen = lifetime.length;
        await Promise.allSettled(batch);
      }
    },
  };
}

export interface ServiceWorkerHarness {
  readonly caches: MemoryCacheStorage;
  readonly network: FakeNetwork;
  /** How often the worker called self.skipWaiting() and self.clients.claim(). */
  readonly calls: { skipWaiting: number; claim: number };
  /** Installs the worker; rejects as the browser fails an install, with the first rejected waitUntil's reason. */
  install(): Promise<void>;
  /** Activates the worker, which then controls the pages. */
  activate(): Promise<void>;
  /** A request from a page this worker controls. */
  fetch(path: string, request?: { mode?: string; method?: string }): DispatchedEvent;
}

/** Runs a service worker's source against in-memory caches and a fake network, both shareable between workers. */
export function runServiceWorker(
  source: string,
  { caches = new MemoryCacheStorage(), network = new FakeNetwork() }: { caches?: MemoryCacheStorage; network?: FakeNetwork } = {},
): ServiceWorkerHarness {
  const listeners = new Map<string, Listener>();
  const calls = { skipWaiting: 0, claim: 0 };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
    skipWaiting: async () => { calls.skipWaiting += 1; },
    clients: { claim: async () => { calls.claim += 1; } },
  };
  vm.runInNewContext(source, { self, caches, fetch: network.fetch, Request, Response, Headers, URL, DOMException, console });

  const lifecycle = async (type: string) => {
    const event = dispatch(listeners.get(type), {});
    await event.settled();
    for (const extension of event.extensions) await extension;
  };
  return {
    caches,
    network,
    calls,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    fetch: (path, { mode = 'no-cors', method = 'GET' } = {}) =>
      dispatch(listeners.get('fetch'), { request: { url: new URL(path, `${ORIGIN}/`).href, mode, method } }),
  };
}
