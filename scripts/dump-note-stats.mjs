/**
 * 一次性诊断脚本：dump 创作者中心笔记列表接口的完整响应。
 * 目的：确认互动指标（浏览/点赞/收藏/评论/分享）的真实字段名与取值范围。
 * 用法：node scripts/dump-note-stats.mjs <输出路径>
 */
import fs from 'node:fs';
import { closeBrowser, getPage, sleep } from '../dist/browser.js';
import { URLS } from '../dist/config.js';

const outPath = process.argv[2] ?? 'note-stats-raw.json';
const PATTERN = /\/api\/galaxy\/v2\/creator\/note\/user\/posted/;

const page = await getPage();
const pending = [];
const hits = [];

page.on('response', res => {
  if (!PATTERN.test(res.url())) return;
  pending.push(
    res
      .json()
      .then(body => hits.push({ url: res.url(), body }))
      .catch(() => undefined),
  );
});

await page.goto(URLS.creatorNoteManage, { waitUntil: 'domcontentloaded' }).catch(e => console.log('goto 失败:', e.message));
await sleep(9000);
await Promise.allSettled(pending);

console.log(`截获 ${hits.length} 条列表响应`);
if (hits.length > 0) {
  fs.writeFileSync(outPath, JSON.stringify(hits, null, 2), 'utf8');
  console.log(`已写入 ${outPath}`);
}

await closeBrowser();
