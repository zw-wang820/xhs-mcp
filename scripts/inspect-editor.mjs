/**
 * 图文编辑区结构探测：上传一张本地测试图，定位标题 / 正文输入框与操作按钮。
 * 只上传素材，不填文字、不点发布、不存草稿 —— 不会产生任何笔记。
 * 用法：node scripts/inspect-editor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { URLS } from '../dist/config.js';
import { closeBrowser, getPage, sleep } from '../dist/browser.js';

const shotPath = path.join(os.tmpdir(), `xhs-probe-${Date.now()}.png`);

const page = await getPage();
await page.goto(URLS.creatorPublish, { waitUntil: 'domcontentloaded' });
// file input 是隐藏元素，只能等 attached，等 visible 会一直超时
await page.waitForSelector('input[type="file"][accept*="jpg"]', { state: 'attached', timeout: 30000 });
await sleep(2500);

await page.screenshot({ path: shotPath });
console.log(`测试素材: ${shotPath} (${Math.round(fs.statSync(shotPath).size / 1024)} KB)`);

const fileInput = page.locator('input[type="file"]').first();
await fileInput.setInputFiles([shotPath]);
console.log('已上传测试素材，等待编辑器渲染...');
await sleep(8000);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(2500);

const editor = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input, textarea'))
    .filter(el => el.getAttribute('type') !== 'file')
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      placeholder: el.getAttribute('placeholder') ?? '',
      cls: (el.className || '').slice(0, 50),
      visible: Boolean(el.offsetParent),
    }))
    .filter(i => i.visible);

  const editables = Array.from(document.querySelectorAll('[contenteditable="true"], .ql-editor, [role="textbox"]')).map(
    el => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').slice(0, 50),
      placeholder: el.getAttribute('data-placeholder') ?? el.getAttribute('placeholder') ?? '',
      visible: Boolean(el.offsetParent),
    }),
  );

  const wanted = ['发布', '草稿', '暂存', '保存'];
  const actions = [];
  for (const el of document.querySelectorAll('button, [role="button"], div, span, a')) {
    const text = (el.textContent ?? '').trim();
    if (text.length === 0 || text.length > 6) continue;
    if (!wanted.some(w => text.includes(w))) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    actions.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').slice(0, 50),
      text,
      y: Math.round(rect.y),
      rect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
    });
  }

  actions.sort((a, b) => a.y - b.y);
  const buttons = Array.from(document.querySelectorAll('button')).map(el => {
    const rect = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? '').trim().slice(0, 10),
      cls: (el.className || '').slice(0, 40),
      y: Math.round(rect.y),
    };
  });

  return { inputs, editables, actions: actions.slice(-20), buttons };
});

console.log('\n=== 可见 input / textarea ===');
console.log(JSON.stringify(editor.inputs, null, 2));
console.log('\n=== contenteditable ===');
console.log(JSON.stringify(editor.editables, null, 2));
console.log('\n=== 发布 / 草稿 相关元素 ===');
console.log(JSON.stringify(editor.actions, null, 2));

console.log('\n未提交任何内容，浏览器即将关闭。');
await closeBrowser();
