import { isPlaybackUrl } from "./core.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  scopeNotice: document.querySelector("#scopeNotice"),
  message: document.querySelector("#message"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  observedHost: document.querySelector("#observedHost"),
  activeHost: document.querySelector("#activeHost"),
  recoveryStatus: document.querySelector("#recoveryStatus"),
  benchmarkAll: document.querySelector("#benchmarkAll"),
  autoMode: document.querySelector("#autoMode"),
  manualMode: document.querySelector("#manualMode"),
  autoRefreshProfile: document.querySelector("#autoRefreshProfile"),
  benchmarkHint: document.querySelector("#benchmarkHint"),
  bandwidthNotice: document.querySelector("#bandwidthNotice"),
  candidateList: document.querySelector("#candidateList"),
  customForm: document.querySelector("#customForm"),
  customHost: document.querySelector("#customHost"),
  version: document.querySelector("#version")
};

let activeTab = null;
let currentState = null;

function showMessage(text, error = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", error);
  elements.message.classList.remove("hidden");
  if (!error) {
    setTimeout(() => elements.message.classList.add("hidden"), 3200);
  }
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    type,
    tabId: activeTab?.id,
    ...payload
  });
  if (!response?.ok) throw new Error(response?.error || "操作失败");
  return response.data;
}

function resultMap() {
  return new Map(
    (currentState?.benchmarks || []).map((result) => [result.host, result])
  );
}

function formatDuration(milliseconds) {
  const minutes = Math.round(milliseconds / 60 / 1000);
  return minutes % 60 === 0
    ? `${minutes / 60} 小时`
    : `${minutes} 分钟`;
}

function renderCandidates() {
  const results = resultMap();
  elements.candidateList.replaceChildren();

  for (const candidate of currentState.candidates) {
    const result = results.get(candidate.host);
    const stalled = (currentState.stalledHosts || []).includes(candidate.host);
    const row = document.createElement("div");
    row.className = "candidate";
    if (currentState.activeHost === candidate.host) row.classList.add("selected");
    if (candidate.disabled) row.classList.add("disabled");

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "candidate-title";
    title.textContent = candidate.label;
    if (["observed", "playurl", "learned", "custom"].includes(candidate.source)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent =
        {
          observed: "当前",
          playurl: "签发",
          learned: "学习",
          custom: "自定"
        }[candidate.source] || "";
      title.append(tag);
    }
    if (stalled) {
      const tag = document.createElement("span");
      tag.className = "tag stalled";
      tag.textContent = "播放卡顿";
      title.append(tag);
    }
    if (candidate.disabled) {
      const tag = document.createElement("span");
      tag.className = "tag disabled";
      tag.textContent = "已禁用";
      title.append(tag);
    }
    title.title = candidate.note || "";
    const host = document.createElement("div");
    host.className = "candidate-host";
    host.title = candidate.host;
    host.textContent = candidate.host;
    info.append(title, host);

    const resultBox = document.createElement("div");
    resultBox.className = "candidate-result";
    if (result) {
      const speed = document.createElement("span");
      speed.className = `speed${result.ok ? "" : " failed"}`;
      speed.textContent = result.ok
        ? result.stage === "quick"
          ? `初筛 ${result.mbps} Mbps`
          : `${result.mbps} Mbps 持续${stalled ? " · 已降权" : ""}`
        : result.error || "失败";
      if (stalled) speed.classList.add("degraded");
      const latency = document.createElement("span");
      latency.className = "latency";
      latency.textContent =
        `${result.ttfbMs ?? "—"} ms 首包` +
        (result.stage === "sustained" && result.burstMbps
          ? ` · 短测 ${result.burstMbps}`
          : "");
      resultBox.append(speed, latency);
    } else if (candidate.disabled) {
      const disabled = document.createElement("span");
      disabled.className = "latency";
      disabled.textContent = "不参与测速和切换";
      resultBox.append(disabled);
    } else if (currentState.config.mode !== "manual") {
      const waiting = document.createElement("span");
      waiting.className = "latency";
      waiting.textContent = "等待测速";
      resultBox.append(waiting);
    }

    if (currentState.config.mode === "manual") {
      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "use-button";
      useButton.textContent =
        currentState.config.manualHost === candidate.host ? "已选择" : "使用";
      useButton.disabled =
        !currentState.applicable ||
        candidate.disabled ||
        currentState.config.manualHost === candidate.host;
      useButton.addEventListener("click", async () => {
        await perform(async () => send("SET_TARGET", { host: candidate.host }));
      });
      resultBox.append(useButton);
    }

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "toggle-button";
    toggleButton.textContent = candidate.disabled ? "重新启用" : "禁用";
    toggleButton.title = candidate.disabled
      ? "恢复参与测速、优选和切换"
      : "保留节点和历史成绩，但不再参与测速、优选和切换";
    toggleButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await perform(
        () =>
          send("SET_HOST_DISABLED", {
            host: candidate.host,
            disabled: !candidate.disabled
          }),
        candidate.disabled ? "已重新启用节点" : "已禁用节点"
      );
    });
    resultBox.append(toggleButton);

    row.append(info, resultBox);
    row.addEventListener("dblclick", async () => {
      if (currentState.applicable && !candidate.disabled) {
        await perform(async () => send("SET_TARGET", { host: candidate.host }));
      }
    });
    elements.candidateList.append(row);
  }
}

function render() {
  const applicable = currentState.applicable;
  elements.version.textContent = `v${currentState.version || "—"}`;
  elements.enabled.checked = currentState.config.enabled;
  elements.enabled.disabled = !applicable;
  elements.benchmarkAll.disabled =
    !applicable || currentState.benchmarkRunning || !currentState.observedHost;
  elements.autoMode.disabled = !applicable;
  elements.manualMode.disabled = !applicable;
  elements.autoRefreshProfile.disabled =
    !applicable || currentState.config.mode !== "auto";
  elements.autoMode.classList.toggle("active", currentState.config.mode === "auto");
  elements.manualMode.classList.toggle(
    "active",
    currentState.config.mode === "manual"
  );
  elements.autoRefreshProfile.value =
    currentState.config.autoRefreshProfile || "balanced";

  elements.scopeNotice.classList.toggle("hidden", applicable);
  elements.scopeNotice.textContent =
    "请在 B 站视频、番剧或课程播放页打开此扩展。其他页面不会建立重定向规则。";

  const active = currentState.ruleActive;
  elements.statusDot.classList.toggle("on", active);
  elements.statusText.textContent = currentState.benchmarkRunning
    ? currentState.benchmarkPhase === "sustained"
      ? "正在复测持续速度…"
      : "正在初筛候选 CDN…"
    : active
      ? "切换已生效"
      : currentState.config.enabled && currentState.config.mode === "auto"
        ? "已启用，等待媒体请求并自动测速"
        : "未启用重定向";
  elements.observedHost.textContent =
    currentState.observedHost || "尚未捕获，请播放视频";
  elements.activeHost.textContent = currentState.activeHost || "未启用";
  const recoveryTarget =
    currentState.lastRecovery?.fallback === "origin"
      ? "B 站原始节点"
      : currentState.lastRecovery?.host || "已切换";
  elements.recoveryStatus.textContent = currentState.recoveryCount
    ? `${currentState.recoveryCount} 次 · ${recoveryTarget}`
    : "尚未触发";
  elements.recoveryStatus.title = currentState.lastRecovery
    ? `${currentState.lastRecovery.fromHost} → ${recoveryTarget}`
    : "";
  const quickKb = Math.round((currentState.quickSampleBytes || 0) / 1024);
  const sustainedMb = Number(
    ((currentState.sustainedSampleBytes || 0) / 1024 / 1024).toFixed(1)
  );
  const softDuration = formatDuration(
    currentState.autoRefreshSoftMs || 90 * 60 * 1000
  );
  const hardDuration = formatDuration(
    currentState.autoResultTtlMs || 2 * 60 * 60 * 1000
  );
  const profileLabel =
    elements.autoRefreshProfile.selectedOptions[0]?.dataset.shortLabel ||
    "平衡";
  const sampleLabel =
    currentState.sampleKind === "video"
      ? "当前按实际视频轨测速；"
      : "";
  const disabledCount = currentState.config.disabledHosts?.length || 0;
  const disabledLabel = disabledCount
    ? `已禁用 ${disabledCount} 个候选；`
    : "";
  elements.benchmarkHint.textContent =
    `已从当前播放接口发现 ${currentState.discoveredCount || 0} 个 host；` +
    sampleLabel +
    disabledLabel +
    `先用 ${quickKb || 128} KB 初筛最多 ${currentState.benchmarkLimit || 8} 个，` +
    `再用 ${sustainedMb || 1} MB 复测前 ${currentState.sustainedFinalists || 3} 个。` +
    `${profileLabel}档下，自动结果 ${softDuration}后仅在可见播放且缓冲安全时按需复测，` +
    `${hardDuration}后失效。`;

  const disabledHosts = new Set(currentState.config.disabledHosts || []);
  const activeSustained = (currentState.benchmarks || []).find(
    (item) =>
      item?.host === currentState.activeHost &&
      !disabledHosts.has(item.host) &&
      item.ok &&
      item.stage === "sustained" &&
      Number.isFinite(item.mbps)
  );
  const bestHealthySustained = (currentState.benchmarks || [])
    .filter(
      (item) =>
        item?.ok &&
        !disabledHosts.has(item.host) &&
        item.stage === "sustained" &&
        Number.isFinite(item.mbps) &&
        !(currentState.stalledHosts || []).includes(item.host)
    )
    .sort((a, b) => b.mbps - a.mbps)[0];
  const referenceSpeed = activeSustained || bestHealthySustained;
  const mayBeSlowFor4k = referenceSpeed && referenceSpeed.mbps < 20;
  elements.bandwidthNotice.classList.toggle("hidden", !mayBeSlowFor4k);
  elements.bandwidthNotice.textContent = mayBeSlowFor4k
    ? `当前可用节点持续测速约 ${referenceSpeed.mbps} Mbps；若正在看 4K，可能仍不够。卡住时自动模式会继续尝试下一节点。`
    : "";

  renderCandidates();
}

async function perform(operation, successMessage = "") {
  try {
    document.body.classList.add("busy");
    currentState = await operation();
    render();
    if (successMessage) showMessage(successMessage);
  } catch (error) {
    showMessage(error?.message || "操作失败", true);
  } finally {
    document.body.classList.remove("busy");
  }
}

elements.enabled.addEventListener("change", async () => {
  await perform(
    () => send("SET_ENABLED", { enabled: elements.enabled.checked }),
    elements.enabled.checked ? "已启用，仅影响 B 站播放标签页" : "已停用"
  );
});

elements.autoMode.addEventListener("click", async () => {
  await perform(() => send("SET_MODE", { mode: "auto" }));
});

elements.manualMode.addEventListener("click", async () => {
  await perform(() => send("SET_MODE", { mode: "manual" }));
});

elements.autoRefreshProfile.addEventListener("change", async () => {
  const label =
    elements.autoRefreshProfile.selectedOptions[0]?.dataset.shortLabel ||
    "所选";
  await perform(
    () =>
      send("SET_AUTO_REFRESH_PROFILE", {
        profile: elements.autoRefreshProfile.value
      }),
    `已切换为${label}档`
  );
});

elements.benchmarkAll.addEventListener("click", async () => {
  elements.statusText.textContent = "正在测试候选 CDN…";
  elements.benchmarkAll.disabled = true;
  await perform(() => send("RUN_BENCHMARK"), "测速完成");
});

elements.customForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const host = elements.customHost.value;
  await perform(() => send("ADD_CUSTOM_HOST", { host }), "已添加候选节点");
  elements.customHost.value = "";
});

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageUrl = activeTab?.url || "";
  currentState = await send("GET_STATE", { pageUrl });
  if (!isPlaybackUrl(pageUrl)) currentState.applicable = false;
  render();
}

init().catch((error) => showMessage(error?.message || "无法读取扩展状态", true));
