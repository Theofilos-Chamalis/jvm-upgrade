# jvm-upgrade

[![npm](https://img.shields.io/npm/v/jvm-upgrade.svg)](https://www.npmjs.com/package/jvm-upgrade)
[![CI](https://github.com/Theofilos-Chamalis/jvm-upgrade/actions/workflows/ci.yml/badge.svg)](https://github.com/Theofilos-Chamalis/jvm-upgrade/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Find outdated libraries in **Java, Kotlin and Android** projects, read their changelogs, and upgrade them. Works with **Gradle** (Kotlin DSL, Groovy DSL, version catalogs) and **Maven**. Like `npm-upgrade`, but for the JVM.

```sh
npx jvm-upgrade
```

```
Name                                   Current  Patch   Minor   Major
androidx.core:core-ktx                 1.10.0   1.10.1  1.17.0
com.android.application                8.5.0    8.5.2   8.13.0
com.squareup.okhttp3:okhttp            4.9.0    4.9.3   4.12.0  5.1.0
org.jetbrains.kotlin:kotlin-stdlib     1.9.0    1.9.25          2.2.20

Run jvm-upgrade -u to apply the underlined versions (target: major), or jvm-upgrade -i to pick.
```

## Why

- **Fast.** It reads Maven repositories directly and in parallel. It does not start Gradle or Maven.
- **Safe.** It changes only the version text. Your comments and formatting stay. Files are written atomically, and nothing is written if any file changed under it.
- **Changelogs.** See the release notes of every version between your version and the new one, right in the terminal.
- **Every source.** Maven Central, Google Maven, Gradle Plugin Portal, JitPack, `mavenLocal()`, and any custom or private repository your build declares.
- **Supply chain aware.** A cooldown window skips versions that are too new to trust.
- **No trash.** No build output, no temp files left behind. The metadata cache lives in your OS cache folder and expires by itself.

## Install

```sh
npm install -g jvm-upgrade
```

Or run it once with `npx jvm-upgrade`. Needs Node.js 20.12 or newer.

## Usage

```sh
jvm-upgrade                 # list available upgrades (nothing is changed)
jvm-upgrade -u              # apply the latest major versions
jvm-upgrade -u -t minor     # apply the latest minor versions only
jvm-upgrade -i              # pick versions and read changelogs interactively
jvm-upgrade -l              # print the changelogs of the selected upgrades
jvm-upgrade -c 7            # ignore versions published in the last 7 days
jvm-upgrade path/to/project
```

### Interactive mode

`jvm-upgrade -i` opens a picker:

| Key | Action |
|---|---|
| `↑` `↓` | Move |
| `←` `→` | Choose patch, minor, major or skip |
| `space` | Select or unselect |
| `a` | Select or unselect all |
| `c` | Show the changelog for the chosen version |
| `enter` | Apply |
| `q` | Quit without changes |

## Options

| Option | Default | Description |
|---|---|---|
| `[directory]` | `.` | Project root to scan |
| `-u, --upgrade` | | Write the upgrades to the build files |
| `-i, --interactive` | | Pick upgrades in a terminal UI |
| `-l, --changelog` | | Print the changelog of each selected upgrade |
| `-t, --target <level>` | `major` | Highest jump allowed: `major`, `minor` or `patch` |
| `-c, --cooldown <days>` | `0` | Skip versions published less than N days ago |
| `--allow-downgrade` | | With `--cooldown`, roll back versions that are too new |
| `--pre` | | Allow prereleases (alpha, beta, rc, ...) |
| `--include <pattern>` | | Only check matching deps. Repeatable or comma separated |
| `--exclude <pattern>` | | Skip matching deps |
| `--repo <url>` | | Extra Maven repository to query. Repeatable |
| `--format <format>` | `text` | `text` or `json` (JSON goes to stdout, the rest to stderr) |
| `--error-on-outdated` | | Exit with code 1 when upgrades are available (for CI) |
| `--verbose` | | Also list dependencies that are up to date |
| `--no-progress` | | Hide progress bars |
| `--concurrency <n>` | `8` | Parallel HTTP requests |
| `--no-cache` | | Do not use the metadata cache |
| `--clear-cache` | | Delete the metadata cache first |

Patterns match `group` (`com.google.*`) or `group:artifact` (`org.jetbrains:*`, `junit:junit`). For plugins, the group is the plugin id.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Upgrades available (only with `--error-on-outdated`) |
| `2` | Bad flag or config |
| `3` | A build file could not be read |
| `4` | Network or repository error |
| `5` | A file changed while upgrading, so nothing was written |

## What it reads

| File | What |
|---|---|
| `build.gradle`, `build.gradle.kts` | Dependencies, `plugins {}`, `buildscript` classpath, `ext` / `val` / `extra` variables, repositories |
| `settings.gradle(.kts)` | `pluginManagement`, `dependencyResolutionManagement`, extra version catalogs |
| `gradle/libs.versions.toml` | `[versions]`, `[libraries]`, `[plugins]` |
| `gradle.properties` | Version properties |
| `gradle/wrapper/gradle-wrapper.properties` | The Gradle version itself |
| `pom.xml` | Dependencies, dependency management, plugins, extensions, parent, `<properties>`, repositories |

When a version comes from a variable (a catalog `version.ref`, a property, `ext`), the upgrade lands where the variable is defined. All libraries that share it are upgraded together, to a version that exists for all of them.

Dynamic versions (`1.+`, `[1.0,2.0)`, `latest.release`) are shown but never rewritten.

## Version rules

1. Never go down (unless `--allow-downgrade`).
2. Stable stays stable. If you use a prerelease, newer prereleases are allowed too. `--pre` allows all prereleases.
3. Cooldown drops versions that are too new.
4. `--target` sets the highest jump.
5. The highest remaining version wins, using Gradle's version ordering.

## Changelogs

For each upgrade, jvm-upgrade looks for the source repository in the POM (`<scm>`, `<url>`, parent POMs), or uses the GitHub repo directly for JitPack. It then reads the GitHub releases between your version and the new one. If there are none, it reads `CHANGELOG.md` (and similar files) and cuts out the right sections. If it finds nothing, it gives you the link.

Set `GITHUB_TOKEN` (or `GH_TOKEN`) to avoid GitHub rate limits.

## Configuration

### Project: `.jvm-upgrade.json`

Put it in the project root, or in a module folder to override settings for that module. The closest file wins, and it inherits the rest from the parent folders.

```json
{
  "target": "minor",
  "cooldown": 7,
  "pre": false,
  "allowDowngrade": false,
  "include": [],
  "exclude": ["com.example:legacy-*"],
  "repositories": ["https://repo.example.com/maven/"]
}
```

### User: `~/.jvm-upgrade/config.json`

Your defaults for every project. It takes all project keys, plus `cacheDir`, `noCache` and `concurrency`.

### Private repositories: `~/.jvm-upgrade/credentials.json`

```json
{
  "repositories": [
    { "url": "https://nexus.example.com/", "token": "$NEXUS_TOKEN" },
    { "url": "https://artifactory.example.com/", "username": "$ART_USER", "password": "$ART_PASS" }
  ]
}
```

Values that start with `$` come from environment variables. The longest matching URL prefix wins. Credentials are only sent to that host, and authenticated responses are never written to the disk cache.

Set `JVM_UPGRADE_HOME` to use a different folder than `~/.jvm-upgrade`.

## CI

```sh
npx jvm-upgrade --error-on-outdated --cooldown 7
npx jvm-upgrade --format json > upgrades.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues with a small build file snippet are the best way to get a new notation supported.

## License

[MIT](LICENSE)
