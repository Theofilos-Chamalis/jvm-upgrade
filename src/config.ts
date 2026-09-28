import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { TARGETS, type Credential, type Target } from './types.js';

export interface ProjectOptions {
  target: Target;
  pre: boolean;
  cooldown: number;
  allowDowngrade: boolean;
  include: string[];
  exclude: string[];
  repositories: string[];
}

export interface UserOptions extends ProjectOptions {
  cacheDir?: string;
  noCache: boolean;
  concurrency: number;
}

export const PROJECT_CONFIG = '.jvm-upgrade.json';

export const DEFAULTS: UserOptions = {
  target: 'major',
  pre: false,
  cooldown: 0,
  allowDowngrade: false,
  include: [],
  exclude: [],
  repositories: [],
  noCache: false,
  concurrency: 8,
};

export class ConfigError extends Error {}

export function userDir(): string {
  return process.env.JVM_UPGRADE_HOME ?? join(homedir(), '.jvm-upgrade');
}

const PROJECT_KEYS: Record<keyof ProjectOptions, (v: unknown) => boolean> = {
  target: (v) => TARGETS.includes(v as Target),
  pre: (v) => typeof v === 'boolean',
  cooldown: (v) => Number.isInteger(v) && (v as number) >= 0,
  allowDowngrade: (v) => typeof v === 'boolean',
  include: isStringArray,
  exclude: isStringArray,
  repositories: isStringArray,
};

const USER_KEYS: Record<string, (v: unknown) => boolean> = {
  ...PROJECT_KEYS,
  cacheDir: (v) => typeof v === 'string',
  noCache: (v) => typeof v === 'boolean',
  concurrency: (v) => Number.isInteger(v) && (v as number) > 0,
};

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected an object');
    return data as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`${file}: invalid JSON (${(e as Error).message})`);
  }
}

function validate(file: string, data: Record<string, unknown>, keys: Record<string, (v: unknown) => boolean>) {
  for (const [key, value] of Object.entries(data)) {
    const check = keys[key];
    if (!check) throw new ConfigError(`${file}: unknown option "${key}"`);
    if (!check(value)) throw new ConfigError(`${file}: invalid value for "${key}"`);
  }
  return data as Partial<UserOptions>;
}

export async function loadUserConfig(): Promise<UserOptions> {
  const file = join(userDir(), 'config.json');
  const data = await readJson(file);
  return { ...DEFAULTS, ...(data && validate(file, data, USER_KEYS)) };
}

/** Returns a resolver giving the merged project options for a build file ("closest config wins"). */
export function projectConfigResolver(root: string, base: ProjectOptions) {
  const cache = new Map<string, Promise<ProjectOptions>>();
  const absRoot = resolve(root);

  const forDir = (dir: string): Promise<ProjectOptions> => {
    let hit = cache.get(dir);
    if (!hit) {
      hit = (async () => {
        const parent = dir === absRoot || !isInside(absRoot, dir) ? base : await forDir(dirname(dir));
        const file = join(dir, PROJECT_CONFIG);
        const data = await readJson(file);
        return data ? { ...parent, ...validate(file, data, PROJECT_KEYS) } : parent;
      })();
      cache.set(dir, hit);
    }
    return hit;
  };

  return (file: string) => {
    const dir = dirname(resolve(file));
    return forDir(dir.endsWith(`${sep}gradle`) && dirname(dir) === absRoot ? absRoot : dir);
  };
}

function isInside(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

export async function loadCredentials(): Promise<Credential[]> {
  const file = join(userDir(), 'credentials.json');
  const data = await readJson(file);
  if (!data) return [];
  const repos = data.repositories;
  if (!Array.isArray(repos)) throw new ConfigError(`${file}: "repositories" must be an array`);
  return repos.map((entry: Record<string, unknown>, i) => {
    const at = `${file}: repositories[${i}]`;
    if (typeof entry?.url !== 'string') throw new ConfigError(`${at}: "url" is required`);
    const hasToken = entry.token !== undefined;
    const hasBasic = entry.username !== undefined || entry.password !== undefined;
    if (hasToken === hasBasic) throw new ConfigError(`${at}: use either "token" or "username" + "password"`);
    const cred: Credential = { url: entry.url };
    for (const key of ['token', 'username', 'password'] as const) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] !== 'string') throw new ConfigError(`${at}: "${key}" must be a string`);
      cred[key] = expandEnv(entry[key] as string, at);
    }
    if (hasBasic && (cred.username === undefined || cred.password === undefined)) {
      throw new ConfigError(`${at}: "username" and "password" are both required`);
    }
    return cred;
  });
}

function expandEnv(value: string, at: string): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  const env = process.env[name];
  if (env === undefined) throw new ConfigError(`${at}: environment variable ${name} is not set`);
  return env;
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/** Patterns without ":" match the group only; "group:artifact" patterns match both. */
export function matchesAny(patterns: string[], group: string, artifact: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(p.includes(':') ? `${group}:${artifact}` : group));
}

export function splitPatterns(values: string[]): string[] {
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}
