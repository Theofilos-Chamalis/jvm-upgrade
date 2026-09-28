import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { applyEdits, EditConflictError, type Edit } from './apply.js';
import { getChangelog } from './changelog.js';
import { ConfigError, loadCredentials, loadUserConfig, projectConfigResolver, splitPatterns } from './config.js';
import { changelogUrl, formatChangelog, formatChangelogHeader, formatChangelogLinks, renderTable, toJson } from './format.js';
import { clearCache, createHttp, defaultCacheDir } from './http.js';
import { createProgress } from './progress.js';
import { buildRows, type Choice, type Row } from './rows.js';
import { scanProject } from './scan/index.js';
import { TARGETS, type Changelog, type Http, type Target } from './types.js';
import { compareVersions } from './version.js';

export const EXIT = { ok: 0, outdated: 1, usage: 2, parse: 3, network: 4, conflict: 5 } as const;

const HELP = `Usage: jvm-upgrade [directory] [options]

Find outdated libraries in Gradle and Maven projects and upgrade them.

Actions
  -u, --upgrade            Write the selected upgrades to the build files
  -i, --interactive        Pick upgrades (and read changelogs) in a terminal UI
  -l, --changelog          Print a changelog link for every selected upgrade
      --changelog-latest   Print the release notes of the new version only
      --changelog-diff     Print the release notes of every version between old and new

Policy
  -t, --target <level>     Highest jump allowed: major, minor or patch (default: major)
  -c, --cooldown <days>    Skip versions published less than <days> days ago
      --allow-downgrade    With --cooldown, roll back versions that are too new
      --pre                Allow prereleases (alpha, beta, rc, ...)
      --include <pattern>  Only check matching deps, e.g. "com.google.*,org.jetbrains:*"
      --exclude <pattern>  Skip matching deps
      --repo <url>         Extra Maven repository to query (repeatable)

Output
      --format <format>    text or json (default: text)
      --error-on-outdated  Exit with code 1 when upgrades are available
      --verbose            Also list dependencies that are up to date
      --no-progress        Hide progress bars

Network
      --concurrency <n>    Parallel HTTP requests (default: 8)
      --no-cache           Do not use the metadata cache
      --clear-cache        Delete the metadata cache first

  -h, --help               Show this help
  -v, --version            Show the version
`;

export function fail(code: number, message: string): never {
  process.stderr.write(`${styleText('red', 'error')} ${message}\n`);
  process.exit(code);
}

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        upgrade: { type: 'boolean', short: 'u' },
        interactive: { type: 'boolean', short: 'i' },
        changelog: { type: 'boolean', short: 'l' },
        'changelog-latest': { type: 'boolean' },
        'changelog-diff': { type: 'boolean' },
        target: { type: 'string', short: 't' },
        cooldown: { type: 'string', short: 'c' },
        'allow-downgrade': { type: 'boolean' },
        pre: { type: 'boolean' },
        include: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        repo: { type: 'string', multiple: true },
        format: { type: 'string' },
        'error-on-outdated': { type: 'boolean' },
        verbose: { type: 'boolean' },
        progress: { type: 'boolean', default: true },
        concurrency: { type: 'string' },
        cache: { type: 'boolean', default: true },
        'clear-cache': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    fail(EXIT.usage, `${(e as Error).message}\nRun jvm-upgrade --help for usage.`);
  }
}

function parseInteger(name: string, value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) fail(EXIT.usage, `--${name} must be an integer >= ${min}`);
  return n;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: flags, positionals } = parseCli(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return EXIT.ok;
  }
  if (flags.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return EXIT.ok;
  }
  if (positionals.length > 1) fail(EXIT.usage, 'only one directory can be given');
  if (flags.target && !TARGETS.includes(flags.target as Target)) fail(EXIT.usage, '--target must be major, minor or patch');
  if (flags.format && flags.format !== 'text' && flags.format !== 'json') fail(EXIT.usage, '--format must be text or json');
  const json = flags.format === 'json';
  if (json && flags.interactive) fail(EXIT.usage, '--interactive cannot be used with --format json');
  if (flags.interactive && !(process.stdin.isTTY && process.stdout.isTTY)) fail(EXIT.usage, '--interactive needs a terminal');

  const root = resolve(positionals[0] ?? '.');
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) fail(EXIT.usage, `${root} is not a directory`);

  let user;
  let credentials;
  try {
    user = await loadUserConfig();
    credentials = await loadCredentials();
  } catch (e) {
    if (e instanceof ConfigError) fail(EXIT.usage, e.message);
    throw e;
  }

  const cooldown = parseInteger('cooldown', flags.cooldown, 0);
  const concurrency = parseInteger('concurrency', flags.concurrency, 1) ?? user.concurrency;
  const cli = {
    ...(flags.target && { target: flags.target as Target }),
    ...(cooldown !== undefined && { cooldown }),
    ...(flags['allow-downgrade'] !== undefined && { allowDowngrade: flags['allow-downgrade'] }),
    ...(flags.pre !== undefined && { pre: flags.pre }),
    ...(flags.include && { include: splitPatterns(flags.include) }),
    ...(flags.exclude && { exclude: splitPatterns(flags.exclude) }),
  };
  const resolveBase = projectConfigResolver(root, user);
  const optionsFor = async (file: string) => ({ ...(await resolveBase(file)), ...cli });
  const rootOptions = await optionsFor(resolve(root, 'build.gradle')).catch((e) => {
    if (e instanceof ConfigError) fail(EXIT.usage, e.message);
    throw e;
  });
  if (rootOptions.allowDowngrade && !rootOptions.cooldown) fail(EXIT.usage, '--allow-downgrade needs --cooldown');

  const cacheDir = user.cacheDir ?? defaultCacheDir();
  if (flags['clear-cache']) await clearCache(cacheDir);
  const showProgress = flags.progress && process.stderr.isTTY;
  const log = (text: string) => process.stderr.write(`${text}\n`);
  const say = (text: string) => (json ? process.stderr : process.stdout).write(`${text}\n`);

  let scan;
  try {
    scan = await scanProject(root);
  } catch (e) {
    fail(EXIT.parse, `could not read the project: ${(e as Error).message}`);
  }
  for (const warning of scan.warnings) log(styleText('yellow', `warning: ${warning}`));
  if (!scan.dependencies.length) {
    say('No Gradle or Maven dependencies found.');
    if (json) process.stdout.write('[]\n');
    return EXIT.ok;
  }

  const progress = createProgress('Checking versions', process.stderr, showProgress);
  const http = createHttp({ credentials, concurrency, cacheDir, noCache: !flags.cache || user.noCache });
  try {
    let rows: Row[];
    try {
      rows = await buildRows(scan.dependencies, {
        http,
        optionsFor,
        extraRepositories: flags.repo ?? [],
        progress,
        now: new Date(),
      });
    } catch (e) {
      if (e instanceof ConfigError) fail(EXIT.usage, e.message);
      throw e;
    } finally {
      progress.done();
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const nameCount = new Map<string, number>();
    for (const row of rows) nameCount.set(row.name, (nameCount.get(row.name) ?? 0) + 1);
    for (const row of rows) if (nameCount.get(row.name)! > 1) row.name += `  (${relative(root, row.deps[0]!.file)})`;

    const outdated = rows.filter((r) => r.choices.length);
    const selectable = outdated.filter((r) => r.selected !== undefined);
    const failed = rows.filter((r) => !r.choices.length && r.errors.length);
    const failedAll = rows.length > 0 && failed.length === rows.length;
    const visible = flags.verbose ? rows : [...outdated, ...failed];

    if (json) {
      process.stdout.write(`${JSON.stringify(toJson(visible, root), null, 2)}\n`);
    } else if (!flags.interactive) {
      if (visible.length) say(renderTable(visible, root));
      if (!outdated.length) say(styleText('green', `All ${rows.length - failed.length} dependencies are up to date.`));
    }
    if (failedAll) return EXIT.network;
    if (!outdated.length) return EXIT.ok;

    let chosen: Map<Row, Choice>;
    if (flags.interactive) {
      const picked = await (await import('./tui.js')).pick(outdated, (row, choice) => loadChangelog(http, row, choice));
      if (!picked) {
        say('Cancelled. Nothing was changed.');
        return EXIT.ok;
      }
      chosen = picked;
    } else {
      chosen = new Map();
      for (const row of outdated) {
        const choice = row.selected === undefined ? undefined : row.choices[row.selected];
        if (choice) chosen.set(row, choice);
      }
    }

    const changelogMode = flags['changelog-diff'] ? 'diff' : flags['changelog-latest'] ? 'latest' : flags.changelog ? 'links' : undefined;
    if (changelogMode && !json) await printChangelogs(http, chosen, changelogMode, showProgress);

    const writable = [...chosen].filter(([row]) => row.location);
    if (flags.upgrade || flags.interactive) {
      if (!writable.length) {
        say('Nothing to upgrade.');
        return EXIT.ok;
      }
      const edits: Edit[] = writable.map(([row, choice]) => ({ location: row.location!, from: row.current, to: choice.version }));
      try {
        await applyEdits(edits);
      } catch (e) {
        if (e instanceof EditConflictError) fail(EXIT.conflict, e.message);
        throw e;
      }
      for (const [row, choice] of writable) say(`${styleText('green', '✔')} ${row.name} ${row.current} → ${choice.version}`);
      say(styleText('gray', 'Build files updated. Run your build and tests to check the upgrades.'));
      return EXIT.ok;
    }

    if (!json) {
      const target = rootOptions.target;
      say(styleText('gray', `\nRun ${styleText('cyan', 'jvm-upgrade -u')} to apply the underlined versions (target: ${target}), or ${styleText('cyan', 'jvm-upgrade -i')} to pick.`));
    }
    return flags['error-on-outdated'] && selectable.length ? EXIT.outdated : EXIT.ok;
  } finally {
    await http.close();
  }
}

function loadChangelog(http: Http, row: Row, choice: Choice): Promise<Changelog> {
  const dep = row.deps[0]!;
  return getChangelog(http, dep, row.current, choice.version, row.repoOf.get(choice.version), compareVersions);
}

const MAX_NOTE_LINES = 40;

async function printChangelogs(http: Http, chosen: Map<Row, Choice>, mode: 'links' | 'latest' | 'diff', showProgress: boolean) {
  const entries = [...chosen];
  if (!entries.length) return;
  const progress = createProgress('Loading changelogs', process.stderr, showProgress);
  progress.total(entries.length);
  const logs = await Promise.all(
    entries.map(([row, choice]) =>
      loadChangelog(http, row, choice)
        .catch((): Changelog => ({ entries: [] }))
        .finally(() => progress.tick()),
    ),
  );
  progress.done();

  if (mode === 'links') {
    const links = entries.map(([row, choice], i) => ({ name: row.name, from: row.current, to: choice, url: changelogUrl(logs[i]!) }));
    process.stdout.write(`\n${formatChangelogLinks(links)}\n`);
    return;
  }
  const width = Math.min(process.stdout.columns ?? 100, 120) - 2;
  entries.forEach(([row, choice], i) => {
    const log = logs[i]!;
    const shown = mode === 'latest' ? { ...log, entries: log.entries.slice(0, 1) } : log;
    process.stdout.write(`\n${formatChangelogHeader(row.name, row.current, choice, width)}\n\n`);
    process.stdout.write(`${formatChangelog(shown, width, { maxLines: MAX_NOTE_LINES })}\n`);
  });
}
