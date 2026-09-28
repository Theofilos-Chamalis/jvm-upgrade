import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Location } from './types.js';

export interface Edit {
  location: Location;
  from: string;
  to: string;
}

export class EditConflictError extends Error {}

/** Rewrites only the version literals. Every file is checked first, then written atomically. */
export async function applyEdits(edits: Edit[]): Promise<void> {
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.location.file) ?? [];
    list.push(edit);
    byFile.set(edit.location.file, list);
  }

  const outputs: { file: string; content: string }[] = [];
  for (const [file, list] of byFile) {
    outputs.push({ file, content: rewrite(file, await readFile(file, 'utf8'), list) });
  }
  for (const out of outputs) await writeAtomic(out.file, out.content);
}

function rewrite(file: string, content: string, edits: Edit[]): string {
  const unique = new Map<number, Edit>();
  for (const edit of edits) {
    const prev = unique.get(edit.location.start);
    if (prev && prev.to !== edit.to) {
      throw new EditConflictError(`${file}: two different upgrades target the same version (${prev.to} and ${edit.to})`);
    }
    unique.set(edit.location.start, edit);
  }
  const sorted = [...unique.values()].sort((a, b) => b.location.start - a.location.start);
  let out = content;
  let lastStart = Infinity;
  for (const { location, from, to } of sorted) {
    if (location.end > lastStart) throw new EditConflictError(`${file}: overlapping edits`);
    const current = out.slice(location.start, location.end);
    if (current !== from) {
      throw new EditConflictError(`${file}: expected "${from}" at offset ${location.start} but found "${current}". Was the file changed?`);
    }
    out = out.slice(0, location.start) + to + out.slice(location.end);
    lastStart = location.start;
  }
  return out;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const { mode } = await stat(file);
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
