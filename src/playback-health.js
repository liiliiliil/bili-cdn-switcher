(() => {
  const DEFAULT_OPTIONS = Object.freeze({
    lowBufferSeconds: 8,
    minimumBufferedSeconds: 0.5,
    minimumDrainSeconds: 6,
    minimumWindowMs: 8000,
    maximumWindowMs: 16000,
    minimumPlaybackAdvanceSeconds: 6,
    maximumPlaybackRate: 3,
    minimumSamples: 5,
    decliningSampleCount: 5,
    maximumReboundSeconds: 0.5
  });

  const finite = (value) => Number.isFinite(Number(value));

  const validSample = (sample) =>
    sample &&
    finite(sample.at) &&
    finite(sample.currentTime) &&
    finite(sample.bufferedAhead) &&
    sample.visible === true &&
    sample.playing === true &&
    sample.seeking !== true;

  const shouldPreemptivelyRecover = (samples, options = {}) => {
    const policy = { ...DEFAULT_OPTIONS, ...options };
    if (
      !Array.isArray(samples) ||
      samples.length < policy.minimumSamples
    ) {
      return false;
    }

    const current = samples.at(-1);
    if (
      !validSample(current) ||
      current.bufferedAhead <= policy.minimumBufferedSeconds ||
      current.bufferedAhead > policy.lowBufferSeconds
    ) {
      return false;
    }

    const recent = samples.filter(
      (sample) =>
        validSample(sample) &&
        sample.at <= current.at &&
        current.at - sample.at <= policy.maximumWindowMs
    );
    if (recent.length < policy.minimumSamples) return false;

    const baselines = recent.filter(
      (sample) => current.at - sample.at >= policy.minimumWindowMs
    );
    if (!baselines.length) return false;

    const baseline = baselines.reduce((best, sample) =>
      sample.bufferedAhead > best.bufferedAhead ? sample : best
    );
    const windowSamples = recent.filter(
      (sample) => sample.at >= baseline.at
    );
    const decliningSamples = recent.slice(
      -policy.decliningSampleCount
    );

    for (let index = 1; index < windowSamples.length; index += 1) {
      const previous = windowSamples[index - 1];
      const sample = windowSamples[index];
      if (sample.currentTime + 0.5 < previous.currentTime) return false;
    }
    if (
      decliningSamples.length < policy.decliningSampleCount ||
      decliningSamples.some(
        (sample, index) =>
          index > 0 &&
          sample.bufferedAhead >
            decliningSamples[index - 1].bufferedAhead +
              policy.maximumReboundSeconds
      )
    ) {
      return false;
    }

    const elapsedSeconds = (current.at - baseline.at) / 1000;
    const playbackAdvance = current.currentTime - baseline.currentTime;
    const bufferDrain =
      baseline.bufferedAhead - current.bufferedAhead;

    return (
      elapsedSeconds > 0 &&
      playbackAdvance >= policy.minimumPlaybackAdvanceSeconds &&
      playbackAdvance <=
        elapsedSeconds * policy.maximumPlaybackRate + 2 &&
      bufferDrain >= policy.minimumDrainSeconds
    );
  };

  const recoveryCooldownRemaining = ({
    now,
    lastAt,
    currentHost,
    lastHost,
    cooldownMs,
    minimumIntervalMs = 0
  }) => {
    if (
      typeof currentHost !== "string" ||
      !currentHost ||
      !finite(now) ||
      !finite(lastAt) ||
      !finite(cooldownMs) ||
      !finite(minimumIntervalMs)
    ) {
      return 0;
    }
    const elapsed = Number(now) - Number(lastAt);
    const sameHostRemaining =
      currentHost === lastHost
        ? Math.max(Number(cooldownMs) - elapsed, 0)
        : 0;
    const switchGraceRemaining = Math.max(
      Number(minimumIntervalMs) - elapsed,
      0
    );
    return Math.max(sameHostRemaining, switchGraceRemaining);
  };

  Object.defineProperty(globalThis, "BiliCdnPlaybackHealth", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      DEFAULT_OPTIONS,
      shouldPreemptivelyRecover,
      recoveryCooldownRemaining
    })
  });
})();
