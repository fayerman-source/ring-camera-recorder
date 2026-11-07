# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-07

### Added

- Detection-time snapshots: each motion clip gets `<clip>.detection.jpg`, the still Ring captured when it detected motion. It predates the first video frame by several seconds and is the only view of the approach available without a subscription. Controlled by `detectionSnapshots` (on by default).
- Per-capture latency log: `timingLog` (on by default) appends one row per clip to `<outputDir>/timing.jsonl`, splitting Ring detection to first frame into push delay, stream setup and ffmpeg time.
- README troubleshooting section for motion events that never produce a clip.

### Fixed

- Motion and doorbell pushes are delivered again. `ring-client-api` 14.3.0 pins `@eneris/push-receiver` 4.3.0, which can no longer decrypt Firebase pushes after a format change, so every event was dropped. An npm `overrides` entry now pins 4.4.0 (upstream dgreif/ring#1877).
- The first run after `npm run auth` now receives events without a restart. Cameras subscribed to motion before Ring knew the push token, so Ring ignored the subscription. The service now re-subscribes every camera once the push token is registered (port of upstream dgreif/ring#1879).
- The logger no longer prints `[object Object]` when an error payload has circular references.

### Changed

- Tests now run on the built-in `node:test` runner.
- CI installs dependencies with `--ignore-scripts`, so transitive packages cannot run code at install time.

## [0.1.0] - 2026-06-17

Initial release.

### Added

- Interactive 2FA login that stores a refresh token and rotates it automatically across restarts.
- Motion and doorbell ("ding") triggered recording, with rising-edge gating, a per-camera cooldown, and no-overlap protection.
- Manual one-shot recording (`npm run record`) and an end-to-end verification harness (`npm run verify`).
- Fragmented-MP4 output, so a clip interrupted mid-recording stays playable.
- Layered configuration (built-in defaults < `config.json` < `config.local.json` < environment variables).
- Optional retention that deletes clips older than a configured number of days.
- systemd and pm2 service units, plus a CI workflow that builds and runs the test suite.

[Unreleased]: https://github.com/fayerman-source/ring-camera-recorder/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fayerman-source/ring-camera-recorder/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fayerman-source/ring-camera-recorder/releases/tag/v0.1.0
