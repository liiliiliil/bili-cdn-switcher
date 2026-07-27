import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentScript = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8"
);
const pageHook = await readFile(
  new URL("../src/page-hook.js", import.meta.url),
  "utf8"
);
const serviceWorker = await readFile(
  new URL("../src/service-worker.js", import.meta.url),
  "utf8"
);

test("恢复 seek 落在冷却期内时会预约下一次卡顿复查", () => {
  assert.match(
    contentScript,
    /scheduleStallCheck = \(video, delayMs = stallConfirmMs\)/
  );
  assert.match(
    contentScript,
    /scheduleStallCheck\(video, cooldownRemaining\)/
  );
});

test("明确卡顿更快确认，新 host 使用较短保护期", () => {
  assert.match(contentScript, /urgentStallConfirmMs = 2500/);
  assert.match(contentScript, /hostSwitchGraceMs = 7000/);
  assert.match(
    contentScript,
    /scheduleStallCheck\(event\.target, urgentStallConfirmMs\)/
  );
  assert.match(
    contentScript,
    /recoveryCooldownRemaining\?\.\(\{/
  );
  assert.match(contentScript, /currentHost,\s*lastHost: lastStallHost/);
  assert.match(
    contentScript,
    /minimumIntervalMs: hostSwitchGraceMs/
  );
  assert.match(
    contentScript,
    /scheduleStallCheck\(video, retryAfterMs\)/
  );
  assert.match(
    serviceWorker,
    /MIN_RECOVERY_SWITCH_INTERVAL_MS = 7 \* 1000/
  );
  assert.match(serviceWorker, /state\.recoveryInFlight = true/);
  assert.match(
    serviceWorker,
    /reason: "cooldown",\s*retryAfterMs:/
  );
});

test("缓冲持续下降时会在耗尽前请求恢复", () => {
  assert.match(contentScript, /healthSampleIntervalMs = 2000/);
  assert.match(contentScript, /preemptiveConfirmMs = 1500/);
  assert.match(
    contentScript,
    /playbackHealth\.shouldPreemptivelyRecover\(healthSamples\)/
  );
  assert.match(
    contentScript,
    /requestStallRecovery\(video, "buffer-draining"\)/
  );
  assert.match(
    contentScript,
    /\["seeking", "pause", "ended"\]/
  );
});

test("播放接口观察器区分视频轨和音频轨测速样本", () => {
  assert.match(pageHook, /videoUrls: videoOutput/);
  assert.match(pageHook, /audioUrls: audioOutput/);
  assert.match(contentScript, /latestPlayurlVideoUrls/);
  assert.match(
    serviceWorker,
    /state\.videoSampleUrl\s*\?\s*state\.videoSampleRange/
  );
  assert.match(serviceWorker, /const BENCHMARK_SCHEMA = 3/);
});

test("切换恢复会跨过播放器 seek 容差并在重新测速后再试一次", () => {
  assert.match(
    contentScript,
    /video\.currentTime - 1/
  );
  assert.match(
    contentScript,
    /setTimeout\(retryPlayback, 50\)/
  );
  assert.match(
    contentScript,
    /preserveStalledHosts: true/
  );
});

test("禁用节点会退出测速、规则和卡顿恢复候选", () => {
  assert.match(serviceWorker, /allCandidates\.filter\(\(item\) => !item\.disabled\)/);
  assert.match(
    serviceWorker,
    /state\.benchmarks\.filter\(\(item\) => !disabled\.has\(item\.host\)\)/
  );
  assert.match(serviceWorker, /case "SET_HOST_DISABLED"/);
  assert.match(serviceWorker, /!disabled\.has\(validation\.host\)/);
});
