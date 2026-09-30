/**
 * Proxy-aware fetch wrapper.
 * Uses undici's ProxyAgent when HTTPS_PROXY is set (e.g., corporate firewalls).
 * Without a proxy (VPS, Docker) it uses undici's fetch with a direct Agent whose timeouts outlast
 * every caller's own deadline.
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

/** The proxy's address for the log, without a user name or password it may carry. */
export function describeProxy(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.username || parsed.password ? ' (credentials hidden)' : ''}`;
  } catch {
    return '(unparseable proxy URL)';
  }
}

let dispatcher: ProxyAgent | undefined;
if (proxyUrl) {
  dispatcher = new ProxyAgent(proxyUrl);
  console.log(`Using HTTP proxy: ${describeProxy(proxyUrl)}`);
}

const CURL_BODY_THRESHOLD = 32 * 1024;
const MAX_CURL_RESPONSE_BYTES = 25 * 1024 * 1024;

export function curlFetch(url: string, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(options.headers);
    // Headers (an API key among them) go through a private file: any local process can read a command line.
    const headerDir = mkdtempSync(join(tmpdir(), 'dictprop-curl-'));
    const headerFile = join(headerDir, 'headers');
    const headerLines: string[] = [];
    headers.forEach((value, name) => headerLines.push(`${name}: ${value}\n`));
    writeFileSync(headerFile, headerLines.join(''), { mode: 0o600 });
    const args = ['-sS', '--max-time', '600', '-X', options.method || 'GET', '-H', `@${headerFile}`];
    args.push('--data-binary', '@-', '--write-out', '\n__DICTPROP_STATUS__:%{http_code}', url);
    let headerFileRemoved = false;
    const removeHeaderFile = () => {
      if (headerFileRemoved) return;
      headerFileRemoved = true;
      rmSync(headerDir, { recursive: true, force: true });
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('curl', args);
    } catch (error) {
      removeHeaderFile();
      throw error;
    }
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
    child.on('error', error => { removeHeaderFile(); finish(() => reject(error)); });
    child.on('close', code => { removeHeaderFile(); finish(() => {
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
    }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(typeof options.body === 'string' ? options.body : '');
  });
}

// The default fetch dispatcher gives up after 300s without response headers, and a non-streamed model
// reply sends its headers only when it is finished, so a 600s comparison was cut off at 300s (and a
// stalled body could hang for as long). Every caller bounds its request with its own AbortSignal;
// these limits only have to outlast the longest of them.
export const NATIVE_HEADERS_TIMEOUT_MS = 11 * 60_000;
export const NATIVE_BODY_TIMEOUT_MS = 11 * 60_000;

let directAgent: Agent | undefined;
function getDirectAgent(): Agent {
  directAgent ??= new Agent({ headersTimeout: NATIVE_HEADERS_TIMEOUT_MS, bodyTimeout: NATIVE_BODY_TIMEOUT_MS });
  return directAgent;
}

/**
 * undici's fetch only recognizes its own FormData class and sends any other one as the text
 * "[object FormData]". Encode a global FormData with the built-in Request, which yields the
 * multipart bytes and the matching boundary header.
 */
export async function encodeFormDataBody(options: RequestInit): Promise<RequestInit> {
  if (!(options.body instanceof FormData)) return options;
  const encoded = new Request('http://localhost/', { method: 'POST', body: options.body });
  const headers = new Headers(options.headers);
  headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');
  return { ...options, headers, body: new Uint8Array(await encoded.arrayBuffer()) };
}

export async function proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (dispatcher) {
    // undici's ProxyAgent can stall on the large JSON/base64 request bodies used by comparison
    // and word alignment. Keep that transport detail inside this one outbound HTTP boundary.
    if (typeof options.body === 'string' && Buffer.byteLength(options.body) >= CURL_BODY_THRESHOLD) {
      return curlFetch(url, options);
    }
    // undici fetch with proxy dispatcher
    return await undiciFetch(url, { ...(await encodeFormDataBody(options)), dispatcher } as any) as unknown as Response;
  }
  return await undiciFetch(url, { ...(await encodeFormDataBody(options)), dispatcher: getDirectAgent() } as any) as unknown as Response;
}
