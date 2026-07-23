import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8")
);

test("manifest 使用 MV3 且默认没有代理权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.7.0");
  assert.equal("version_name" in manifest, false);
  assert.equal(manifest.permissions.includes("proxy"), false);
  assert.equal(manifest.permissions.includes("webRequestBlocking"), false);
  assert.equal(manifest.permissions.includes("alarms"), false);
  assert.equal(manifest.permissions.includes("<all_urls>"), false);
  assert.equal(
    manifest.permissions.includes("declarativeNetRequestWithHostAccess"),
    true
  );
  assert.equal(
    manifest.permissions.includes("declarativeNetRequest"),
    false
  );
});

test("扩展与商店图标路径完整", async () => {
  const expectedIcons = {
    16: "assets/icons/icon-16.png",
    32: "assets/icons/icon-32.png",
    48: "assets/icons/icon-48.png",
    128: "assets/icons/icon-128.png"
  };
  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, {
    16: expectedIcons[16],
    32: expectedIcons[32]
  });

  for (const [size, path] of Object.entries(expectedIcons)) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(bytes.toString("ascii", 1, 4), "PNG");
    assert.equal(bytes.readUInt32BE(16), Number(size));
    assert.equal(bytes.readUInt32BE(20), Number(size));
  }
});

test("商店图片尺寸符合上传要求", async () => {
  const assets = new Map([
    ["assets/store/small-promo-440x280.png", [440, 280]],
    ["assets/store/screenshot-01-overview-1280x800.png", [1280, 800]],
    ["assets/store/screenshot-02-scope-1280x800.png", [1280, 800]]
  ]);

  for (const [path, [width, height]] of assets) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(bytes.toString("ascii", 1, 4), "PNG");
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
  }
});

test("host 权限只覆盖 B 站页面与 bilivideo 媒体", () => {
  assert.deepEqual(manifest.host_permissions, [
    "https://www.bilibili.com/*",
    "https://m.bilibili.com/*",
    "https://*.bilivideo.com/*"
  ]);
});

test("内容脚本只进入明确的 B 站播放路径", () => {
  for (const script of manifest.content_scripts) {
    assert.equal(
      script.matches.every((match) => match.includes("bilibili.com/")),
      true
    );
    assert.equal(script.matches.some((match) => match.includes("/video/*")), true);
    assert.equal(
      script.matches.some((match) => match.includes("/bangumi/play/*")),
      true
    );
  }
});

test("主世界脚本只读观察 playurl，替换逻辑仍由 DNR 承担", () => {
  const mainScript = manifest.content_scripts.find(
    (script) => script.world === "MAIN"
  );
  assert.ok(mainScript);
  assert.deepEqual(mainScript.js, ["src/page-hook.js"]);
  assert.equal(mainScript.run_at, "document_start");
  assert.equal(manifest.permissions.includes("scripting"), false);
});
