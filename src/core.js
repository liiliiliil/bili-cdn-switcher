const BILIVIDEO_SUFFIX = ".bilivideo.com";
const BILIBILI_SUFFIX = ".bilibili.com";

export const AUTO_REFRESH_PROFILES = Object.freeze({
  frequent: Object.freeze({
    id: "frequent",
    softTtlMs: 30 * 60 * 1000,
    hardTtlMs: 60 * 60 * 1000
  }),
  balanced: Object.freeze({
    id: "balanced",
    softTtlMs: 90 * 60 * 1000,
    hardTtlMs: 2 * 60 * 60 * 1000
  }),
  economy: Object.freeze({
    id: "economy",
    softTtlMs: 6 * 60 * 60 * 1000,
    hardTtlMs: 12 * 60 * 60 * 1000
  })
});

export function resolveAutoRefreshProfile(value) {
  return (
    (typeof value === "string" &&
      Object.prototype.hasOwnProperty.call(AUTO_REFRESH_PROFILES, value) &&
      AUTO_REFRESH_PROFILES[value]) ||
    AUTO_REFRESH_PROFILES.balanced
  );
}

export function validateCdnHost(value) {
  if (typeof value !== "string") {
    return { ok: false, error: "CDN host 必须是文本" };
  }

  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) {
    return { ok: false, error: "CDN host 长度无效" };
  }
  if (host.includes("/") || host.includes(":") || host.includes("@")) {
    return { ok: false, error: "只填写 host，不要包含协议、端口或路径" };
  }
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) {
    return { ok: false, error: "CDN host 格式无效" };
  }
  if (!host.endsWith(BILIVIDEO_SUFFIX)) {
    return { ok: false, error: "为安全起见，只允许 bilivideo.com 子域名" };
  }
  return { ok: true, host };
}

export function isBilibiliHost(value) {
  try {
    const host = value.includes("://") ? new URL(value).hostname : value;
    return host === "bilibili.com" || host.endsWith(BILIBILI_SUFFIX);
  } catch {
    return false;
  }
}

export function isBilibiliInitiator(value) {
  if (!value || value === "null") return false;
  return isBilibiliHost(value);
}

export function isPlaybackUrl(value) {
  try {
    const url = new URL(value);
    if (!isBilibiliHost(url.hostname)) return false;
    return /^\/(video\/|bangumi\/play\/|cheese\/play\/)/.test(url.pathname);
  } catch {
    return false;
  }
}

export function playbackPageKey(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (!isPlaybackUrl(url.href)) return url.href;

    const meaningfulParams = new URLSearchParams();
    for (const key of ["p", "cid", "ep_id", "season_id"]) {
      if (url.searchParams.has(key)) {
        meaningfulParams.set(key, url.searchParams.get(key));
      }
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const query = meaningfulParams.toString();
    return `${url.origin}${pathname}${query ? `?${query}` : ""}`;
  } catch {
    return typeof value === "string" ? value : "";
  }
}

export function isSupportedMediaUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.endsWith(BILIVIDEO_SUFFIX) &&
      (
        /\.(?:m4s|mp4|flv)(?:$|[?#])/i.test(url.pathname + url.search) ||
        url.pathname.includes("/upgcxcode/")
      )
    );
  } catch {
    return false;
  }
}

export function isCandidateMediaUrl(value) {
  if (!isSupportedMediaUrl(value)) return false;
  try {
    const url = new URL(value);
    const firstLabel = url.hostname.split(".")[0] || "";
    return !(
      url.port ||
      url.searchParams.get("os") === "mcdn" ||
      url.hostname.includes(".mcdn.") ||
      firstLabel.includes("302") ||
      url.hostname === "upos-sz-mirror14b.bilivideo.com"
    );
  } catch {
    return false;
  }
}

export function replaceMediaHost(value, targetHost) {
  const validation = validateCdnHost(targetHost);
  if (!validation.ok) throw new TypeError(validation.error);
  if (!isSupportedMediaUrl(value)) {
    throw new TypeError("不是受支持的 bilivideo.com 媒体 URL");
  }
  const url = new URL(value);
  url.protocol = "https:";
  url.hostname = validation.host;
  url.port = "";
  return url.href;
}

export function makeProbeRange(
  value,
  maxBytes = 256 * 1024,
  offsetBytes = 0
) {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0
  ) {
    return "";
  }
  const match = /^bytes=(\d+)-(\d*)$/i.exec(value.trim());
  if (!match) return "";

  const start = BigInt(match[1]) + BigInt(offsetBytes);
  const requestedEnd = match[2] ? BigInt(match[2]) : null;
  const cappedEnd = start + BigInt(maxBytes) - 1n;
  const end =
    requestedEnd !== null && requestedEnd < cappedEnd
      ? requestedEnd
      : cappedEnd;
  if (end < start) return "";
  return `bytes=${start}-${end}`;
}

export function uniqueCandidates(
  builtins,
  customHosts = [],
  observedHost = "",
  playurlHosts = [],
  learnedHosts = []
) {
  const output = [];
  const seen = new Set();

  const add = (item, source) => {
    const rawHost = typeof item === "string" ? item : item.host;
    const validation = validateCdnHost(rawHost);
    if (!validation.ok || seen.has(validation.host)) return;
    seen.add(validation.host);
    output.push({
      host: validation.host,
      label:
        typeof item === "object" && item.label ? item.label : validation.host,
      note:
        typeof item === "object" && item.note
          ? item.note
          : {
              observed: "当前播放器实际请求",
              playurl: "当前播放接口签发",
              builtin: "本地核心种子",
              custom: "自定义候选",
              learned: "近期播放中学习"
            }[source] || "候选节点",
      source
    });
  };

  if (observedHost) add(observedHost, "observed");
  playurlHosts.forEach((host) => add(host, "playurl"));
  customHosts.forEach((host) => add(host, "custom"));
  builtins.forEach((item) => add(item, "builtin"));
  learnedHosts.forEach((host) => add(host, "learned"));
  return output;
}

export function chooseBenchmarkCandidates(
  candidates,
  preferredHost = "",
  limit = 8
) {
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit <= 0) {
    return [];
  }

  const sourcePriority = {
    observed: 0,
    playurl: 1,
    custom: 2,
    builtin: 3,
    learned: 4
  };
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      priority:
        candidate.host === preferredHost
          ? -1
          : sourcePriority[candidate.source] ?? 9
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function selectBestBenchmark(results) {
  const successful = results.filter(
    (item) =>
      item &&
      item.ok &&
      Number.isFinite(item.mbps) &&
      item.mbps > 0 &&
      Number.isFinite(item.ttfbMs)
  );
  successful.sort(
    (a, b) =>
      benchmarkConfidence(b) - benchmarkConfidence(a) ||
      b.mbps - a.mbps ||
      a.ttfbMs - b.ttfbMs ||
      a.host.localeCompare(b.host)
  );
  return successful[0] || null;
}

export function benchmarkConfidence(result) {
  if (result?.stage === "quick") return 1;
  return 2;
}

export function chooseAutoBenchmark(
  results,
  currentHost = "",
  minimumImprovementRatio = 0.15
) {
  const best = selectBestBenchmark(results);
  if (!best || !currentHost || best.host === currentHost) return best;

  const current = results.find(
    (item) =>
      item?.host === currentHost &&
      item.ok &&
      Number.isFinite(item.mbps) &&
      item.mbps > 0
  );
  if (!current) return best;

  return best.mbps >= current.mbps * (1 + minimumImprovementRatio)
    ? best
    : current;
}

export function selectRecoveryBenchmark(
  results,
  currentHost = "",
  excludedHosts = []
) {
  const excluded = new Set([currentHost, ...excludedHosts].filter(Boolean));
  return selectBestBenchmark(
    (Array.isArray(results) ? results : []).filter(
      (item) => !excluded.has(item?.host)
    )
  );
}

export function classifyAutoResultAge(
  autoBestAt,
  {
    now = Date.now(),
    softTtlMs = 90 * 60 * 1000,
    hardTtlMs = 2 * 60 * 60 * 1000
  } = {}
) {
  if (
    !Number.isFinite(autoBestAt) ||
    autoBestAt <= 0 ||
    !Number.isFinite(now) ||
    !Number.isFinite(softTtlMs) ||
    !Number.isFinite(hardTtlMs) ||
    softTtlMs <= 0 ||
    hardTtlMs <= softTtlMs
  ) {
    return "expired";
  }
  const age = Math.max(0, now - autoBestAt);
  if (age < softTtlMs) return "fresh";
  if (age < hardTtlMs) return "stale";
  return "expired";
}

export function isAutoRefreshActivityEligible(
  activity,
  {
    minimumCurrentTime = 3,
    minimumSafeBuffer = 10,
    requireSafeBuffer = false
  } = {}
) {
  if (
    !activity ||
    activity.visible !== true ||
    activity.playing !== true ||
    !Number.isFinite(activity.currentTime) ||
    activity.currentTime < minimumCurrentTime
  ) {
    return false;
  }
  return (
    !requireSafeBuffer ||
    (Number.isFinite(activity.bufferedAhead) &&
      activity.bufferedAhead >= minimumSafeBuffer)
  );
}

export function buildSessionRedirectRule({ id, tabId, targetHost }) {
  const validation = validateCdnHost(targetHost);
  if (!validation.ok) throw new TypeError(validation.error);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError("规则 ID 无效");
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError("标签页 ID 无效");

  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        transform: {
          scheme: "https",
          host: validation.host
        }
      }
    },
    condition: {
      tabIds: [tabId],
      initiatorDomains: ["bilibili.com"],
      requestDomains: ["bilivideo.com"],
      excludedRequestDomains: [validation.host],
      resourceTypes: ["media", "xmlhttprequest", "other"]
    }
  };
}
