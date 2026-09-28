import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEdits, EditConflictError } from '../src/apply.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jvm-upgrade-apply-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const at = (content: string, text: string, from = 0) => content.indexOf(text, from);

describe('applyEdits', () => {
  it('replaces only the version literals and keeps everything else', async () => {
    const file = join(dir, 'libs.versions.toml');
    const content = '[versions]\n# pinned\nkotlin = "1.9.0"   # keep\nokhttp = "4.9.0"\n';
    await writeFile(file, content);
    await applyEdits([
      { location: { file, start: at(content, '1.9.0'), end: at(content, '1.9.0') + 5 }, from: '1.9.0', to: '2.0.21' },
      { location: { file, start: at(content, '4.9.0'), end: at(content, '4.9.0') + 5 }, from: '4.9.0', to: '4.12.0' },
    ]);
    expect(await readFile(file, 'utf8')).toBe('[versions]\n# pinned\nkotlin = "2.0.21"   # keep\nokhttp = "4.12.0"\n');
    expect(await readdir(dir)).toEqual(['libs.versions.toml']);
  });

  it('merges duplicate edits of a shared location', async () => {
    const file = join(dir, 'gradle.properties');
    const content = 'v=1.0\n';
    await writeFile(file, content);
    const location = { file, start: 2, end: 5 };
    await applyEdits([{ location, from: '1.0', to: '1.1' }, { location, from: '1.0', to: '1.1' }]);
    expect(await readFile(file, 'utf8')).toBe('v=1.1\n');
  });

  it('refuses to write when the file changed and leaves all files untouched', async () => {
    const a = join(dir, 'a.gradle');
    const b = join(dir, 'b.gradle');
    await writeFile(a, "implementation 'g:a:1.0'");
    await writeFile(b, "implementation 'g:b:2.0'");
    await expect(
      applyEdits([
        { location: { file: a, start: 19, end: 22 }, from: '1.0', to: '1.1' },
        { location: { file: b, start: 19, end: 22 }, from: '9.9', to: '3.0' },
      ]),
    ).rejects.toBeInstanceOf(EditConflictError);
    expect(await readFile(a, 'utf8')).toBe("implementation 'g:a:1.0'");
    expect((await readdir(dir)).sort()).toEqual(['a.gradle', 'b.gradle']);
  });

  it('rejects two different versions for one location', async () => {
    const file = join(dir, 'x');
    await writeFile(file, 'v=1.0');
    const location = { file, start: 2, end: 5 };
    await expect(applyEdits([{ location, from: '1.0', to: '1.1' }, { location, from: '1.0', to: '2.0' }])).rejects.toThrow(/same version/);
  });
});
