import { describe, expect, it } from 'vitest';
import { renderTable, toJson } from '../src/format.js';
import { toChoices, type Row } from '../src/rows.js';
import { initialState, reduce } from '../src/tui.js';

const row = (over: Partial<Row> = {}): Row => ({
  name: 'com.squareup.okhttp3:okhttp',
  deps: [{ group: 'com.squareup.okhttp3', artifact: 'okhttp', kind: 'library', version: '4.9.0', file: '/p/build.gradle', repositories: [] }],
  current: '4.9.0',
  location: { file: '/p/build.gradle', start: 0, end: 5 },
  choices: toChoices('4.9.0', { patch: '4.9.3', minor: '4.12.0', major: '5.1.0' }),
  selected: 2,
  repoOf: new Map(),
  errors: [],
  ...over,
});

describe('toChoices', () => {
  it('dedupes and labels by real jump', () => {
    expect(toChoices('1.2.0', { patch: '1.2.1', minor: '1.2.1', major: '1.2.1' })).toEqual([{ level: 'patch', version: '1.2.1' }]);
    expect(toChoices('1.2.0', { minor: '1.3.0', major: '2.0.0' })).toEqual([
      { level: 'minor', version: '1.3.0' },
      { level: 'major', version: '2.0.0' },
    ]);
    expect(toChoices('1.2.0', { downgrade: '1.1.0' })).toEqual([{ level: 'downgrade', version: '1.1.0' }]);
  });
});

describe('picker', () => {
  it('moves, cycles versions and toggles', () => {
    const rows = [row(), row({ name: 'b', selected: 0 })];
    let s = initialState(rows);
    expect(s.choice).toEqual([2, 0]);
    s = reduce(s, rows, 'left') as typeof s;
    expect(s.choice[0]).toBe(1);
    s = reduce(s, rows, 'right') as typeof s;
    s = reduce(s, rows, 'right') as typeof s;
    expect(s.choice[0]).toBeNull();
    s = reduce(s, rows, 'space') as typeof s;
    expect(s.choice[0]).toBe(2);
    s = reduce(s, rows, 'down') as typeof s;
    s = reduce(s, rows, 'down') as typeof s;
    expect(s.cursor).toBe(1);
    s = reduce(s, rows, 'all') as typeof s;
    expect(s.choice).toEqual([null, null]);
    s = reduce(s, rows, 'all') as typeof s;
    expect(s.choice).toEqual([2, 0]);
    expect(reduce(s, rows, 'enter')).toBe('submit');
    expect(reduce(s, rows, 'cancel')).toBe('cancel');
  });

  it('never selects rows that cannot be rewritten', () => {
    const rows = [row({ location: undefined, selected: undefined })];
    const s = initialState(rows);
    expect(reduce(s, rows, 'space')).toEqual(s);
  });
});

describe('output', () => {
  it('renders a table and json', () => {
    const text = renderTable([row()], '/p').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('com.squareup.okhttp3:okhttp');
    expect(text).toMatch(/4\.9\.0\s+4\.9\.3\s+4\.12\.0\s+5\.1\.0/);
    expect(toJson([row()], '/p')[0]).toMatchObject({ current: '4.9.0', patch: '4.9.3', minor: '4.12.0', major: '5.1.0', selected: '5.1.0', rewritable: true });
  });
});

describe('changelog output', () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('cleans release-note markdown', async () => {
    const { renderMarkdown } = await import('../src/format.js');
    const md = [
      '<!-- hidden -->',
      '## What\'s Changed',
      '',
      '* Fix `Call` by @a in https://github.com/o/r/pull/12',
      '* Update x by @renovate[bot] in https://github.com/o/r/pull/13',
      '  - nested [link](https://example.com)',
      '**Fixed**',
      '- Bug (https://github.com/o/r/commit/30780158a07394a22eba3d57527ef32cac795e76)',
      '[1.0.0]: https://github.com/o/r/releases/tag/1.0.0',
      '![img](https://x/y.png)',
    ].join('\n');
    expect(renderMarkdown(md, 80).map(plain)).toEqual([
      "What's Changed",
      '• Fix Call by @a in #12',
      '  • nested link',
      '',
      'Fixed',
      '• Bug (30780158)',
    ]);
  });

  it('wraps long bullets with a hanging indent', async () => {
    const { renderMarkdown } = await import('../src/format.js');
    const lines = renderMarkdown(`- ${'word '.repeat(20).trim()}`, 30).map(plain);
    expect(lines[0]!.startsWith('• ')).toBe(true);
    expect(lines.slice(1).every((l) => l.startsWith('  ') && l.length <= 30)).toBe(true);
  });

  it('cuts long notes and lists links', async () => {
    const { formatChangelog, formatChangelogLinks, changelogUrl } = await import('../src/format.js');
    const log = { entries: [{ version: '2.0.0', body: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n\n'), url: 'https://x/2.0.0' }], source: 'https://x' };
    const text = plain(formatChangelog(log, 80, { maxLines: 5 }));
    expect(text).toContain('more lines at https://x/2.0.0');
    expect(text).not.toContain('Source:');
    expect(changelogUrl(log)).toBe('https://x/2.0.0');
    expect(changelogUrl({ entries: [], source: 'https://notes' })).toBe('https://notes');
    const links = plain(formatChangelogLinks([
      { name: 'a:b', from: '1.0', to: { level: 'major', version: '2.0' }, url: 'https://x' },
      { name: 'long:name', from: '1.0', to: { level: 'patch', version: '1.0.1' } },
    ]));
    expect(links).toBe('Changelogs\na:b        1.0 → 2.0    https://x\nlong:name  1.0 → 1.0.1  no release notes found');
  });
});
