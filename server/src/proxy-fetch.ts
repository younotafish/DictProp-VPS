/**
 * Proxy-aware fetch wrapper.
 * Uses undici's ProxyAgent when HTTPS_PROXY is set (e.g., corporate firewalls).
 * Falls back to native fetch when no proxy is needed (VPS, Docker).
 */
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

let dispatcher: ProxyAgent | undefined;
if (proxyUrl) {
  dispatcher = new ProxyAgent(proxyUrl);
  console.log(`Using HTTP proxy: ${proxyUrl}`);
}

export function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  if (dispatcher) {
    // undici fetch with proxy dispatcher
    return undiciFetch(url, { ...options, dispatcher } as any) as unknown as Promise<Response>;
  }
  return fetch(url, options);
}
