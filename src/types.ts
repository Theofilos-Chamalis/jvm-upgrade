export type Target = 'patch' | 'minor' | 'major';

export const TARGETS: readonly Target[] = ['patch', 'minor', 'major'];

/** Exact span of a version literal inside a file (string indices, end exclusive). */
export interface Location {
  file: string;
  start: number;
  end: number;
}

export type DependencyKind = 'library' | 'plugin' | 'gradle';

export interface Dependency {
  /** For plugins: the plugin id. For kind 'gradle': "org.gradle". */
  group: string;
  /** For plugins: `${id}.gradle.plugin` (the marker artifact). For kind 'gradle': "gradle". */
  artifact: string;
  kind: DependencyKind;
  /** Current version text as written after resolving properties / catalog refs. */
  version: string;
  /** Build file that declares the dependency (used for closest-config lookup and display). */
  file: string;
  /** Where the version literal lives. Missing when it cannot be rewritten safely (ranges, dynamic, unresolved). */
  location?: Location;
  /** Repository base URLs to query, in order, each ending with "/". */
  repositories: string[];
}

export interface ScanResult {
  dependencies: Dependency[];
  warnings: string[];
}

export interface Credential {
  url: string;
  token?: string;
  username?: string;
  password?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Http {
  get(url: string): Promise<HttpResponse>;
  head(url: string): Promise<HttpResponse>;
}

export interface PolicyOptions {
  target: Target;
  pre: boolean;
  cooldownDays: number;
  allowDowngrade: boolean;
  now: Date;
}

/** Best candidate per upgrade level. Missing key = nothing available at that level. */
export interface Candidates {
  patch?: string;
  minor?: string;
  major?: string;
  /** Set when allowDowngrade + cooldown rolls the current version back. */
  downgrade?: string;
}

export interface ChangelogEntry {
  version: string;
  title?: string;
  body: string;
  url?: string;
  date?: string;
}

export interface Changelog {
  entries: ChangelogEntry[];
  /** Where the notes came from, or where to read them when entries is empty. */
  source?: string;
}
