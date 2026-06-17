# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/fayerman-source/ring-camera-recorder/releases/tag/v0.1.0
