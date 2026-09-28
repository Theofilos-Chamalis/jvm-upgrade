import type { Candidates, PolicyOptions, Target } from './types.js';
import { compareVersions, isPrerelease, isSnapshot, upgradeLevel } from './version.js';

const DAY_MS = 86_400_000;
const RANK: Record<Target, number> = { patch: 0, minor: 1, major: 2 };

export async function selectCandidates(
  current: string,
  versions: string[],
  opts: PolicyOptions,
  publishedAt: (v: string) => Promise<Date | undefined>,
): Promise<Candidates> {
  const allowSnapshot = isSnapshot(current);
  const allowPre = opts.pre || isPrerelease(current);
  const allowed = [...new Set(versions)]
    .filter((v) => (allowSnapshot || !isSnapshot(v)) && (allowPre || !isPrerelease(v)))
    .sort((a, b) => compareVersions(b, a));

  const memo = new Map<string, Promise<boolean>>();
  const cutoff = opts.now.getTime() - opts.cooldownDays * DAY_MS;
  const passes = (v: string): Promise<boolean> => {
    if (opts.cooldownDays <= 0) return Promise.resolve(true);
    let p = memo.get(v);
    if (!p) {
      p = publishedAt(v).then((d) => !d || d.getTime() <= cutoff);
      memo.set(v, p);
    }
    return p;
  };
  const firstPassing = async (list: string[]) => {
    for (const v of list) if (await passes(v)) return v;
    return undefined;
  };

  const upgrades = allowed
    .map((v) => ({ v, level: upgradeLevel(current, v) }))
    .filter((c): c is { v: string; level: Target } => c.level !== undefined);
  const upTo = (t: Target) => upgrades.filter((c) => RANK[c.level] <= RANK[t]).map((c) => c.v);

  const result: Candidates = {};
  for (const t of ['major', 'minor', 'patch'] as const) {
    const v = await firstPassing(upTo(t));
    if (v) result[t] = v;
  }

  if (opts.allowDowngrade && opts.cooldownDays > 0 && !result.major && !(await passes(current))) {
    const v = await firstPassing(allowed.filter((x) => compareVersions(x, current) < 0));
    if (v) result.downgrade = v;
  }
  return result;
}

export function pick(c: Candidates, target: Target): string | undefined {
  if (target === 'major') return c.major ?? c.minor ?? c.patch;
  if (target === 'minor') return c.minor ?? c.patch;
  return c.patch;
}

export function intersectVersions(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  const sets = rest.map((l) => new Set(l));
  return [...new Set(first)].filter((v) => sets.every((s) => s.has(v)));
}
