import fs from 'node:fs';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { LIMITS, PROFILE_DIR, ROOT, URLS } from './config.js';
import { log } from './logger.js';

let ctx: BrowserContext | null = null;

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 区间随机停顿，避免固定节奏被识别 */
export async function pacing(minMs = 400, maxMs = 1200): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

function launchPersistent(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    // 必须是有头浏览器：headless 在小红书风控下极易被判为机器人，发布环节尤其明显
    headless: false,
    viewport: { width: 1440, height: 920 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/**
 * profile 目录同一时刻只能被一个 Chromium 实例持有。
 *
 * 常见触发场景：上一个 MCP 进程刚结束但浏览器还没退干净、或者用户在终端跑脚本的同时
 * WorkBuddy 里的 MCP 也占着 profile。此时 Chromium 会把启动请求转交给已存在实例然后
 * 自己退出，Playwright 收到的报错是 "Target page, context or browser has been closed"，
 * 完全看不出真实原因，所以这里做一次短重试 + 人话翻译。
 */
function isProfileBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /browser has been closed|ProcessSingleton|already in use|Target page, context/i.test(message);
}

export async function getContext(): Promise<BrowserContext> {
  if (ctx) {
    const browser = ctx.browser();
    if (!browser || browser.isConnected()) return ctx;
    log('existing context disconnected, relaunching');
    ctx = null;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(ROOT, { recursive: true });
  log('launching persistent chromium at', PROFILE_DIR);

  let launched: BrowserContext;
  try {
    launched = await launchPersistent();
  } catch (err) {
    if (!isProfileBusy(err)) throw err;
    log('profile busy (上一个实例可能还在退出), 2 秒后重试一次');
    await sleep(2000);
    try {
      launched = await launchPersistent();
    } catch {
      throw new Error(
        `浏览器 profile 被其他进程占用：${PROFILE_DIR}\n` +
          '同一时刻只能有一个 xhs-mcp 实例使用它。请先关闭占用方：\n' +
          '  · 若是在终端跑脚本，WorkBuddy 里的 MCP 可能正持有浏览器 —— 在那个会话里调用 xhs_close_browser，或直接关掉弹出的浏览器窗口；\n' +
          '  · 若有残留的 Chromium 进程，结束它再重试（登录态已持久化，不会丢）。',
      );
    }
  }
  ctx = launched;
  ctx.setDefaultNavigationTimeout(LIMITS.navigationTimeoutMs);

  // 兜底：esbuild/tsx 的 keepNames 会把具名函数包成 `__name(fn, "fn")`，
  // 而 page.evaluate 的回调是序列化后进浏览器执行的，那里没有 `__name`。
  // 注入一个空实现，避免任何残留的 evaluate 因这个 helper 崩掉。
  await ctx.addInitScript(() => {
    const scope = window as unknown as Record<string, unknown>;
    if (typeof scope['__name'] !== 'function') {
      scope['__name'] = (target: unknown) => target;
    }
  });

  return ctx;
}

export async function getPage(): Promise<Page> {
  const context = await getContext();
  const pages = context.pages().filter(p => !p.isClosed());

  /**
   * 可复用的页面判定。
   *
   * 为什么排除 /login：小红书 www 域的 web_session 可能被服务端单独注销，
   * 此时残留的标签页停在 /login。若复用它，后续所有操作都会做在登录页上
   * （曾出现标题被读成「手机号登录」）。creator 域是干活的主战场，
   * 优先落在那里，用户看到的也是已登录状态。
   */
  const isUsable = (p: Page): boolean => {
    const url = p.url();
    if (url === 'about:blank') return false;
    if (/\/login/i.test(url)) return false;
    return url.includes('xiaohongshu.com');
  };

  const target =
    pages.find(p => isUsable(p) && p.url().includes('creator.xiaohongshu.com')) ??
    pages.find(isUsable) ??
    pages[0];
  const page = target ?? (await context.newPage());
  if (!isUsable(page)) {
    await page.goto(URLS.creatorHome, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }
  await page.bringToFront();
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (!ctx) return;
  log('closing browser');
  await ctx.close().catch(() => undefined);
  ctx = null;
}

/**
 * 逐字符输入，带随机间隔。小红书对「整段文本一次性注入」比较敏感，
 * 尤其是标题和正文输入框会做输入事件校验。
 */
export async function humanType(locator: Locator, text: string, clearFirst = true): Promise<void> {
  if (clearFirst) {
    await locator.click();
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await locator.press('Backspace');
    await pacing(150, 400);
  } else {
    await locator.click();
  }
  const [minD, maxD] = LIMITS.typeDelayMs;
  for (const ch of text) {
    await locator.pressSequentially(ch, { delay: minD + Math.random() * (maxD - minD) });
    if (ch === '\n') await pacing(120, 260);
  }
}

export async function firstVisible(candidates: Locator[], timeoutMs = 3000): Promise<Locator | null> {
  for (const loc of candidates) {
    try {
      const count = await loc.count();
      for (let i = 0; i < count; i += 1) {
        const item = loc.nth(i);
        if (await item.isVisible({ timeout: timeoutMs })) return item;
      }
    } catch {
      // 选择器不匹配时继续试下一个候选
    }
  }
  return null;
}
