# 发布指南（给自己看的操作清单）

按顺序执行。每一步都有验证点，没通过就别进入下一步。

## 0. 发布前已完成的改动

| 改动 | 文件 | 作用 |
|---|---|---|
| 去掉 `private: true`，补 `bin`/`files`/`license`/`engines`/`repository` | `package.json` | 否则无法 `npm publish` |
| 新增 npm bin 入口，自动检测 Chromium 缺失 | `src/bin.ts` | `npx -y xhs-mcp` 能直接跑 |
| 运行时目录支持 `XHS_MCP_HOME` | `src/config.ts` | 多实例隔离、数据放指定磁盘 |
| 发布间隔 10 分钟 + 写入节流 8 秒，**不读环境变量** | `src/config.ts`、`src/tools/publish.ts` | 保护使用者账号 |
| 启动打印免责声明（`XHS_MCP_QUIET=1` 可抑制输出，不影响行为） | `src/logger.ts`、`src/server.ts` | 责任边界 |
| 新增 MIT 协议 + 附加风险说明 | `LICENSE` | 明确授权与免责 |
| `.npmignore` 排除 `profile/` `captures/` `state.json` | `.npmignore` | 防止登录态被发布 |
| 对外 README（212 行），开发文档另存 | `README.md` / `README-DEV.md` | 用户看前者，你看后者 |
| 脱敏：清掉本机路径、账号 ID、笔记 ID | 全部文档 | 不暴露个人信息 |

**已扫描确认**：仓库内不含 `pml_wzw`、`E:/AI/workbuddy`、小红书号 `49965281553`、任何笔记 ID。

## 1. 建仓库并推送

```bash
cd <仓库路径>/xhs-mcp

git init
git add -A
git commit -m "feat: xhs-mcp v0.1.0"

# 先在 GitHub 网页建空仓库 xhs-mcp（不要勾选 README，避免冲突）
git branch -M main
git remote add origin git@github.com:zw-wang820/xhs-mcp.git
git push -u origin main

# 校验 ref 是否真落盘（老规矩，防假成功）
git reflog -1
git ls-remote origin main
```

**验证点**：`git ls-remote` 输出的 hash 与本地 `git rev-parse HEAD` 一致。

**推送前必查**：

```bash
git status --ignored --short | grep -E "profile|captures|state.json" || echo "无敏感目录被跟踪 ✓"
git ls-files | grep -E "profile/|captures/|state.json" && echo "⚠️ 有敏感文件被跟踪！" || echo "跟踪清单干净 ✓"
```

## 2. 发 npm 包

```bash
npm login                      # 浏览器授权
npm whoami                     # 确认身份

npm run typecheck              # 必须 0 error
npm pack --dry-run             # 看清楚要发什么
npm publish                    # 正式发布
```

**发布后立刻验证**（这一步别省，装不上等于白发）：

```bash
# 换一个干净目录，模拟陌生用户
mkdir /tmp/xhs-test && cd /tmp/xhs-test
npx -y xhs-mcp --help          # 能拉起即可（会打印免责声明后等待 stdio）
```

**验证点**：
- `npx -y xhs-mcp` 打印免责声明横幅
- 不报「找不到 dist/server.js」
- 报错信息是「需要 npx playwright install chromium」而不是一坨 Playwright 堆栈

## 3. 补 GitHub 仓库信息

- 右侧 About 填描述：`MCP server for Xiaohongshu: read your own notes, analyze stats, publish posts. No password stored.`
- Topics：`mcp` `model-context-protocol` `xiaohongshu` `playwright` `automation`
- 确认 License 显示为 MIT
- 开 Issues（关掉 blank issue，用模板更好，但非必须）

## 4. 可选：后续版本

- 等有 20+ star 再考虑上架 Smithery / mcp.so 这类目录站
- 上架前先确认平台规范，避免被当成 spam
- `README-DEV.md` 里的接口细节是维护资产，改版时优先看它

## 版本发布节奏

- `0.1.x`：修选择器、修接口特征
- `0.2.0`：新增工具（如账号概览、视频笔记）
- 每次发版更新 README 的「已知限制」表

## 不要做的事

- 不要为了让别人「开箱即用」把 Playwright Chromium 打进包里（体积会到 150MB+，且平台相关）
- 不要提供关闭风控节流的开关
- 不要把 `~/.xhs-mcp` 放进任何模板或示例
- 不要在 issue 里回复用户上传的截图（可能含他们的账号信息）
