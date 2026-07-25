# Chrome Web Store 隐私字段

这份文档是开发者后台的填写草稿，不是法律意见。提交前应以当时页面显示的字段为准。

## 单一用途

> 在用户打开并播放 B 站点播视频时，本地观察、测速并切换 `bilivideo.com` 媒体 CDN host，以改善因节点或路由不佳导致的缓冲；不处理直播或其他网站。

## 权限说明

### `activeTab`

用户点击扩展弹窗时，读取当前活动标签页的 ID 和 URL，用于判断它是否为支持的 B 站点播页，并显示这个标签页的本地状态。扩展不会借此读取其他标签页内容。

### `storage`

在 `chrome.storage.local` 保存启停、自动/手动模式、自动重新优选档位、自定义或暂时禁用的 host，以及有数量和期限上限的本地节点表现摘要。数据不上传，也不使用 `storage.sync`。

### `webRequest`

只读观察目标为 `*.bilivideo.com` 的媒体请求、Range、完成状态和错误，以识别当前 CDN、使用播放器正在访问的字节位置测速，并判断切换后的请求是否成功。扩展不修改请求头，不读取 Cookie，也不使用 `webRequestBlocking`。

### `declarativeNetRequestWithHostAccess`

为当前 B 站点播标签页建立会话级重定向规则，只把经过校验的 `*.bilivideo.com` scheme/host 替换为另一个经过校验的候选，保留原路径、查询参数和签名。规则还限制发起方、请求类型与标签页，浏览器会话结束后失效。

### `https://www.bilibili.com/*` 与 `https://m.bilibili.com/*`

运行只读播放地址观察器和本地测速脚本。Manifest 的内容脚本匹配范围进一步收窄到视频、番剧和课程点播路径。

### `https://*.bilivideo.com/*`

观察、测速并在用户启用时切换 B 站媒体 CDN。该权限不涵盖其他域名。

## 远程代码

选择：

> No, I am not using remote code.

补充说明：

> All JavaScript executed by the extension is included in the submitted package. The extension parses media URL data returned by Bilibili, but it does not download or execute scripts, modules, commands, or configuration logic from a remote source. It does not use `eval` or dynamic code generation.

## 数据使用

Chrome 的政策把本地处理也算作“处理用户数据”。为避免低报，建议按保守口径勾选：

- **Web browsing activity**：仅限用户访问的 B 站点播页 URL 与 `bilivideo.com` 媒体请求，用来识别作用范围、当前 CDN 和请求状态。
- **Website content**：仅限 B 站 `playurl` 响应中现成的媒体 URL，以及播放器的本地缓冲状态；这些信息只用于测速、切换与卡顿恢复。

不勾选：

- Personally identifiable information
- Health information
- Financial and payment information
- Authentication information
- Personal communications
- Location
- User activity（除上述 Web browsing activity 外）
- User-provided content

## 数据去向与保存

- 开关、模式、自定义 host 和有限的 host 统计保存在 `chrome.storage.local`。
- 完整媒体 URL 只在扩展内存中短暂存在，用于当前标签页的测速；关闭标签页、重启扩展后台或退出浏览器后消失。
- 每个候选 CDN 会像正常播放一样收到用户 IP 和媒体请求，但请求直接发往 B 站使用的 `bilivideo.com` 基础设施，不经过开发者服务器。
- 不向开发者、广告商、分析服务或数据经纪人传输数据。

## Limited Use 认证

可确认以下声明：

- 数据只用于商店页面和扩展界面中明确说明的单一用途。
- 不出售数据，也不用于个性化广告、信用评估或无关用途。
- 不允许开发者或第三方人工读取用户数据。
- 不把数据用于与 CDN 观测、测速、切换和恢复无关的功能。

隐私政策 URL：

`https://github.com/liiliiliil/bili-cdn-switcher/blob/main/PRIVACY.md`

## 审核前再核对

- Manifest 没有新增权限或 host。
- README、商店说明、弹窗和隐私政策对处理范围的说法一致。
- 包内没有远程脚本、分析 SDK、广告代码或开发者服务器地址。
- `PRIVACY.md` 链接已经在 GitHub 主分支公开可访问。
