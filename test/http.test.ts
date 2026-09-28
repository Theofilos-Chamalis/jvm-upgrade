import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeader, clearCache, createHttp, defaultCacheDir } from '../src/http.js';

const cacheName = (url: string) => `${createHash('sha256').update(url).digest('hex')}.json`;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

const servers: Server[] = [];
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jvmup-http-'));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function start(handler: Handler) {
  const s = await serve(handler);
  servers.push(s.server);
  return s.url;
}

describe('authHeader', () => {
  const creds = [
    { url: 'https://repo.example.com/', username: 'u', password: 'p' },
    { url: 'https://repo.example.com/private/', token: 'tok' },
  ];

  it('picks the longest matching prefix', () => {
    expect(authHeader('https://repo.example.com/private/a.xml', creds)).toBe('Bearer tok');
    expect(authHeader('https://repo.example.com/public/a.xml', creds)).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
  });

  it('does not match other origins with a shared string prefix', () => {
    expect(authHeader('https://repo.example.com.evil.io/x', creds)).toBeUndefined();
    expect(authHeader('https://other.example.com/x', creds)).toBeUndefined();
  });

  it('uses GITHUB_TOKEN only for api.github.com', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghtok');
    expect(authHeader('https://api.github.com/repos/a/b', [])).toBe('Bearer ghtok');
    expect(authHeader('https://raw.githubusercontent.com/a/b', [])).toBeUndefined();
  });
});

describe('createHttp', () => {
  it('sends auth and does not leak it across a redirect to another origin', async () => {
    const seen: (string | undefined)[] = [];
    const other = await start((req, res) => {
      seen.push(req.headers.authorization);
      res.end('ok');
    });
    const main = await start((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(302, { location: `${other}file` }).end();
    });
    const http = createHttp({ credentials: [{ url: main, token: 'secret' }], concurrency: 2 });
    const res = await http.get(`${main}x`);
    expect(res.body).toBe('ok');
    expect(seen).toEqual(['Bearer secret', undefined]);
  });

  it('limits concurrent requests', async () => {
    let inFlight = 0;
    let max = 0;
    const url = await start((_req, res) => {
      inFlight++;
      max = Math.max(max, inFlight);
      setTimeout(() => {
        inFlight--;
        res.end('x');
      }, 20);
    });
    const http = createHttp({ credentials: [], concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => http.get(`${url}${i}`)));
    expect(max).toBe(2);
  });

  it('dedupes identical concurrent GETs', async () => {
    let hits = 0;
    const url = await start((_req, res) => {
      hits++;
      setTimeout(() => res.end('x'), 10);
    });
    const http = createHttp({ credentials: [], concurrency: 4 });
    await Promise.all([http.get(url), http.get(url), http.get(url)]);
    expect(hits).toBe(1);
  });

  it('retries once on 5xx', async () => {
    let hits = 0;
    const url = await start((_req, res) => {
      hits++;
      res.statusCode = hits === 1 ? 503 : 200;
      res.end('ok');
    });
    const res = await createHttp({ credentials: [], concurrency: 1 }).get(url);
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  it('reads file:// urls and returns 404 when missing', async () => {
    await writeFile(join(dir, 'a.xml'), '<x/>');
    const http = createHttp({ credentials: [], concurrency: 1 });
    expect((await http.get(pathToFileURL(join(dir, 'a.xml')).href)).body).toBe('<x/>');
    expect((await http.get(pathToFileURL(join(dir, 'b.xml')).href)).status).toBe(404);
  });

  it('caches 200 and 404 on disk and reuses them in a new client', async () => {
    let hits = 0;
    const url = await start((req, res) => {
      hits++;
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end('body');
    });
    const cacheDir = join(dir, 'cache');
    const first = createHttp({ credentials: [], concurrency: 1, cacheDir });
    await first.get(`${url}ok`);
    await first.get(`${url}missing`);
    const files = await readdir(cacheDir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.json'))).toBe(true);
    const second = createHttp({ credentials: [], concurrency: 1, cacheDir });
    expect((await second.get(`${url}ok`)).body).toBe('body');
    expect((await second.get(`${url}missing`)).status).toBe(404);
    expect(hits).toBe(2);
  });

  it('does not cache 500s, authenticated responses, or with noCache', async () => {
    const url = await start((req, res) => {
      res.statusCode = req.url === '/err' ? 500 : 200;
      res.end('x');
    });
    const cacheDir = join(dir, 'cache');
    await createHttp({ credentials: [], concurrency: 1, cacheDir }).get(`${url}err`);
    await createHttp({ credentials: [{ url, token: 't' }], concurrency: 1, cacheDir }).get(`${url}a`);
    await createHttp({ credentials: [], concurrency: 1, cacheDir, noCache: true }).get(`${url}b`);
    expect(await readdir(cacheDir).catch(() => [])).toEqual([]);
  });

  it('ignores and deletes expired entries, and prunes on close', async () => {
    let hits = 0;
    const url = await start((_req, res) => {
      hits++;
      res.end(`v${hits}`);
    });
    const cacheDir = join(dir, 'cache');
    const http = createHttp({ credentials: [], concurrency: 1, cacheDir, ttlMs: 1000 });
    await http.get(`${url}a`);
    await http.get(`${url}b`);
    const fileA = cacheName(`${url}a`);
    const fileB = cacheName(`${url}b`);
    for (const f of [fileA, fileB]) {
      const p = join(cacheDir, f);
      const entry = JSON.parse(await readFile(p, 'utf8'));
      await writeFile(p, JSON.stringify({ ...entry, time: Date.now() - 5000 }));
    }
    await writeFile(join(cacheDir, 'stale.tmp'), '');
    const fresh = createHttp({ credentials: [], concurrency: 1, cacheDir, ttlMs: 1000 });
    expect((await fresh.get(`${url}a`)).body).toBe('v3');
    await fresh.close();
    const left = await readdir(cacheDir);
    expect(left).toHaveLength(2);
    expect(left).toContain(fileA);
    expect(left).toContain('stale.tmp');
    expect(left).not.toContain(fileB);
  });

  it('leaves no temp files after writes', async () => {
    const url = await start((_req, res) => res.end('x'));
    const cacheDir = join(dir, 'cache');
    const http = createHttp({ credentials: [], concurrency: 4, cacheDir });
    await Promise.all(Array.from({ length: 5 }, (_, i) => http.get(`${url}${i}`)));
    expect((await readdir(cacheDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the temp file when the write fails', async () => {
    const url = await start((_req, res) => res.end('x'));
    const cacheDir = join(dir, 'cache');
    await mkdir(cacheDir);
    const http = createHttp({ credentials: [], concurrency: 1, cacheDir });
    const target = join(cacheDir, cacheName(url));
    await mkdir(target);
    await writeFile(join(target, 'blocker'), '');
    expect((await http.get(url)).body).toBe('x');
    expect((await readdir(cacheDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('cache dir helpers', () => {
  it('honors XDG_CACHE_HOME', () => {
    vi.stubEnv('XDG_CACHE_HOME', '/xdg');
    expect(defaultCacheDir()).toBe(join('/xdg', 'jvm-upgrade'));
  });

  it('clearCache removes the directory', async () => {
    const cacheDir = join(dir, 'cache');
    await mkdir(cacheDir);
    await writeFile(join(cacheDir, 'a.json'), '{}');
    await clearCache(cacheDir);
    await expect(readdir(cacheDir)).rejects.toThrow();
  });
});
