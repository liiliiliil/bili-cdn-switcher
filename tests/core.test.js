import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_REFRESH_PROFILES,
  buildSessionRedirectRule,
  classifyAutoResultAge,
  chooseAutoBenchmark,
  chooseBenchmarkCandidates,
  isAutoRefreshActivityEligible,
  isBilibiliInitiator,
  isCandidateMediaUrl,
  isPlaybackUrl,
  isSupportedMediaUrl,
  makeProbeRange,
  playbackPageKey,
  replaceMediaHost,
  resolveAutoRefreshProfile,
  selectBestBenchmark,
  selectRecoveryBenchmark,
  uniqueCandidates,
  validateCdnHost
} from "../src/core.js";

test("自动重新优选使用受限预设并默认回退到平衡档", () => {
  assert.deepEqual(resolveAutoRefreshProfile("frequent"), {
    id: "frequent",
    softTtlMs: 30 * 60 * 1000,
    hardTtlMs: 60 * 60 * 1000
  });
  assert.deepEqual(resolveAutoRefreshProfile("economy"), {
    id: "economy",
    softTtlMs: 6 * 60 * 60 * 1000,
    hardTtlMs: 12 * 60 * 60 * 1000
  });
  assert.equal(resolveAutoRefreshProfile("unknown").id, "balanced");
  assert.equal(resolveAutoRefreshProfile("__proto__").id, "balanced");
  assert.equal(Object.isFrozen(AUTO_REFRESH_PROFILES), true);
});

test("每个自动重新优选档位都保持软过期早于硬过期", () => {
  const now = 50_000_000;
  for (const profile of Object.values(AUTO_REFRESH_PROFILES)) {
    const options = {
      now,
      softTtlMs: profile.softTtlMs,
      hardTtlMs: profile.hardTtlMs
    };
    assert.equal(
      classifyAutoResultAge(now - profile.softTtlMs + 1, options),
      "fresh"
    );
    assert.equal(
      classifyAutoResultAge(now - profile.softTtlMs, options),
      "stale"
    );
    assert.equal(
      classifyAutoResultAge(now - profile.hardTtlMs, options),
      "expired"
    );
  }
});

test("只接受 bilivideo.com 子域名作为目标", () => {
  assert.deepEqual(validateCdnHost("UPOS-SZ-MIRRORHW.BILIVIDEO.COM"), {
    ok: true,
    host: "upos-sz-mirrorhw.bilivideo.com"
  });
  assert.equal(validateCdnHost("evil.example").ok, false);
  assert.equal(validateCdnHost("bilivideo.com").ok, false);
  assert.equal(validateCdnHost("https://a.bilivideo.com/path").ok, false);
  assert.equal(validateCdnHost("a.bilivideo.com:443").ok, false);
});

test("媒体 URL 替换只改变 scheme 和 host", () => {
  const source =
    "http://old.bilivideo.com/upgcxcode/a/video.m4s?deadline=1&token=x";
  const output = replaceMediaHost(
    source,
    "upos-sz-mirrorcos.bilivideo.com"
  );
  assert.equal(
    output,
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a/video.m4s?deadline=1&token=x"
  );
});

test("测速使用播放器当前 Range，并限制读取大小", () => {
  assert.equal(
    makeProbeRange("bytes=4865806381-4884696416", 262144),
    "bytes=4865806381-4866068524"
  );
  assert.equal(makeProbeRange("bytes=100-120", 262144), "bytes=100-120");
  assert.equal(
    makeProbeRange("bytes=4865806381-4884696416", 1048576, 131072),
    "bytes=4865937453-4866986028"
  );
  assert.equal(makeProbeRange("not-a-range", 262144), "");
});

test("作用域识别不会覆盖非 B 站和非 bilivideo 请求", () => {
  assert.equal(
    isPlaybackUrl("https://www.bilibili.com/video/anonymous-video-a"),
    true
  );
  assert.equal(
    isPlaybackUrl("https://www.bilibili.com/bangumi/play/ep1"),
    true
  );
  assert.equal(isPlaybackUrl("https://www.bilibili.com/"), false);
  assert.equal(
    isPlaybackUrl("https://example.com/video/anonymous-video-a"),
    false
  );
  assert.equal(isBilibiliInitiator("https://www.bilibili.com/video/x"), true);
  assert.equal(isBilibiliInitiator("https://notbilibili.com/video/x"), false);
  assert.equal(
    isSupportedMediaUrl("https://foo.bilivideo.com/path/video.m4s"),
    true
  );
  assert.equal(
    isSupportedMediaUrl("https://foo.bilivideo.cn/path/video.m4s"),
    false
  );
  assert.equal(
    isSupportedMediaUrl("https://foo.bilivideo.com/not-media.json"),
    false
  );
  assert.equal(
    isCandidateMediaUrl(
      "https://upos-tf-all-hw.bilivideo.com/upgcxcode/video.m4s"
    ),
    true
  );
  assert.equal(
    isCandidateMediaUrl(
      "https://xy1x2x3x4xy.mcdn.bilivideo.com:448/upgcxcode/video.m4s?os=mcdn"
    ),
    false
  );
});

test("同一播放页的追踪参数和尾斜杠不会清空状态", () => {
  assert.equal(
    playbackPageKey(
      "https://www.bilibili.com/video/anonymous-video-a/?tracking_a=333&tracking_b=abc"
    ),
    playbackPageKey("https://www.bilibili.com/video/anonymous-video-a")
  );
  assert.equal(
    playbackPageKey(
      "https://www.bilibili.com/video/anonymous-video-a?p=2&tracking=333"
    ),
    "https://www.bilibili.com/video/anonymous-video-a?p=2"
  );
  assert.notEqual(
    playbackPageKey("https://www.bilibili.com/video/anonymous-video-a?p=1"),
    playbackPageKey("https://www.bilibili.com/video/anonymous-video-a?p=2")
  );
});

test("候选去重，并让实际观测和当前签发节点排在最前", () => {
  const list = uniqueCandidates(
    [{ host: "a.bilivideo.com", label: "A" }],
    ["b.bilivideo.com", "a.bilivideo.com"],
    "current.bilivideo.com",
    ["signed.bilivideo.com", "a.bilivideo.com"],
    ["learned.bilivideo.com"]
  );
  assert.deepEqual(
    list.map((item) => item.host),
    [
      "current.bilivideo.com",
      "signed.bilivideo.com",
      "a.bilivideo.com",
      "b.bilivideo.com",
      "learned.bilivideo.com"
    ]
  );
  assert.equal(list[0].source, "observed");
  assert.equal(list[1].source, "playurl");
  assert.equal(list.at(-1).source, "learned");
});

test("每轮测速数量封顶，并优先保留缓存最佳与当前签发节点", () => {
  const candidates = [
    { host: "seen.bilivideo.com", source: "observed" },
    { host: "signed.bilivideo.com", source: "playurl" },
    { host: "custom.bilivideo.com", source: "custom" },
    { host: "builtin1.bilivideo.com", source: "builtin" },
    { host: "builtin2.bilivideo.com", source: "builtin" },
    { host: "learned1.bilivideo.com", source: "learned" }
  ];
  const selected = chooseBenchmarkCandidates(
    candidates,
    "learned1.bilivideo.com",
    4
  );
  assert.deepEqual(
    selected.map((item) => item.host),
    [
      "learned1.bilivideo.com",
      "seen.bilivideo.com",
      "signed.bilivideo.com",
      "custom.bilivideo.com"
    ]
  );
});

test("自动选择优先吞吐量，再比较首包时间", () => {
  const best = selectBestBenchmark([
    { host: "a.bilivideo.com", ok: true, mbps: 8, ttfbMs: 90 },
    { host: "b.bilivideo.com", ok: true, mbps: 12, ttfbMs: 300 },
    { host: "c.bilivideo.com", ok: false, mbps: 100, ttfbMs: 10 }
  ]);
  assert.equal(best.host, "b.bilivideo.com");
});

test("持续复测优先于短时初筛", () => {
  const best = selectBestBenchmark([
    {
      host: "burst.bilivideo.com",
      ok: true,
      mbps: 100,
      ttfbMs: 20,
      stage: "quick"
    },
    {
      host: "steady.bilivideo.com",
      ok: true,
      mbps: 8,
      ttfbMs: 100,
      stage: "sustained"
    }
  ]);
  assert.equal(best.host, "steady.bilivideo.com");
});

test("卡顿恢复跳过当前与已失败节点", () => {
  const next = selectRecoveryBenchmark(
    [
      { host: "a.bilivideo.com", ok: true, mbps: 12, ttfbMs: 50 },
      { host: "b.bilivideo.com", ok: true, mbps: 9, ttfbMs: 80 },
      { host: "c.bilivideo.com", ok: true, mbps: 7, ttfbMs: 60 }
    ],
    "a.bilivideo.com",
    ["b.bilivideo.com"]
  );
  assert.equal(next.host, "c.bilivideo.com");
});

test("已有可用节点时，只有明显更快才自动切换", () => {
  const smallGain = chooseAutoBenchmark(
    [
      { host: "old.bilivideo.com", ok: true, mbps: 10, ttfbMs: 100 },
      { host: "new.bilivideo.com", ok: true, mbps: 11, ttfbMs: 80 }
    ],
    "old.bilivideo.com"
  );
  assert.equal(smallGain.host, "old.bilivideo.com");

  const clearGain = chooseAutoBenchmark(
    [
      { host: "old.bilivideo.com", ok: true, mbps: 10, ttfbMs: 100 },
      { host: "new.bilivideo.com", ok: true, mbps: 12, ttfbMs: 120 }
    ],
    "old.bilivideo.com"
  );
  assert.equal(clearGain.host, "new.bilivideo.com");
});

test("自动结果分为新鲜、软过期和硬过期", () => {
  const now = 10_000_000;
  const options = {
    now,
    softTtlMs: 90 * 60 * 1000,
    hardTtlMs: 2 * 60 * 60 * 1000
  };
  assert.equal(
    classifyAutoResultAge(now - 60 * 60 * 1000, options),
    "fresh"
  );
  assert.equal(
    classifyAutoResultAge(now - 100 * 60 * 1000, options),
    "stale"
  );
  assert.equal(
    classifyAutoResultAge(now - 3 * 60 * 60 * 1000, options),
    "expired"
  );
  assert.equal(classifyAutoResultAge(0, options), "expired");
});

test("自动刷新只接受可见、正在播放且缓冲安全的页面", () => {
  const active = {
    visible: true,
    playing: true,
    currentTime: 30,
    bufferedAhead: 18
  };
  assert.equal(
    isAutoRefreshActivityEligible(active, { requireSafeBuffer: true }),
    true
  );
  assert.equal(
    isAutoRefreshActivityEligible(
      { ...active, visible: false },
      { requireSafeBuffer: true }
    ),
    false
  );
  assert.equal(
    isAutoRefreshActivityEligible(
      { ...active, playing: false },
      { requireSafeBuffer: true }
    ),
    false
  );
  assert.equal(
    isAutoRefreshActivityEligible(
      { ...active, bufferedAhead: 3 },
      { requireSafeBuffer: true }
    ),
    false
  );
  assert.equal(
    isAutoRefreshActivityEligible(
      { ...active, bufferedAhead: 0 },
      { requireSafeBuffer: false }
    ),
    true
  );
});

test("会话规则同时锁定标签页、发起站点和媒体域", () => {
  const rule = buildSessionRedirectRule({
    id: 1000042,
    tabId: 42,
    targetHost: "upos-sz-mirrorhw.bilivideo.com"
  });
  assert.deepEqual(rule.condition.tabIds, [42]);
  assert.deepEqual(rule.condition.initiatorDomains, ["bilibili.com"]);
  assert.deepEqual(rule.condition.requestDomains, ["bilivideo.com"]);
  assert.deepEqual(rule.condition.resourceTypes, [
    "media",
    "xmlhttprequest",
    "other"
  ]);
  assert.equal(
    rule.action.redirect.transform.host,
    "upos-sz-mirrorhw.bilivideo.com"
  );
});
