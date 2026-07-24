(() => {
  let lastUrl = location.href;
  let latestPlayurlUrls = [];
  let latestPlayurlVideoUrls = [];
  const extensionManifest = chrome.runtime.getManifest();
  const extensionVersion =
    extensionManifest.version_name || extensionManifest.version;
  const maxAllowedSampleBytes = 1024 * 1024;
  const stallConfirmMs = 4500;
  const stallCooldownMs = 15000;
  let stallTimer = 0;
  let lastStallReportAt = 0;

  // Harmless local marker for verifying an unpacked-extension reload.
  document.documentElement.dataset.bilibiliCdnSwitcherVersion =
    extensionVersion;

  const applyDiagnosticStatus = (status) => {
    if (!status) return;
    const root = document.documentElement.dataset;
    root.bilibiliCdnSwitcherEnabled = String(Boolean(status.enabled));
    root.bilibiliCdnSwitcherMode = status.mode || "";
    root.bilibiliCdnSwitcherRuleActive = String(Boolean(status.ruleActive));
    root.bilibiliCdnSwitcherActiveHost = status.activeHost || "";
    root.bilibiliCdnSwitcherObservedHost = status.observedHost || "";
    root.bilibiliCdnSwitcherBenchmarkRunning = String(
      Boolean(status.benchmarkRunning)
    );
    root.bilibiliCdnSwitcherBenchmarkCount = String(
      status.benchmarkCount || 0
    );
    root.bilibiliCdnSwitcherSuccessfulBenchmarks = String(
      status.successfulBenchmarks || 0
    );
    root.bilibiliCdnSwitcherDiscoveredCount = String(
      status.discoveredCount || 0
    );
    root.bilibiliCdnSwitcherLearnedCount = String(
      status.learnedCount || 0
    );
    root.bilibiliCdnSwitcherRecoveryCount = String(
      status.recoveryCount || 0
    );
    root.bilibiliCdnSwitcherBenchmarkPhase = status.benchmarkPhase || "";
    root.bilibiliCdnSwitcherAutoResultStatus =
      status.autoResultStatus || "";
    root.bilibiliCdnSwitcherAutoRefreshProfile =
      status.autoRefreshProfile || "";
  };

  const syncDiagnostics = () => {
    try {
      chrome.runtime.sendMessage(
        { type: "GET_DIAGNOSTICS", extensionVersion },
        (response) => {
          if (!chrome.runtime.lastError && response?.ok) {
            applyDiagnosticStatus(response.data);
          }
        }
      );
    } catch {
      // Extension reloads can invalidate an existing content-script context.
    }
  };

  const testCandidate = async (spec) => {
    const host = spec?.host;
    if (
      typeof host !== "string" ||
      !/^[a-z0-9.-]+\.bilivideo\.com$/i.test(host)
    ) {
      return { host, ok: false, error: "候选 host 无效", status: 0 };
    }

    const maxBytes = Math.min(
      Math.max(Number(spec?.maxBytes) || 128 * 1024, 1),
      maxAllowedSampleBytes
    );
    const timeoutMs = Math.min(
      Math.max(Number(spec?.timeoutMs) || 5000, 1000),
      9000
    );
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const url = new URL(spec?.url);
      if (
        url.hostname !== host ||
        !url.hostname.endsWith(".bilivideo.com") ||
        !(
          /\.(?:m4s|mp4|flv)(?:$|[?#])/i.test(
            url.pathname + url.search
          ) ||
          url.pathname.includes("/upgcxcode/")
        )
      ) {
        throw new Error("样本 URL 不属于 bilivideo.com");
      }
      url.protocol = "https:";
      url.port = "";

      response = await fetch(url, {
        method: "GET",
        headers: {
          Range: spec?.range || `bytes=0-${maxBytes - 1}`
        },
        cache: "no-store",
        credentials: "omit",
        referrer: location.href,
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
          stage: spec?.stage
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
        source: spec?.direct ? "playurl" : "host-swap",
        stage: spec?.stage,
        rangeAccepted: response.status === 206,
        contentType
      };
    } catch (error) {
      return {
        host,
        ok: false,
        status: response?.status || 0,
        error:
          error?.name === "AbortError"
            ? "超时"
            : error?.message || "页面测速失败",
        ttfbMs: Math.round(performance.now() - startedAt),
        source: "page",
        stage: spec?.stage
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const mapWithConcurrency = async (items, limit, task) => {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor++;
          results[index] = await task(items[index]);
        }
      }
    );
    await Promise.all(workers);
    return results;
  };

  const playbackActivity = () => {
    const videos = [...document.querySelectorAll("video")];
    const video = videos
      .map((item) => ({
        item,
        area: Math.max(item.clientWidth, 0) * Math.max(item.clientHeight, 0)
      }))
      .sort((a, b) => b.area - a.area)[0]?.item;
    if (!(video instanceof HTMLVideoElement)) {
      return {
        visible: document.visibilityState === "visible",
        playing: false,
        currentTime: 0,
        bufferedAhead: 0,
        readyState: 0
      };
    }
    let ahead = 0;
    try {
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (
          video.buffered.start(index) <= video.currentTime + 0.05 &&
          video.buffered.end(index) >= video.currentTime
        ) {
          ahead = Math.max(video.buffered.end(index) - video.currentTime, 0);
          break;
        }
      }
    } catch {
      ahead = 0;
    }
    return {
      visible: document.visibilityState === "visible",
      playing: !video.paused && !video.ended,
      currentTime: Number(video.currentTime) || 0,
      bufferedAhead: Number(ahead.toFixed(3)),
      readyState: video.readyState
    };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "DIAGNOSTIC_STATUS") {
      applyDiagnosticStatus(message.status);
      return false;
    }
    if (message.type === "GET_PLAYURL_URLS") {
      sendResponse({
        ok: true,
        urls: latestPlayurlUrls,
        videoUrls: latestPlayurlVideoUrls
      });
      return false;
    }
    if (message.type === "GET_PLAYBACK_ACTIVITY") {
      sendResponse({ ok: true, activity: playbackActivity() });
      return false;
    }
    if (message.type !== "RUN_PAGE_BENCHMARK") return false;

    const concurrency = Math.min(
      Math.max(Number(message.concurrency) || 1, 1),
      2
    );
    mapWithConcurrency(message.specs || [], concurrency, (spec) =>
      testCandidate(spec)
    )
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "页面测速失败"
        })
      );
    return true;
  });

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(
        { extensionVersion, ...message },
        () => void chrome.runtime.lastError
      );
    } catch {
      // Extension reloads can invalidate an existing content-script context.
    }
  };

  const bufferedAhead = (video) => {
    try {
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (
          video.buffered.start(index) <= video.currentTime + 0.05 &&
          video.buffered.end(index) >= video.currentTime
        ) {
          return Math.max(video.buffered.end(index) - video.currentTime, 0);
        }
      }
    } catch {
      // A changing MediaSource can invalidate TimeRanges during inspection.
    }
    return 0;
  };

  const cancelStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = 0;
  };

  const scheduleStallCheck = (video, delayMs = stallConfirmMs) => {
    cancelStallTimer();
    if (
      !(video instanceof HTMLVideoElement) ||
      video.paused ||
      video.ended ||
      video.currentTime <= 0 ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    stallTimer = setTimeout(() => {
      stallTimer = 0;
      const now = Date.now();
      if (
        video.paused ||
        video.ended ||
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ||
        bufferedAhead(video) >= 0.5 ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      const cooldownRemaining =
        stallCooldownMs - (now - lastStallReportAt);
      if (cooldownRemaining > 0) {
        scheduleStallCheck(video, cooldownRemaining);
        return;
      }
      lastStallReportAt = now;
      try {
        chrome.runtime.sendMessage(
          {
            type: "PLAYBACK_STALL",
            extensionVersion,
            currentTime: Number(video.currentTime.toFixed(3)),
            readyState: video.readyState,
            bufferedAhead: Number(bufferedAhead(video).toFixed(3))
          },
          (response) => {
            if (chrome.runtime.lastError || !response?.ok) return;
            const recovery = response.data;
            if (!recovery?.switched || !video.isConnected) return;
            const recoveryTarget =
              recovery.fallback === "origin"
                ? "origin"
                : recovery.host || "";
            document.documentElement.dataset.bilibiliCdnSwitcherLastRecovery =
              `${recovery.fromHost || ""}->${recoveryTarget}`;
            const retryPlayback = () => {
              if (!video.isConnected || video.ended) return;
              const resumeAt = Math.max(0, video.currentTime - 1);
              try {
                video.currentTime = resumeAt;
                void video.play().catch(() => {});
              } catch {
                // The player can recover on its next retry even if seeking fails.
              }
            };
            setTimeout(retryPlayback, 150);
            if (recovery.retryBenchmark) {
              setTimeout(() => {
                try {
                  chrome.runtime.sendMessage(
                    {
                      type: "RUN_BENCHMARK",
                      extensionVersion,
                      preserveStalledHosts: true
                    },
                    (benchmarkResponse) => {
                      if (
                        chrome.runtime.lastError ||
                        !benchmarkResponse?.ok
                      ) {
                        return;
                      }
                      setTimeout(retryPlayback, 50);
                    }
                  );
                } catch {
                  // A later playback request can retry automatic selection.
                }
              }, 250);
            }
          }
        );
      } catch {
        // An extension reload can invalidate an old content-script context.
      }
    }, Math.max(Number(delayMs) || stallConfirmMs, 250));
  };

  ["waiting", "stalled", "seeking", "play", "seeked"].forEach(
    (type) =>
      document.addEventListener(
        type,
        (event) => scheduleStallCheck(event.target),
        true
      )
  );
  ["playing", "canplay", "pause", "ended"].forEach(
    (type) =>
      document.addEventListener(type, cancelStallTimer, true)
  );

  document.addEventListener("bilibili-cdn-switcher:playurl", (event) => {
    try {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        reportNavigation("NAVIGATION");
      }
      const sanitizeMediaUrls = (values) =>
        Array.isArray(values)
          ? values
            .filter((value) => {
              if (typeof value !== "string") return false;
              const url = new URL(value);
              return (
                url.hostname.endsWith(".bilivideo.com") &&
                (
                  /\.(?:m4s|mp4|flv)(?:$|[?#])/i.test(
                    url.pathname + url.search
                  ) ||
                  url.pathname.includes("/upgcxcode/")
                )
              );
            })
            .slice(0, 80)
          : [];
      const urls = sanitizeMediaUrls(event.detail?.urls);
      const videoUrls = sanitizeMediaUrls(event.detail?.videoUrls);
      if (urls.length) {
        latestPlayurlUrls = [
          ...new Set([...urls, ...latestPlayurlUrls])
        ].slice(0, 80);
        latestPlayurlVideoUrls = [
          ...new Set([...videoUrls, ...latestPlayurlVideoUrls])
        ].slice(0, 80);
        send({
          type: "PLAYURL_URLS",
          urls: latestPlayurlUrls,
          videoUrls: latestPlayurlVideoUrls
        });
      }
    } catch {
      // Ignore malformed events from the host page.
    }
  });

  const reportNavigation = (type = "READY") => {
    if (type === "NAVIGATION") {
      latestPlayurlUrls = [];
      latestPlayurlVideoUrls = [];
    }
    send({ type, url: location.href });
  };

  reportNavigation();
  [1000, 8000, 24000].forEach((delay) =>
    setTimeout(syncDiagnostics, delay)
  );

  addEventListener("popstate", () => reportNavigation("NAVIGATION"));
  addEventListener("hashchange", () => reportNavigation("NAVIGATION"));

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reportNavigation("NAVIGATION");
    }
  }, 1000);

  if ("PerformanceObserver" in globalThis) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        try {
          const url = new URL(entry.name);
          if (url.hostname.endsWith(".bilivideo.com")) {
            send({ type: "MEDIA_SEEN", url: entry.name });
            setTimeout(syncDiagnostics, 1000);
          }
        } catch {
          // Ignore non-URL performance entries.
        }
      }
    });

    try {
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer.observe({ entryTypes: ["resource"] });
    }
  }
})();
