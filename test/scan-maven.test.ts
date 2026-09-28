import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/scan/index.js';
import { JITPACK, MAVEN_CENTRAL } from '../src/scan/repos.js';
import type { Dependency, ScanResult } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

function find(result: ScanResult, group: string, artifact: string): Dependency {
  const matches = result.dependencies.filter((d) => d.group === group && d.artifact === artifact);
  expect(matches, `${group}:${artifact}`).toHaveLength(1);
  return matches[0]!;
}

function expectLocationsMatch(result: ScanResult): void {
  for (const dep of result.dependencies) {
    if (!dep.location) continue;
    const content = readFileSync(dep.location.file, 'utf8');
    expect(content.slice(dep.location.start, dep.location.end), `${dep.group}:${dep.artifact}`).toBe(dep.version);
  }
}

const simpleRoot = fixture('maven-simple');
const simple = await scanProject(simpleRoot);
const multiRoot = fixture('maven-multimodule');
const multi = await scanProject(multiRoot);

describe('single maven pom', () => {
  const pom = join(simpleRoot, 'pom.xml');
  const libRepos = [JITPACK, MAVEN_CENTRAL];
  const pluginRepos = ['https://plugins.example.com/maven2/', MAVEN_CENTRAL];

  it('keeps every location pointing at the version literal', () => expectLocationsMatch(simple));

  it('reads dependencies and dependency management', () => {
    expect(find(simple, 'com.google.guava', 'guava')).toMatchObject({
      version: '33.2.1-jre',
      kind: 'library',
      file: pom,
      repositories: libRepos,
    });
    expect(find(simple, 'com.fasterxml.jackson', 'jackson-bom')).toMatchObject({ version: '2.17.1' });
    expect(find(simple, 'org.apache.commons', 'commons-lang3')).toMatchObject({ version: '3.14.0' });
  });

  it('reads the external parent', () => {
    expect(find(simple, 'org.springframework.boot', 'spring-boot-starter-parent')).toMatchObject({
      version: '3.3.1',
      kind: 'library',
    });
  });

  it('reads plugins, plugin management and extensions', () => {
    for (const [group, artifact, version] of [
      ['org.apache.maven.plugins', 'maven-surefire-plugin', '3.3.0'],
      ['org.apache.maven.plugins', 'maven-compiler-plugin', '3.13.0'],
      ['kr.motd.maven', 'os-maven-plugin', '1.7.1'],
    ] as const) {
      expect(find(simple, group, artifact)).toMatchObject({ version, kind: 'plugin', repositories: pluginRepos });
    }
    expect(find(simple, 'org.ow2.asm', 'asm')).toMatchObject({ version: '9.7' });
    expect(find(simple, 'org.ow2.asm', 'asm').location).toBeUndefined();
  });

  it('skips managed, commented, self versioned and unresolved dependencies', () => {
    const artifacts = simple.dependencies.map((d) => d.artifact);
    for (const skipped of ['jackson-databind', 'out', 'sibling', 'unresolved', 'spring-boot-maven-plugin', 'jsr305']) {
      expect(artifacts).not.toContain(skipped);
    }
    expect(simple.warnings.some((w) => w.includes('com.example:unresolved'))).toBe(true);
  });

  it('omits the location of version ranges', () => {
    const ranged = find(simple, 'com.example', 'ranged');
    expect(ranged.version).toBe('[1.0,2.0)');
    expect(ranged.location).toBeUndefined();
  });
});

describe('multi module maven project', () => {
  const parentPom = join(multiRoot, 'pom.xml');
  const repos = ['https://repo.example.com/maven/', MAVEN_CENTRAL];

  it('keeps every location pointing at the version literal', () => expectLocationsMatch(multi));

  it('resolves properties from parent poms', () => {
    const junit = find(multi, 'org.junit.jupiter', 'junit-jupiter');
    expect(junit).toMatchObject({ version: '5.10.3', file: join(multiRoot, 'app', 'pom.xml'), repositories: repos });
    expect(junit.location?.file).toBe(parentPom);
    expect(find(multi, 'org.junit', 'junit-bom').location).toEqual(junit.location);
  });

  it('dedupes dependencies sharing one location', () => {
    expect(find(multi, 'org.slf4j', 'slf4j-simple').location?.file).toBe(parentPom);
  });

  it('reads module properties and literals', () => {
    expect(find(multi, 'org.projectlombok', 'lombok')).toMatchObject({ version: '1.18.34', repositories: repos });
    expect(find(multi, 'ch.qos.logback', 'logback-classic')).toMatchObject({ version: '1.5.6' });
  });

  it('skips inter-module dependencies, module parents and build output', () => {
    const artifacts = multi.dependencies.map((d) => d.artifact);
    expect(artifacts).not.toContain('core');
    expect(artifacts).not.toContain('parent');
    expect(artifacts).not.toContain('y');
    expect(multi.dependencies).toHaveLength(5);
  });
});
