# Contributing

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Setup

```sh
git clone https://github.com/Theofilos-Chamalis/jvm-upgrade.git
cd jvm-upgrade
npm install
npm test
```

Run the CLI from source against any project:

```sh
npm run build && node dist/cli.js /path/to/project
```

## Project layout

| Path | What it does |
|---|---|
| `src/scan/` | Finds dependencies, plugins and repositories in Gradle and Maven files |
| `src/version.ts` | Version ordering (Gradle rules) and prerelease detection |
| `src/policy.ts` | Picks patch / minor / major candidates (cooldown, prerelease rules) |
| `src/http.ts` | HTTP client: concurrency limit, auth, retries, cache |
| `src/repos.ts` | Reads versions and publish dates from Maven repositories |
| `src/changelog.ts` | Finds release notes (GitHub releases, CHANGELOG files) |
| `src/rows.ts` | Joins scan results and versions into rows |
| `src/tui.ts` | Interactive picker |
| `src/apply.ts` | Safe, atomic in-place edits of version literals |
| `src/main.ts` | Command line flags and the main flow |

## Rules

- Keep runtime dependencies at zero. Node's standard library covers what we need.
- Every bug fix or new notation gets a test. Parser tests live next to a small fixture project in `test/fixtures/`.
- Tests must not use the real network. Use a fake `Http` or a local `node:http` server.
- Run `npm run typecheck && npm test` before you open a pull request.

## Found a notation we miss?

Open an issue with a small snippet of the build file. That is the fastest way to get it supported.

## Releasing

1. Add a `## [x.y.z]` section at the top of `CHANGELOG.md`.
2. Run `npm version x.y.z` (this commits and makes the `vx.y.z` tag).
3. Run `git push --follow-tags`.

The Release workflow runs the tests, publishes to npm with Trusted Publishing (if that version is not there yet), and makes the GitHub release with the notes from `CHANGELOG.md`.
