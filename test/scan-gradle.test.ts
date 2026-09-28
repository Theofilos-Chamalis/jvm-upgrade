import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { scanProject } from '../src/scan/index.js';
import { GOOGLE, GRADLE_PLUGIN_PORTAL, JITPACK, MAVEN_CENTRAL } from '../src/scan/repos.js';
import type { Dependency, ScanResult } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

function find(result: ScanResult, group: string, artifact: string): Dependency {
  const matches = result.dependencies.filter((d) => d.group === group && d.artifact === artifact);
  expect(matches, `${group}:${artifact}`).toHaveLength(1);
  return matches[0]!;
}

function plugin(result: ScanResult, id: string): Dependency {
  const dep = find(result, id, `${id}.gradle.plugin`);
  expect(dep.kind).toBe('plugin');
  return dep;
}

function expectLocationsMatch(result: ScanResult): void {
  for (const dep of result.dependencies) {
    if (!dep.location) continue;
    const content = readFileSync(dep.location.file, 'utf8');
    expect(content.slice(dep.location.start, dep.location.end), `${dep.group}:${dep.artifact}`).toBe(dep.version);
  }
}

const ktsRoot = fixture('gradle-kts-catalog');
const ktsResult = await scanProject(ktsRoot);

describe('gradle kotlin dsl with version catalogs', () => {
  const root = ktsRoot;
  const result = ktsResult;
  const catalog = join(root, 'gradle', 'libs.versions.toml');
  const libRepos = [GOOGLE, MAVEN_CENTRAL, JITPACK, 'https://repo.example.com/releases/'];
  const pluginRepos = [GOOGLE, MAVEN_CENTRAL, GRADLE_PLUGIN_PORTAL];

  it('keeps every location pointing at the version literal', () => expectLocationsMatch(result));

  it('reads catalog libraries in all forms', () => {
    const core = find(result, 'org.jetbrains.kotlinx', 'kotlinx-coroutines-core');
    const android = find(result, 'org.jetbrains.kotlinx', 'kotlinx-coroutines-android');
    expect(core).toMatchObject({ version: '1.8.1', kind: 'library', file: catalog, repositories: libRepos });
    expect(android.location).toEqual(core.location);
    expect(find(result, 'com.google.code.gson', 'gson')).toMatchObject({ version: '2.11.0' });
    expect(find(result, 'junit', 'junit')).toMatchObject({ version: '4.13.2' });
    expect(find(result, 'com.google.guava', 'guava')).toMatchObject({ version: '33.2.1-jre' });
    expect(find(result, 'com.squareup.okhttp3', 'okhttp')).toMatchObject({ version: '4.12.0' });
    expect(find(result, 'androidx.compose', 'compose-bom')).toMatchObject({ version: '2024.06.00' });
    expect(find(result, 'com.example', 'multi')).toMatchObject({ version: '0.9.0' });
    const dynamic = find(result, 'com.example', 'anything');
    expect(dynamic.version).toBe('1.+');
    expect(dynamic.location).toBeUndefined();
    expect(result.dependencies.some((d) => d.artifact === 'ui' || d.artifact === 'material3')).toBe(false);
  });

  it('reads catalogs declared in settings', () => {
    const ktlint = find(result, 'com.pinterest.ktlint', 'ktlint-cli');
    expect(ktlint.version).toBe('1.3.0');
    expect(ktlint.file).toBe(join(root, 'gradle', 'tools.versions.toml'));
  });

  it('reads catalog plugins', () => {
    expect(plugin(result, 'org.jetbrains.kotlin.jvm')).toMatchObject({ version: '2.0.0', repositories: pluginRepos });
    expect(plugin(result, 'com.google.devtools.ksp')).toMatchObject({ version: '2.0.0-1.0.22' });
    expect(plugin(result, 'io.gitlab.arturbosch.detekt')).toMatchObject({ version: '1.23.6' });
  });

  it('reads plugins blocks in settings and build files', () => {
    expect(plugin(result, 'org.jetbrains.kotlin.plugin.serialization')).toMatchObject({ version: '2.0.0' });
    expect(plugin(result, 'org.gradle.toolchains.foojay-resolver-convention')).toMatchObject({ version: '0.8.0' });
    expect(plugin(result, 'org.jetbrains.kotlin.plugin.parcelize')).toMatchObject({
      version: '2.0.0',
      file: join(root, 'build.gradle.kts'),
    });
    expect(plugin(result, 'com.github.ben-manes.versions')).toMatchObject({ version: '0.51.0' });
  });

  it('reads build file notations and resolves variables', () => {
    const app = join(root, 'app', 'build.gradle.kts');
    expect(find(result, 'com.squareup.okhttp3', 'okhttp-bom')).toMatchObject({ version: '4.12.0', file: app });
    const runtime = find(result, 'androidx.room', 'room-runtime');
    expect(runtime).toMatchObject({ version: '2.6.1', repositories: libRepos });
    expect(find(result, 'androidx.room', 'room-compiler').location).toEqual(runtime.location);
    const lifecycle = find(result, 'androidx.lifecycle', 'lifecycle-runtime-ktx');
    expect(lifecycle.version).toBe('2.8.3');
    expect(lifecycle.location?.file).toBe(join(root, 'gradle.properties'));
    expect(find(result, 'com.squareup.retrofit2', 'retrofit')).toMatchObject({ version: '2.11.0' });
    const test = find(result, 'org.jetbrains.kotlinx', 'kotlinx-coroutines-test');
    expect(test.location).toEqual(find(result, 'org.jetbrains.kotlinx', 'kotlinx-coroutines-core').location);
    expect(find(result, 'org.jetbrains.kotlin', 'kotlin-test')).toMatchObject({ version: '2.0.0' });
    expect(find(result, 'com.example', 'classified')).toMatchObject({ version: '1.2.3' });
  });

  it('omits locations it cannot rewrite safely', () => {
    expect(find(result, 'com.example', 'dyn').location).toBeUndefined();
    expect(find(result, 'com.example', 'range')).toMatchObject({ version: '[1.0,2.0)' });
    expect(find(result, 'com.example', 'range').location).toBeUndefined();
    const mixed = find(result, 'com.example', 'mixed');
    expect(mixed.version).toBe('2.6.1-beta');
    expect(mixed.location).toBeUndefined();
    expect(result.dependencies.some((d) => d.artifact === 'unresolved')).toBe(false);
    expect(result.warnings.some((w) => w.includes('com.example:unresolved'))).toBe(true);
  });

  it('ignores comments and build output directories', () => {
    const groups = result.dependencies.map((d) => d.group);
    expect(groups).not.toContain('commented');
    expect(groups).not.toContain('block');
    expect(groups).not.toContain('should');
    expect(result.dependencies.flatMap((d) => d.repositories)).not.toContain('https://commented.example.com/');
  });

  it('uses module gradle.properties and module repositories', () => {
    const slf4j = find(result, 'org.slf4j', 'slf4j-api');
    expect(slf4j.version).toBe('2.0.13');
    expect(slf4j.location?.file).toBe(join(root, 'lib', 'gradle.properties'));
    expect(slf4j.repositories).toEqual([...libRepos, 'https://maven.lib.example.com/']);
  });

  it('reads the gradle wrapper', () => {
    expect(find(result, 'org.gradle', 'gradle')).toMatchObject({ kind: 'gradle', version: '8.9', repositories: [] });
  });
});

const groovyRoot = fixture('gradle-groovy');
const groovyResult = await scanProject(groovyRoot);

describe('gradle groovy dsl', () => {
  const root = groovyRoot;
  const result = groovyResult;
  const libRepos = [
    MAVEN_CENTRAL,
    'https://buildscript.example.com/',
    pathToFileURL(join(homedir(), '.m2', 'repository')).href + '/',
    'https://allprojects.example.com/repo/',
  ];

  it('keeps every location pointing at the version literal', () => expectLocationsMatch(result));

  it('resolves ext variables in buildscript classpath', () => {
    const kgp = find(result, 'org.jetbrains.kotlin', 'kotlin-gradle-plugin');
    expect(kgp).toMatchObject({ version: '1.9.24', kind: 'library', repositories: libRepos });
    expect(kgp.location?.file).toBe(join(root, 'build.gradle'));
    expect(find(result, 'com.android.tools.build', 'gradle')).toMatchObject({ version: '8.5.0' });
    const stdlib = find(result, 'org.jetbrains.kotlin', 'kotlin-stdlib');
    expect(stdlib.file).toBe(join(root, 'core', 'build.gradle'));
    expect(stdlib.location).toEqual(kgp.location);
  });

  it('reads string and map notations', () => {
    expect(find(result, 'org.apache.commons', 'commons-lang3')).toMatchObject({ version: '3.14.0' });
    expect(find(result, 'com.google.guava', 'guava')).toMatchObject({ version: '33.2.1-jre' });
    const jackson = find(result, 'com.fasterxml.jackson.core', 'jackson-databind');
    expect(jackson.version).toBe('2.17.1');
    expect(jackson.location?.file).toBe(join(root, 'gradle.properties'));
    expect(find(result, 'org.yaml', 'snakeyaml')).toMatchObject({ version: '2.2' });
    expect(find(result, 'org.springframework.boot', 'spring-boot-dependencies')).toMatchObject({ version: '3.3.1' });
    expect(find(result, 'com.example', 'native')).toMatchObject({ version: '1.0.0' });
    expect(find(result, 'com.android.tools', 'desugar_jdk_libs')).toMatchObject({ version: '2.0.4' });
    expect(find(result, 'org.junit.jupiter', 'junit-jupiter').location?.file).toBe(join(root, 'core', 'gradle.properties'));
  });

  it('reads plugins with pluginManagement repositories', () => {
    const repos = [GRADLE_PLUGIN_PORTAL, 'https://plugins.example.com/m2/'];
    expect(plugin(result, 'org.springframework.boot')).toMatchObject({ version: '3.3.1', repositories: repos });
    expect(plugin(result, 'io.spring.dependency-management')).toMatchObject({ version: '1.1.5' });
    expect(plugin(result, 'com.github.johnrengelman.shadow')).toMatchObject({ version: '8.1.1' });
    expect(result.dependencies.some((d) => d.group === 'java')).toBe(false);
  });

  it('reads a release candidate wrapper', () => {
    expect(find(result, 'org.gradle', 'gradle')).toMatchObject({ version: '8.10-rc-1' });
  });
});

const androidRoot = fixture('android-app');
const androidResult = await scanProject(androidRoot);

describe('android project', () => {
  const root = androidRoot;
  const result = androidResult;

  it('keeps every location pointing at the version literal', () => expectLocationsMatch(result));

  it('reads android configurations and notations', () => {
    for (const [group, artifact, version] of [
      ['androidx.core', 'core-ktx', '1.13.1'],
      ['com.example', 'widget', '2.0.0'],
      ['com.google.dagger', 'hilt-compiler', '2.51.1'],
      ['androidx.test.espresso', 'espresso-core', '3.6.1'],
      ['com.android.tools', 'desugar_jdk_libs', '2.0.4'],
      ['com.google.gms', 'google-services', '4.4.2'],
      ['org.jetbrains.kotlin', 'kotlin-reflect', '1.9.24'],
    ] as const) {
      expect(find(result, group, artifact)).toMatchObject({ version, repositories: [GOOGLE, MAVEN_CENTRAL] });
    }
  });

  it('reads plugins with google on the plugin repositories', () => {
    const repos = [GOOGLE, MAVEN_CENTRAL, GRADLE_PLUGIN_PORTAL];
    expect(plugin(result, 'com.android.application')).toMatchObject({
      version: '8.5.0',
      file: join(root, 'settings.gradle.kts'),
      repositories: repos,
    });
    expect(plugin(result, 'org.jetbrains.kotlin.android')).toMatchObject({ version: '1.9.24' });
  });
});

const tempRoots: string[] = [];
afterAll(() => Promise.all(tempRoots.map((r) => rm(r, { recursive: true, force: true }))));

async function scanTree(files: Record<string, string>): Promise<ScanResult> {
  const root = await mkdtemp(join(tmpdir(), 'jvm-upgrade-'));
  tempRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return scanProject(root);
}

describe('gradle regressions', () => {
  it('keeps offsets correct with CRLF line endings', async () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const result = await scanTree({
      'settings.gradle.kts': crlf('plugins {\n  id("org.example.settings") version "1.0.0"\n}\n'),
      'gradle.properties': crlf('# comment\nokioVersion = 3.9.0 \nother=1\n'),
      'build.gradle.kts': crlf(
        '// c\nval retrofit = "2.11.0"\ndependencies {\n  implementation("com.squareup.retrofit2:retrofit:$retrofit")\n  implementation("com.squareup.okio:okio:${okioVersion}")\n  implementation(group = "org.yaml", name = "snakeyaml", version = "2.2")\n}\n',
      ),
      'gradle/libs.versions.toml': crlf('# c\n[versions]\ngson = "2.11.0"\n\n[libraries]\ngson = { module = "com.google.code.gson:gson", version.ref = "gson" }\njunit = "junit:junit:4.13.2"\n'),
      'gradle/wrapper/gradle-wrapper.properties': crlf('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip\n'),
    });
    expect(result.dependencies.filter((d) => d.location)).toHaveLength(7);
    expectLocationsMatch(result);
  });

  it('ignores coordinate-like strings that are not dependencies', async () => {
    const result = await scanTree({
      'build.gradle.kts': [
        'tasks.test { systemProperty("db", "jdbc:h2:mem:test") }',
        'val at = "12:30:00"',
        'tasks.register<Exec>("x") { args("--opt:java.base:value", "host:port:path/to") }',
        'dependencies { implementation("com.example:real:1.0.0") }',
      ].join('\n'),
    });
    expect(result.dependencies.map((d) => `${d.group}:${d.artifact}`)).toEqual(['com.example:real']);
  });

  it('resolves extra, property and groovy map references', async () => {
    const result = await scanTree({
      'gradle.properties': 'coreVersion=1.13.1\nappcompatVersion=1.7.0\n',
      'build.gradle.kts': [
        'extra["okhttpVersion"] = "4.12.0"',
        'val kotlinVersion = "2.0.0"',
        'dependencies {',
        '  implementation("com.squareup.okhttp3:okhttp:${rootProject.extra["okhttpVersion"]}")',
        '  implementation("androidx.core:core-ktx:${property("coreVersion")}")',
        '  implementation("androidx.appcompat:appcompat:${findProperty("appcompatVersion")}")',
        '  implementation(kotlin("stdlib", kotlinVersion))',
        '}',
      ].join('\n'),
      'app/build.gradle': [
        'ext.versions = [compose: "1.6.8", "quoted": "x"]',
        'ext { deps = [room: \'2.6.1\'] }',
        'dependencies {',
        '  implementation "androidx.compose.ui:ui:$versions.compose"',
        '  implementation "androidx.room:room-runtime:${rootProject.ext.deps.room}"',
        '}',
      ].join('\n'),
    });
    expectLocationsMatch(result);
    expect(result.warnings).toEqual([]);
    for (const [group, artifact, version] of [
      ['com.squareup.okhttp3', 'okhttp', '4.12.0'],
      ['androidx.core', 'core-ktx', '1.13.1'],
      ['androidx.appcompat', 'appcompat', '1.7.0'],
      ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.0.0'],
      ['androidx.compose.ui', 'ui', '1.6.8'],
      ['androidx.room', 'room-runtime', '2.6.1'],
    ] as const) {
      const dep = find(result, group, artifact);
      expect(dep.version).toBe(version);
      expect(dep.location).toBeDefined();
    }
  });

  it('does not hang on an unterminated toml table header', async () => {
    const result = await scanTree({
      'build.gradle.kts': '',
      'gradle/libs.versions.toml': '[libraries]\na = "g:a:1.0"\n[versions\nb = "2"\n',
    });
    expect(find(result, 'g', 'a').version).toBe('1.0');
  }, 2000);

  it('skips build files inside module source trees', async () => {
    const result = await scanTree({
      'settings.gradle.kts': '',
      'build.gradle.kts': 'dependencies { implementation("com.example:real:1.0.0") }',
      'src/test/resources/project/build.gradle': 'dependencies { implementation "com.example:fixture:1.0.0" }',
      'app/build.gradle.kts': '',
      'app/src/it/sample/pom.xml': '<project><dependencies><dependency><groupId>a</groupId><artifactId>fixture</artifactId><version>1</version></dependency></dependencies></project>',
    });
    expect(result.dependencies.map((d) => d.artifact)).toEqual(['real']);
  });
});
