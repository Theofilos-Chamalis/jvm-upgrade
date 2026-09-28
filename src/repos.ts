import type { Dependency, Http } from './types.js';

type DepRef = Pick<Dependency, 'group' | 'artifact' | 'kind' | 'repositories'>;

export interface VersionsResult {
  versions: string[];
  repoOf: Map<string, string>;
  errors: string[];
}

interface GradleVersion {
  version: string;
  buildTime?: string;
  snapshot?: boolean;
  nightly?: boolean;
  releaseNightly?: boolean;
  broken?: boolean;
}

const GRADLE_VERSIONS_URL = 'https://services.gradle.org/versions/all';

const gradleBuildTimes = new WeakMap<Http, Promise<Map<string, string>>>();
const publishedMemo = new WeakMap<Http, Map<string, Promise<Date | undefined>>>();

export function artifactPath(group: string, artifact: string): string {
  return `${group.replaceAll('.', '/')}/${artifact}`;
}

export function parseMetadata(xml: string): string[] {
  const found = new Set<string>();
  const block = /<versions>([\s\S]*?)<\/versions>/.exec(xml)?.[1] ?? '';
  for (const m of block.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)) found.add(m[1]!);
  for (const tag of ['latest', 'release']) {
    const m = new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`).exec(xml);
    if (m) found.add(m[1]!);
  }
  return [...found];
}

export function parseGradleBuildTime(value: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([+-]\d{4})?$/.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, tz = '+0000'] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${tz.slice(0, 3)}:${tz.slice(3)}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function loadGradle(http: Http): Promise<Map<string, string>> {
  let p = gradleBuildTimes.get(http);
  if (!p) {
    p = (async () => {
      const res = await http.get(GRADLE_VERSIONS_URL);
      if (res.status !== 200) throw new Error(`${GRADLE_VERSIONS_URL}: HTTP ${res.status}`);
      const list = JSON.parse(res.body) as GradleVersion[];
      const usable = list.filter((v) => !v.snapshot && !v.nightly && !v.broken && !v.releaseNightly);
      return new Map(usable.map((v) => [v.version, v.buildTime ?? '']));
    })();
    p.catch(() => gradleBuildTimes.delete(http));
    gradleBuildTimes.set(http, p);
  }
  return p;
}

async function fetchGithubTags(http: Http, owner: string, repo: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`;
  const res = await http.get(url);
  if (res.status === 404) return [];
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  const tags = JSON.parse(res.body) as { name: string }[];
  return tags.map((t) => t.name.replace(/^v(?=\d)/i, ''));
}

async function versionsFromRepo(http: Http, dep: DepRef, repo: string): Promise<string[]> {
  const url = `${repo}${artifactPath(dep.group, dep.artifact)}/maven-metadata.xml`;
  const res = await http.get(url);
  if (res.status === 200) {
    // Some proxies answer 200 with an HTML page instead of 404 or 401.
    if (!res.body.includes('<metadata')) throw new Error(`${url}: not a maven-metadata.xml response`);
    return parseMetadata(res.body);
  }
  if (res.status === 404) {
    // JitPack: com.github.Owner:Repo, or com.github.Owner.Repo:Module for multi-module builds.
    const [, , owner, ghRepo = dep.artifact] = dep.group.split('.');
    if (repo.includes('jitpack.io') && dep.group.startsWith('com.github.') && owner) {
      return fetchGithubTags(http, owner, ghRepo);
    }
    return [];
  }
  throw new Error(`${url}: HTTP ${res.status}`);
}

export async function fetchVersions(http: Http, dep: DepRef): Promise<VersionsResult> {
  const repoOf = new Map<string, string>();
  if (dep.kind === 'gradle') {
    try {
      return { versions: [...(await loadGradle(http)).keys()], repoOf, errors: [] };
    } catch (err) {
      return { versions: [], repoOf, errors: [errorText(err)] };
    }
  }
  const results = await Promise.allSettled(dep.repositories.map((r) => versionsFromRepo(http, dep, r)));
  const errors: string[] = [];
  results.forEach((result, i) => {
    const repo = dep.repositories[i]!;
    if (result.status === 'rejected') {
      errors.push(`${repo}: ${errorText(result.reason)}`);
      return;
    }
    for (const v of result.value) if (!repoOf.has(v)) repoOf.set(v, repo);
  });
  return { versions: [...repoOf.keys()], repoOf, errors };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function publishedAt(http: Http, dep: DepRef, version: string, repo?: string): Promise<Date | undefined> {
  if (dep.kind === 'gradle') {
    const time = (await loadGradle(http).catch(() => undefined))?.get(version);
    return time ? parseGradleBuildTime(time) : undefined;
  }
  const base = repo ?? dep.repositories[0];
  if (!base) return undefined;
  const url = `${base}${artifactPath(dep.group, dep.artifact)}/${version}/${dep.artifact}-${version}.pom`;
  const res = await http.head(url).catch(() => undefined);
  const header = res?.status === 200 ? res.headers['last-modified'] : undefined;
  if (!header) return undefined;
  const date = new Date(header);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function fetchPublishedAt(http: Http, dep: DepRef, version: string, repo?: string): Promise<Date | undefined> {
  let memo = publishedMemo.get(http);
  if (!memo) publishedMemo.set(http, (memo = new Map()));
  const key = `${dep.kind}|${dep.group}:${dep.artifact}:${version}|${repo ?? dep.repositories[0] ?? ''}`;
  let p = memo.get(key);
  if (!p) memo.set(key, (p = publishedAt(http, dep, version, repo)));
  return p;
}

export async function fetchPom(
  http: Http,
  group: string,
  artifact: string,
  version: string,
  repo: string,
): Promise<string | undefined> {
  const url = `${repo}${artifactPath(group, artifact)}/${version}/${artifact}-${version}.pom`;
  const res = await http.get(url).catch(() => undefined);
  return res?.status === 200 ? res.body : undefined;
}
