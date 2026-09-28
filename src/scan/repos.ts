import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAVEN_CENTRAL = 'https://repo.maven.apache.org/maven2/';
export const GOOGLE = 'https://dl.google.com/dl/android/maven2/';
export const GRADLE_PLUGIN_PORTAL = 'https://plugins.gradle.org/m2/';
export const JITPACK = 'https://jitpack.io/';
export const JCENTER = 'https://jcenter.bintray.com/';

export function mavenLocal(): string {
  return withSlash(pathToFileURL(join(homedir(), '.m2', 'repository')).href);
}

export const NAMED_REPOS: Record<string, () => string> = {
  mavenCentral: () => MAVEN_CENTRAL,
  google: () => GOOGLE,
  gradlePluginPortal: () => GRADLE_PLUGIN_PORTAL,
  jcenter: () => JCENTER,
  mavenLocal,
};

export function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function dedupeRepos(urls: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    const normalized = withSlash(url.trim());
    if (normalized !== JCENTER) out.add(normalized);
  }
  return [...out];
}
