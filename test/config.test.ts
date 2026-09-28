import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, loadCredentials, loadUserConfig, matchesAny, projectConfigResolver, splitPatterns } from '../src/config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jvm-upgrade-config-'));
  process.env.JVM_UPGRADE_HOME = join(dir, 'home');
  await mkdir(process.env.JVM_UPGRADE_HOME);
});
afterEach(async () => {
  delete process.env.JVM_UPGRADE_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe('patterns', () => {
  it('matches group globs and group:artifact globs', () => {
    expect(matchesAny(['com.google.*'], 'com.google.guava', 'guava')).toBe(true);
    expect(matchesAny(['org.jetbrains:*'], 'org.jetbrains', 'annotations')).toBe(true);
    expect(matchesAny(['org.jetbrains:*'], 'org.jetbrains.kotlin', 'kotlin-stdlib')).toBe(false);
    expect(matchesAny(['junit:junit'], 'junit', 'junit')).toBe(true);
    expect(matchesAny(['com.example:legacy-*'], 'com.example', 'api')).toBe(false);
  });

  it('splits comma separated flags', () => {
    expect(splitPatterns(['a.*, b:c', 'd'])).toEqual(['a.*', 'b:c', 'd']);
  });
});

describe('user config', () => {
  it('uses defaults when missing', async () => {
    expect(await loadUserConfig()).toEqual(DEFAULTS);
  });

  it('merges and validates', async () => {
    await writeFile(join(process.env.JVM_UPGRADE_HOME!, 'config.json'), JSON.stringify({ target: 'minor', cooldown: 3, concurrency: 4 }));
    expect(await loadUserConfig()).toMatchObject({ target: 'minor', cooldown: 3, concurrency: 4 });
  });

  it('rejects unknown keys and bad values', async () => {
    const file = join(process.env.JVM_UPGRADE_HOME!, 'config.json');
    await writeFile(file, JSON.stringify({ nope: 1 }));
    await expect(loadUserConfig()).rejects.toBeInstanceOf(ConfigError);
    await writeFile(file, JSON.stringify({ target: 'huge' }));
    await expect(loadUserConfig()).rejects.toThrow(/target/);
  });
});

describe('project config', () => {
  it('closest config wins and inherits the rest', async () => {
    await writeFile(join(dir, '.jvm-upgrade.json'), JSON.stringify({ target: 'major', cooldown: 7 }));
    await mkdir(join(dir, 'legacy'));
    await writeFile(join(dir, 'legacy', '.jvm-upgrade.json'), JSON.stringify({ target: 'patch' }));
    await mkdir(join(dir, 'gradle'));
    await writeFile(join(dir, 'gradle', '.jvm-upgrade.json'), JSON.stringify({ target: 'minor' }));
    const resolve = projectConfigResolver(dir, DEFAULTS);
    expect(await resolve(join(dir, 'build.gradle'))).toMatchObject({ target: 'major', cooldown: 7 });
    expect(await resolve(join(dir, 'legacy', 'build.gradle'))).toMatchObject({ target: 'patch', cooldown: 7 });
    expect(await resolve(join(dir, 'gradle', 'libs.versions.toml'))).toMatchObject({ target: 'major' });
  });

  it('rejects user-only keys', async () => {
    await writeFile(join(dir, '.jvm-upgrade.json'), JSON.stringify({ cacheDir: '/tmp' }));
    await expect(projectConfigResolver(dir, DEFAULTS)(join(dir, 'pom.xml'))).rejects.toThrow(/cacheDir/);
  });
});

describe('credentials', () => {
  const write = (data: unknown) => writeFile(join(process.env.JVM_UPGRADE_HOME!, 'credentials.json'), JSON.stringify(data));

  it('expands environment variables', async () => {
    process.env.TEST_NEXUS_TOKEN = 'secret';
    await write({ repositories: [{ url: 'https://nexus/', token: '$TEST_NEXUS_TOKEN' }, { url: 'https://art/', username: 'u', password: 'p' }] });
    expect(await loadCredentials()).toEqual([{ url: 'https://nexus/', token: 'secret' }, { url: 'https://art/', username: 'u', password: 'p' }]);
    delete process.env.TEST_NEXUS_TOKEN;
  });

  it('fails on missing variables and mixed auth', async () => {
    await write({ repositories: [{ url: 'https://x/', token: '$SURELY_NOT_SET_VAR' }] });
    await expect(loadCredentials()).rejects.toThrow(/SURELY_NOT_SET_VAR/);
    await write({ repositories: [{ url: 'https://x/', token: 't', username: 'u', password: 'p' }] });
    await expect(loadCredentials()).rejects.toThrow(/either/);
  });
});
