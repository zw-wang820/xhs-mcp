# xhs-mcp 开发笔记

> 这是我自己用的开发文档，记录了真机探测出来的接口细节、选择器、踩过的坑。
> 面向使用者的说明在 [README.md](README.md)。



小红书本地 MCP Server。让智能体读你自己的笔记、按指令填写或发布图文笔记，全程通过一个有头浏览器操作网页版。

## 为什么是这个方案

| 路径 | 可行性 | 说明 |
|---|---|---|
| 账号密码登录 | ❌ 不做 | 网页版密码登录触发滑块 / 短信验证；密码落盘风险不可接受 |
| 官方开放平台 API | ❌ 个人号无权限 | 需企业主体 + 营业执照，「笔记发布」权限审核严格；access_token 仅 2 小时且无 refresh |
| 浏览器自动化 | ✅ 采用 | 复用真实浏览器环境，扫码登录一次长期有效 |

不伪造请求：小红书前端对接口做 x-s 签名，本项目只**截获页面自己发出的请求**，做旁观者。

## 安装

```bash
npm install
npx playwright install chromium
npm run build
```

## 首次登录（扫码）

```bash
npm run login
```

弹出 Chromium 窗口后用小红书 App 扫码。登录态保存在 `~/.xhs-mcp/profile`，之后不用重复登录。

## 接入 MCP

在 MCP 客户端的配置里加入（WorkBuddy 用户改 `~/.workbuddy/mcp.json`）：

```json
{
  "mcpServers": {
    "xiaohongshu": {
      "command": "node",
      "args": ["<仓库绝对路径>/xhs-mcp/dist/server.js"]
    }
  }
}
```

写完后到连接器管理页右上角「自定义连接器」入口点「信任」启用。

## 工具清单

| 工具 | 作用 | 副作用 |
|---|---|---|
| `xhs_auth_status` | 分别探活 creator 与 www 两个域，返回 `creatorLoggedIn` / `wwwLoggedIn` | — |
| `xhs_login` | 扫码登录并持久化登录态 | — |
| `xhs_list_my_notes` | 我发布的笔记列表（含点赞/阅读/收藏、带 xsec_token 的 url） | — |
| `xhs_get_note` | 单篇笔记正文 / 话题 / 图片 / 互动数 | — |
| `xhs_get_note_stats` | 单篇数据：曝光/观看/点赞/收藏/评论/分享/涨粉/人均时长/封面点击率 + 窗口汇总 + 曝光排名 | — |
| `xhs_list_note_stats` | 时间窗内全部笔记按曝光排行 + 整体汇总 | — |
| `xhs_save_draft` | 填好内容停在发布页，**不提交** | 低 |
| `xhs_publish_note` | 真正点「发布笔记」，需 `confirm=true` | 高 |
| `xhs_close_browser` | 关闭浏览器释放 profile 锁 | — |

## 怎么调用

### 方式一：对话里说人话（推荐）

MCP 启用后，工具是给智能体用的，你不需要记工具名和参数。直接说需求即可：

| 你说 | 智能体会调 |
|---|---|
| 「检查一下小红书登录还有效吗」 | `xhs_auth_status` |
| 「我登录过期了，扫码」 | `xhs_login` |
| 「列一下我最近 5 篇笔记」 | `xhs_list_my_notes {limit:5}` |
| 「看看这篇笔记的正文」+ 链接 | `xhs_get_note {target:"<链接>"}` |
| 「这篇曝光多少、涨了几个粉」 | `xhs_get_note_stats {target:"<链接或ID>"}` |
| 「我最近哪篇笔记表现最好」 | `xhs_list_note_stats {days:30}` |
| 「最近一个月总共曝光多少」 | `xhs_list_note_stats` 里的 `summary` |
| 「把这段内容存成小红书草稿」 | `xhs_save_draft` |
| 「直接发布」（明确要求才会走） | `xhs_publish_note {confirm:true}` |
| 「把浏览器关掉」 | `xhs_close_browser` |

### 方式二：命令行直连（调试用）

不经过 MCP 客户端，直接对单个工具发一次调用，适合排查问题：

```bash
cd <仓库路径>/xhs-mcp

node scripts/call.mjs --list                                        # 列出全部工具与参数
node scripts/call.mjs xhs_auth_status                               # 无参数工具
node scripts/call.mjs xhs_list_my_notes '{"limit":3}'               # JSON 传参
node scripts/call.mjs xhs_get_note '{"target":"https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>"}'
node scripts/call.mjs xhs_get_note_stats '{"target":"<24位笔记ID>"}'
node scripts/call.mjs xhs_list_note_stats '{"days":30,"limit":5}'
```

**注意：profile 是独占的。** 同一时刻只能有一个进程持有 `~/.xhs-mcp/profile`。如果 WorkBuddy 里的 MCP 正跑着浏览器，终端脚本会启动失败（报错已翻译成中文并提示解法）。先在那个会话里调 `xhs_close_browser`，或直接关掉弹出的浏览器窗口。

### 工具之间是有顺序的

```
xhs_auth_status  ──未登录──>  xhs_login  ──>  再查 auth_status
       │
    已登录
       ↓
xhs_list_my_notes ──> 拿 noteId + url（含 xsec_token）──> xhs_get_note
```

`xhs_get_note` 必须用列表返回的**带 `xsec_token` 的 url**，裸 ID 会被拒（「当前笔记暂时无法浏览」）。这是小红书现在的访问控制。

### 返回值怎么读

`xhs_list_my_notes` 单条：

```json
{
  "noteId": "<你的笔记ID>",
  "title": "10🈷️ 19 日锻炼日记💪🏋️",
  "type": "normal",
  "publishTime": "2026-10-19 22:00",
  "viewCount": 13, "likeCount": 1,
  "collectCount": 0, "commentCount": 0, "shareCount": 0,
  "url": "https://www.xiaohongshu.com/explore/...?xsec_token=...",
  "xsecToken": "..."
}
```

`viewCount` 来自创作者中心（含曝光口径），和笔记页显示的阅读数可能有差异，分析时以这个为准。

`xhs_get_note_stats` 的返回（真实数据）：

```json
{
  "window": { "days": 30, "begin": "2026-09-23 00:00", "end": "2026-10-22 23:59" },
  "totalInWindow": 3,
  "note": {
    "noteId": "<你的笔记ID>",
    "title": "10🈷️ 20 日锻炼日记💪🏋️",
    "postTime": "2026-10-20 22:09",
    "impressions": 347,
    "reads": 20,
    "likes": 1, "collects": 0, "comments": 0, "shares": 0,
    "fansGained": 0,
    "avgViewSeconds": 8,
    "coverClickRate": 0.058,
    "coverClickRateText": "5.8%"
  },
  "summary": { "notes": 3, "impressions": 755, "reads": 53, "likes": 2, "fansGained": 0 },
  "rankByImpressions": { "position": 1, "of": 3 },
  "found": true
}
```

**为什么要把 `summary` 和 `rankByImpressions` 一起返回**：单看「曝光 347」没有意义，配合同期 3 篇共 755 曝光、这篇排第 1，才读得出好坏。

## 数据中心的三个坑

这些是 2026-10-22 实测踩出来的，改代码前先看：

| 坑 | 表现 | 应对 |
|---|---|---|
| 只覆盖近期笔记 | 把时间窗从 30 天扩到 400 天，`total` 还是 3 | 工具检测到「扩窗后条数没增加」就停止探测，不空跑 400 天 |
| 请求必须由页面发出 | 用 `page.request` 自己构造同一 URL，一律 **406** | 只做「打开页面 + 旁观响应」，绝不构造请求 |
| 字段名反直觉 | 收藏是 `fav_count`（不是 `collect_count`），涨粉是 `increase_fans_count` | 已在 `tools/stats.ts` 里归一化成 `collects` / `fansGained` |

## 验证状态（2026-10-22 真机实测）

| 能力 | 状态 | 备注 |
|---|---|---|
| 扫码登录 / 登录态持久化 | ✅ 已验证 | 重启进程后 cookie 仍有效 |
| 账号信息读取 | ✅ 已验证 | userId 来自 www；昵称来自创作者中心 `userName` 字段 |
| 笔记列表 | ✅ 已验证 | 接口 `/api/galaxy/v2/creator/note/user/posted` |
| 笔记详情 | ✅ 已验证 | 需带 `xsec_token`，走 DOM 解析 |
| 双域登录态诊断 | ✅ 已验证 | www 失效时能准确报告，且实测不影响任何工具 |
| 单篇数据指标 | ✅ 已验证 | 曝光 347 / 观看 20 / 点击率 5.8%，与页面表格逐项一致 |
| 数据排行与汇总 | ✅ 已验证 | 按曝光降序 347 > 244 > 164 |
| 窗口外笔记的降级 | ✅ 已验证 | 2 次探测后明确告知「只保留近期数据」 |
| 填写标题 / 正文 / 话题 / 图片 | ✅ 已验证 | 话题能正确转成 chip |
| 点击「发布笔记」 | ⚠️ 未实测 | 为避免产生公开内容，未在真实账号上跑过 |
| 10 分钟发布频率闸门 | ✅ 已实现 | 逻辑单测未覆盖，靠代码审查 |

## 关键接口与选择器（改版时优先看这里）

接口特征集中在 `src/config.ts` 的 `API_PATTERNS`，选择器集中在 `src/tools/publish.ts` 的 `SELECTOR`。

实测确认的事实：

- 笔记列表接口：`/api/galaxy/v2/creator/note/user/posted`
- 账号信息接口：`/api/galaxy/user/info`，昵称字段是 **`userName`**（不是 `nickname`）
- 创作者中心的 `userId` 与 www 域的 `userId` **不是同一个值**，别混用；`redId` 才是对外的小红书号
- 笔记详情页必须带 `?xsec_token=...&xsec_source=pc_creatormng`，裸笔记 ID 会返回「当前笔记暂时无法浏览」
- 发布页默认落在「上传视频」模式，URL 必须带 `?target=image` 才是图文模式
- 标题框 `input[placeholder="填写标题会有更多赞哦"]`；正文是 ProseMirror `div.tiptap.ProseMirror`
- 提交按钮 `div.publish-video .btn-wrapper`，文本「发布笔记」
- **没有「存草稿」按钮**：草稿在离开页面时弹窗保存，所以 `xhs_save_draft` 的语义是「填好但停在页面」
- 数据中心单篇分析接口 `/api/galaxy/creator/datacenter/note/analyze/list`，参数 `post_begin_time` / `post_end_time`（毫秒）

### 数据指标字段名（`note_infos` 单项）

| 中文 | 字段 | 说明 |
|---|---|---|
| 曝光 | `imp_count` | 数据中心口径 |
| 观看 | `read_count` | 笔记页显示的「阅读」 |
| 点赞 | `like_count` | — |
| 收藏 | `fav_count` | **不是** `collect_count` |
| 评论 | `comment_count` | — |
| 分享 | `share_count` | — |
| 涨粉 | `increase_fans_count` | 因这篇新增的粉丝 |
| 人均观看时长 | `view_time_avg` | 秒 |
| 封面点击率 | `coverClickRate` | 0-1 小数，`0.058` = 5.8% |
| 发布时间 | `post_time` | 毫秒时间戳 |
| 笔记 ID | `id` | 24 位 |

## 接口 / 选择器失效怎么办

```bash
node scripts/call.mjs --list    # 列出全部工具与参数，也可直接调用任意单个工具
node scripts/probe.mjs          # 登录态 + 创作者中心全部接口 + 列表/详情读取
node scripts/diag-login.mjs     # 诊断：两域登录态、页面视角、cookie 过期时间
node scripts/diag-cookies.mjs   # 诊断：cookie 的域分布与各自过期时间
node scripts/inspect-editor.mjs # 发布页编辑器结构（会上传一张测试图，不提交）
node scripts/test-draft.mjs     # 端到端跑一遍填写链路，不提交
node scripts/smoke.mjs          # 只验 MCP 协议握手与工具注册，不启动浏览器
npm run capture -- <页面地址>    # 抓任意页面的全部 XHR
```

## 两个域的登录态是独立的

这是最容易误判的地方，也是「已经登录了，为什么浏览器还停在登录页」的答案。

| 域 | 凭据 | 用途 | 失效表现 |
|---|---|---|---|
| `creator.xiaohongshu.com` | `access-token-creator.xiaohongshu.com`、`galaxy_creator_session_id` | 读笔记列表、发布、数据中心 | 跳转 `/login` |
| `www.xiaohongshu.com` | `web_session` | 打开 explore 笔记详情 | 访问个人主页时 302 到 `/login?redirectPath=...` |

两者可能一个有效、一个失效。`web_session` cookie 在本地看起来还在、过期时间也正常，但服务端可以单方面注销它——**只看 cookie 存在与否会得出错误的「已登录」结论**。

`xhs_auth_status` 因此改成真实探活，分别返回 `creatorLoggedIn` 和 `wwwLoggedIn`。实测 www 失效时：

- 浏览器打开 www 会显示登录页（`guest: true`，页面上有登录入口，头像不显示）
- 但 `xhs_list_my_notes`、`xhs_get_note`、发布**全部正常**
- 因为详情页用的是带 `xsec_token` 的链接，游客身份也能打开

所以 www 失效是**观感问题，不是功能问题**。想消除登录页，重新扫码一次即可；creator 的凭据是另一套，通常不受影响。

## 安全边界

- **不保存账号密码**，只保留 cookie 级登录态，存在本机 `~/.xhs-mcp/`。
- **写入默认不提交**：`xhs_save_draft` 填完就停手，把最后一步留给人。
- **发布频率闸门**：两次真实发布间隔不足 10 分钟直接拒绝。
- `profile/`、`captures/` 已在 `.gitignore`，不进版本库。
- 只操作自己账号，不含点赞 / 评论 / 关注 / 搜索他人内容。

## 已知限制

- **profile 独占**：同一时刻只能有一个进程持有 `~/.xhs-mcp/profile`。在终端跑脚本前，先关掉 WorkBuddy 会话里正在用的浏览器（调 `xhs_close_browser`），否则启动会失败。
- **数据中心只覆盖近期笔记**：无论时间窗多大，接口最多只返回近期发布的作品（实测 400 天窗与 30 天窗结果相同）。更早的笔记查不到单篇数据指标。
- **数据中心单页 10 条**：`page_size` 只认 10，超过或外部构造请求都返回 406。窗口内超过 10 篇时结果会被截断，返回里 `truncated: true`。
- 必须有桌面会话：headless 模式在小红书风控下极易被识别，发布环节尤其明显。
- 运行时不能关闭弹出的浏览器窗口。
- 图片上传后需人工核对封面裁切，自动化不处理封面选择。
- 昵称只在调用过 `xhs_list_my_notes` 之后才会补齐（www 页面的全局状态里不含昵称）。
- 每次进程启动都要拉起浏览器，冷启动约 2-10 秒；同进程内复用，后续调用快得多。数据中心类调用约 11 秒/次（需等页面渲染 + 接口返回）。
