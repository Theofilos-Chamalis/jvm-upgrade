# Changelog

## [0.2.0]

### Added
- Changelogs for the Gradle wrapper, read from the `gradle/gradle` GitHub releases.
- Release notes links for Google Play services and Firebase, which have no public source.
- Changelogs for projects whose tags drop the major version, such as protobuf-java (`4.36.2` is tag `v36.2`).
- Groovy map versions (`ext.versions = [compose: '1.6.8']`, `$versions.compose`), `kotlin("stdlib", kotlinVersion)`, and `rootProject.extra["x"]` / `property("x")` references.
- GitHub releases are made automatically from this file when a version tag is pushed.

### Changed
- Needs Node.js 22.13 or newer (Node 20 is end of life).
- The result table goes to stdout, so it can be piped or saved to a file. Progress and warnings stay on stderr.
- Prerelease notes are skipped unless you upgrade to a prerelease.
- `--error-on-outdated` only fails when an upgrade is allowed by `--target`.

### Fixed
- Credentials for `https://host/maven` were also sent to `https://host/maven-other/`.
- A proxy answering with an HTML page made dependencies look up to date. It is now reported as an error.
- Cooldown now works for `mavenLocal()` and other `file://` repositories.
- Failed (5xx, 429) responses were kept for the whole run and never retried.
- JitPack multi-module groups (`com.github.Owner.Repo:Module`) now find their tags.
- Strings like `"jdbc:h2:mem:test"` or `"12:30:00"` were read as dependencies.
- Test projects under `src/` (for example `src/it/*/pom.xml`) were scanned as real projects.
- Dependencies inside a Maven `<plugin>` now use the plugin repositories.
- A TOML table header with no closing `]` made the scanner hang.
- Upgrading a symlinked build file replaced the link with a normal file.
- One failed lookup could stop the whole run.

## [0.1.0]

- First release.
