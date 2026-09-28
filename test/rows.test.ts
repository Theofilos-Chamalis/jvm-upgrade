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
