/**
 * 诊断脚本：验证登录态 + 盘点创作者中心真实接口 + 测试笔记读取。
 * 用法：node scripts/probe.mjs
 *
 * 它会把页面自己发出的所有 XHR / fetch 列出来，
 * 匹配不上时直接从这里的输出里找新地址，改 src/config.ts 的 API_PATTERNS。
 */
import { URLS } from '../dist/config.js';
import { closeBrowser, getPage, sleep } from '../dist/browser.js';
import { readAuthState } from '../dist/auth.js';
import { listMyNotes, getNote } from '../dist/tools/notes.js';

const state = await readAuthState();
console.log('=== 登录态 ===');
console.log(`loggedIn=${state.loggedIn} nickname=${state.nickname} userId=${state.userId} source=${state.infoSource}`);

const pending = [];
const hits = [];

const page = await getPage();
page.on('response', res => {
  const url = res.url();
  if (!/xiaohongshu\.com/.test(url)) return;
  const type = res.request().resourceType();
  if (type !== 'xhr' && type !== 'fetch') return;
  pending.push(
    res
      .json()
      .then(body => hits.push({ url, body }))
      .catch(() => undefined),
  );
});

console.log('\n=== 打开创作者中心笔记管理页 ===');
await page.goto(URLS.creatorNoteManage, { waitUntil: 'domcontentloaded' }).catch(e => console.log(`goto 失败: ${e.message}`));
await sleep(8000);
await Promise.allSettled(pending);

console.log(`当前地址: ${page.url()}`);
console.log(`截获 ${hits.length} 条接口：`);
for (const hit of hits) {
  let keys = '';
  if (hit.body && typeof hit.body === 'object') {
    keys = Object.keys(hit.body).slice(0, 6).join(',');
  }
  console.log(`  ${new URL(hit.url).pathname}${keys ? `  {${keys}}` : ''}`);
}

console.log('\n=== listMyNotes ===');
try {
  const result = await listMyNotes(10);
  console.log(`source=${result.source} count=${result.count}`);
  if (result.hint) console.log(`hint: ${result.hint}`);
  for (const note of result.notes) {
    console.log(`  - ${note.noteId ?? '(无ID)'} | ${(note.title ?? '(无标题)').slice(0, 30)} | 赞${note.likeCount ?? '-'}`);
  }

  const first = result.notes.find(n => n.noteId && n.url);
  if (first?.url) {
    console.log('\n=== getNote（用带 xsec_token 的 url）===');
    try {
      const detail = await getNote(first.url);
      console.log(`source=${detail.source} title=${detail.title ?? '(无)'}`);
      console.log(`desc=${(detail.desc ?? '').slice(0, 120)}`);
      console.log(`tags=${detail.tags.join(',') || '(无)'} images=${detail.images.length}`);
    } catch (err) {
      console.log(`失败: ${err.message}`);
    }
  }
} catch (err) {
  console.log(`listMyNotes 失败: ${err.message}`);
}

const after = await readAuthState();
console.log('\n=== 账号信息（列表操作后应已补齐昵称）===');
console.log(`nickname=${after.nickname ?? '(未取到)'} userId=${after.userId} source=${after.infoSource}`);

await closeBrowser();
