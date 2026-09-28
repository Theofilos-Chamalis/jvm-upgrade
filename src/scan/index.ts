import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Dependency, ScanResult } from '../types.js';
import { scanGradle, type GradleBuild } from './gradle.js';
import { scanMaven } from './maven.js';

const SKIP_DIRS = new Set(['build', 'node_modules', 'target', 'out', 'bin', 'intermediates']);
const SETTINGS = new Set(['settings.gradle', 'settings.gradle.kts']);
const BUILD_FILES = new Set(['build.gradle', 'build.gradle.kts']);

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) await walk(path, files);
      } else if (SETTINGS.has(entry.name) || BUILD_FILES.has(entry.name) || entry.name === 'pom.xml') {
        files.push(path);
      }
    }),
  );
}

function isUnder(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root + sep);
}

function depth(path: string): number {
  return path.split(sep).length;
}

export function groupGradleBuilds(files: string[]): GradleBuild[] {
  const builds = new Map<string, GradleBuild>();
  for (const file of files.filter((f) => SETTINGS.has(basename(f)))) {
    builds.set(dirname(file), { root: dirname(file), settings: file, buildFiles: [] });
  }
  const buildFiles = files.filter((f) => BUILD_FILES.has(basename(f))).sort((a, b) => depth(a) - depth(b));
  for (const file of buildFiles) {
    const dir = dirname(file);
    const owner = [...builds.keys()].filter((root) => isUnder(dir, root)).sort((a, b) => b.length - a.length)[0];
    const root = owner && basename(dir) !== 'buildSrc' ? owner : dir;
    if (!builds.has(root)) builds.set(root, { root, buildFiles: [] });
    builds.get(root)!.buildFiles.push(file);
  }
  return [...builds.values()];
}

function dedupe(deps: Dependency[]): Dependency[] {
  const seen = new Map<string, Dependency>();
  for (const dep of deps) {
    const where = dep.location ? `${dep.location.file}:${dep.location.start}` : `${dep.file}:${dep.version}`;
    const key = `${dep.kind}|${dep.group}|${dep.artifact}|${where}`;
    if (!seen.has(key)) seen.set(key, dep);
  }
  return [...seen.values()];
}

export async function scanProject(root: string): Promise<ScanResult> {
  const files: string[] = [];
  await walk(resolve(root), files);
  files.sort();
  const results = await Promise.all([
    ...groupGradleBuilds(files).map(scanGradle),
    scanMaven(files.filter((f) => basename(f) === 'pom.xml')),
  ]);
  return {
    dependencies: dedupe(results.flatMap((r) => r.dependencies)),
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
  };
}
