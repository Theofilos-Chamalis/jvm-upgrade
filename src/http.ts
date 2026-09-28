import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Credential, Http, HttpResponse } from './types.js';

export interface HttpOptions {
  credentials: Credential[];
  concurrency: number;
  cacheDir?: string;
  noCache?: boolean;
  ttlMs?: number;
  onRequest?: () => void;
  onResponse?: () => void;
  timeoutMs?: number;
  userAgent?: string;
}

interface CacheEntry extends HttpResponse {
  time: number;
}

const DEFAULT_TTL = 60 * 60 * 1000;
const MAX_REDIRECTS = 5;

export function defaultCacheDir(): string {
  const env = process.env;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'jvm-upgrade');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'jvm-upgrade');
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'jvm-upgrade', 'cache');
  }
  return join(homedir(), '.cache', 'jvm-upgrade');
}

export async function clearCache(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function authHeader(url: string, credentials: Credential[]): string | undefined {
  const match = credentials
    .filter((c) => url.startsWith(c.url) && sameOrigin(url, c.url))
    .sort((a, b) => b.url.length - a.url.length)[0];
  if (match?.token) return `Bearer ${match.token}`;
  if (match?.username !== undefined && match.password !== undefined) {
    return `Basic ${Buffer.from(`${match.username}:${match.password}`).toString('base64')}`;
  }
  const gh = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (gh && hostOf(url) === 'api.github.com') return `Bearer ${gh}`;
  return undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

async function readLocal(url: string): Promise<HttpResponse> {
  try {
    const body = await readFile(fileURLToPath(url), 'utf8');
    return { status: 200, headers: {}, body };
  } catch {
    return { status: 404, headers: {}, body: '' };
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHttp(opts: HttpOptions): Http & { close(): Promise<void> } {
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cacheDir = opts.noCache ? undefined : opts.cacheDir;
  const limit = limiter(Math.max(1, opts.concurrency));
  const inflight = new Map<string, Promise<HttpResponse>>();
  let dirReady: Promise<unknown> | undefined;

  const cacheFile = (url: string) =>
    join(cacheDir!, `${createHash('sha256').update(url).digest('hex')}.json`);

  async function readCache(url: string): Promise<HttpResponse | undefined> {
    if (!cacheDir) return undefined;
    const file = cacheFile(url);
    try {
      const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
      if (Date.now() - entry.time <= ttl) {
        return { status: entry.status, headers: entry.headers, body: entry.body };
      }
      await rm(file, { force: true });
    } catch {
      // missing or corrupt entry
    }
    return undefined;
  }

  async function writeCache(url: string, res: HttpResponse): Promise<void> {
    if (!cacheDir || (res.status !== 200 && res.status !== 404)) return;
    try {
      dirReady ??= mkdir(cacheDir, { recursive: true });
      await dirReady;
      await atomicWrite(cacheFile(url), JSON.stringify({ ...res, time: Date.now() }));
    } catch {
      // cache is best effort
    }
  }

  async function fetchOnce(method: string, url: string): Promise<HttpResponse> {
    const auth = authHeader(url, opts.credentials);
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers: Record<string, string> = { 'user-agent': opts.userAgent ?? 'jvm-upgrade' };
      if (auth && sameOrigin(current, url)) headers.authorization = auth;
      const res = await fetch(current, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = new URL(location, current).toString();
        continue;
      }
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: method === 'HEAD' ? '' : await res.text(),
      };
    }
    throw new Error(`Too many redirects: ${url}`);
  }

  async function network(method: string, url: string): Promise<HttpResponse> {
    return limit(async () => {
      opts.onRequest?.();
      try {
        try {
          const res = await fetchOnce(method, url);
          if (res.status < 500 && res.status !== 429) return res;
        } catch {
          // retried below
        }
        await sleep(300);
        return await fetchOnce(method, url);
      } finally {
        opts.onResponse?.();
      }
    });
  }

  async function get(url: string): Promise<HttpResponse> {
    if (url.startsWith('file:')) return readLocal(url);
    const authed = authHeader(url, opts.credentials) !== undefined;
    const cached = authed ? undefined : await readCache(url);
    if (cached) return cached;
    const res = await network('GET', url);
    if (!authed) await writeCache(url, res);
    return res;
  }

  return {
    get(url) {
      let p = inflight.get(url);
      if (!p) {
        p = get(url);
        inflight.set(url, p);
        p.catch(() => inflight.delete(url));
      }
      return p;
    },
    async head(url) {
      if (url.startsWith('file:')) return readLocal(url);
      return network('HEAD', url);
    },
    async close() {
      if (!cacheDir) return;
      const files = await readdir(cacheDir).catch(() => [] as string[]);
      const ours = files.filter((f) => f.endsWith('.json') || f.endsWith('.tmp'));
      await Promise.all(ours.map((f) => pruneFile(join(cacheDir, f), ttl)));
    },
  };
}

async function pruneFile(file: string, ttl: number): Promise<void> {
  try {
    if (file.endsWith('.tmp')) {
      if (Date.now() - (await stat(file)).mtimeMs > ttl) await rm(file, { force: true });
      return;
    }
    const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
    if (Date.now() - entry.time > ttl) await rm(file, { force: true });
  } catch {
    await rm(file, { force: true });
  }
}
