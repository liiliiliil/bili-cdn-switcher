# 排障指南

## 怎么确认扩展已经工作

1. 弹窗底部显示预期版本号。
2. 打开受支持的 B 站点播页并播放几秒。
3. 弹窗出现“当前观测”、候选测速结果和“重定向到”的节点。
4. 自动或手动选择节点后，顶部状态显示“切换已生效”。

重新加载扩展会让旧页面里的内容脚本失效。重新加载后，需要刷新已经打开的视频页。

## 页面诊断标记

如果弹窗信息不足，可以在播放页的开发者工具 Console 中查看：

```js
document.documentElement.dataset.bilibiliCdnSwitcherVersion
document.documentElement.dataset.bilibiliCdnSwitcherEnabled
document.documentElement.dataset.bilibiliCdnSwitcherRuleActive
document.documentElement.dataset.bilibiliCdnSwitcherObservedHost
document.documentElement.dataset.bilibiliCdnSwitcherActiveHost
document.documentElement.dataset.bilibiliCdnSwitcherBenchmarkPhase
document.documentElement.dataset.bilibiliCdnSwitcherSuccessfulBenchmarks
```

这些标记只用于本地排障，不包含完整媒体 URL、签名、Cookie 或账号信息，也不会上传。

## 常见情况

### 一直显示等待媒体请求

- 确认当前页面是点播视频，而不是首页、动态页或直播页。
- 开始播放并等待几秒；暂停页面不会主动测速。
- 如果刚重新加载过扩展，刷新视频页。

### 能看到候选，但全部测速失败

部分节点会因为跨域、防盗链、签名绑定 host 或当前网络路径而拒绝请求。失败项不会被自动选中；可以刷新视频、稍后重试或降低清晰度。

### 已开启，但当前 host 没变化

当前节点可能已经是本轮最佳结果，也可能还没有候选通过持续复测。查看弹窗里的测速状态和“规则已建立”状态，不要只比较 host 名称。

### 禁用节点后仍看到它是“当前观测”

这是预期行为。“禁用”表示不再把该 host 作为测速、优选和重定向目标，但不会屏蔽 B 站自己签发的原始媒体请求。节点会继续显示，历史成绩也会保留；点击“重新启用”即可让它恢复参与选择。

### 直播没有反应

这是预期行为。当前版本只处理 `bilivideo.com` 点播媒体，不处理 B 站直播。

## 提交问题时

建议提供扩展版本、浏览器版本、大致地区、问题发生阶段和相关 CDN host。不要公开完整媒体 URL、签名参数、Cookie、账号信息或不必要的视频/个人页面标识。
