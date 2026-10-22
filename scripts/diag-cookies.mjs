/**
 * 列出所有 xiaohongshu 相关 cookie 的域 / 过期时间 / 是否 httpOnly。
 * 用于判断 www 域与 creator 域是否各自持有独立会话。
 */
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PROFILE_DIR = path.join(os.homedir(), '.xhs-mcp', 'profile');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
try {
  const cookies = await ctx.cookies();
  const xhs = cookies.filter(c => c.domain.includes('xiaohongshu.com'));
  console.log(`共 ${xhs.length} 个 cookie\n`);
  const rows = xhs.map(c => ({
    name: c.name,
    domain: c.domain,
    len: c.value.length,
    httpOnly: c.httpOnly,
    expires: c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString().slice(0, 10),
  }));
  rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  console.table(rows);

  // 分别按域查询同一个 URL 会带上哪些 cookie（服务端看到的就是这个集合）
  for (const url of ['https://www.xiaohongshu.com/explore', 'https://creator.xiaohongshu.com/creator/home']) {
    const visible = await ctx.cookies(url);
    const names = visible.filter(c => c.domain.includes('xiaohongshu')).map(c => `${c.name}@${c.domain}`).sort();
    console.log(`\n${url}\n  ${names.join(', ')}`);
  }
} finally {
  await ctx.close().catch(() => undefined);
}
