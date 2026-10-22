/**
 * 接口校准工具。
 *
 * 用法：
 *   npm run capture -- https://creator.xiaohongshu.com/creator/notemanage
 *   npm run capture -- https://www.xiaohongshu.com/explore --wait 12000
 *
 * 作用：打开指定页面，把小红书域下所有 XHR / fetch 的响应 JSON 落盘。
 * 当前端改版导致 API_PATTERNS 匹配不到时，跑一次这个命令，
 * 从 captures/*.json 里找到新地址，改 src/config.ts 一处即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'playwright';
import { CAPTURE_DIR } from '../config.js';
import { closeBrowser, getPage, sleep } from '../browser.js';

const args = process.argv.slice(2);

function readFlag(name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const raw = args[index + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const targetUrl = args.find(a => a.startsWith('http'));
if (!targetUrl) {
  process.stdout.write('用法：npm run capture -- <page-url> [--wait 8000]\n');
  process.exit(1);
}
const waitMs = readFlag('wait', 8000);

type Hit = { url: string; status: number; body: unknown };

const hits: Hit[] = [];
const pending: Promise<void>[] = [];

const page = await getPage();
page.on('response', (res: Response) => {
  const url = res.url();
  if (!/xiaohongshu\.com/.test(url)) return;
  const type = res.request().resourceType();
  if (type !== 'xhr' && type !== 'fetch') return;
  pending.push(
    res
      .json()
      .then(body => {
        hits.push({ url, status: res.status(), body });
      })
      .catch(() => undefined),
  );
});

process.stdout.write(`打开 ${targetUrl}，采集 ${waitMs}ms ...\n`);
await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
await sleep(waitMs);
await Promise.allSettled(pending);

fs.mkdirSync(CAPTURE_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(CAPTURE_DIR, `capture-${stamp}.json`);
fs.writeFileSync(outFile, `${JSON.stringify(hits, null, 2)}\n`, 'utf8');

process.stdout.write(`\n捕获 ${hits.length} 条接口响应：\n`);
for (const hit of hits) {
  const pathname = new URL(hit.url).pathname;
  process.stdout.write(`  [${hit.status}] ${pathname}\n`);
}
process.stdout.write(`\n完整 JSON 已写入：${outFile}\n`);
process.stdout.write('浏览器保持打开，可继续手动操作观察。按 Ctrl+C 结束进程。\n');

await new Promise<void>(resolve => {
  process.on('SIGINT', () => resolve());
});
await closeBrowser();
