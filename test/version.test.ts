import { describe, expect, it } from 'vitest';
import { compareVersions, isPrerelease, isSnapshot, upgradeLevel } from '../src/version.js';

const ascending = (list: string[]) => {
  for (let i = 0; i < list.length - 1; i++) {
    expect(compareVersions(list[i]!, list[i + 1]!), `${list[i]} < ${list[i + 1]}`).toBe(-1);
    expect(compareVersions(list[i + 1]!, list[i]!), `${list[i + 1]} > ${list[i]}`).toBe(1);
  }
};

describe('compareVersions', () => {
  it('orders numeric parts numerically', () => {
    ascending(['1.0', '1.1', '1.2', '1.10', '2.0', '10.0']);
  });

  it('follows Gradle docs examples', () => {
    ascending(['1.1', '1.1.0']);
    ascending(['1.a', '1.1']);
    ascending(['1.1.a', '1.1']);
    ascending(['1.0-dev', '1.0-alpha', '1.0-rc', '1.0-snapshot', '1.0-final', '1.0-ga', '1.0-release', '1.0-sp', '1.0.1']);
    ascending(['1.0-alpha', '1.0-beta', '1.0-rc']);
    ascending(['1.0-rc-1', '1.0-rc-2']);
  });

  it('treats separators and digit boundaries alike', () => {
    expect(compareVersions('1.a.1', '1-a+1')).toBe(0);
    expect(compareVersions('1a1', '1.a.1')).toBe(0);
    expect(compareVersions('1_0', '1.0')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(compareVersions('1.0-RC1', '1.0-rc1')).toBe(0);
    ascending(['1.0-DEV', '1.0-Alpha', '1.0-RC']);
  });

  it('handles leading zeros and big numbers', () => {
    expect(compareVersions('1.01', '1.1')).toBe(0);
    ascending(['20230101', '20231231', '123456789012345678901']);
  });

  it('orders Kotlin prereleases', () => {
    ascending(['1.9.24', '2.0.0-Beta1', '2.0.0-Beta2', '2.0.0-RC1', '2.0.0-RC2', '2.0.0', '2.0.20-Beta1', '2.0.20']);
  });

  it('orders androidx prereleases', () => {
    ascending(['1.6.0-alpha01', '1.6.0-alpha02', '1.6.0-alpha10', '1.6.0-beta01', '1.6.0-rc01', '1.6.0', '1.6.1']);
  });

  it('orders Guava and Spring versions', () => {
    ascending(['32.1.3-jre', '33.0.0-jre', '33.1.0-jre']);
    ascending(['5.2.9.RELEASE', '5.3.0.RELEASE', '5.3.1.RELEASE']);
    ascending(['1.0.0.Beta1', '1.0.0.CR1', '1.0.0.Final']);
    ascending(['r09', 'r10']);
    ascending(['1.0.0-M1', '1.0.0-M2', '1.0.0-RC1', '1.0.0']);
  });
});

describe('isPrerelease', () => {
  it.each([
    '1.0-alpha', '1.0.0-a1', '2.0-beta', '1.0-b2', '1.0-milestone-1', '5.0.0-M1', '1.0-rc', '1.0.0.CR1',
    '2023.1-eap', '1.0-dev', '1.0-SNAPSHOT', '1.0-preview', '1.0-pre', '1.0-canary', '1.0-incubating',
    '21-ea', '1.0-nightly', '2.0.0-Beta1', '2.0.0-RC1', '1.6.0-alpha01', '1.0.0-beta.2', '1.0.0-M1',
    '1.2.3-SNAPSHOT', '1.0.0-rc.1', '0.9.0-dev.12', '1.0.0-preview.3',
  ])('%s is prerelease', (v) => expect(isPrerelease(v)).toBe(true));

  it.each([
    '1.0.0', '1.0.0-jre', '33.0.0-android', '1.0.0.Final', '5.3.0.RELEASE', '1.0-GA', '1.0-sp1', '2.0.0',
    '1.0.0-betamax', '3.2.1-android-1', 'r09', '31.1-jre', '20240101',
  ])('%s is not prerelease', (v) => expect(isPrerelease(v)).toBe(false));
});

describe('isSnapshot', () => {
  it('detects snapshots', () => {
    expect(isSnapshot('1.0-SNAPSHOT')).toBe(true);
    expect(isSnapshot('1.0-snapshot')).toBe(true);
    expect(isSnapshot('1.0')).toBe(false);
    expect(isSnapshot('1.0-rc1')).toBe(false);
  });
});

describe('upgradeLevel', () => {
  it('classifies upgrades', () => {
    expect(upgradeLevel('1.2.3', '2.0.0')).toBe('major');
    expect(upgradeLevel('1.2.3', '1.3.0')).toBe('minor');
    expect(upgradeLevel('1.2.3', '1.2.4')).toBe('patch');
    expect(upgradeLevel('1.2', '1.2.1')).toBe('patch');
    expect(upgradeLevel('1', '1.1')).toBe('minor');
    expect(upgradeLevel('2.0.0-RC1', '2.0.0')).toBe('patch');
    expect(upgradeLevel('32.1.3-jre', '33.0.0-jre')).toBe('major');
    expect(upgradeLevel('5.3.0.RELEASE', '5.3.1.RELEASE')).toBe('patch');
    expect(upgradeLevel('1.9.10', '1.10.0')).toBe('minor');
  });

  it('returns undefined when not higher', () => {
    expect(upgradeLevel('1.2.3', '1.2.3')).toBeUndefined();
    expect(upgradeLevel('1.2.3', '1.2.2')).toBeUndefined();
    expect(upgradeLevel('2.0.0', '2.0.0-RC1')).toBeUndefined();
  });
});

describe('v prefix (JitPack tags)', () => {
  it('ignores a leading v when comparing', async () => {
    const { compareVersions, upgradeLevel, preferStyle } = await import('../src/version.js');
    expect(compareVersions('v4.0.0', '4.0.0')).toBe(0);
    expect(compareVersions('2.1.5', 'v3.0.3')).toBeLessThan(0);
    expect(upgradeLevel('v3.0.3', 'v4.0.0')).toBe('major');
    expect(upgradeLevel('v3.0.3', 'v3.2.0')).toBe('minor');
    expect(preferStyle('v3.0.3', ['v3.2.0', '4.0.0', 'v4.0.0', '5.0.0'])).toEqual(['v3.2.0', 'v4.0.0', '5.0.0']);
    expect(preferStyle('3.0.3', ['v4.0.0', '4.0.0'])).toEqual(['4.0.0']);
  });
});
