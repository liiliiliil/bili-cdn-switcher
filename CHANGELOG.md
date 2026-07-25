# Changelog

All notable changes to this project are documented here.

## [Unreleased]

Nothing yet.

## [1.8.0] - 2026-07-25

- Keep disabled CDN hosts, labels and historical benchmark results visible
  while excluding them from benchmarks, automatic selection and stall recovery.
- Release an active redirect rule immediately when its target is disabled.
- Allow any disabled candidate to be re-enabled from the popup without
  deleting or rebuilding its local history.

## [1.7.1] - 2026-07-24

- Release an expired automatic result's stale redirect rule before checking whether the page has enough safe buffer to re-benchmark.
- Fall back to Bilibili's original signed media host when every in-memory recovery candidate is exhausted, then immediately start a fresh bounded benchmark.
- Retry the stalled media position one second earlier after a recovery rule is installed, which reliably crosses the player's seek tolerance.
- Re-schedule stall detection for the end of its cooldown instead of silently dropping a recovery check triggered by that seek.
- Keep a short, tab-local memory of recently stalled hosts across recovery benchmarks so the next cycle does not immediately select them again.
- Prefer the current video-track path and its matching Range for benchmarks, instead of allowing a much lighter audio request to overstate 4K throughput.
- Invalidate cached automatic results from the older benchmark schema on upgrade, and make the popup's 4K bandwidth caution more conservative.
- Show the original-host fallback clearly in local recovery diagnostics.

## [1.7.0] - 2026-07-24

- Added frequent, balanced and low-frequency automatic re-benchmark profiles; the existing 90-minute soft expiry and 2-hour hard expiry remain the default.
- Kept every profile activity-gated: no alarms or idle/background benchmarks were added.
- Added profile validation, local configuration migration and popup controls.
- Switched to `declarativeNetRequestWithHostAccess` and narrowed Bilibili host permissions to the supported `www` and `m` playback origins.
- Added original extension icons, anonymized store screenshots and Chrome Web Store review materials.
- Reworked the README and store copy to make the scope, setup and limits easier to scan.

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

[Unreleased]: https://github.com/liiliiliil/bili-cdn-switcher/compare/v1.8.0...HEAD
[1.8.0]: https://github.com/liiliiliil/bili-cdn-switcher/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/liiliiliil/bili-cdn-switcher/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/liiliiliil/bili-cdn-switcher/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/liiliiliil/bili-cdn-switcher/releases/tag/v1.6.0
