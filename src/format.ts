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

export interface ChangelogOptions {
  /** Body lines shown per version before it is cut short. */
  maxLines?: number;
}

export function formatChangelog(log: Changelog, width: number, opts: ChangelogOptions = {}): string {
  if (!log.entries.length) {
    return log.source ? `  No release notes found here. Read them at:\n  ${styleText('cyan', log.source)}` : '  No release notes found.';
  }
  const out: string[] = [];
  for (const entry of log.entries) {
    const title = entry.title && !isJustVersion(entry.title, entry.version) ? styleText('gray', `  ${entry.title}`) : '';
    const date = entry.date ? styleText('gray', `  ·  ${entry.date.slice(0, 10)}`) : '';
    out.push(`  ${styleText(['bold', 'green'], `● ${entry.version}`)}${title}${date}`);
    if (entry.url) out.push(`    ${styleText('gray', entry.url)}`);
    const body = renderMarkdown(entry.body, width - 4);
    const shown = opts.maxLines && body.length > opts.maxLines ? body.slice(0, opts.maxLines) : body;
    if (shown.length) out.push('', ...shown.map((line) => (line ? `    ${line}` : '')));
    if (shown.length < body.length) {
      out.push(styleText('gray', `    … ${body.length - shown.length} more lines${entry.url ? ` at ${entry.url}` : ''}`));
    }
    out.push('');
  }
  if (log.source && log.entries.some((e) => !e.url)) out.push(styleText('gray', `  Source: ${log.source}`));
  return out.join('\n').trimEnd();
}

export function formatChangelogHeader(name: string, from: string, to: Choice, width: number): string {
  const title = ` ${name}  ${from} → ${to.version} `;
  const rule = '━'.repeat(Math.max(3, Math.min(width, 100) - title.length - 3));
  return `${styleText('gray', '━━')}${styleText('bold', ` ${name}  `)}${from} → ${styleText(['bold', levelColor(to.level)], to.version)} ${styleText('gray', rule)}`;
}

export interface ChangelogLink {
  name: string;
  from: string;
  to: Choice;
  url?: string;
}

export function formatChangelogLinks(links: ChangelogLink[]): string {
  const nameWidth = Math.max(...links.map((l) => l.name.length));
  const jumpWidth = Math.max(...links.map((l) => `${l.from} → ${l.to.version}`.length));
  const lines = links.map((l) => {
    const jump = `${l.from} → ${l.to.version}`;
    const colored = `${l.from} → ${styleText(levelColor(l.to.level), l.to.version)}${' '.repeat(jumpWidth - jump.length)}`;
    return `${l.name.padEnd(nameWidth)}  ${colored}  ${l.url ? styleText('cyan', l.url) : styleText('gray', 'no release notes found')}`;
  });
  return [styleText('bold', 'Changelogs'), ...lines].join('\n');
}

/** Link to the notes of the target version when found, else to the general notes page. */
export function changelogUrl(log: Changelog): string | undefined {
  return log.entries[0]?.url ?? log.source;
}

function isJustVersion(title: string, version: string): boolean {
  return title.replace(/^v/i, '') === version || !title.replace(new RegExp(version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').replace(/[\sv]/gi, '');
}

/** Turns release-note markdown into short, styled terminal lines. */
export function renderMarkdown(markdown: string, width: number): string[] {
  const text = markdown
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:https?:[^)\s]+)\)/g, '$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/(\d+)/g, '#$1')
    .replace(/\(?https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{8})[0-9a-f]*\)?/g, '($1)')
    .replace(/^\s*(?:\*\*|__)([^*_\n]+)(?:\*\*|__):?\s*$/gm, '### $1')
    .replace(/^\s*[-*+]\s.*@(?:renovate|dependabot)\[bot\].*$\n?/gim, '')
    .replace(/\*\*|__/g, '');

  const out: string[] = [];
  let fence = false;
  let afterHeading = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const wasHeading: boolean = afterHeading;
    afterHeading = false;
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(styleText('cyan', line));
      continue;
    }
    if (/^\s*\[[^\]]+\]:\s*\S+$/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      if (out.length && out.at(-1) !== '') out.push('');
      out.push(styleText(['bold', 'yellow'], heading[1]!));
      afterHeading = true;
      continue;
    }
    if (!line.trim()) {
      if (out.length && out.at(-1) !== '' && !wasHeading) out.push('');
      afterHeading = wasHeading;
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = '  '.repeat(Math.min(Math.floor(bullet[1]!.length / 2), 3));
      out.push(...wrap(bullet[2]!, width - indent.length - 2).map((l, i) => `${indent}${i ? '  ' : '• '}${code(l)}`));
      continue;
    }
    out.push(...wrap(line.trim(), width).map(code));
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

function code(line: string): string {
  return line.replace(/`([^`]+)`/g, (_, c: string) => styleText('cyan', c));
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width || width < 20) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
