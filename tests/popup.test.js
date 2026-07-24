import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const popupHtml = await readFile(
  new URL("../src/popup.html", import.meta.url),
  "utf8"
);
const popupScript = await readFile(
  new URL("../src/popup.js", import.meta.url),
  "utf8"
);

test("弹窗只提供三种受限的自动重新优选预设", () => {
  assert.match(popupHtml, /id="autoRefreshProfile"/);
  const profileValues = [
    ...popupHtml.matchAll(/<option value="([^"]+)"/g)
  ].map((match) => match[1]);
  assert.deepEqual(profileValues, ["frequent", "balanced", "economy"]);
  assert.match(popupHtml, /平衡 · 90 分钟/);
  assert.match(popupHtml, /低频 · 6 小时/);
  assert.doesNotMatch(popupHtml, /省流/);
});

test("弹窗通过后台消息保存自动重新优选档位", () => {
  assert.match(popupScript, /SET_AUTO_REFRESH_PROFILE/);
  assert.match(popupScript, /profile: elements\.autoRefreshProfile\.value/);
});

test("弹窗可以禁用和重新启用候选，而不是删除记录", () => {
  assert.match(popupScript, /SET_HOST_DISABLED/);
  assert.match(popupScript, /candidate\.disabled \? "重新启用" : "禁用"/);
  assert.match(popupScript, /不参与测速和切换/);
  assert.doesNotMatch(popupScript, /DELETE_CUSTOM_HOST/);
});
