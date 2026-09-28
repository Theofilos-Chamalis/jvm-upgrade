import type { Target } from './types.js';

const SPECIAL: Record<string, number> = { dev: -1, rc: 1, snapshot: 2, final: 3, ga: 4, release: 5, sp: 6 };

const PRERELEASE = new Set([
  'alpha', 'a', 'beta', 'b', 'milestone', 'm', 'rc', 'cr', 'eap', 'dev', 'snapshot', 'preview', 'pre',
  'canary', 'incubating', 'ea', 'nightly', 'experimental',
]);

const isNum = (s: string) => /^\d+$/.test(s);

export function tokenize(v: string): string[] {
  return v.toLowerCase().replace(/^v(?=\d)/, '').match(/\d+|[^\d._\-+]+/g) ?? [];
}

function compareNumeric(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

function compareParts(a: string, b: string): number {
  const an = isNum(a);
  const bn = isNum(b);
  if (an && bn) return compareNumeric(a, b);
  if (an !== bn) return an ? 1 : -1;
  const sa = SPECIAL[a] ?? 0;
  const sb = SPECIAL[b] ?? 0;
  if (sa !== sb) return sa - sb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = tokenize(a);
  const pb = tokenize(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = compareParts(pa[i]!, pb[i]!);
    if (c !== 0) return Math.sign(c);
  }
  if (pa.length === pb.length) return 0;
  const [extra, sign] = pa.length > pb.length ? [pa[pb.length]!, 1] : [pb[pa.length]!, -1];
  return isNum(extra) ? sign : -sign;
}

export function isSnapshot(v: string): boolean {
  return tokenize(v).includes('snapshot');
}

export function isPrerelease(v: string): boolean {
  return tokenize(v).some((t) => PRERELEASE.has(t));
}

export function isDynamic(v: string): boolean {
  const s = v.trim();
  return /^[[(]/.test(s) || /[\])]$/.test(s) || s.endsWith('+') || /^latest\./i.test(s) || /^(LATEST|RELEASE)$/.test(s);
}

export function upgradeLevel(from: string, to: string): Target | undefined {
  if (compareVersions(to, from) <= 0) return undefined;
  const f = tokenize(from);
  const t = tokenize(to);
  const part = (p: string[], i: number) => p[i] ?? '0';
  if (compareParts(part(f, 0), part(t, 0)) !== 0) return 'major';
  if (compareParts(part(f, 1), part(t, 1)) !== 0) return 'minor';
  return 'patch';
}

/** JitPack often has both "v1.2" and "1.2" for one tag. Keep the style the project already uses. */
export function preferStyle(current: string, versions: string[]): string[] {
  const prefixed = /^v\d/i.test(current);
  const all = new Set(versions);
  return versions.filter((v) => {
    const hasV = /^v\d/i.test(v);
    if (hasV === prefixed) return true;
    return !all.has(hasV ? v.slice(1) : `v${v}`);
  });
}
