import { describe, expect, it, vi } from 'vitest';
import { intersectVersions, pick, selectCandidates } from '../src/policy.js';
import type { PolicyOptions } from '../src/types.js';

const now = new Date('2026-01-31T00:00:00Z');
const opts = (o: Partial<PolicyOptions> = {}): PolicyOptions => ({
  target: 'major',
  pre: false,
  cooldownDays: 0,
  allowDowngrade: false,
  now,
  ...o,
});
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const noDates = async () => undefined;
const dates = (ages: Record<string, number>) =>
  vi.fn(async (v: string) => (v in ages ? daysAgo(ages[v]!) : undefined));

describe('selectCandidates', () => {
  const versions = ['1.0.0', '1.0.1', '1.0.2', '1.1.0', '1.2.0', '1.2.1', '2.0.0', '2.1.0', '3.0.0-RC1', '3.0.0-SNAPSHOT'];

  it('picks best per level for stable current', async () => {
    expect(await selectCandidates('1.0.1', versions, opts(), noDates)).toEqual({
      patch: '1.0.2',
      minor: '1.2.1',
      major: '2.1.0',
    });
  });

  it('returns empty when up to date', async () => {
    expect(await selectCandidates('2.1.0', versions, opts(), noDates)).toEqual({});
  });

  it('allows prereleases with pre', async () => {
    expect((await selectCandidates('2.1.0', versions, opts({ pre: true }), noDates)).major).toBe('3.0.0-RC1');
  });

  it('allows prereleases when current is prerelease', async () => {
    const c = await selectCandidates('2.0.0-Beta1', ['2.0.0-Beta1', '2.0.0-Beta2', '2.0.0-RC1', '2.0.0', '2.0.20-Beta1'], opts(), noDates);
    expect(c).toEqual({ patch: '2.0.20-Beta1', minor: '2.0.20-Beta1', major: '2.0.20-Beta1' });
  });

  it('never picks snapshots unless current is a snapshot', async () => {
    expect((await selectCandidates('2.1.0', versions, opts({ pre: true }), noDates)).major).not.toContain('SNAPSHOT');
    const c = await selectCandidates('3.0.0-RC1', versions, opts(), noDates);
    expect(c.major).toBeUndefined();
    expect((await selectCandidates('2.9-SNAPSHOT', versions, opts(), noDates)).major).toBe('3.0.0-SNAPSHOT');
  });

  it('keeps Guava flavors as stable', async () => {
    const c = await selectCandidates('32.1.3-jre', ['32.1.3-jre', '33.0.0-jre', '33.1.0-jre'], opts(), noDates);
    expect(c.major).toBe('33.1.0-jre');
  });

  it('handles androidx prereleases', async () => {
    const vs = ['1.5.0', '1.6.0-alpha01', '1.6.0-beta01', '1.6.0-rc01'];
    expect(await selectCandidates('1.5.0', vs, opts(), noDates)).toEqual({});
    expect((await selectCandidates('1.6.0-alpha01', vs, opts(), noDates)).minor).toBe('1.6.0-rc01');
  });

  it('handles Spring RELEASE suffix', async () => {
    const c = await selectCandidates('5.3.0.RELEASE', ['5.3.0.RELEASE', '5.3.1.RELEASE', '5.3.2'], opts(), noDates);
    expect(c.patch).toBe('5.3.2');
  });

  it('does not call publishedAt without cooldown', async () => {
    const pub = dates({});
    await selectCandidates('1.0.1', versions, opts(), pub);
    expect(pub).not.toHaveBeenCalled();
  });

  it('applies cooldown, keeping unknown dates', async () => {
    const pub = dates({ '2.1.0': 1, '2.0.0': 30, '1.2.1': 2, '1.2.0': 20, '1.0.2': 3 });
    const c = await selectCandidates('1.0.1', versions, opts({ cooldownDays: 7 }), pub);
    expect(c).toEqual({ minor: '1.2.0', major: '2.0.0' });
  });

  it('calls publishedAt lazily and once per version', async () => {
    const pub = dates({ '2.1.0': 1, '2.0.0': 30, '1.2.1': 30, '1.0.2': 30 });
    const c = await selectCandidates('1.0.1', versions, opts({ cooldownDays: 7 }), pub);
    expect(c).toEqual({ patch: '1.0.2', minor: '1.2.1', major: '2.0.0' });
    expect(pub.mock.calls.map((x) => x[0]).sort()).toEqual(['1.0.2', '1.2.1', '2.0.0', '2.1.0']);
  });

  it('downgrades when current is too young and nothing passes', async () => {
    const pub = dates({ '1.2.0': 2, '1.1.0': 3, '1.0.2': 10, '1.0.1': 40 });
    const vs = ['1.0.1', '1.0.2', '1.1.0', '1.1.0-RC1', '1.2.0'];
    const c = await selectCandidates('1.1.0', vs, opts({ cooldownDays: 7, allowDowngrade: true }), pub);
    expect(c).toEqual({ downgrade: '1.0.2' });
  });

  it('does not downgrade without the flag or when current is old enough', async () => {
    const vs = ['1.0.2', '1.1.0', '1.2.0'];
    const young = dates({ '1.2.0': 2, '1.1.0': 3, '1.0.2': 10 });
    expect(await selectCandidates('1.1.0', vs, opts({ cooldownDays: 7 }), young)).toEqual({});
    const old = dates({ '1.2.0': 2, '1.1.0': 30, '1.0.2': 40 });
    expect(await selectCandidates('1.1.0', vs, opts({ cooldownDays: 7, allowDowngrade: true }), old)).toEqual({});
  });

  it('does not downgrade when an upgrade passes', async () => {
    const pub = dates({ '1.2.0': 20, '1.1.0': 3, '1.0.2': 10 });
    const c = await selectCandidates('1.1.0', ['1.0.2', '1.1.0', '1.2.0'], opts({ cooldownDays: 7, allowDowngrade: true }), pub);
    expect(c).toEqual({ minor: '1.2.0', major: '1.2.0' });
  });
});

describe('pick', () => {
  const c = { patch: '1.0.2', minor: '1.2.0', major: '2.0.0' };
  it('respects target ceiling', () => {
    expect(pick(c, 'major')).toBe('2.0.0');
    expect(pick(c, 'minor')).toBe('1.2.0');
    expect(pick(c, 'patch')).toBe('1.0.2');
    expect(pick({ patch: '1.0.2' }, 'major')).toBe('1.0.2');
    expect(pick({ major: '2.0.0' }, 'minor')).toBeUndefined();
    expect(pick({}, 'major')).toBeUndefined();
  });
});

describe('intersectVersions', () => {
  it('keeps versions in every list', () => {
    expect(intersectVersions([['1', '2', '3'], ['2', '3', '4'], ['3', '2']])).toEqual(['2', '3']);
    expect(intersectVersions([['1', '1']])).toEqual(['1']);
    expect(intersectVersions([])).toEqual([]);
    expect(intersectVersions([['1'], []])).toEqual([]);
  });
});
