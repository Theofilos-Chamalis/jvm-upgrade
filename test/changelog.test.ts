import { describe, expect, it } from 'vitest';
import {
  androidxReleasesUrl,
  findSourceRepo,
  getChangelog,
  normalizeScmUrl,
  normalizeTag,
  splitChangelog,
} from '../src/changelog.js';
import type { Http, HttpResponse } from '../src/types.js';

function fakeHttp(routes: Record<string, HttpResponse>): Http & { calls: string[] } {
  const calls: string[] = [];
  const respond = async (url: string) => {
    calls.push(url);
    return routes[url] ?? { status: 404, headers: {}, body: '' };
  };
  return { calls, get: respond, head: respond };
}

const ok = (body: string): HttpResponse => ({ status: 200, headers: {}, body });

const compare = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const REPO = 'https://repo.example/';
const lib = { group: 'com.example', artifact: 'lib', kind: 'library' as const };
const pomUrl = (g: string, a: string, v: string) => `${REPO}${g.replaceAll('.', '/')}/${a}/${v}/${a}-${v}.pom`;

describe('normalizeScmUrl', () => {
  it.each([
    'scm:git:git@github.com:square/okhttp.git',
    'scm:git:https://github.com/square/okhttp.git',
    'git@github.com:square/okhttp.git',
    'git://github.com/square/okhttp.git',
    'ssh://git@github.com/square/okhttp',
    'http://github.com/square/okhttp',
    'https://github.com/square/okhttp/tree/master/okhttp',
  ])('%s', (raw) => {
    expect(normalizeScmUrl(raw)?.github).toEqual({ owner: 'square', repo: 'okhttp' });
  });

  it('keeps non-github urls and rejects placeholders', () => {
    expect(normalizeScmUrl('scm:git:https://gitlab.com/a/b.git')).toEqual({ url: 'https://gitlab.com/a/b' });
    expect(normalizeScmUrl('${project.url}')).toBeUndefined();
  });
});

describe('findSourceRepo', () => {
  it('handles special groups', async () => {
    const http = fakeHttp({});
    expect((await findSourceRepo(http, { ...lib, group: 'com.github.owner' }, '1', REPO)).github).toEqual({
      owner: 'owner',
      repo: 'lib',
    });
    expect((await findSourceRepo(http, { ...lib, group: 'org.jetbrains.kotlin' }, '1', REPO)).github).toEqual({
      owner: 'JetBrains',
      repo: 'kotlin',
    });
    expect(
      await findSourceRepo(http, { group: 'org.gradle', artifact: 'gradle', kind: 'gradle' }, '8.10', REPO),
    ).toEqual({ url: 'https://docs.gradle.org/8.10/release-notes.html' });
    expect(http.calls).toEqual([]);
  });

  it('maps androidx groups to release pages', () => {
    expect(androidxReleasesUrl('androidx.compose.ui')).toBe(
      'https://developer.android.com/jetpack/androidx/releases/compose-ui',
    );
    expect(androidxReleasesUrl('androidx.lifecycle')).toBe(
      'https://developer.android.com/jetpack/androidx/releases/lifecycle',
    );
  });

  it('prefers scm over project url and ignores urls in other sections', async () => {
    const pom = `<project><url>https://example.com</url><licenses><license><url>https://apache.org</url></license></licenses>
      <scm><connection>scm:git:git@github.com:acme/lib.git</connection></scm></project>`;
    const http = fakeHttp({ [pomUrl('com.example', 'lib', '1.0')]: ok(pom) });
    expect((await findSourceRepo(http, lib, '1.0', REPO)).github).toEqual({ owner: 'acme', repo: 'lib' });
    const noScm = `<project><licenses><license><url>https://apache.org</url></license></licenses><url>https://example.com/lib</url></project>`;
    const http2 = fakeHttp({ [pomUrl('com.example', 'lib', '1.0')]: ok(noScm) });
    expect(await findSourceRepo(http2, lib, '1.0', REPO)).toEqual({ url: 'https://example.com/lib' });
  });

  it('follows parent POMs up to 3 levels', async () => {
    const parent = (g: string, a: string, v: string) =>
      `<project><parent><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version><url>https://nope</url></parent></project>`;
    const routes = {
      [pomUrl('com.example', 'lib', '1.0')]: ok(parent('com.example', 'p1', '1')),
      [pomUrl('com.example', 'p1', '1')]: ok(parent('com.example', 'p2', '1')),
      [pomUrl('com.example', 'p2', '1')]: ok(parent('com.example', 'p3', '1')),
      [pomUrl('com.example', 'p3', '1')]: ok('<project><scm><url>https://github.com/acme/root</url></scm></project>'),
    };
    expect((await findSourceRepo(fakeHttp(routes), lib, '1.0', REPO)).github).toEqual({ owner: 'acme', repo: 'root' });
    routes[pomUrl('com.example', 'p3', '1')] = ok(parent('com.example', 'p4', '1'));
    routes[pomUrl('com.example', 'p4', '1')] = ok('<project><scm><url>https://github.com/acme/deep</url></scm></project>');
    expect(await findSourceRepo(fakeHttp(routes), lib, '1.0', REPO)).toEqual({});
  });
});

describe('normalizeTag', () => {
  it.each([
    ['v1.2.3', '1.2.3'],
    ['release-1.2.3', '1.2.3'],
    ['lib-1.2.3', '1.2.3'],
    ['LIB@1.2.3', '1.2.3'],
    ['Release-v2.0', '2.0'],
    ['1.0.0-RC1', '1.0.0-RC1'],
  ])('%s -> %s', (tag, expected) => {
    expect(normalizeTag(tag, 'lib')).toBe(expected);
  });
});

describe('splitChangelog', () => {
  it('splits at version headings and keeps sub-headings in the body', () => {
    const md = `# Changelog

## [Unreleased]
- wip

## [2.0.0] - 2024-05-01
### Added
- big thing

## Version 1.5
- small thing

## 1.0.0
- first
`;
    const entries = splitChangelog(md);
    expect(entries.map((e) => e.version)).toEqual(['2.0.0', '1.5', '1.0.0']);
    expect(entries[0]!.body).toBe('### Added\n- big thing');
    expect(entries[1]!.body).toBe('- small thing');
  });
});

describe('getChangelog', () => {
  const gh = { ...lib, group: 'com.github.acme' };
  const releasesApi = (page: number) => `https://api.github.com/repos/acme/lib/releases?per_page=100&page=${page}`;

  it('returns releases in (from, to] sorted descending', async () => {
    const releases = [
      { tag_name: 'v1.3.0', name: 'One three', body: 'c', html_url: 'u3' },
      { tag_name: 'v1.1.0', body: 'a' },
      { tag_name: 'v1.2.0', body: 'b' },
      { tag_name: 'v1.0.0', body: 'old' },
      { tag_name: 'nightly', body: 'x' },
      { tag_name: 'v1.2.5', body: 'draft', draft: true },
    ];
    const http = fakeHttp({ [releasesApi(1)]: ok(JSON.stringify(releases)) });
    const log = await getChangelog(http, gh, '1.0.0', '1.2.0', REPO, compare);
    expect(log.entries.map((e) => [e.version, e.body])).toEqual([
      ['1.2.0', 'b'],
      ['1.1.0', 'a'],
    ]);
    expect(log.source).toBe('https://github.com/acme/lib/releases');
  });

  it('paginates and stops once a page is entirely older than from', async () => {
    const page = (start: number) =>
      ok(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ tag_name: `v${start - i}.0`, body: '' }))));
    const http = fakeHttp({ [releasesApi(1)]: page(300), [releasesApi(2)]: page(200), [releasesApi(3)]: page(100) });
    const log = await getChangelog(http, gh, '150.0', '205.0', REPO, compare);
    expect(log.entries).toHaveLength(55);
    expect(http.calls.filter((c) => c.includes('/releases'))).toHaveLength(3);
  });

  it('falls back to CHANGELOG.md sections', async () => {
    const http = fakeHttp({
      [releasesApi(1)]: ok('[]'),
      'https://raw.githubusercontent.com/acme/lib/HEAD/CHANGES.md': ok('## 1.1\n- fix\n## 1.0\n- init\n'),
    });
    const log = await getChangelog(http, gh, '1.0', '1.1', REPO, compare);
    expect(log.entries).toEqual([{ version: '1.1', title: '1.1', body: '- fix' }]);
    expect(log.source).toBe('https://github.com/acme/lib/blob/HEAD/CHANGES.md');
  });

  it('returns the releases page when rate limited', async () => {
    const http = fakeHttp({ [releasesApi(1)]: { status: 403, headers: {}, body: '' } });
    expect(await getChangelog(http, gh, '1.0', '1.1', REPO, compare)).toEqual({
      entries: [],
      source: 'https://github.com/acme/lib/releases',
    });
    expect(http.calls).toHaveLength(1);
  });

  it('returns the project url when there is no GitHub repo', async () => {
    const http = fakeHttp({ [pomUrl('com.example', 'lib', '2.0')]: ok('<project><url>https://lib.example</url></project>') });
    expect(await getChangelog(http, lib, '1.0', '2.0', REPO, compare)).toEqual({
      entries: [],
      source: 'https://lib.example',
    });
  });
});

describe('pomFirstDependency', () => {
  it('reads the real artifact of a Gradle plugin marker', async () => {
    const { pomFirstDependency } = await import('../src/changelog.js');
    const pom = '<project><dependencies><dependency>\n<groupId>com.google.protobuf</groupId>\n<artifactId>protobuf-gradle-plugin</artifactId>\n<version>0.10.0</version>\n</dependency></dependencies></project>';
    expect(pomFirstDependency(pom)).toEqual({ group: 'com.google.protobuf', artifact: 'protobuf-gradle-plugin', version: '0.10.0' });
    expect(pomFirstDependency('<project/>')).toBeUndefined();
  });
});

describe('normalizeTag with scoped tags', () => {
  it('keeps only tags scoped to this artifact', async () => {
    const { normalizeTag } = await import('../src/changelog.js');
    expect(normalizeTag('gradle/8.10.3', 'spotless-plugin-gradle')).toBe('8.10.3');
    expect(normalizeTag('lib/3.0.0', 'spotless-plugin-gradle')).toBe('lib/3.0.0');
  });
});
