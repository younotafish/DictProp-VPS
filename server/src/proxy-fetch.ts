/**
 * Proxy-aware fetch wrapper.
 * Uses undici's ProxyAgent when HTTPS_PROXY is set (e.g., corporate firewalls).
 * Falls back to native fetch when no proxy is needed (VPS, Docker).
 */
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { spawn } from 'child_process';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

let dispatcher: ProxyAgent | undefined;
if (proxyUrl) {
  dispatcher = new ProxyAgent(proxyUrl);
  console.log(`Using HTTP proxy: ${proxyUrl}`);
}

const CURL_BODY_THRESHOLD = 32 * 1024;
const MAX_CURL_RESPONSE_BYTES = 25 * 1024 * 1024;

function curlFetch(url: string, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(options.headers);
    const args = ['-sS', '--max-time', '600', '-X', options.method || 'GET'];
    headers.forEach((value, name) => args.push('-H', `${name}: ${value}`));
    args.push('--data-binary', '@-', '--write-out', '\n__DICTPROP_STATUS__:%{http_code}', url);
    const child = spawn('curl', args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new DOMException('The operation was aborted', 'AbortError')));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CURL_RESPONSE_BYTES) {
        child.kill('SIGTERM');
        finish(() => reject(new Error('Outbound response exceeded 25 MB')));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => finish(() => {
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
        return;
      }
      const raw = Buffer.concat(stdout).toString('utf8');
      const marker = '\n__DICTPROP_STATUS__:';
      const markerAt = raw.lastIndexOf(marker);
      if (markerAt < 0) {
        reject(new Error('curl response did not include an HTTP status'));
        return;
      }
      const status = Number(raw.slice(markerAt + marker.length).trim());
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error('curl response included an invalid HTTP status'));
        return;
      }
      const responseBody = status === 204 || status === 205 || status === 304 ? null : raw.slice(0, markerAt);
      resolve(new Response(responseBody, { status }));
    }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(typeof options.body === 'string' ? options.body : '');
  });
}

export function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  if (dispatcher) {
    // undici's ProxyAgent can stall on the large JSON/base64 request bodies used by comparison
    // and word alignment. Keep that transport detail inside this one outbound HTTP boundary.
    if (options && typeof options.body === 'string' && Buffer.byteLength(options.body) >= CURL_BODY_THRESHOLD) {
      return curlFetch(url, options);
    }
    // undici fetch with proxy dispatcher
    return undiciFetch(url, { ...options, dispatcher } as any) as unknown as Promise<Response>;
  }
  return fetch(url, options);
}
