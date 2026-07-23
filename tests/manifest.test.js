import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8")
);

test("manifest 使用 MV3 且默认没有代理权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.6.1");
  assert.equal(manifest.version_name, "1.7.0-rc.1");
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
