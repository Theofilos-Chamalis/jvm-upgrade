import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Dependency, DependencyKind, Location, ScanResult } from '../types.js';
import { dedupeRepos, GOOGLE, GRADLE_PLUGIN_PORTAL, MAVEN_CENTRAL, NAMED_REPOS } from './repos.js';

export interface GradleBuild {
  root: string;
  settings?: string;
  buildFiles: string[];
}

interface Source {
  file: string;
  content: string;
  code: string;
}

interface Value {
  value: string;
  loc?: Location;
}

type Vars = Map<string, Value>;

interface Span {
  start: number;
  end: number;
}

interface Scope {
  vars: Vars[];
  catalogs: Map<string, Vars>;
}

interface Context {
  scope: Scope;
  repositories: string[];
  warnings: string[];
  out: Dependency[];
}

const COORD_RE = /(["'])([\w.\-]+):([\w.\-]+):([^"'\s@:]+)(?::[\w.\-]+)?(?:@\w+)?\1/dg;
const MAP_RE =
  /\bgroup\s*[:=]\s*(["'])([^"']+)\1\s*,\s*name\s*[:=]\s*(["'])([^"']+)\3\s*,\s*version\s*[:=]\s*(?:(["'])([^"']*)\5|([A-Za-z_][\w.]*))/dg;
const KOTLIN_DEP_RE = /\bkotlin\s*\(\s*"([\w\-]+)"\s*,\s*(?:version\s*=\s*)?"([^"]*)"\s*\)/dg;
const PLUGIN_RE =
  /\b(id|kotlin)\s*\(?\s*(["'])([\w.\-]+)\2\s*\)?\s*\.?\s*version\s*\(?\s*(?:(["'])([^"']*)\4|([A-Za-z_][\w.]*(?:\(\))?))/dg;
const REPO_RE =
  /\b(mavenCentral|google|gradlePluginPortal|jcenter|mavenLocal)\s*[({]|\bmaven\s*\(\s*(?:url\s*=\s*)?(?:uri\s*\(\s*)?["']([^"'$]+)["']|\b(?:url|setUrl)\s*(?:=\s*)?\(?\s*(?:uri\s*\(\s*)?["']([^"'$]+)["']/g;
const CATALOG_RE =
  /(?:create\s*\(\s*["'](\w+)["']\s*\)|(\w+))\s*\{[^{}]*?\bfrom\s*\(\s*files\s*\(\s*["']([^"']+)["']/g;
const VAR_RES = [
  /\b(?:ext|extra)\.(\w+)\s*=\s*(["'])([^"'$\n]*)\2/dg,
  /\b(?:ext|extra)\.set\s*\(\s*["'](\w+)["']\s*,\s*(["'])([^"'$\n]*)\2/dg,
  /\bextra\s*\[\s*["'](\w+)["']\s*\]\s*=\s*(["'])([^"'$\n]*)\2/dg,
  /\b(?:val|var|def|String)\s+(\w+)\s*(?::\s*String\s*)?(?:=|by\s+extra\s*\()\s*(["'])([^"'$\n]*)\2/dg,
];
const EXT_BLOCK_RES = [
  /(?<![\w.])(\w+)\s*=\s*(["'])([^"'$\n]*)\2/dg,
  /\bset\s*\(\s*["'](\w+)["']\s*,\s*(["'])([^"'$\n]*)\2/dg,
];
const PROPERTY_RE = /^[ \t]*([\w.\-]+)[ \t]*[=:][ \t]*(.*?)[ \t]*\r?$/dgm;
const WRAPPER_RE = /distributionUrl\s*[=:].*?gradle-([\w.\-]+?)-(?:bin|all)\.zip/d;

export function isDynamic(version: string): boolean {
  return version === '' || /[+\[\]()*,]|^latest\./.test(version);
}

export function stripCode(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      blank(i, (i = end < 0 ? src.length : end));
    } else if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i + 2);
      blank(i, (i = close < 0 ? src.length : close + 2));
    } else if (src[i] === '"' || src[i] === "'") {
      i = skipString(src, i);
    } else {
      i++;
    }
  }
  return out.join('');
}

function skipString(src: string, i: number): number {
  const quote = src[i]!;
  const delim = src.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
  let j = i + delim.length;
  while (j < src.length) {
    if (src[j] === '\\') j += 2;
    else if (src.startsWith(delim, j)) return j + delim.length;
    else if (delim.length === 1 && src[j] === '\n') return j;
    else j++;
  }
  return j;
}

export function stripToml(src: string): string {
  const out = src.split('');
  let quote: string | undefined;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote || c === '\n') quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      for (; i < src.length && src[i] !== '\n'; i++) out[i] = ' ';
    }
  }
  return out.join('');
}

export function stripProperties(src: string): string {
  return src.replace(/^[ \t]*[#!].*$/gm, (line) => ' '.repeat(line.length));
}

async function readSource(file: string, strip: (s: string) => string): Promise<Source | undefined> {
  try {
    const content = await readFile(file, 'utf8');
    return { file, content, code: strip(content) };
  } catch {
    return undefined;
  }
}

function findBlocks(code: string, name: string): Span[] {
  const re = new RegExp(`\\b${name}\\s*(?:\\([^()]*\\))?\\s*\\{`, 'g');
  return [...code.matchAll(re)].map((m) => {
    const open = m.index + m[0].length - 1;
    return { start: open + 1, end: matchBrace(code, open) };
  });
}

function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return code.length;
}

function within(pos: number, spans: Span[]): boolean {
  return spans.some((s) => pos >= s.start && pos < s.end);
}

function matchesIn(code: string, re: RegExp, spans?: Span[]): RegExpExecArray[] {
  return [...code.matchAll(re)].filter((m) => !spans || within(m.index, spans));
}

function locOf(src: Source, m: RegExpExecArray, group: number): Location {
  const [start, end] = m.indices![group]!;
  return { file: src.file, start, end };
}

function reposIn(code: string, spans: Span[]): string[] {
  const urls: string[] = [];
  for (const span of spans) {
    for (const m of code.slice(span.start, span.end).matchAll(REPO_RE)) {
      urls.push(m[1] ? NAMED_REPOS[m[1]]!() : (m[2] ?? m[3])!);
    }
  }
  return dedupeRepos(urls);
}

function reposWithin(src: Source, outer: string): string[] {
  const outerSpans = findBlocks(src.code, outer);
  return reposIn(src.code, findBlocks(src.code, 'repositories').filter((s) => within(s.start, outerSpans)));
}

function buildFileRepos(src: Source): string[] {
  const publishing = findBlocks(src.code, 'publishing');
  return reposIn(src.code, findBlocks(src.code, 'repositories').filter((s) => !within(s.start, publishing)));
}

function collectVars(src: Source): Vars {
  const vars: Vars = new Map();
  const extBlocks = findBlocks(src.code, 'ext');
  const matches = [
    ...EXT_BLOCK_RES.flatMap((re) => matchesIn(src.code, re, extBlocks)),
    ...VAR_RES.flatMap((re) => matchesIn(src.code, re)),
  ].sort((a, b) => a.index - b.index);
  for (const m of matches) vars.set(m[1]!, { value: m[3]!, loc: locOf(src, m, 3) });
  return vars;
}

function propertyVars(src: Source | undefined): Vars {
  const vars: Vars = new Map();
  for (const m of src?.code.matchAll(PROPERTY_RE) ?? []) {
    if (m[2]) vars.set(m[1]!, { value: m[2], loc: locOf(src!, m, 2) });
  }
  return vars;
}

function normKey(key: string): string {
  return key.replace(/[-_]/g, '.');
}

function lookup(scope: Scope, expr: string): Value | undefined {
  const e = expr.trim().replace(/\.get(?:\(\))?$/, '');
  const catalog = /^(\w+)\.versions\.([\w.]+)$/.exec(e);
  if (catalog) return scope.catalogs.get(catalog[1]!)?.get(normKey(catalog[2]!));
  const key =
    /(?:extra|properties)\s*\[\s*["']([\w.\-]+)["']\s*\]$/.exec(e)?.[1] ??
    /property\s*\(\s*["']([\w.\-]+)["']\s*\)$/.exec(e)?.[1] ??
    e.replace(/^(?:(?:rootProject|project|ext|extra|properties)\.)+/, '');
  for (const vars of scope.vars) {
    const value = vars.get(key);
    if (value) return value;
  }
  return undefined;
}

const REF_RE = /\$\{([^}]+)\}|\$([A-Za-z_][\w.]*(?:\(\))?)/g;

function resolveVersion(raw: string, loc: Location | undefined, scope: Scope): Value | undefined {
  const whole = /^(?:\$\{([^}]+)\}|\$([A-Za-z_][\w.]*(?:\(\))?))$/.exec(raw);
  let result: Value | undefined;
  if (whole) {
    result = lookup(scope, (whole[1] ?? whole[2])!);
  } else if (!raw.includes('$')) {
    result = { value: raw, loc };
  } else {
    let ok = true;
    const value = raw.replace(REF_RE, (_, braced?: string, bare?: string) => {
      const found = lookup(scope, (braced ?? bare)!);
      if (!found) ok = false;
      return found?.value ?? '';
    });
    result = ok ? { value } : undefined;
  }
  return result && (isDynamic(result.value) || !result.loc) ? { value: result.value } : result;
}

function makeDep(
  kind: DependencyKind,
  group: string,
  artifact: string,
  version: Value,
  file: string,
  repositories: string[],
): Dependency {
  return { group, artifact, kind, version: version.value, file, repositories, ...(version.loc && { location: version.loc }) };
}

function addResolved(
  ctx: Context,
  src: Source,
  kind: DependencyKind,
  group: string,
  artifact: string,
  raw: string,
  loc?: Location,
): void {
  const version = resolveVersion(raw, loc, ctx.scope);
  if (!version) {
    ctx.warnings.push(`${src.file}: cannot resolve version "${raw}" of ${group}:${artifact}`);
    return;
  }
  ctx.out.push(makeDep(kind, group, artifact, version, src.file, ctx.repositories));
}

function libraryDeps(src: Source, ctx: Context): void {
  for (const m of src.code.matchAll(COORD_RE)) {
    addResolved(ctx, src, 'library', m[2]!, m[3]!, m[4]!, locOf(src, m, 4));
  }
  for (const m of src.code.matchAll(MAP_RE)) {
    if (m[6] !== undefined) addResolved(ctx, src, 'library', m[2]!, m[4]!, m[6], locOf(src, m, 6));
    else addResolved(ctx, src, 'library', m[2]!, m[4]!, `\${${m[7]}}`);
  }
  const plugins = findBlocks(src.code, 'plugins');
  for (const m of src.code.matchAll(KOTLIN_DEP_RE)) {
    if (!within(m.index, plugins)) {
      addResolved(ctx, src, 'library', 'org.jetbrains.kotlin', `kotlin-${m[1]}`, m[2]!, locOf(src, m, 2));
    }
  }
}

function pluginDeps(src: Source, ctx: Context): void {
  for (const m of matchesIn(src.code, PLUGIN_RE, findBlocks(src.code, 'plugins'))) {
    const id = m[1] === 'kotlin' ? `org.jetbrains.kotlin.${m[3]}` : m[3]!;
    if (m[5] !== undefined) addResolved(ctx, src, 'plugin', id, `${id}.gradle.plugin`, m[5], locOf(src, m, 5));
    else addResolved(ctx, src, 'plugin', id, `${id}.gradle.plugin`, `\${${m[6]}}`);
  }
}

interface TomlString {
  value: string;
  start: number;
  end: number;
}

interface TomlEntry {
  table: string;
  key: string;
  fields: Map<string, TomlString>;
}

export function parseToml(code: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  let table = '';
  let i = 0;
  const skipWs = (newlines: boolean) => {
    while (i < code.length && (code[i] === ' ' || code[i] === '\t' || code[i] === '\r' || (newlines && code[i] === '\n'))) i++;
  };
  const skipLine = () => {
    const nl = code.indexOf('\n', i);
    i = nl < 0 ? code.length : nl + 1;
  };
  const readKey = () => {
    const key = /^(?:[\w.\-]+|"[^"\n]*"|'[^'\n]*')+/.exec(code.slice(i, i + 256))?.[0] ?? '';
    i += key.length;
    return key.replace(/["']/g, '');
  };
  const readValue = (path: string, fields: Map<string, TomlString>) => {
    const c = code[i];
    if (c === '"' || c === "'") {
      const start = i + 1;
      let j = start;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += c === '"' && code[j] === '\\' ? 2 : 1;
      fields.set(path, { value: code.slice(start, j), start, end: j });
      i = j + 1;
    } else if (c === '{') {
      i++;
      for (;;) {
        skipWs(true);
        if (i >= code.length || code[i] === '}') break;
        if (code[i] === ',') {
          i++;
          continue;
        }
        const key = readKey();
        skipWs(false);
        if (!key || code[i] !== '=') break;
        i++;
        skipWs(true);
        readValue(path ? `${path}.${key}` : key, fields);
      }
      i++;
    } else if (c === '[') {
      let depth = 0;
      for (; i < code.length; i++) {
        if (code[i] === '[') depth++;
        else if (code[i] === ']' && --depth === 0) break;
      }
      i++;
    } else {
      while (i < code.length && !/[\n,}]/.test(code[i]!)) i++;
    }
  };
  while (i < code.length) {
    skipWs(true);
    if (i >= code.length) break;
    if (code[i] === '[') {
      const end = code.indexOf(']', i);
      table = code.slice(i + 1, end).trim();
      i = end + 1;
      skipLine();
      continue;
    }
    const key = readKey();
    skipWs(false);
    if (!key || code[i] !== '=') {
      skipLine();
      continue;
    }
    i++;
    skipWs(false);
    const fields = new Map<string, TomlString>();
    readValue('', fields);
    entries.push({ table, key, fields });
    skipLine();
  }
  return entries;
}

interface Catalog {
  name: string;
  file: string;
}

async function catalogDeclarations(root: string, settings?: Source): Promise<Catalog[]> {
  const declared: Catalog[] = [];
  if (settings) {
    const blocks = findBlocks(settings.code, 'versionCatalogs');
    for (const m of matchesIn(settings.code, CATALOG_RE, blocks)) {
      declared.push({ name: (m[1] ?? m[2])!, file: resolve(dirname(settings.file), m[3]!) });
    }
  }
  const defaultFile = join(root, 'gradle', 'libs.versions.toml');
  if (!declared.some((c) => c.file === defaultFile)) declared.push({ name: 'libs', file: defaultFile });
  return declared;
}

function tomlValue(src: Source, s: TomlString): Value {
  return isDynamic(s.value) ? { value: s.value } : { value: s.value, loc: { file: src.file, start: s.start, end: s.end } };
}

function pickVersion(src: Source, fields: Map<string, TomlString>, path: string): Value | undefined {
  const plain = fields.get(path);
  if (plain) return tomlValue(src, plain);
  const rich = ['require', 'strictly', 'prefer']
    .map((k) => fields.get(path ? `${path}.${k}` : k))
    .filter((s): s is TomlString => s !== undefined);
  const best = rich.find((s) => !isDynamic(s.value)) ?? rich[0];
  return best && tomlValue(src, best);
}

function splitNotation(src: Source, s: TomlString): { parts: string[]; version?: Value } {
  const parts = s.value.split(':');
  const last = parts[parts.length - 1]!;
  const start = s.end - last.length;
  return { parts, version: tomlValue(src, { value: last, start, end: s.end }) };
}

function parseCatalog(
  src: Source,
  libraryRepos: string[],
  pluginRepos: string[],
  warnings: string[],
): { versions: Vars; deps: Dependency[] } {
  const entries = parseToml(src.code);
  const versions: Vars = new Map();
  for (const e of entries.filter((e) => e.table === 'versions')) {
    const v = pickVersion(src, e.fields, '');
    if (v) versions.set(e.key, v);
  }
  const versionOf = (e: TomlEntry): Value | undefined => {
    const ref = e.fields.get('version.ref');
    if (!ref) return pickVersion(src, e.fields, 'version');
    const found = versions.get(ref.value);
    if (!found) warnings.push(`${src.file}: unknown version.ref "${ref.value}" in ${e.key}`);
    return found;
  };
  const deps: Dependency[] = [];
  for (const e of entries.filter((e) => e.table === 'libraries')) {
    const str = e.fields.get('');
    if (str) {
      const { parts, version } = splitNotation(src, str);
      if (parts.length >= 3 && version) deps.push(makeDep('library', parts[0]!, parts[1]!, version, src.file, libraryRepos));
      continue;
    }
    const [group, artifact] = e.fields.get('module')?.value.split(':') ?? [e.fields.get('group')?.value, e.fields.get('name')?.value];
    const version = versionOf(e);
    if (group && artifact && version) deps.push(makeDep('library', group, artifact, version, src.file, libraryRepos));
  }
  for (const e of entries.filter((e) => e.table === 'plugins')) {
    const str = e.fields.get('');
    const id = str ? str.value.split(':')[0] : e.fields.get('id')?.value;
    const version = str ? (str.value.includes(':') ? splitNotation(src, str).version : undefined) : versionOf(e);
    if (id && version) deps.push(makeDep('plugin', id, `${id}.gradle.plugin`, version, src.file, pluginRepos));
  }
  const normalized: Vars = new Map([...versions].map(([k, v]) => [normKey(k), v]));
  return { versions: normalized, deps };
}

async function wrapperDep(root: string): Promise<Dependency | undefined> {
  const src = await readSource(join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'), stripProperties);
  const m = src && WRAPPER_RE.exec(src.code);
  if (!src || !m) return undefined;
  return makeDep('gradle', 'org.gradle', 'gradle', { value: m[1]!, loc: locOf(src, m, 1) }, src.file, []);
}

export async function scanGradle(build: GradleBuild): Promise<ScanResult> {
  const warnings: string[] = [];
  const out: Dependency[] = [];
  const settings = build.settings ? await readSource(build.settings, stripCode) : undefined;
  const rootProps = propertyVars(await readSource(join(build.root, 'gradle.properties'), stripProperties));
  const rootBuildFile = build.buildFiles.find((f) => dirname(f) === build.root);
  const rootBuild = rootBuildFile ? await readSource(rootBuildFile, stripCode) : undefined;
  const rootVars = rootBuild ? collectVars(rootBuild) : new Map<string, Value>();

  const pluginManagementRepos = settings ? reposWithin(settings, 'pluginManagement') : [];
  const resolutionRepos = settings ? reposWithin(settings, 'dependencyResolutionManagement') : [];
  const sharedLibraryRepos = [...resolutionRepos, ...(rootBuild ? buildFileRepos(rootBuild) : [])];
  const libraryRepos = (extra: string[]) => {
    const repos = dedupeRepos([...sharedLibraryRepos, ...extra]);
    return repos.length ? repos : [MAVEN_CENTRAL, GOOGLE];
  };
  const pluginRepos = dedupeRepos([
    ...(pluginManagementRepos.length ? pluginManagementRepos : [GRADLE_PLUGIN_PORTAL]),
    ...resolutionRepos.filter((url) => url === GOOGLE || url === MAVEN_CENTRAL),
  ]);

  const catalogs = new Map<string, Vars>();
  for (const decl of await catalogDeclarations(build.root, settings)) {
    const src = await readSource(decl.file, stripToml);
    if (!src) continue;
    const parsed = parseCatalog(src, libraryRepos([]), pluginRepos, warnings);
    catalogs.set(decl.name, parsed.versions);
    out.push(...parsed.deps);
  }

  if (settings) {
    const scope = { vars: [collectVars(settings), rootProps], catalogs };
    pluginDeps(settings, { scope, repositories: pluginRepos, warnings, out });
  }

  for (const file of build.buildFiles) {
    const src = file === rootBuildFile ? rootBuild : await readSource(file, stripCode);
    if (!src) continue;
    const dir = dirname(file);
    const moduleProps =
      dir === build.root ? new Map<string, Value>() : propertyVars(await readSource(join(dir, 'gradle.properties'), stripProperties));
    const scope = { vars: [collectVars(src), rootVars, moduleProps, rootProps], catalogs };
    libraryDeps(src, { scope, repositories: libraryRepos(buildFileRepos(src)), warnings, out });
    pluginDeps(src, { scope, repositories: pluginRepos, warnings, out });
  }

  const wrapper = await wrapperDep(build.root);
  if (wrapper) out.push(wrapper);
  return { dependencies: out, warnings };
}
