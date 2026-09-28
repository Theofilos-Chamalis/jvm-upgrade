import { describe, expect, it } from 'vitest';
import { fetchPom, fetchPublishedAt, fetchVersions, parseGradleBuildTime, parseMetadata } from '../src/repos.js';
import type { Http, HttpResponse } from '../src/types.js';

type Route = HttpResponse | Error;

function fakeHttp(routes: Record<string, Route>): Http & { calls: string[] } {
  const calls: string[] = [];
  const respond = async (method: string, url: string): Promise<HttpResponse> => {
    calls.push(`${method} ${url}`);
    const r = routes[url];
    if (r instanceof Error) throw r;
    return r ?? { status: 404, headers: {}, body: '' };
  };
  return { calls, get: (u) => respond('GET', u), head: (u) => respond('HEAD', u) };
}

const ok = (body: string, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, body });
const meta = (...versions: string[]) =>
  `<metadata><versioning><latest>${versions.at(-1)}</latest><release>${versions.at(-1)}</release><versions>${versions
    .map((v) => `<version>${v}</version>`)
    .join('\n')}</versions></versioning></metadata>`;

const A = 'https://a.example/';
const B = 'https://b.example/';
const dep = { group: 'com.example.lib', artifact: 'core', kind: 'library' as const, repositories: [A, B] };
const path = 'com/example/lib/core/maven-metadata.xml';

describe('parseMetadata', () => {
  it('reads versions, latest and release', () => {
    const xml = '<metadata><versioning><latest>3.0</latest><release>2.0</release><versions><version> 1.0 </version><version>2.0</version></versions></versioning></metadata>';
    expect(parseMetadata(xml).sort()).toEqual(['1.0', '2.0', '3.0']);
  });
});

describe('fetchVersions', () => {
  it('merges repos and maps each version to the first repo in order', async () => {
    const http = fakeHttp({ [`${A}${path}`]: ok(meta('1.0', '1.1')), [`${B}${path}`]: ok(meta('1.1', '2.0')) });
    const r = await fetchVersions(http, dep);
    expect(r.versions.sort()).toEqual(['1.0', '1.1', '2.0']);
    expect(r.repoOf.get('1.1')).toBe(A);
    expect(r.repoOf.get('2.0')).toBe(B);
    expect(r.errors).toEqual([]);
  });

  it('treats 404 as empty and 401/403/network failure as errors', async () => {
    const http = fakeHttp({ [`${B}${path}`]: { status: 401, headers: {}, body: '' } });
    const r = await fetchVersions(http, { ...dep, repositories: [A, B, 'https://c.example/'] });
    const failing = fakeHttp({ [`${A}${path}`]: new Error('ECONNREFUSED') });
    const r2 = await fetchVersions(failing, dep);
    expect(r.versions).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('401');
    expect(r2.errors[0]).toContain('ECONNREFUSED');
  });

  it('falls back to GitHub tags for jitpack com.github groups', async () => {
    const http = fakeHttp({
      'https://api.github.com/repos/user/proj/tags?per_page=100': ok(JSON.stringify([{ name: 'v1.2.0' }, { name: '1.1' }])),
    });
    const r = await fetchVersions(http, {
      group: 'com.github.user',
      artifact: 'proj',
      kind: 'library',
      repositories: ['https://jitpack.io/'],
    });
    expect(r.versions).toEqual(['1.2.0', '1.1']);
    expect(r.repoOf.get('1.2.0')).toBe('https://jitpack.io/');
  });

  it('lists gradle wrapper versions without snapshots, nightlies or broken builds', async () => {
    const list = [
      { version: '8.10', buildTime: '20240814110745+0000' },
      { version: '8.10-rc-1', buildTime: '20240801000000+0000' },
      { version: '8.11-20240901', snapshot: true },
      { version: '8.11-n', nightly: true },
      { version: '8.9-r', releaseNightly: true },
      { version: '8.0.1', broken: true },
    ];
    const http = fakeHttp({ 'https://services.gradle.org/versions/all': ok(JSON.stringify(list)) });
    const gradle = { group: 'org.gradle', artifact: 'gradle', kind: 'gradle' as const, repositories: [] };
    const r = await fetchVersions(http, gradle);
    expect(r.versions).toEqual(['8.10', '8.10-rc-1']);
    expect(r.repoOf.size).toBe(0);
    expect(await fetchPublishedAt(http, gradle, '8.10')).toEqual(new Date('2024-08-14T11:07:45Z'));
    expect(http.calls).toHaveLength(1);
  });
});

describe('fetchPublishedAt', () => {
  it('reads Last-Modified from a HEAD of the POM and memoizes', async () => {
    const pom = `${A}com/example/lib/core/1.0/core-1.0.pom`;
    const http = fakeHttp({ [pom]: ok('', { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }) });
    expect(await fetchPublishedAt(http, dep, '1.0', A)).toEqual(new Date('2015-10-21T07:28:00Z'));
    await fetchPublishedAt(http, dep, '1.0', A);
    expect(http.calls).toEqual([`HEAD ${pom}`]);
    expect(await fetchPublishedAt(http, dep, '9.9', A)).toBeUndefined();
  });

  it('parses gradle build times with offsets', () => {
    expect(parseGradleBuildTime('20240812123456+0200')).toEqual(new Date('2024-08-12T10:34:56Z'));
    expect(parseGradleBuildTime('bogus')).toBeUndefined();
  });
});

describe('fetchPom', () => {
  it('returns the body or undefined', async () => {
    const http = fakeHttp({ [`${A}com/example/lib/core/1.0/core-1.0.pom`]: ok('<project/>') });
    expect(await fetchPom(http, 'com.example.lib', 'core', '1.0', A)).toBe('<project/>');
    expect(await fetchPom(http, 'com.example.lib', 'core', '2.0', A)).toBeUndefined();
  });
});
