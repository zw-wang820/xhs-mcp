#!/usr/bin/env node
/**
 * npm bin 入口。
 *
 * MCP 客户端只认一个可执行命令，标准做法是 `npx -y xhs-mcp`。
 * 这里做两件额外的事：
 *   1. 检测 Chromium 是否就绪，缺失时给出明确指引（而不是让用户在 MCP 里看到一坨 Playwright 报错）
 *   2. 把子进程的 stdout/stderr 原样透传，保证 stdio 协议不被污染
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'server.js');

if (!existsSync(entry)) {
  process.stderr.write(
    'xhs-mcp: 找不到 dist/server.js。如果你是从源码安装，请先运行 `npm run build`。\n',
  );
  process.exit(1);
}

// Chromium 缺失时提前拦下，给出可复制的修复命令
try {
  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) {
    process.stderr.write(
      [
        '',
        '─'.repeat(68),
        'xhs-mcp 需要 Playwright 自带的 Chromium，但本机还没下载。',
        '请在终端执行一次（约 150MB）：',
        '',
        '    npx playwright install chromium',
        '',
        '下载完成后重新启动即可。这个步骤只需做一次。',
        '─'.repeat(68),
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
} catch {
  // playwright 本身缺失属于依赖安装异常，交给下面的 spawn 暴露真实错误
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
