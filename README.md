# Bili CDN Switcher / B站视频 CDN 优选器

[![CI](https://github.com/liiliiliil/bili-cdn-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/liiliiliil/bili-cdn-switcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chromium-Manifest%20V3-4285F4.svg)](manifest.json)

一个保守、无代理、无遥测的 Chromium Manifest V3 扩展。它只在 B 站视频/番剧/课程播放标签页里观测 `bilivideo.com` 媒体请求，并可把后续媒体请求的 host 换成测速更好的候选节点。

这是非官方开源项目，与哔哩哔哩不存在隶属、授权或背书关系。“哔哩哔哩”“Bilibili”等名称与标识的权利归其各自权利人所有。

当前版本：**v1.6.0**。弹窗底部会显示版本号；内容脚本加载后，还会在页面根元素写入版本、启停、模式、目标 host、当前发现数、学习数、测速阶段、自动结果状态、自动恢复次数等本地诊断标记，方便确认解压扩展是否已重新加载和建立规则。这些标记不包含完整媒体 URL、签名或用户数据，也不会上传。

## 它能做什么

- 记录当前播放标签页实际使用的媒体 CDN host。
- 只读观察 B 站 `playurl` 响应，优先使用其中刚签发的 `baseUrl` / `backupUrl` 作为候选，不改写响应内容。
- 使用当前视频的有效媒体 URL 和播放器正在请求的真实字节位置，先以 128 KB 初筛最多 8 个候选，再以不同字节区间对最快的 3 个各读取最多 1 MB，复测持续吞吐。
- 自动选择通过持续复测的最佳节点；弹窗会把只做过初筛和做过持续复测的结果分开标明，也可手动选择。
- 自动模式下，播放器连续约 4.5 秒没有可播放缓冲时，会给当前节点记录一次真实卡顿、切换到下一可用候选，并轻微回退 0.15 秒促使播放器发起新请求。每次恢复至少间隔 15 秒。
- 播放、拖动进度条或完成跳转后也会主动安排一次缓冲检查，避免只依赖可能早于内容脚本触发的 `waiting` / `stalled` 事件。
- 动态学习近期真实出现且可用的 host；最多保留 24 个、30 天自动过期、连续失败会降低优先级。
- 每轮总测速流量上限约 4 MB。成功结果在 90 分钟内直接复用，之后只在播放页可见、视频正在播放、确有媒体 Range 请求且已有节点的缓冲不少于 10 秒时按需复测；2 小时后结果硬过期。
- 没有后台定时测速，也没有申请 `alarms` 权限；仅仅开着 B 站首页、动态页、直播页、隐藏或暂停的点播页不会触发复测。多个标签页共用一个自动测速锁。
- 不把带 `os=mcdn`、非标准端口、明显 302 跳转或已知 PCDN 特征的地址加入候选池。
- 每个标签页使用独立的 Chrome 会话规则；离开播放页、关闭标签页、停用扩展或结束浏览器会话时移除/失效。
- 同一视频 URL 新增或移除 `spm_id_from`、`vd_source` 等追踪参数时会保留已观测状态；真正切换 BV、分 P（`p`）、CID 或番剧身份参数时才重置。
- 不需要全局 proxy，也没有申请 Chrome 的 `proxy` 权限。

## 安装

1. 解压 ZIP。
2. 在 Chrome、Edge、Brave 等 Chromium 浏览器打开扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
3. 打开右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的 `bilibili-cdn-switcher` 文件夹。
5. 把扩展固定到工具栏。

## 使用

1. 打开一个 B 站视频并开始播放几秒。
2. 点击工具栏中的“B站 CDN Switcher”。
3. 打开启停开关。
4. 保持“自动选择”时，扩展会在捕获到媒体 URL 后从“当前实际 host、当前播放接口签发 host、自定义项、少量核心种子、近期成功项”中挑最多 8 个初筛，再持续复测前 3 个，并为这个标签页选择表现最好的成功项；也可以切到“手动选择”并选择一个 host。
5. 自动模式检测到真实卡顿后会轮换下一候选。若所有候选都慢，弹窗会提示当前持续带宽可能不足；此时降低清晰度通常比继续换 host 更有效。

测速结果只代表这一个视频、这一时刻和这一条网络路径。CDN 的 DNS、缓存和跨境路由会变化，今天最快的节点不保证明天仍然最快。

## 验证与研究

项目在真实 Chromium 会话中完成了多轮两阶段测速、持续播放、自动恢复和未缓存位置跳转回归。公开材料经过匿名化，不包含测试视频 ID、标题、UP 主、账号标识、个人空间或完整媒体 URL。

- [匿名浏览器测试报告](docs/testing/browser-test-report-2026-07-23.md)：测速、恢复、随机跳转和 v1.6.0 活动门槛。
- [B站“4K”画质研究](docs/research/bilibili-4k-quality-2026-07-23.md)：实际解码分辨率、码率与有限跨平台对照。
- [文档索引](docs/README.md)：文档分类及公开信息边界。

## 工作原理与 MV3 取舍

普通 MV3 扩展不能再使用 `webRequestBlocking` 同步改写请求。因此本项目把能力拆开：

1. `webRequest` 仅观察由 B 站发起的 `bilivideo.com` 请求，记录播放器当前的 Range，并保存本地状态。
2. 一个运行在页面主世界的最小只读观察器会克隆并解析 B 站 `playurl` 的 fetch/XHR 响应，以及页面已有的 `window.__playinfo__`。它只提取通过白名单校验的 `*.bilivideo.com` 媒体 URL，不修改播放器对象或网络响应。
3. 两阶段测速在 B 站播放页的隔离内容脚本中进行，以使用与播放器相同的页面来源与 Referer 环境；第二阶段换一个相邻 Range，避免重复读取浏览器缓存。测速结果只返回扩展后台。
4. `declarativeNetRequest.updateSessionRules()` 建立会话级重定向规则。
5. 内容脚本只监听播放器的 `waiting` / `stalled` 等本地媒体状态；确认不是暂停、页面不可见或仍有缓冲后，才请求后台轮换一次节点。
6. 规则同时要求：
   - 请求来自特定 B 站播放标签页的 `tabId`；
   - initiator 属于 `bilibili.com`；
   - 目标属于 `bilivideo.com`；
   - 类型为 `media`、`xmlhttprequest` 或 `other`；
   - 只把 scheme/host 换成经校验的 `*.bilivideo.com`，原路径、查询参数和签名保持不变。

声明式规则会在浏览器网络层覆盖媒体元素、XHR、fetch、普通 Worker 和播放器内部加载器发出的匹配请求。因此，本项目不需要把替换逻辑注入 Worker，也不需要申请 `webRequestBlocking`；页面主世界的 hook 只用于观察 `playurl` 返回了哪些现成签名地址。

## 权限说明

- `declarativeNetRequest`：为当前 B 站播放标签页建立受限的 CDN host 替换规则。
- `webRequest`：只读观测 `bilivideo.com` 媒体请求、完成状态和错误。
- `storage`：在本机保存开关、模式、候选 host 和有数量/期限上限的测速摘要。
- `activeTab`：弹窗读取用户刚刚点击的当前标签页。
- `https://*.bilibili.com/*` / `https://bilibili.com/*`：确认请求确实由 B 站页面发起。
- `https://*.bilivideo.com/*`：观察、测速和切换 B 站媒体 CDN。

没有 `<all_urls>`、`proxy`、Cookie、历史记录或远程代码权限。详见 [PRIVACY.md](PRIVACY.md)。

## 限制

- 这不是 VPN，也不会建立任何隧道；它不能绕过地区版权限制、登录限制或已经失效的媒体签名。
- host 替换依赖不同 B 站 CDN 接受同一条已签名路径。某些视频、版权内容、运营商专用节点或未来的 URL 格式可能不兼容。
- 页面测速可能因节点拒绝跨域请求、签名绑定 host、防盗链或网络错误失败。失败项不会被自动选择；扩展会优先测试 B 站原样签发的地址，只有没有对应签发地址时才做 host 替换测试。
- 已经开始的单个网络请求不能“半途换线”；自动恢复会在换规则后把播放位置回退约 0.15 秒，以触发后续请求，画面可能出现几乎不可察觉的重复。
- 当前版本严格限制为 `bilivideo.com`，不会改写 `akamaized.net`、`bilivideo.cn`、直播流或非 B 站请求。

## 候选节点

内置列表现在只是一个很小的冷启动种子，不再被当作长期真值。除常见 mirror 节点外，v1.5 加入了仍被其他开源加速器使用的 `upos-tf-all-hw` / `upos-tf-all-tx` 通用 UPOS 种子。扩展会把“当前视频实际请求的 host”和“当前 `playurl` 原样签发的 host”排在前面，再参考本机近期成功记录；每轮测试数固定封顶，过期、长期失败或真实播放中卡顿的项会被降权或淘汰。这样新 host 可以自动进入候选，但列表不会无限膨胀，也不会让每次播放越来越慢。

你可以添加自定义 host，但安全校验只接受 `*.bilivideo.com`，不接受协议、路径、端口或其他域名。

## 开发与检查

需要 Node.js 18 或更新版本：

```bash
npm test
npm run check
```

测试覆盖 host 白名单、URL 替换、播放页作用域、动态候选排序与数量上限、两阶段结果优先级、卡顿候选轮换、自动切换防抖、会话规则约束和 Manifest 权限边界。

欢迎通过 [Issues](https://github.com/liiliiliil/bili-cdn-switcher/issues) 报告问题或建议功能。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 的说明提交。版本变化记录见 [CHANGELOG.md](CHANGELOG.md)。

## 参考

- [Chrome declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Chrome Content scripts 与 MAIN/ISOLATED world](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Bilibili Video CDN Switcher 候选 host 与使用说明](https://greasyfork.org/en/scripts/500213-bilibili-video-cdn-switcher)
- [BiliCDN Pilot 的动态学习、有限测速与 Worker 兼容思路](https://github.com/zzvsjs1/BiliCDN-Pilot)
- [Bilibili Accelerator 的通用 UPOS 候选、卡顿恢复和主动传输测速思路](https://github.com/realzza/bilibili-accelerator)
- [Bilibili-Evolved 的媒体 URL 类型识别](https://github.com/the1812/Bilibili-Evolved/blob/master/registry/lib/components/video/download/url-type.ts)

本项目代码为独立实现，没有复制上述用户脚本代码；扩展使用浏览器网络层规则覆盖 Worker，而不是采用用户脚本的 Worker 源码注入方案。
