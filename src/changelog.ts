import { fetchPom } from './repos.js';
import { isPrerelease } from './version.js';
import type { Changelog, ChangelogEntry, Dependency, Http } from './types.js';

type DepRef = Pick<Dependency, 'group' | 'artifact' | 'kind'>;
type Compare = (a: string, b: string) => number;

export interface GithubRepo {
  owner: string;
  repo: string;
}

export interface SourceRepo {
  github?: GithubRepo;
  url?: string;
  /** Shown when no notes are found in the repo itself. */
  notesUrl?: string;
}

interface Release {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

const CHANGELOG_FILES = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'RELEASE_NOTES.md', 'docs/CHANGELOG.md'];
const MAX_RELEASE_PAGES = 5;
const MAX_PARENT_DEPTH = 3;
const GOOGLE_NOTES: [prefix: string, url: string][] = [
  ['com.google.android.gms', 'https://developers.google.com/android/guides/releases'],
  ['com.google.gms', 'https://developers.google.com/android/guides/releases'],
  ['com.google.firebase', 'https://firebase.google.com/support/release-notes/android'],
];
const POM_NOISE =
  /<(parent|scm|licenses|developers|contributors|organization|distributionManagement|issueManagement|ciManagement|mailingLists|repositories|pluginRepositories|build|reporting|profiles|dependencies|dependencyManagement)\b[\s\S]*?<\/\1>/g;

export function normalizeScmUrl(raw: string): SourceRepo | undefined {
  let s = raw.trim();
  if (!s || s.includes('${')) return undefined;
  s = s.replace(/^scm:(git:|svn:|hg:)?/i, '');
  s = s.replace(/^git@([^:]+):/i, 'https://$1/');
  s = s.replace(/^(ssh|git|http):\/\/(git@)?/i, 'https://');
  if (!/^https:\/\//i.test(s)) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() === 'github.com' || url.hostname.toLowerCase() === 'www.github.com') {
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return undefined;
    const clean = repo.replace(/\.git$/i, '');
    return { github: { owner, repo: clean }, url: `https://github.com/${owner}/${clean}` };
  }
  return { url: s.replace(/\.git$/i, '').replace(/\/$/, '') };
}

function tagValue(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml)?.[1];
}

export function pomCandidates(pom: string): string[] {
  const scm = /<scm>([\s\S]*?)<\/scm>/.exec(pom)?.[1] ?? '';
  const scmValues = ['url', 'connection', 'developerConnection'].map((t) => tagValue(scm, t));
  return [...scmValues, tagValue(pom.replace(POM_NOISE, ''), 'url')].filter((v): v is string => !!v);
}

export function pomParent(pom: string): { group: string; artifact: string; version: string } | undefined {
  const block = /<parent>([\s\S]*?)<\/parent>/.exec(pom)?.[1];
  if (!block) return undefined;
  const group = tagValue(block, 'groupId');
  const artifact = tagValue(block, 'artifactId');
  const version = tagValue(block, 'version');
  return group && artifact && version ? { group, artifact, version } : undefined;
}

function pickSource(candidates: string[]): SourceRepo | undefined {
  const normalized = candidates.map(normalizeScmUrl).filter((s): s is SourceRepo => !!s);
  return normalized.find((s) => s.github) ?? normalized[0];
}

export function androidxReleasesUrl(group: string): string | undefined {
  const [root, first, second] = group.split('.');
  if (root !== 'androidx' || !first) return undefined;
  const name = first === 'compose' && second ? `compose-${second}` : first;
  return `https://developer.android.com/jetpack/androidx/releases/${name}`;
}

function googleNotesUrl(group: string): string | undefined {
  return GOOGLE_NOTES.find(([prefix]) => group === prefix || group.startsWith(`${prefix}.`))?.[1];
}

export async function findSourceRepo(http: Http, dep: DepRef, version: string, repo?: string): Promise<SourceRepo> {
  if (dep.kind === 'gradle') {
    const notesUrl = `https://docs.gradle.org/${version}/release-notes.html`;
    return { github: { owner: 'gradle', repo: 'gradle' }, url: notesUrl, notesUrl };
  }
  const fromPom = await sourceFromPom(http, dep, version, repo);
  const notesUrl = googleNotesUrl(dep.group);
  if (notesUrl) return { ...fromPom, url: fromPom.url ?? notesUrl, notesUrl };
  return fromPom;
}

async function sourceFromPom(http: Http, dep: DepRef, version: string, repo?: string): Promise<SourceRepo> {
  const [root, , owner] = dep.group.split('.');
  if (dep.group.startsWith('com.github.') && owner) {
    return { github: { owner, repo: dep.artifact }, url: `https://github.com/${owner}/${dep.artifact}` };
  }
  if (dep.group === 'org.jetbrains.kotlin' || dep.group.startsWith('org.jetbrains.kotlin.')) {
    return { github: { owner: 'JetBrains', repo: 'kotlin' }, url: 'https://github.com/JetBrains/kotlin' };
  }
  const androidx = root === 'androidx' ? androidxReleasesUrl(dep.group) : undefined;
  if (androidx) return { url: androidx };
  if (!repo) return {};

  let coords: { group: string; artifact: string; version: string } | undefined = {
    group: dep.group,
    artifact: dep.artifact,
    version,
  };
  for (let depth = 0; coords && depth <= MAX_PARENT_DEPTH; depth++) {
    const pom = await fetchPom(http, coords.group, coords.artifact, coords.version, repo);
    if (!pom) break;
    const found = pickSource(pomCandidates(pom));
    if (found) return found;
    coords = depth === 0 && dep.artifact.endsWith('.gradle.plugin') ? (pomFirstDependency(pom) ?? pomParent(pom)) : pomParent(pom);
  }
  return {};
}

/** Gradle plugin marker POMs only declare the real plugin artifact as their single dependency. */
export function pomFirstDependency(pom: string): { group: string; artifact: string; version: string } | undefined {
  const block = /<dependency>([\s\S]*?)<\/dependency>/.exec(pom)?.[1];
  const tag = (name: string) => block && new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`).exec(block)?.[1];
  const group = tag('groupId');
  const artifact = tag('artifactId');
  const version = tag('version');
  return group && artifact && version ? { group, artifact, version } : undefined;
}

export function normalizeTag(tag: string, artifact: string): string {
  let v = tag.trim();
  const lower = () => v.toLowerCase();
  const art = artifact.toLowerCase();
  const slash = v.lastIndexOf('/');
  if (slash !== -1) {
    const scope = lower().slice(0, slash).split('/').pop()!;
    if (!art.split(/[-_.]/).includes(scope) && scope !== art) return v;
    v = v.slice(slash + 1);
  }
  for (const prefix of [`${art}@`, `${art}-`, 'release-', 'v']) {
    if (lower().startsWith(prefix)) v = v.slice(prefix.length);
  }
  return v;
}

const isVersionLike = (v: string) => /^\d+(\.\d+)*([-.+_][0-9A-Za-z.+_-]*)?$/.test(v);

const trimZeros = (v: string) => v.replace(/(\.0)+(?=$|-)/, '');

/** Trailing ".0" parts are ignored so a "v9.8.0" tag matches version "9.8". */
function inRange(v: string, from: string, to: string, compare: Compare): boolean {
  const x = trimZeros(v);
  return compare(x, trimZeros(from)) > 0 && compare(x, trimZeros(to)) <= 0;
}

/** Some projects tag without the artifact's major, e.g. protobuf-java 4.36.2 is tag v36.2. */
function withoutMajor(v: string): string | undefined {
  const parts = v.split('.');
  return parts.length >= 3 && /^\d+$/.test(parts[0]!) ? parts.slice(1).join('.') : undefined;
}

const sortDesc = (entries: ChangelogEntry[], compare: Compare) =>
  entries.sort((a, b) => compare(b.version, a.version));

type ReleaseResult = { entries: ChangelogEntry[]; rateLimited: boolean };

async function releaseEntries(
  http: Http,
  gh: GithubRepo,
  artifact: string,
  from: string,
  to: string,
  compare: Compare,
  includePre: boolean,
): Promise<ReleaseResult> {
  const entries: ChangelogEntry[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const res = await http
      .get(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases?per_page=100&page=${page}`)
      .catch(() => undefined);
    if (res && (res.status === 403 || res.status === 429)) return { entries, rateLimited: true };
    if (res?.status !== 200) break;
    const releases = JSON.parse(res.body) as Release[];
    const versions: string[] = [];
    for (const r of releases) {
      const version = normalizeTag(r.tag_name, artifact);
      if (r.draft || !isVersionLike(version)) continue;
      versions.push(version);
      if (!inRange(version, from, to, compare) || (r.prerelease && !includePre)) continue;
      entries.push({
        version,
        title: r.name || undefined,
        body: r.body ?? '',
        url: r.html_url,
        date: r.published_at ?? undefined,
      });
    }
    if (releases.length < 100 || versions.every((v) => compare(v, from) < 0)) break;
  }
  return { entries, rateLimited: false };
}

const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const VERSION_TOKEN = /(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)(?![\w.])/;

export function splitChangelog(markdown: string): ChangelogEntry[] {
  const sections: (ChangelogEntry & { level: number; lines: string[] })[] = [];
  let current: (typeof sections)[number] | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!;
      const version = VERSION_TOKEN.exec(title)?.[1];
      if (version) {
        current = { version, title, body: '', level, lines: [] };
        sections.push(current);
        continue;
      }
      if (current && level <= current.level) current = undefined;
    }
    current?.lines.push(line);
  }
  return sections.map(({ version, title, lines }) => ({ version, title, body: lines.join('\n').trim() }));
}

async function changelogFileEntries(
  http: Http,
  gh: GithubRepo,
  from: string,
  to: string,
  compare: Compare,
): Promise<Changelog | undefined> {
  for (const file of CHANGELOG_FILES) {
    const res = await http
      .get(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/${file}`)
      .catch(() => undefined);
    if (res?.status !== 200) continue;
    const entries = splitChangelog(res.body).filter((e) => inRange(e.version, from, to, compare));
    if (entries.length) {
      const source = `https://github.com/${gh.owner}/${gh.repo}/blob/HEAD/${file}`;
      return { entries: sortDesc(dedupe(entries), compare), source };
    }
  }
  return undefined;
}

function dedupe(entries: ChangelogEntry[]): ChangelogEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.version) && !!seen.add(e.version));
}

export async function getChangelog(
  http: Http,
  dep: DepRef,
  from: string,
  to: string,
  repo: string | undefined,
  compare: Compare,
): Promise<Changelog> {
  const src = await findSourceRepo(http, dep, to, repo);
  const gh = src.github;
  if (!gh) return { entries: [], source: src.notesUrl ?? src.url };
  const releasesUrl = `https://github.com/${gh.owner}/${gh.repo}/releases`;
  const fallback: Changelog = { entries: [], source: src.notesUrl ?? releasesUrl };
  const includePre = isPrerelease(to);

  const ranges: [string, string][] = [[from, to]];
  const [shortFrom, shortTo] = [withoutMajor(from), withoutMajor(to)];
  if (shortFrom && shortTo && compare(shortFrom, shortTo) < 0) ranges.push([shortFrom, shortTo]);

  for (const [a, b] of ranges) {
    const releases = await releaseEntries(http, gh, dep.artifact, a, b, compare, includePre);
    if (releases.entries.length) return { entries: sortDesc(releases.entries, compare), source: releasesUrl };
    if (releases.rateLimited) return fallback;
    const files = await changelogFileEntries(http, gh, a, b, compare);
    if (files) return files;
  }
  return fallback;
}
