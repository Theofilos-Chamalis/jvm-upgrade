import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const VERSIONS: Record<string, string[]> = {
  'com/example/lib': ['1.0.0', '1.0.1', '1.1.0', '2.0.0'],
  'com/example/core': ['3.0.0', '3.0.1', '3.2.0'],
  'com/example/core-ktx': ['3.0.0', '3.0.1', '3.1.0', '3.2.0'],
};
const DAY = 86_400_000;

let server: Server;
let repo: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const meta = /^\/(.+)\/maven-metadata\.xml$/.exec(url);
    if (meta && VERSIONS[meta[1]!]) {
      const versions = VERSIONS[meta[1]!]!.map((v) => `<version>${v}</version>`).join('');
      res.end(`<metadata><versioning><versions>${versions}</versions></versioning></metadata>`);
      return;
    }
    const pom = /\/([^/]+)\/[^/]+\.pom$/.exec(url);
    if (pom) {
      const age = pom[1] === '2.0.0' ? 1 : 30;
      res.setHeader('Last-Modified', new Date(Date.now() - age * DAY).toUTCString());
      res.end('<project></project>');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  repo = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let out: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jvm-upgrade-e2e-'));
  process.env.JVM_UPGRADE_HOME = join(dir, '.home');
  await mkdir(join(dir, 'gradle'));
  await writeFile(
    join(dir, 'settings.gradle.kts'),
    `dependencyResolutionManagement {\n  repositories {\n    maven("${repo}")\n  }\n}\nrootProject.name = "demo"\n`,
  );
  await writeFile(
    join(dir, 'gradle', 'libs.versions.toml'),
    '[versions]\ncore = "3.0.0" # shared\n\n[libraries]\ncore = { module = "com.example:core", version.ref = "core" }\ncore-ktx = { module = "com.example:core-ktx", version.ref = "core" }\n',
  );
  await writeFile(join(dir, 'build.gradle.kts'), 'dependencies {\n    implementation("com.example:lib:1.0.0")\n    implementation(libs.core)\n}\n');
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.JVM_UPGRADE_HOME;
  await rm(dir, { recursive: true, force: true });
});

const run = (...args: string[]) => main([dir, '--no-cache', '--no-progress', ...args]);
const json = () => JSON.parse(out) as { name: string; selected: string; patch: string | null; minor: string | null; major: string | null }[];

describe('jvm-upgrade end to end', () => {
  it('lists upgrades per level and groups shared versions', async () => {
    expect(await run('--format', 'json')).toBe(0);
    const rows = json();
    const lib = rows.find((r) => r.name === 'com.example:lib')!;
    expect(lib).toMatchObject({ patch: '1.0.1', minor: '1.1.0', major: '2.0.0', selected: '2.0.0' });
    const core = rows.find((r) => r.name.startsWith('com.example:core'))!;
    expect(core.name).toMatch(/\(\+1\)$/);
    expect(core.selected).toBe('3.2.0');
  });

  it('respects target and cooldown', async () => {
    await run('--format', 'json', '-t', 'minor');
    expect(json().find((r) => r.name === 'com.example:lib')!.selected).toBe('1.1.0');
    out = '';
    await run('--format', 'json', '-c', '7');
    expect(json().find((r) => r.name === 'com.example:lib')!.selected).toBe('1.1.0');
  });

  it('upgrades files in place without leaving files behind', async () => {
    expect(await run('-u', '-t', 'patch')).toBe(0);
    expect(await readFile(join(dir, 'build.gradle.kts'), 'utf8')).toContain('"com.example:lib:1.0.1"');
    expect(await readFile(join(dir, 'gradle', 'libs.versions.toml'), 'utf8')).toContain('core = "3.0.1" # shared');
    expect((await readdir(dir)).sort()).toEqual(['build.gradle.kts', 'gradle', 'settings.gradle.kts']);
    expect(await readdir(join(dir, 'gradle'))).toEqual(['libs.versions.toml']);
  });

  it('exits 1 with --error-on-outdated and filters with --exclude', async () => {
    expect(await run('--error-on-outdated')).toBe(1);
    out = '';
    await run('--format', 'json', '--exclude', 'com.example:lib');
    expect(json().map((r) => r.name)).not.toContain('com.example:lib');
  });
});
