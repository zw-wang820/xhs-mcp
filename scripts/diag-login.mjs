/**
 * 诊断：登录态判定与页面实际状态是否一致。
 *
 * 关注三件事：
 *  1. 浏览器启动时恢复的是什么页面（Playwright persistent context 会恢复上次会话）
 *  2. www 首页在 cookie 有效时，DOM 上是否仍显示「登录」入口
 *  3. web_session cookie 的实际过期时间
 *
 * 用法：node scripts/diag-login.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PROFILE_DIR = path.join(os.homedir(), '.xhs-mcp', 'profile');
const OUT = path.join(os.homedir(), '.xhs-mcp', 'captures');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1440, height: 920 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--disable-blink-features=AutomationControlled'],
});

try {
  // 1. 启动瞬间的页面 = 上次会话恢复的页面
  const restored = ctx.pages().map(p => ({ url: p.url(), title: '' }));
  console.log('=== 启动时恢复的页面 ===');
  console.log(JSON.stringify(restored, null, 2));

  const cookies = await ctx.cookies('https://www.xiaohongshu.com');
  const session = cookies.find(c => c.name === 'web_session');
  const webId = cookies.find(c => c.name === 'webId');
  console.log('\n=== cookie ===');
  console.log(`总数 ${cookies.length}`);
  console.log(`web_session: ${session ? `存在, 长度 ${session.value.length}` : '缺失'}`);
  if (session) {
    const expiresAt = session.expires === -1 ? '会话级（关浏览器即失效）' : new Date(session.expires * 1000).toLocaleString('zh-CN');
    console.log(`  过期时间: ${expiresAt}`);
  }
  console.log(`webId: ${webId ? webId.value : '缺失'}`);

  // 2. 打开首页，看 DOM 上到底是已登录还是登录引导
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const probe = await page.evaluate(() => {
    const root = window.__INITIAL_STATE__;
    const ui = root && root.user && root.user.userInfo;
    const inner = ui && ui._value;
    const guestRaw = inner ? inner.guest : undefined;

    // 页面上可见的「登录」字样（排除隐藏元素）
    const loginTexts = [];
    for (const el of document.querySelectorAll('button, div, span, a')) {
      const text = (el.textContent ?? '').trim();
      if (text !== '登录' && text !== '立即登录' && text !== '登录/注册') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      loginTexts.push({ text, cls: (el.className || '').slice(0, 40) });
      if (loginTexts.length >= 5) break;
    }

    const avatar = Boolean(document.querySelector('.user .avatar, img.avatar, .side-bar .user'));

    return {
      pageUrl: location.href,
      pageTitle: document.title,
      hasInitialState: Boolean(root),
      userInfoKeys: inner ? Object.keys(inner) : null,
      guest: guestRaw,
      userId: inner ? inner.userId : undefined,
      loginEntryVisible: loginTexts,
      avatarVisible: avatar,
      bodyHead: (document.body.innerText || '').slice(0, 200).replace(/\n+/g, ' | '),
    };
  });

  console.log('\n=== www/explore 页面状态 ===');
  console.log(JSON.stringify(probe, null, 2));

  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, `diag-login-${Date.now()}.png`);
  await page.screenshot({ path: shot });
  console.log(`\n截图：${shot}`);

  // 2.5 www 域的个人主页：本人视角 vs 访客视角
  //     本人视角会出现「编辑资料」，访客视角会出现「关注」
  const profileUrl = `https://www.xiaohongshu.com/user/profile/${probe.userId}`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const profile = await page.evaluate(() => {
    const texts = ['编辑资料', '关注', '发消息', '我的收藏', '笔记'];
    const found = {};
    for (const t of texts) {
      found[t] = false;
      for (const el of document.querySelectorAll('button, div, span, a')) {
        if ((el.textContent ?? '').trim() !== t) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          found[t] = true;
          break;
        }
      }
    }
    const root = window.__INITIAL_STATE__;
    const ui = root && root.user && root.user.userInfo;
    const inner = ui && ui._value;
    return {
      pageUrl: location.href,
      guest: inner ? inner.guest : undefined,
      hasEditProfile: found['编辑资料'],
      hasFollow: found['关注'],
      hasMessage: found['发消息'],
      verdict: found['编辑资料'] ? '本人视角（已登录）' : found['关注'] || found['发消息'] ? '访客视角（未登录）' : '无法判定',
    };
  });
  console.log('\n=== www 个人主页视角 ===');
  console.log(JSON.stringify(profile, null, 2));

  // 3. 再看创作者中心（真正干活的域）
  await page.goto('https://creator.xiaohongshu.com/creator/notemanage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const creator = await page.evaluate(() => ({
    pageUrl: location.href,
    redirectedToLogin: /login/i.test(location.href),
    head: (document.body.innerText || '').slice(0, 150).replace(/\n+/g, ' | '),
  }));
  console.log('\n=== creator/notemanage 页面状态 ===');
  console.log(JSON.stringify(creator, null, 2));
} finally {
  await ctx.close().catch(() => undefined);
}
