import { BUILTIN_CANDIDATES } from "./candidates.js";
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
  normalizeCdnHosts,
  planStallRecovery,
  playbackPageKey,
  replaceMediaHost,
  retainRecentStalledHosts,
  resolveAutoRefreshProfile,
  sameMediaPath,
  selectRecoveryBenchmark,
  shouldReleaseExpiredAutoRule,
  uniqueCandidates,
  validateCdnHost
} from "./core.js";

const CONFIG_KEY = "config";
const HOST_HEALTH_KEY = "hostHealth";
const RULE_ID_OFFSET = 1_000_000;
const QUICK_SAMPLE_BYTES = 128 * 1024;
const SUSTAINED_SAMPLE_BYTES = 1024 * 1024;
const QUICK_TEST_TIMEOUT_MS = 5000;
const SUSTAINED_TEST_TIMEOUT_MS = 9000;
const SUSTAINED_FINALISTS = 3;
const BENCHMARK_SCHEMA = 3;
const MAX_EVENTS = 24;
const MAX_PLAYURL_URLS = 80;
const MAX_LEARNED_HOSTS = 24;
const MAX_BENCHMARK_HOSTS = 8;
const RECENT_STALL_HOST_LIMIT = 3;
const HOST_HEALTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_ACTIVITY_RETRY_MS = 30 * 1000;
const AUTO_FAILURE_RETRY_MS = 5 * 60 * 1000;
const tabStates = new Map();
let autoRefreshOwnerTabId = null;

function extensionVersion() {
  const manifest = chrome.runtime.getManifest();
  return manifest.version_name || manifest.version;
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: "auto",
  manualHost: BUILTIN_CANDIDATES[0].host,
  customHosts: [],
  disabledHosts: [],
  autoBestHost: "",
  autoBestAt: 0,
  autoBestSchema: 0,
  autoRefreshProfile: "balanced"
});

function stateFor(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      playback: false,
      pageUrl: "",
      pageKey: "",
      contentVersion: "",
      observedHost: "",
      sampleUrl: "",
      sampleRange: "",
      videoSampleUrl: "",
      videoSampleRange: "",
      playurlUrls: [],
      playurlVideoUrls: [],
      autoHost: "",
      benchmarkRunning: false,
      benchmarkPhase: "",
      autoAttempted: false,
      autoRefreshChecking: false,
      nextAutoRefreshCheckAt: 0,
      benchmarks: [],
      stalledHosts: [],
      recoveryCount: 0,
      lastRecovery: null,
      events: []
    });
  }
  return tabStates.get(tabId);
}

function appendEvent(tabId, event) {
  const state = stateFor(tabId);
  state.events.unshift({ at: Date.now(), ...event });
  state.events = state.events.slice(0, MAX_EVENTS);
}

async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const config = { ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] || {}) };
  return {
    ...config,
    customHosts: normalizeCdnHosts(config.customHosts),
    disabledHosts: normalizeCdnHosts(config.disabledHosts),
    autoRefreshProfile: resolveAutoRefreshProfile(
      config.autoRefreshProfile
    ).id
  };
}

async function saveConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

function freshAutoHost(config) {
  const validation = validateCdnHost(config.autoBestHost || "");
  const disabled = new Set(config.disabledHosts || []);
  const policy = resolveAutoRefreshProfile(config.autoRefreshProfile);
  return (
    validation.ok &&
    !disabled.has(validation.host) &&
    config.autoBestSchema === BENCHMARK_SCHEMA &&
    Number.isFinite(config.autoBestAt) &&
    Date.now() - config.autoBestAt < policy.hardTtlMs
  )
    ? validation.host
    : "";
}

function autoResultStatus(config) {
  const validation = validateCdnHost(config.autoBestHost || "");
  const disabled = new Set(config.disabledHosts || []);
  if (
    !validation.ok ||
    disabled.has(validation.host) ||
    config.autoBestSchema !== BENCHMARK_SCHEMA
  ) {
    return "expired";
  }
  const policy = resolveAutoRefreshProfile(config.autoRefreshProfile);
  return classifyAutoResultAge(config.autoBestAt, {
    softTtlMs: policy.softTtlMs,
    hardTtlMs: policy.hardTtlMs
  });
}

function sanitizeHealth(raw) {
  const now = Date.now();
  const entries = Object.entries(raw && typeof raw === "object" ? raw : {})
    .filter(([host, item]) => {
      const validation = validateCdnHost(host);
      return (
        validation.ok &&
        item &&
        typeof item === "object" &&
        Number.isFinite(item.lastSeenAt) &&
        now - item.lastSeenAt < HOST_HEALTH_TTL_MS
      );
    })
    .sort((a, b) => {
      const aItem = a[1];
      const bItem = b[1];
      const aHealthy = (aItem.successes || 0) > 0;
      const bHealthy = (bItem.successes || 0) > 0;
      if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;
      return (bItem.lastSeenAt || 0) - (aItem.lastSeenAt || 0);
    })
    .slice(0, MAX_LEARNED_HOSTS);
  return Object.fromEntries(entries);
}

async function getHostHealth() {
  const stored = await chrome.storage.local.get(HOST_HEALTH_KEY);
  return sanitizeHealth(stored[HOST_HEALTH_KEY]);
}

async function rememberHosts(hosts) {
  if (!Array.isArray(hosts) || !hosts.length) return;
  const health = await getHostHealth();
  const now = Date.now();
  for (const rawHost of hosts) {
    const validation = validateCdnHost(rawHost);
    if (!validation.ok) continue;
    health[validation.host] = {
      successes: 0,
      failures: 0,
      ...(health[validation.host] || {}),
      lastSeenAt: now
    };
  }
  await chrome.storage.local.set({
    [HOST_HEALTH_KEY]: sanitizeHealth(health)
  });
}

async function saveBenchmarkHealth(results) {
  const health = await getHostHealth();
  const now = Date.now();
  for (const result of results) {
    const validation = validateCdnHost(result?.host || "");
    if (!validation.ok) continue;
    const old = health[validation.host] || {
      successes: 0,
      failures: 0
    };
    const next = {
      ...old,
      lastSeenAt: now,
      lastTestedAt: now
    };
    if (result.ok) {
      next.successes = (old.successes || 0) + 1;
      next.mbps = Number.isFinite(old.mbps)
        ? Number((old.mbps * 0.6 + result.mbps * 0.4).toFixed(2))
        : result.mbps;
      next.ttfbMs = Number.isFinite(old.ttfbMs)
        ? Math.round(old.ttfbMs * 0.6 + result.ttfbMs * 0.4)
        : result.ttfbMs;
      next.lastStage = result.stage || "sustained";
    } else {
      next.failures = (old.failures || 0) + 1;
    }
    health[validation.host] = next;
  }
  await chrome.storage.local.set({
    [HOST_HEALTH_KEY]: sanitizeHealth(health)
  });
}

async function rememberPlaybackFailure(host) {
  const validation = validateCdnHost(host || "");
  if (!validation.ok) return;
  const health = await getHostHealth();
  const old = health[validation.host] || {
    successes: 0,
    failures: 0
  };
  health[validation.host] = {
    ...old,
    failures: (old.failures || 0) + 1,
    playbackFailures: (old.playbackFailures || 0) + 1,
    lastFailureAt: Date.now(),
    lastSeenAt: Date.now()
  };
  await chrome.storage.local.set({
    [HOST_HEALTH_KEY]: sanitizeHealth(health)
  });
}

function learnedCandidates(health) {
  return Object.entries(health)
    .filter(([, item]) => {
      const successes = item.successes || 0;
      const failures = item.failures || 0;
      return successes > 0 || failures < 3;
    })
    .sort((a, b) => {
      const aItem = a[1];
      const bItem = b[1];
      const aRatio =
        (aItem.successes || 0) /
        Math.max((aItem.successes || 0) + (aItem.failures || 0), 1);
      const bRatio =
        (bItem.successes || 0) /
        Math.max((bItem.successes || 0) + (bItem.failures || 0), 1);
      return (
        bRatio - aRatio ||
        (bItem.mbps || 0) - (aItem.mbps || 0) ||
        (bItem.lastSeenAt || 0) - (aItem.lastSeenAt || 0)
      );
    })
    .map(([host, item]) => ({
      host,
      label: host,
      note: Number.isFinite(item.mbps)
        ? `近期成功，约 ${item.mbps} Mbps；真实卡顿 ${item.playbackFailures || 0} 次`
        : "近期播放中出现"
    }));
}

function playurlHosts(state) {
  return [
    ...new Set(
      state.playurlUrls
        .filter(isCandidateMediaUrl)
        .map((value) => new URL(value).hostname)
    )
  ];
}

async function candidatesFor(config, state) {
  const health = await getHostHealth();
  const observedCandidate =
    state.sampleUrl && isCandidateMediaUrl(state.sampleUrl)
      ? state.observedHost
      : "";
  return uniqueCandidates(
    BUILTIN_CANDIDATES,
    config.customHosts,
    observedCandidate,
    playurlHosts(state),
    learnedCandidates(health),
    config.disabledHosts
  );
}

function ruleIdForTab(tabId) {
  const id = RULE_ID_OFFSET + tabId;
  if (id > 2_147_483_647) throw new RangeError("标签页 ID 超出规则范围");
  return id;
}

async function removeRule(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleIdForTab(tabId)]
  });
  try {
    await setBadge(tabId, false);
  } catch {
    // The tab may already have been closed.
  }
}

async function setBadge(tabId, enabled, mode = "") {
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: enabled ? "#00a1d6" : "#777777"
  });
  await chrome.action.setBadgeText({
    tabId,
    text: enabled ? (mode === "auto" ? "A" : "ON") : ""
  });
}

async function applyRule(tabId) {
  const config = await getConfig();
  const state = stateFor(tabId);
  const targetHost =
    config.mode === "auto" ? state.autoHost : config.manualHost;
  const validation = validateCdnHost(targetHost || "");
  const disabled = new Set(config.disabledHosts || []);
  const shouldEnable =
    config.enabled &&
    state.playback &&
    isPlaybackUrl(state.pageUrl) &&
    validation.ok &&
    !disabled.has(validation.host);

  if (!shouldEnable) {
    await removeRule(tabId);
    return "";
  }

  const id = ruleIdForTab(tabId);
  const rule = buildSessionRedirectRule({
    id,
    tabId,
    targetHost: validation.host
  });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [rule]
  });
  await setBadge(tabId, true, config.mode);
  return validation.host;
}

async function applyToKnownPlaybackTabs() {
  const config = await getConfig();
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.bilibili.com/video/*",
      "https://www.bilibili.com/bangumi/play/*",
      "https://www.bilibili.com/cheese/play/*",
      "https://m.bilibili.com/video/*",
      "https://m.bilibili.com/bangumi/play/*"
    ]
  });
  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map(async (tab) => {
        const state = stateFor(tab.id);
        state.playback = true;
        state.pageUrl = tab.url || "";
        state.pageKey = playbackPageKey(state.pageUrl);
        const cachedHost = freshAutoHost(config);
        if (config.mode === "auto" && cachedHost) {
          state.autoHost = cachedHost;
        }
        await applyRule(tab.id);
        await pushDiagnostics(tab.id);
      })
  );
}

function updatePageState(tabId, pageUrl) {
  const state = stateFor(tabId);
  const normalizedUrl = pageUrl || "";
  const nextPageKey = playbackPageKey(normalizedUrl);
  const changed = Boolean(state.pageKey && state.pageKey !== nextPageKey);
  state.pageUrl = normalizedUrl;
  state.pageKey = nextPageKey;
  state.playback = isPlaybackUrl(normalizedUrl);

  if (changed) {
    state.observedHost = "";
    state.sampleUrl = "";
    state.sampleRange = "";
    state.videoSampleUrl = "";
    state.videoSampleRange = "";
    state.playurlUrls = [];
    state.playurlVideoUrls = [];
    state.autoHost = "";
    state.autoAttempted = false;
    state.autoRefreshChecking = false;
    state.nextAutoRefreshCheckAt = 0;
    state.benchmarkPhase = "";
    state.benchmarks = [];
    state.stalledHosts = [];
    state.recoveryCount = 0;
    state.lastRecovery = null;
    state.events = [];
  }
  return state;
}

function observePlayurlUrls(tabId, values, videoValues = []) {
  if (tabId < 0 || !Array.isArray(values)) return [];
  const state = stateFor(tabId);
  const urls = values
    .filter((value) => typeof value === "string" && isSupportedMediaUrl(value))
    .map((value) => new URL(value).href);
  if (!urls.length) return [];

  state.playurlUrls = [
    ...new Set([...urls, ...state.playurlUrls])
  ].slice(0, MAX_PLAYURL_URLS);
  const videoUrls = (Array.isArray(videoValues) ? videoValues : [])
    .filter((value) => typeof value === "string" && isSupportedMediaUrl(value))
    .map((value) => new URL(value).href);
  state.playurlVideoUrls = [
    ...new Set([...videoUrls, ...state.playurlVideoUrls])
  ].slice(0, MAX_PLAYURL_URLS);
  if (
    !state.videoSampleUrl &&
    state.sampleUrl &&
    state.playurlVideoUrls.some((value) =>
      sameMediaPath(value, state.sampleUrl)
    )
  ) {
    state.videoSampleUrl = state.sampleUrl;
    state.videoSampleRange = state.sampleRange;
  }
  const hosts = playurlHosts(state);
  appendEvent(tabId, {
    kind: "playurl",
    count: urls.length,
    hosts: hosts.length
  });
  void rememberHosts(hosts);
  return hosts;
}

function observeMedia(tabId, value, source = "request", rangeHeader = "") {
  if (tabId < 0 || !isSupportedMediaUrl(value)) return;
  const state = stateFor(tabId);
  const url = new URL(value);
  state.observedHost = url.hostname;
  const isVideoSample = state.playurlVideoUrls.some((candidate) =>
    sameMediaPath(candidate, url.href)
  );
  if (
    isVideoSample ||
    !state.sampleUrl ||
    (!state.videoSampleUrl && /\.(m4s|mp4)(?:$|\?)/i.test(url.href))
  ) {
    state.sampleUrl = url.href;
  }
  const probeRange = makeProbeRange(rangeHeader, QUICK_SAMPLE_BYTES);
  if (probeRange && (isVideoSample || !state.videoSampleUrl)) {
    state.sampleRange = rangeHeader.trim();
  }
  if (isVideoSample) {
    state.videoSampleUrl = url.href;
    if (probeRange) state.videoSampleRange = rangeHeader.trim();
  }
  appendEvent(tabId, {
    kind: source,
    host: url.hostname,
    range: probeRange || ""
  });
  const activeSampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  if (activeSampleRange) void maybeRunAuto(tabId);
}

function benchmarkSpec(
  state,
  candidate,
  {
    maxBytes = QUICK_SAMPLE_BYTES,
    offsetBytes = 0,
    timeoutMs = QUICK_TEST_TIMEOUT_MS,
    stage = "quick"
  } = {}
) {
  const sampleUrl = state.videoSampleUrl || state.sampleUrl;
  const sampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  const sample = new URL(sampleUrl);
  const directPool = state.videoSampleUrl
    ? state.playurlVideoUrls
    : state.playurlUrls;
  const directUrls = directPool.filter(
    (value) =>
      isSupportedMediaUrl(value) &&
      new URL(value).hostname === candidate.host
  );
  const exact = directUrls.find(
    (value) => new URL(value).pathname === sample.pathname
  );
  const directUrl =
    exact || (state.videoSampleUrl ? "" : directUrls[0] || "");
  const baseRange =
    exact || !directUrl
      ? sampleRange || "bytes=0-"
      : "bytes=0-";
  return {
    host: candidate.host,
    url: directUrl || replaceMediaHost(sampleUrl, candidate.host),
    range:
      makeProbeRange(baseRange, maxBytes, offsetBytes) ||
      makeProbeRange("bytes=0-", maxBytes),
    direct: Boolean(directUrl),
    maxBytes,
    timeoutMs,
    stage
  };
}

async function testCandidate(spec) {
  const { host, url: testUrl, range: sampleRange } = spec;
  const maxBytes = Math.min(
    Math.max(Number(spec.maxBytes) || QUICK_SAMPLE_BYTES, 1),
    SUSTAINED_SAMPLE_BYTES
  );
  const timeoutMs = Math.min(
    Math.max(Number(spec.timeoutMs) || QUICK_TEST_TIMEOUT_MS, 1000),
    SUSTAINED_TEST_TIMEOUT_MS
  );
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(testUrl, {
      method: "GET",
      headers: { Range: sampleRange || `bytes=0-${maxBytes - 1}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
    const ttfbMs = performance.now() - startedAt;
    if (!response.ok) {
      return {
        host,
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        ttfbMs: Math.round(ttfbMs)
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (/text\/html|application\/json/i.test(contentType)) {
      return {
        host,
        ok: false,
        status: response.status,
        error: "返回内容不是媒体",
        ttfbMs: Math.round(ttfbMs),
        stage: spec.stage
      };
    }

    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader) {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
      }
      await reader.cancel();
    } else {
      const buffer = await response.arrayBuffer();
      bytes = Math.min(buffer.byteLength, maxBytes);
    }

    const durationMs = Math.max(performance.now() - startedAt, 1);
    return {
      host,
      ok: bytes > 0,
      status: response.status,
      bytes,
      ttfbMs: Math.round(ttfbMs),
      durationMs: Math.round(durationMs),
      mbps: Number(((bytes * 8) / durationMs / 1000).toFixed(2)),
      redirected: response.redirected,
      finalHost: new URL(response.url).hostname,
      source: spec.direct ? "playurl" : "host-swap",
      stage: spec.stage,
      rangeAccepted: response.status === 206,
      contentType
    };
  } catch (error) {
    return {
      host,
      ok: false,
      status: response?.status || 0,
      error:
        error?.name === "AbortError" ? "超时" : error?.message || "测速失败",
      ttfbMs: Math.round(performance.now() - startedAt),
      stage: spec.stage
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await task(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function testCandidatesInPage(tabId, specs, concurrency = 2) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "RUN_PAGE_BENCHMARK",
    specs,
    concurrency
  });
  if (!response?.ok || !Array.isArray(response.results)) {
    throw new Error(response?.error || "页面测速没有返回结果");
  }
  return response.results;
}

async function refreshPlayurlUrlsFromPage(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_PLAYURL_URLS"
    });
    if (response?.ok && Array.isArray(response.urls)) {
      observePlayurlUrls(tabId, response.urls, response.videoUrls);
    }
  } catch {
    // The page observer is optional; webRequest discovery remains available.
  }
}

async function runBenchmark(
  tabId,
  requestedHosts = null,
  { preserveStalledHosts = false } = {}
) {
  const state = stateFor(tabId);
  const sampleUrl = state.videoSampleUrl || state.sampleUrl;
  const sampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  if (!sampleUrl || !sampleRange) {
    throw new Error("还没有捕获到媒体 URL。请先播放几秒视频，再测速。");
  }
  if (state.benchmarkRunning) {
    throw new Error("测速正在进行中");
  }
  if (!state.playurlUrls.length) {
    await refreshPlayurlUrlsFromPage(tabId);
  }

  const config = await getConfig();
  const allCandidates = await candidatesFor(config, state);
  const requested = Array.isArray(requestedHosts)
    ? new Set(requestedHosts)
    : null;
  const eligible = requested
    ? allCandidates.filter(
        (item) => !item.disabled && requested.has(item.host)
      )
    : allCandidates.filter((item) => !item.disabled);
  const candidates = chooseBenchmarkCandidates(
    eligible,
    config.autoBestHost,
    MAX_BENCHMARK_HOSTS
  );
  if (!candidates.length) throw new Error("没有可测速的候选 CDN");
  const quickSpecs = candidates.map((candidate) =>
    benchmarkSpec(state, candidate, {
      maxBytes: QUICK_SAMPLE_BYTES,
      timeoutMs: QUICK_TEST_TIMEOUT_MS,
      stage: "quick"
    })
  );

  state.benchmarkRunning = true;
  state.benchmarkPhase = "quick";
  state.stalledHosts = preserveStalledHosts
    ? retainRecentStalledHosts(
        state.stalledHosts,
        RECENT_STALL_HOST_LIMIT
      )
    : [];
  appendEvent(tabId, { kind: "benchmark-start", count: candidates.length });
  await removeRule(tabId);
  await pushDiagnostics(tabId);
  try {
    const runSpecs = async (specs, concurrency) => {
      try {
        return await testCandidatesInPage(tabId, specs, concurrency);
      } catch (pageError) {
        appendEvent(tabId, {
          kind: "page-benchmark-error",
          message: pageError?.message || "页面测速失败"
        });
        return mapWithConcurrency(specs, concurrency, (spec) =>
          testCandidate(spec)
        );
      }
    };

    const quickResults = await runSpecs(quickSpecs, 2);
    const finalists = quickResults
      .filter(
        (item) =>
          item?.ok &&
          Number.isFinite(item.mbps) &&
          item.mbps > 0
      )
      .sort(
        (a, b) =>
          b.mbps - a.mbps ||
          (a.ttfbMs || Number.MAX_SAFE_INTEGER) -
            (b.ttfbMs || Number.MAX_SAFE_INTEGER)
      )
      .slice(0, SUSTAINED_FINALISTS);

    state.benchmarkPhase = "sustained";
    await pushDiagnostics(tabId);
    const candidateByHost = new Map(
      candidates.map((candidate) => [candidate.host, candidate])
    );
    const sustainedSpecs = finalists.map((result) =>
      benchmarkSpec(state, candidateByHost.get(result.host), {
        maxBytes: SUSTAINED_SAMPLE_BYTES,
        offsetBytes: QUICK_SAMPLE_BYTES,
        timeoutMs: SUSTAINED_TEST_TIMEOUT_MS,
        stage: "sustained"
      })
    );
    const sustainedResults = sustainedSpecs.length
      ? await runSpecs(sustainedSpecs, 1)
      : [];

    const resultsByHost = new Map(
      quickResults.map((item) => [
        item.host,
        { ...item, stage: "quick" }
      ])
    );
    for (const item of sustainedResults) {
      const quick = resultsByHost.get(item.host);
      resultsByHost.set(item.host, {
        ...item,
        stage: "sustained",
        burstMbps: quick?.mbps || 0,
        burstTtfbMs: quick?.ttfbMs
      });
    }
    const results = [...resultsByHost.values()];
    const previous = new Map(state.benchmarks.map((item) => [item.host, item]));
    results.forEach((item) => previous.set(item.host, item));
    state.benchmarks = [...previous.values()];
    await saveBenchmarkHealth(results);

    let best = preserveStalledHosts
      ? selectRecoveryBenchmark(results, "", state.stalledHosts)
      : chooseAutoBenchmark(results, config.autoBestHost);
    if (!best && preserveStalledHosts) {
      state.stalledHosts = [];
      best = chooseAutoBenchmark(results, config.autoBestHost);
    }
    const freshConfig = await getConfig();
    const disabled = new Set(freshConfig.disabledHosts || []);
    if (best && disabled.has(best.host)) best = null;
    if (
      freshConfig.enabled &&
      freshConfig.mode === "auto" &&
      best
    ) {
      state.autoHost = best.host;
      await saveConfig({
        autoBestHost: best.host,
        autoBestAt: Date.now(),
        autoBestSchema: BENCHMARK_SCHEMA
      });
      await applyRule(tabId);
    } else if (freshConfig.enabled && freshConfig.mode === "manual") {
      await applyRule(tabId);
    }
    appendEvent(tabId, {
      kind: "benchmark-done",
      host: best?.host || "",
      mbps: best?.mbps || 0,
      sustained: best?.stage !== "quick"
    });
    return { results, best };
  } finally {
    state.benchmarkRunning = false;
    state.benchmarkPhase = "";
    await pushDiagnostics(tabId);
  }
}

async function maybeRunAuto(tabId) {
  const state = stateFor(tabId);
  const sampleUrl = state.videoSampleUrl || state.sampleUrl;
  const sampleRange = state.videoSampleUrl
    ? state.videoSampleRange
    : state.sampleRange;
  if (
    state.benchmarkRunning ||
    !sampleUrl ||
    !sampleRange
  ) {
    return;
  }
  const config = await getConfig();
  if (!config.enabled || config.mode !== "auto" || !state.playback) return;
  const cachedHost = freshAutoHost(config);
  const resultStatus = autoResultStatus(config);
  if (
    shouldReleaseExpiredAutoRule(
      resultStatus,
      cachedHost,
      state.autoHost
    )
  ) {
    const expiredHost = state.autoHost;
    state.autoHost = "";
    state.autoAttempted = false;
    await removeRule(tabId);
    appendEvent(tabId, {
      kind: "expired-rule-released",
      host: expiredHost
    });
    await pushDiagnostics(tabId);
  }
  if (cachedHost && resultStatus === "fresh") {
    if (state.autoAttempted && state.autoHost === cachedHost) return;
    state.autoAttempted = true;
    state.autoHost = cachedHost;
    appendEvent(tabId, {
      kind: "benchmark-cache",
      host: cachedHost
    });
    await applyRule(tabId);
    await pushDiagnostics(tabId);
    return;
  }

  if (cachedHost && state.autoHost !== cachedHost) {
    state.autoHost = cachedHost;
    await applyRule(tabId);
  }

  const now = Date.now();
  if (
    state.autoRefreshChecking ||
    now < state.nextAutoRefreshCheckAt ||
    (
      autoRefreshOwnerTabId !== null &&
      autoRefreshOwnerTabId !== tabId
    )
  ) {
    return;
  }

  state.autoRefreshChecking = true;
  state.nextAutoRefreshCheckAt = now + AUTO_ACTIVITY_RETRY_MS;
  autoRefreshOwnerTabId = tabId;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_PLAYBACK_ACTIVITY"
    });
    const activity = response?.ok ? response.activity : null;
    const requireSafeBuffer = Boolean(state.autoHost);
    if (
      !isAutoRefreshActivityEligible(activity, {
        requireSafeBuffer
      })
    ) {
      appendEvent(tabId, {
        kind: "benchmark-deferred",
        reason: activity?.visible
          ? activity?.playing
            ? "buffer"
            : "paused"
          : "hidden"
      });
      return;
    }
    state.autoAttempted = true;
    await runBenchmark(tabId);
  } catch (error) {
    state.nextAutoRefreshCheckAt = Date.now() + AUTO_FAILURE_RETRY_MS;
    appendEvent(tabId, {
      kind: "error",
      message: error?.message || "自动测速失败"
    });
  } finally {
    state.autoRefreshChecking = false;
    if (autoRefreshOwnerTabId === tabId) autoRefreshOwnerTabId = null;
  }
}

async function recoverFromPlaybackStall(tabId, details = {}) {
  const config = await getConfig();
  const state = stateFor(tabId);
  if (
    !config.enabled ||
    config.mode !== "auto" ||
    !state.playback ||
    state.benchmarkRunning
  ) {
    return { switched: false, reason: "inactive" };
  }

  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const activeRule = rules.find((rule) => rule.id === ruleIdForTab(tabId));
  const currentHost =
    activeRule?.action?.redirect?.transform?.host ||
    state.autoHost ||
    "";
  if (!currentHost) {
    return { switched: false, reason: "no-active-host" };
  }

  state.stalledHosts = retainRecentStalledHosts(
    [...state.stalledHosts, currentHost],
    MAX_BENCHMARK_HOSTS
  );
  await rememberPlaybackFailure(currentHost);
  await saveConfig({
    autoBestHost: "",
    autoBestAt: 0,
    autoBestSchema: BENCHMARK_SCHEMA
  });

  const disabled = new Set(config.disabledHosts || []);
  const recoveryPlan = planStallRecovery(
    state.benchmarks.filter((item) => !disabled.has(item.host)),
    currentHost,
    state.stalledHosts
  );
  const next = recoveryPlan.candidate;
  if (recoveryPlan.kind === "origin") {
    const fallbackAt = Date.now();
    state.autoHost = "";
    state.autoAttempted = false;
    state.nextAutoRefreshCheckAt = 0;
    await removeRule(tabId);
    state.recoveryCount += 1;
    state.lastRecovery = {
      at: fallbackAt,
      fromHost: currentHost,
      host: "",
      fallback: "origin"
    };
    appendEvent(tabId, {
      kind: "stall-fallback",
      host: currentHost,
      atSecond: Number(details.currentTime) || 0
    });
    await pushDiagnostics(tabId);
    return {
      switched: true,
      fallback: "origin",
      retryBenchmark: recoveryPlan.retryBenchmark,
      fromHost: currentHost,
      host: "",
      recoveryCount: state.recoveryCount
    };
  }

  state.autoHost = next.host;
  const switchedAt = Date.now();
  await saveConfig({
    autoBestHost: next.host,
    autoBestAt: switchedAt,
    autoBestSchema: BENCHMARK_SCHEMA
  });
  await applyRule(tabId);
  state.recoveryCount += 1;
  state.lastRecovery = {
    at: switchedAt,
    fromHost: currentHost,
    host: next.host,
    mbps: next.mbps,
    stage: next.stage || "sustained"
  };
  appendEvent(tabId, {
    kind: "stall-switch",
    fromHost: currentHost,
    host: next.host,
    mbps: next.mbps
  });
  await pushDiagnostics(tabId);
  return {
    switched: true,
    fromHost: currentHost,
    host: next.host,
    recoveryCount: state.recoveryCount
  };
}

async function publicState(tabId, pageUrl = "") {
  const config = await getConfig();
  const autoRefreshPolicy = resolveAutoRefreshProfile(
    config.autoRefreshProfile
  );
  const state = pageUrl ? updatePageState(tabId, pageUrl) : stateFor(tabId);
  if (state.playback && !state.playurlUrls.length) {
    await refreshPlayurlUrlsFromPage(tabId);
  }
  const targetHost =
    config.mode === "auto" ? state.autoHost : config.manualHost;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const activeRule = rules.find((rule) => rule.id === ruleIdForTab(tabId));
  const ruleActive = Boolean(activeRule);
  const ruleHost =
    activeRule?.action?.redirect?.transform?.host || targetHost || "";
  const candidates = await candidatesFor(config, state);
  return {
    version: extensionVersion(),
    contentVersion: state.contentVersion,
    applicable: state.playback && isPlaybackUrl(state.pageUrl),
    config,
    observedHost: state.observedHost,
    activeHost: ruleActive ? ruleHost : "",
    ruleActive,
    benchmarkRunning: state.benchmarkRunning,
    benchmarkPhase: state.benchmarkPhase,
    benchmarks: state.benchmarks,
    benchmarkLimit: MAX_BENCHMARK_HOSTS,
    quickSampleBytes: QUICK_SAMPLE_BYTES,
    sustainedSampleBytes: SUSTAINED_SAMPLE_BYTES,
    sustainedFinalists: SUSTAINED_FINALISTS,
    autoRefreshSoftMs: autoRefreshPolicy.softTtlMs,
    autoResultTtlMs: autoRefreshPolicy.hardTtlMs,
    autoRefreshProfiles: Object.values(AUTO_REFRESH_PROFILES),
    autoResultStatus: autoResultStatus(config),
    sampleKind: state.videoSampleUrl ? "video" : "media",
    discoveredCount: playurlHosts(state).length,
    candidates,
    recoveryCount: state.recoveryCount,
    lastRecovery: state.lastRecovery,
    stalledHosts: state.stalledHosts,
    events: state.events
  };
}

async function diagnosticState(tabId) {
  const config = await getConfig();
  const state = stateFor(tabId);
  const health = await getHostHealth();
  const targetHost =
    config.mode === "auto" ? state.autoHost : config.manualHost;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const activeRule = rules.find((rule) => rule.id === ruleIdForTab(tabId));
  const ruleActive = Boolean(activeRule);
  const ruleHost =
    activeRule?.action?.redirect?.transform?.host || targetHost || "";
  return {
    version: extensionVersion(),
    enabled: config.enabled,
    mode: config.mode,
    ruleActive,
    activeHost: ruleActive ? ruleHost : "",
    observedHost: state.observedHost,
    benchmarkRunning: state.benchmarkRunning,
    benchmarkPhase: state.benchmarkPhase,
    benchmarkCount: state.benchmarks.length,
    successfulBenchmarks: state.benchmarks.filter((item) => item.ok).length,
    discoveredCount: playurlHosts(state).length,
    learnedCount: learnedCandidates(health).length,
    recoveryCount: state.recoveryCount,
    autoResultStatus: autoResultStatus(config),
    autoRefreshProfile: config.autoRefreshProfile
  };
}

async function pushDiagnostics(tabId) {
  try {
    const status = await diagnosticState(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "DIAGNOSTIC_STATUS",
      status
    });
  } catch {
    // The content script may not be ready, or the tab may have closed.
  }
}

async function handleMessage(message, sender) {
  const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;

  if (message.type === "READY" || message.type === "NAVIGATION") {
    if (!Number.isInteger(tabId)) return { ok: false };
    const state = updatePageState(
      tabId,
      message.url || sender.tab?.url || ""
    );
    state.contentVersion = message.extensionVersion || "";
    const config = await getConfig();
    const cachedHost = freshAutoHost(config);
    if (config.mode === "auto" && cachedHost) {
      state.autoHost = cachedHost;
    }
    if (!state.playback) {
      await removeRule(tabId);
    } else {
      await applyRule(tabId);
      await maybeRunAuto(tabId);
    }
    await pushDiagnostics(tabId);
    return { ok: true };
  }

  if (message.type === "MEDIA_SEEN") {
    if (Number.isInteger(tabId)) {
      updatePageState(tabId, sender.tab?.url || "");
      observeMedia(tabId, message.url, "performance");
    }
    return { ok: true };
  }

  if (message.type === "PLAYURL_URLS") {
    if (!Number.isInteger(tabId)) return { ok: false };
    const state = updatePageState(tabId, sender.tab?.url || "");
    if (!state.playback) return { ok: false };
    const hosts = observePlayurlUrls(
      tabId,
      message.urls,
      message.videoUrls
    );
    await pushDiagnostics(tabId);
    return { ok: true, hosts: hosts.length };
  }

  if (!Number.isInteger(tabId)) throw new Error("找不到当前标签页");

  switch (message.type) {
    case "GET_DIAGNOSTICS":
      if (sender.tab?.url) updatePageState(tabId, sender.tab.url);
      return diagnosticState(tabId);
    case "GET_STATE":
      return publicState(tabId, message.pageUrl);
    case "SET_ENABLED":
      await saveConfig({ enabled: Boolean(message.enabled) });
      await applyToKnownPlaybackTabs();
      await maybeRunAuto(tabId);
      return publicState(tabId);
    case "SET_MODE":
      if (!["auto", "manual"].includes(message.mode)) {
        throw new Error("模式无效");
      }
      await saveConfig({ mode: message.mode });
      if (message.mode === "auto") {
        const state = stateFor(tabId);
        const config = await getConfig();
        state.autoAttempted = false;
        state.stalledHosts = [];
        const cachedHost = freshAutoHost(config);
        if (cachedHost) {
          state.autoHost = cachedHost;
        }
        await maybeRunAuto(tabId);
      }
      await applyToKnownPlaybackTabs();
      return publicState(tabId);
    case "SET_AUTO_REFRESH_PROFILE": {
      const policy = resolveAutoRefreshProfile(message.profile);
      if (policy.id !== message.profile) {
        throw new Error("自动复测频率无效");
      }
      await saveConfig({ autoRefreshProfile: policy.id });
      const state = stateFor(tabId);
      state.autoAttempted = false;
      state.nextAutoRefreshCheckAt = 0;
      await maybeRunAuto(tabId);
      await pushDiagnostics(tabId);
      return publicState(tabId);
    }
    case "SET_TARGET": {
      const validation = validateCdnHost(message.host);
      if (!validation.ok) throw new Error(validation.error);
      const config = await getConfig();
      if (config.disabledHosts.includes(validation.host)) {
        throw new Error("这个节点已禁用，请先重新启用");
      }
      await saveConfig({ manualHost: validation.host, mode: "manual" });
      await applyToKnownPlaybackTabs();
      return publicState(tabId);
    }
    case "RUN_BENCHMARK":
      await runBenchmark(tabId, message.hosts || null, {
        preserveStalledHosts: Boolean(message.preserveStalledHosts)
      });
      return publicState(tabId);
    case "PLAYBACK_STALL":
      return recoverFromPlaybackStall(tabId, message);
    case "ADD_CUSTOM_HOST": {
      const validation = validateCdnHost(message.host);
      if (!validation.ok) throw new Error(validation.error);
      const config = await getConfig();
      const customHosts = [...new Set([...config.customHosts, validation.host])];
      await saveConfig({ customHosts });
      return publicState(tabId);
    }
    case "SET_HOST_DISABLED": {
      const validation = validateCdnHost(message.host);
      if (!validation.ok) throw new Error(validation.error);
      const disabled = Boolean(message.disabled);
      const config = await getConfig();
      const disabledHosts = new Set(config.disabledHosts);
      if (disabled) {
        disabledHosts.add(validation.host);
      } else {
        disabledHosts.delete(validation.host);
      }
      const patch = {
        disabledHosts: [...disabledHosts]
      };
      if (disabled && config.autoBestHost === validation.host) {
        patch.autoBestHost = "";
        patch.autoBestAt = 0;
        patch.autoBestSchema = BENCHMARK_SCHEMA;
      }
      await saveConfig(patch);
      if (disabled) {
        for (const state of tabStates.values()) {
          if (state.autoHost !== validation.host) continue;
          state.autoHost = "";
          state.autoAttempted = false;
          state.nextAutoRefreshCheckAt = 0;
        }
      }
      await applyToKnownPlaybackTabs();
      if (disabled) await maybeRunAuto(tabId);
      return publicState(tabId);
    }
    default:
      throw new Error("未知操作");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void getConfig().then((config) =>
    chrome.storage.local.set({ [CONFIG_KEY]: config })
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({ ok: false, error: error?.message || "操作失败" })
    );
  return true;
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (!isBilibiliInitiator(initiator)) return;
    if (!stateFor(details.tabId).playback && details.documentUrl) {
      updatePageState(details.tabId, details.documentUrl);
    }
    if (stateFor(details.tabId).benchmarkRunning) return;
    observeMedia(details.tabId, details.url, "request");
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (!isBilibiliInitiator(initiator)) return;
    if (!stateFor(details.tabId).playback && details.documentUrl) {
      updatePageState(details.tabId, details.documentUrl);
    }
    if (stateFor(details.tabId).benchmarkRunning) return;
    const rangeHeader = details.requestHeaders?.find(
      (header) => header.name.toLowerCase() === "range"
    )?.value;
    if (rangeHeader) {
      observeMedia(details.tabId, details.url, "range", rangeHeader);
    }
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  },
  ["requestHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (details.tabId < 0 || !isBilibiliInitiator(initiator)) return;
    appendEvent(details.tabId, {
      kind: "completed",
      host: new URL(details.url).hostname,
      status: details.statusCode,
      fromCache: Boolean(details.fromCache)
    });
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const initiator = details.initiator || details.documentUrl || "";
    if (details.tabId < 0 || !isBilibiliInitiator(initiator)) return;
    appendEvent(details.tabId, {
      kind: "request-error",
      host: new URL(details.url).hostname,
      message: details.error
    });
  },
  {
    urls: ["*://*.bilivideo.com/*"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;
  const state = updatePageState(tabId, url);
  if (!state.playback) void removeRule(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  void chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleIdForTab(tabId)]
  });
});
