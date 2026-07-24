(() => {
  const marker = "__BILIBILI_CDN_SWITCHER_PLAYURL_OBSERVER__";
  const eventName = "bilibili-cdn-switcher:playurl";
  if (window[marker]) return;
  window[marker] = true;

  const playurlPaths = [
    "/x/player/wbi/playurl",
    "/x/player/playurl",
    "/pgc/player/web/v2/playurl",
    "/pgc/player/web/playurl",
    "/pgc/player/api/playurl",
    "/pugv/player/web/playurl",
    "/ogv/player/playview"
  ];

  const isPlayurlRequest = (value) => {
    try {
      const raw =
        typeof value === "string"
          ? value
          : value && typeof value.url === "string"
            ? value.url
            : "";
      const url = new URL(raw, location.href);
      return (
        (url.hostname === "bilibili.com" ||
          url.hostname.endsWith(".bilibili.com")) &&
        playurlPaths.some((path) => url.pathname.startsWith(path))
      );
    } catch {
      return false;
    }
  };

  const collectMediaUrls = (value) => {
    const output = [];
    const videoOutput = [];
    const audioOutput = [];
    const seenObjects = new WeakSet();
    const seenUrls = new Set();
    const seenVideoUrls = new Set();
    const seenAudioUrls = new Set();

    const visit = (item, depth = 0, mediaKind = "") => {
      if (depth > 20 || item == null) return;
      if (typeof item === "string") {
        try {
          const url = new URL(item.startsWith("//") ? `https:${item}` : item);
          if (
            url.hostname.endsWith(".bilivideo.com") &&
            (
              /\.(?:m4s|mp4|flv)(?:$|[?#])/i.test(
                url.pathname + url.search
              ) ||
              url.pathname.includes("/upgcxcode/")
            ) &&
            !seenUrls.has(url.href)
          ) {
            seenUrls.add(url.href);
            output.push(url.href);
          }
          if (
            mediaKind === "video" &&
            !seenVideoUrls.has(url.href)
          ) {
            seenVideoUrls.add(url.href);
            videoOutput.push(url.href);
          } else if (
            mediaKind === "audio" &&
            !seenAudioUrls.has(url.href)
          ) {
            seenAudioUrls.add(url.href);
            audioOutput.push(url.href);
          }
        } catch {
          // Ignore non-URL strings in the playinfo payload.
        }
        return;
      }
      if (typeof item !== "object" || seenObjects.has(item)) return;
      seenObjects.add(item);
      if (Array.isArray(item)) {
        item.forEach((entry) => visit(entry, depth + 1, mediaKind));
        return;
      }
      Object.entries(item).forEach(([key, entry]) => {
        const nextKind =
          key === "video"
            ? "video"
            : key === "audio"
              ? "audio"
              : mediaKind;
        visit(entry, depth + 1, nextKind);
      });
    };

    visit(value);
    return {
      urls: output.slice(0, 80),
      videoUrls: videoOutput.slice(0, 80),
      audioUrls: audioOutput.slice(0, 80)
    };
  };

  const publish = (playInfo) => {
    const media = collectMediaUrls(playInfo);
    if (!media.urls.length) return;
    document.dispatchEvent(
      new CustomEvent(eventName, {
        detail: media
      })
    );
  };

  const inspectJsonText = (text) => {
    if (typeof text !== "string" || !text) return;
    try {
      publish(JSON.parse(text));
    } catch {
      // A failed parse must never affect the page's original response.
    }
  };

  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function observedFetch(input, init) {
        const responsePromise = originalFetch.call(this, input, init);
        if (isPlayurlRequest(input)) {
          responsePromise
            .then((response) => response.clone().json())
            .then(publish)
            .catch(() => {});
        }
        return responsePromise;
      };
    }
  } catch {
    // Fall back to webRequest-only discovery when the page locks fetch.
  }

  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function observedOpen(method, url, ...rest) {
      if (isPlayurlRequest(url)) {
        this.addEventListener(
          "load",
          () => {
            try {
              if (this.responseType === "json") {
                publish(this.response);
              } else if (
                this.responseType === "" ||
                this.responseType === "text"
              ) {
                inspectJsonText(this.responseText);
              }
            } catch {
              // Reading an unsupported responseType should not affect XHR.
            }
          },
          { once: true }
        );
      }
      return originalOpen.call(this, method, url, ...rest);
    };
  } catch {
    // Fall back to fetch/global playinfo observation.
  }

  const inspectGlobals = () => {
    try {
      if (window.__playinfo__) publish(window.__playinfo__);
    } catch {
      // Ignore accessors installed by the host page.
    }
  };

  inspectGlobals();
  [0, 500, 1500, 5000].forEach((delay) =>
    setTimeout(inspectGlobals, delay)
  );
})();
