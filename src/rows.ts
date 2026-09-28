import type { ProjectOptions } from './config.js';
import { matchesAny } from './config.js';
import { intersectVersions, pick, selectCandidates } from './policy.js';
import type { Progress } from './progress.js';
import { fetchPublishedAt, fetchVersions } from './repos.js';
import type { Candidates, Dependency, Http, Location, Target } from './types.js';
import { compareVersions, preferStyle, upgradeLevel } from './version.js';

export interface Choice {
  level: Target | 'downgrade';
  version: string;
}

export interface Row {
  name: string;
  deps: Dependency[];
  current: string;
  location?: Location;
  /** Unique versions, lowest first. */
  choices: Choice[];
  /** Index into choices picked by the configured target. */
  selected?: number;
  repoOf: Map<string, string>;
  errors: string[];
}

export interface BuildOptions {
  http: Http;
  optionsFor: (file: string) => Promise<ProjectOptions>;
  extraRepositories: string[];
  progress: Progress;
  now: Date;
}

export function displayName(dep: Dependency): string {
  if (dep.kind === 'plugin' && dep.artifact.endsWith('.gradle.plugin')) return dep.group;
  if (dep.kind === 'gradle') return 'gradle (wrapper)';
  return `${dep.group}:${dep.artifact}`;
}

export function levelColor(level: Choice['level']) {
  return level === 'major' ? 'red' : level === 'minor' ? 'yellow' : level === 'patch' ? 'green' : 'magenta';
}

/** Dependencies sharing one version literal (catalog ref, property) become one row. */
function groupByLocation(deps: Dependency[]): Dependency[][] {
  const groups = new Map<string, Dependency[]>();
  for (const dep of deps) {
    const key = dep.location
      ? `${dep.location.file}:${dep.location.start}`
      : `${dep.group}:${dep.artifact}:${dep.version}:${dep.file}`;
    const list = groups.get(key) ?? [];
    list.push(dep);
    groups.set(key, list);
  }
  return [...groups.values()];
}

export async function buildRows(deps: Dependency[], opts: BuildOptions): Promise<Row[]> {
  const filtered: { dep: Dependency; options: ProjectOptions }[] = [];
  for (const dep of deps) {
    const options = await opts.optionsFor(dep.file);
    if (options.include.length && !matchesAny(options.include, dep.group, dep.artifact)) continue;
    if (matchesAny(options.exclude, dep.group, dep.artifact)) continue;
    filtered.push({ dep, options });
  }
  const optionsOf = new Map(filtered.map((f) => [f.dep, f.options]));
  const groups = groupByLocation(filtered.map((f) => f.dep));
  opts.progress.total(groups.length);

  return Promise.all(
    groups.map(async (group) => {
      try {
        return await buildRow(group, optionsOf.get(group[0]!)!, opts);
      } finally {
        opts.progress.tick();
      }
    }),
  );
}

async function buildRow(group: Dependency[], options: ProjectOptions, opts: BuildOptions): Promise<Row> {
  const first = group[0]!;
  const extra = first.kind === 'gradle' ? [] : [...opts.extraRepositories, ...options.repositories].map((r) => (r.endsWith('/') ? r : `${r}/`));
  const results = await Promise.all(
    group.map((dep) => fetchVersions(opts.http, { ...dep, repositories: [...new Set([...dep.repositories, ...extra])] })),
  );
  const errors = [...new Set(results.flatMap((r) => r.errors))];
  const repoOf = results[0]!.repoOf;
  const versions = preferStyle(first.version, intersectVersions(results.map((r) => r.versions)));
  const name = group.length > 1 ? `${displayName(first)} (+${group.length - 1})` : displayName(first);

  const candidates = await selectCandidates(
    first.version,
    versions,
    { target: options.target, pre: options.pre, cooldownDays: options.cooldown, allowDowngrade: options.allowDowngrade, now: opts.now },
    (v) => fetchPublishedAt(opts.http, first, v, repoOf.get(v)),
  );

  const choices = toChoices(first.version, candidates);
  const wanted = candidates.downgrade ?? pick(candidates, options.target);
  const selected = wanted === undefined ? undefined : choices.findIndex((c) => c.version === wanted);
  return { name, deps: group, current: first.version, location: first.location, choices, selected: selected === -1 ? undefined : selected, repoOf, errors };
}

export function toChoices(current: string, c: Candidates): Choice[] {
  const seen = new Set<string>();
  const choices: Choice[] = [];
  if (c.downgrade) {
    choices.push({ level: 'downgrade', version: c.downgrade });
    seen.add(c.downgrade);
  }
  for (const v of [c.patch, c.minor, c.major]) {
    if (!v || seen.has(v)) continue;
    const level = upgradeLevel(current, v);
    if (!level) continue;
    seen.add(v);
    choices.push({ level, version: v });
  }
  return choices.sort((a, b) => compareVersions(a.version, b.version));
}
