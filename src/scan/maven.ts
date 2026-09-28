import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Dependency, DependencyKind, Location, ScanResult } from '../types.js';
import { isDynamic, type Value } from './gradle.js';
import { dedupeRepos, MAVEN_CENTRAL } from './repos.js';

interface XmlNode {
  name: string;
  parent?: XmlNode;
  children: XmlNode[];
  textStart: number;
  textEnd: number;
}

interface Pom {
  file: string;
  code: string;
  project: XmlNode;
  groupId?: string;
  artifactId?: string;
  props: Map<string, Value>;
  parent?: XmlNode;
}

const TAG_RE = /<(\/?)([\w.\-:]+)(?:\s[^>]*?)?(\/?)>/g;
const SELF_VERSION_RE = /\$\{(?:project\.|pom\.)?(?:parent\.)?version\}/;

export function stripXmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

export function parseXml(code: string): XmlNode {
  const root: XmlNode = { name: '#root', children: [], textStart: 0, textEnd: code.length };
  const stack = [root];
  for (const m of code.matchAll(TAG_RE)) {
    const [tag, closing, name, selfClosing] = m;
    const top = stack[stack.length - 1]!;
    if (closing) {
      const idx = stack.map((n) => n.name).lastIndexOf(name!);
      if (idx > 0) {
        stack[idx]!.textEnd = m.index;
        stack.length = idx;
      }
      continue;
    }
    const start = m.index + tag.length;
    const node: XmlNode = { name: name!, parent: top, children: [], textStart: start, textEnd: start };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function findAll(node: XmlNode, name: string, parentName: string): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name && n.name === parentName) out.push(c);
      visit(c);
    }
  };
  visit(node);
  return out;
}

function textOf(pom: Pom, node: XmlNode | undefined): Value | undefined {
  if (!node || node.children.length) return undefined;
  const raw = pom.code.slice(node.textStart, node.textEnd);
  const value = raw.trim();
  if (!value) return undefined;
  const start = node.textStart + raw.indexOf(value);
  return { value, loc: { file: pom.file, start, end: start + value.length } };
}

function childText(pom: Pom, node: XmlNode | undefined, name: string): string | undefined {
  return textOf(pom, child(node, name))?.value;
}

async function loadPom(file: string): Promise<Pom | undefined> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const code = stripXmlComments(content);
  const project = child(parseXml(code), 'project');
  if (!project) return undefined;
  const pom: Pom = { file, code, project, props: new Map(), parent: child(project, 'parent') };
  pom.artifactId = childText(pom, project, 'artifactId');
  pom.groupId = childText(pom, project, 'groupId') ?? childText(pom, pom.parent, 'groupId');
  for (const prop of child(project, 'properties')?.children ?? []) {
    const value = textOf(pom, prop);
    if (value) pom.props.set(prop.name, value);
  }
  return pom;
}

class PomTree {
  private cache = new Map<string, Promise<Pom | undefined>>();

  load(file: string): Promise<Pom | undefined> {
    let pom = this.cache.get(file);
    if (!pom) this.cache.set(file, (pom = loadPom(file)));
    return pom;
  }

  async chain(pom: Pom): Promise<Pom[]> {
    const chain = [pom];
    for (let current = pom; current.parent; ) {
      const relative = child(current.parent, 'relativePath');
      const rel = relative ? (textOf(current, relative)?.value ?? '') : '../pom.xml';
      if (!rel) break;
      const path = resolve(dirname(current.file), rel);
      const parent = await this.load(path.endsWith('.xml') ? path : join(path, 'pom.xml'));
      if (!parent || chain.includes(parent) || parent.artifactId !== childText(current, current.parent, 'artifactId')) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }
}

function lookup(chain: Pom[], key: string): Value | undefined {
  const pom = chain[0]!;
  if (/^(?:project|pom)\.groupId$/.test(key) && pom.groupId) return { value: pom.groupId };
  if (/^(?:project|pom)\.artifactId$/.test(key) && pom.artifactId) return { value: pom.artifactId };
  for (const p of chain) {
    const value = p.props.get(key);
    if (value) return value;
  }
  return undefined;
}

function resolveValue(raw: string, loc: Location | undefined, chain: Pom[], depth = 0): Value | undefined {
  if (depth > 5 || SELF_VERSION_RE.test(raw)) return undefined;
  const whole = /^\$\{([^}]+)\}$/.exec(raw);
  if (whole) {
    const found = lookup(chain, whole[1]!);
    if (!found) return undefined;
    return found.value.includes('${') ? resolveValue(found.value, undefined, chain, depth + 1) : found;
  }
  if (!raw.includes('${')) return { value: raw, loc };
  let ok = true;
  const value = raw.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    const found = resolveValue(`\${${key}}`, undefined, chain, depth + 1);
    if (!found) ok = false;
    return found?.value ?? '';
  });
  return ok ? { value } : undefined;
}

function repoUrls(pom: Pom, chain: Pom[], name: string, parentName: string): string[] {
  return findAll(pom.project, name, parentName)
    .map((repo) => childText(pom, repo, 'url'))
    .map((url) => url && resolveValue(url, undefined, chain)?.value)
    .filter((url): url is string => !!url && !url.includes('${'));
}

interface Coordinates {
  node: XmlNode;
  kind: DependencyKind;
  defaultGroup?: string;
}

function coordinates(pom: Pom): Coordinates[] {
  return [
    ...findAll(pom.project, 'dependency', 'dependencies').map((node) => ({ node, kind: 'library' as const })),
    ...findAll(pom.project, 'plugin', 'plugins').map((node) => ({
      node,
      kind: 'plugin' as const,
      defaultGroup: 'org.apache.maven.plugins',
    })),
    ...findAll(pom.project, 'extension', 'extensions').map((node) => ({ node, kind: 'plugin' as const })),
    ...(pom.parent ? [{ node: pom.parent, kind: 'library' as const }] : []),
  ];
}

export async function scanMaven(pomFiles: string[]): Promise<ScanResult> {
  const tree = new PomTree();
  const poms = (await Promise.all(pomFiles.map((f) => tree.load(f)))).filter((p): p is Pom => !!p);
  const modules = new Set(poms.map((p) => `${p.groupId}:${p.artifactId}`));
  const warnings: string[] = [];
  const dependencies: Dependency[] = [];

  for (const pom of poms) {
    const chain = await tree.chain(pom);
    const libraryRepos = dedupeRepos([...chain.flatMap((p) => repoUrls(p, chain, 'repository', 'repositories')), MAVEN_CENTRAL]);
    const pluginRepos = dedupeRepos([
      ...chain.flatMap((p) => repoUrls(p, chain, 'pluginRepository', 'pluginRepositories')),
      MAVEN_CENTRAL,
    ]);
    for (const { node, kind, defaultGroup } of coordinates(pom)) {
      const rawGroup = childText(pom, node, 'groupId') ?? defaultGroup;
      const rawArtifact = childText(pom, node, 'artifactId');
      const versionText = textOf(pom, child(node, 'version'));
      if (!rawGroup || !rawArtifact || !versionText) continue;
      const group = resolveValue(rawGroup, undefined, chain)?.value;
      const artifact = resolveValue(rawArtifact, undefined, chain)?.value;
      if (!group || !artifact || modules.has(`${group}:${artifact}`) || SELF_VERSION_RE.test(versionText.value)) continue;
      const version = resolveValue(versionText.value, versionText.loc, chain);
      if (!version) {
        warnings.push(`${pom.file}: cannot resolve version "${versionText.value}" of ${group}:${artifact}`);
        continue;
      }
      const location = version.loc && !isDynamic(version.value) ? version.loc : undefined;
      dependencies.push({
        group,
        artifact,
        kind,
        version: version.value,
        file: pom.file,
        repositories: kind === 'plugin' || node.parent?.parent?.name === 'plugin' ? pluginRepos : libraryRepos,
        ...(location && { location }),
      });
    }
  }
  return { dependencies, warnings };
}
