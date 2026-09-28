import { relative } from 'node:path';
import { styleText } from 'node:util';
import { type Choice, type Row, levelColor } from './rows.js';
import type { Changelog, Target } from './types.js';

const LEVELS: Target[] = ['patch', 'minor', 'major'];

export function renderTable(rows: Row[], root: string): string {
  const header = ['Name', 'Current', 'Patch', 'Minor', 'Major'];
  const cells = rows.map((row) => [
    row.location ? row.name : `${row.name} (manual)`,
    row.current,
    ...LEVELS.map((level) => row.choices.find((c) => c.level === level)?.version ?? ''),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const lines = [header.map((h, i) => styleText('bold', h.padEnd(widths[i]!))).join('  ')];
  rows.forEach((row, r) => {
    const selected = row.selected === undefined ? undefined : row.choices[row.selected];
    const line = cells[r]!.map((text, i) => {
      const padded = text.padEnd(widths[i]!);
      if (i === 0) return row.location ? padded : styleText('gray', padded);
      if (i === 1) return padded;
      const level = LEVELS[i - 2]!;
      if (!text) return padded;
      const styles: Parameters<typeof styleText>[0] = selected?.version === text ? [levelColor(level), 'bold', 'underline'] : [levelColor(level)];
      return styleText(styles, text) + padded.slice(text.length);
    });
    lines.push(line.join('  ').trimEnd());
    const down = row.choices.find((c) => c.level === 'downgrade');
    if (down) lines.push(styleText('magenta', `  ↳ cooldown: roll back to ${down.version}`));
    for (const error of row.errors) lines.push(styleText('yellow', `  ↳ ${error}`));
  });
  return lines.join('\n');
}

export function toJson(rows: Row[], root: string) {
  return rows.map((row) => {
    const selected: Choice | undefined = row.selected === undefined ? undefined : row.choices[row.selected];
    return {
      name: row.name,
      dependencies: row.deps.map((d) => ({ group: d.group, artifact: d.artifact, kind: d.kind, file: relative(root, d.file) })),
      current: row.current,
      patch: row.choices.find((c) => c.level === 'patch')?.version ?? null,
      minor: row.choices.find((c) => c.level === 'minor')?.version ?? null,
      major: row.choices.find((c) => c.level === 'major')?.version ?? null,
      downgrade: row.choices.find((c) => c.level === 'downgrade')?.version ?? null,
      selected: selected?.version ?? null,
      rewritable: row.location !== undefined,
      errors: row.errors,
    };
  });
}

export function formatChangelog(log: Changelog, width: number): string {
  if (!log.entries.length) {
    return log.source ? `No release notes found here. Read them at:\n${log.source}` : 'No release notes found.';
  }
  const out: string[] = [];
  for (const entry of log.entries) {
    const date = entry.date ? styleText('gray', `  ${entry.date.slice(0, 10)}`) : '';
    out.push(styleText(['bold', 'cyan'], entry.title && entry.title !== entry.version ? `${entry.version}  ${entry.title}` : entry.version) + date);
    if (entry.url) out.push(styleText('gray', entry.url));
    out.push('');
    for (const line of entry.body.replace(/\r/g, '').trim().split('\n')) out.push(...wrap(line, width));
    out.push('');
  }
  if (log.source) out.push(styleText('gray', `Source: ${log.source}`));
  return out.join('\n');
}

function wrap(line: string, width: number): string[] {
  if (line.length <= width || width < 20) return [line];
  const indent = /^\s*([-*+]\s+|\d+\.\s+)?/.exec(line)![0].length;
  const pad = ' '.repeat(Math.min(indent, 8));
  const words = line.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = pad + word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
