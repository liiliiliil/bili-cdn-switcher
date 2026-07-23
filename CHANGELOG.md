# Changelog

All notable changes to this project are documented here.

## [Unreleased]

- Prepare a configurable automatic re-benchmark profile and Chrome Web Store release candidate.

## [1.6.0] - 2026-07-23

- Added 90-minute soft expiry and 2-hour hard expiry for automatic benchmark results.
- Limited automatic re-benchmarking to visible, actively playing Bilibili video tabs with real media Range traffic and safe forward buffering.
- Added a cross-tab benchmark mutex and retry backoff without background alarms.
- Exposed the automatic-result status in local diagnostics and the popup.
- Added unit tests for expiry states, activity gating, permission boundaries, URL scoping, candidate selection and recovery behavior.
- Documented Chrome playback tests, cold-video regressions and Bilibili 4K output measurements.

## [1.5.2] - 2026-07-23

- Added delayed buffer confirmation after play and seek events.
- Avoided treating normal seeking as an immediate playback failure.

## [1.5.1] - 2026-07-23

- Preserved tab state across tracking-parameter and trailing-slash URL changes.

## [1.5.0] - 2026-07-23

- Added two-stage Range benchmarking, bounded dynamic host learning and playback-stall recovery.

[Unreleased]: https://github.com/liiliiliil/bili-cdn-switcher/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/liiliiliil/bili-cdn-switcher/releases/tag/v1.6.0
