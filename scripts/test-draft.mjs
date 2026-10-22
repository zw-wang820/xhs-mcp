/**
 * 端到端验证「填写」链路：上传图片 → 填标题 → 填正文 → 加话题，然后停在页面不提交。
 * 不点任何提交按钮，不会产生公开笔记。
 * 用法：node scripts/test-draft.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URLS } from '../dist/config.js';
import { closeBrowser, getPage, sleep } from '../dist/browser.js';
import { createNote } from '../dist/tools/publish.js';

const imagePath = path.join(os.tmpdir(), `xhs-e2e-${Date.now()}.png`);
const page = await getPage();
await page.goto(URLS.explore, { waitUntil: 'domcontentloaded' });
await sleep(2500);
await page.screenshot({ path: imagePath });
console.log(`测试图片: ${imagePath}`);

try {
  const result = await createNote({
    title: '自动化链路验证',
    content: '这是一条用于验证发布链路的测试内容，不提交。',
    images: [imagePath],
    tags: ['测试'],
    mode: 'draft',
  });
  console.log('\n=== 结果 ===');
  console.log(JSON.stringify(result, null, 2));

  const check = await getPage().then(p =>
    p.evaluate(() => ({
      title: document.querySelector('input[placeholder*="填写标题"]')?.value ?? '(未找到标题框)',
      body: (document.querySelector('div.tiptap.ProseMirror')?.innerText ?? '(未找到正文)').slice(0, 80),
    })),
  );
  console.log('\n=== 页面实际内容 ===');
  console.log(`标题: ${check.title}`);
  console.log(`正文: ${check.body}`);
} catch (err) {
  console.log(`失败: ${err.message}`);
} finally {
  await page.screenshot({ path: path.join(os.tmpdir(), 'xhs-e2e-final.png') }).catch(() => undefined);
  await closeBrowser();
  fs.rmSync(imagePath, { force: true });
}
