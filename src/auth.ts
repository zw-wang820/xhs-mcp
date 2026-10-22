import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { LIMITS, STATE_FILE, URLS } from './config.js';
import { getContext, getPage, pacing, sleep } from './browser.js';
import { log } from './logger.js';

export type AuthState = {
  loggedIn: boolean;
  userId?: string;
  nickname?: string;
  redId?: string;
  cookieCount: number;
  /** live = 本次从页面读到的；cache = 从 state.json 回退的；none = 都没有 */
  infoSource: 'live' | 'cache' | 'none';
  checkedAt: string;
};

/**
 * 完整诊断结果。
 *
 * 为什么需要它：小红书 www 域和 creator 域是**两套独立的会话**。
 * creator 靠 `access-token-creator.xiaohongshu.com` + `galaxy_creator_session_id`，
 * www 靠 `web_session`。出现过 web_session cookie 还在、本地看一切正常，
 * 但服务端已把它注销、www 主页直接 302 到 /login 的情况。
 * 只看 cookie 存在与否会给出「已登录」的假结论，所以这里对 www 做真实探活。
 */
export type AuthDiagnosis = AuthState & {
  /** 创作者中心是否可用 —— 决定能不能读列表、发布 */
  creatorLoggedIn: boolean;
  /** www 域是否可用 —— 决定能不能用 explore 链接看笔记详情 */
  wwwLoggedIn: boolean;
  /** 探活最终落到的 URL，登录失效时能看到 redirectPath */
  wwwProbeUrl: string;
  hint: string;
};

type PersistedState = {
  /** www 域的 userId */
  userId?: string;
  /** 创作者中心的 userId —— 与 www 域不是同一个值，别混用 */
  creatorUserId?: string;
  nickname?: string;
  /** 小红书号，对外可见的稳定标识 */
  redId?: string;
  lastPublishAt?: number;
  lastDraftAt?: number;
};

export function readStateFile(): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as PersistedState;
  } catch {
    return {};
  }
}

/**
 * 合并写入，但**丢弃 undefined 字段**。
 * 早先直接用 { ...old, ...patch } 合并，导致一次拿不到 nickname 的读取
 * 会把上次读到的昵称覆盖成 undefined（JSON.stringify 再把它丢掉），缓存被静默清空。
 */
export function writeStateFile(patch: Partial<PersistedState>): PersistedState {
  const previous = readStateFile();
  const next: PersistedState = { ...previous };
  for (const key of Object.keys(patch) as Array<keyof PersistedState>) {
    const value = patch[key];
    if (value !== undefined && value !== null) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 会话有效性的唯一可信信号：登录 cookie 是否存在且非空 */
async function hasSessionCookie(ctx: BrowserContext): Promise<{ ok: boolean; count: number }> {
  const cookies = await ctx.cookies();
  const xhs = cookies.filter(c => c.domain.includes('xiaohongshu.com'));
  const session = xhs.find(c => c.name === 'web_session' && c.value.trim().length > 10);
  return { ok: Boolean(session), count: xhs.length };
}

/**
 * 从页面全局状态里捞当前账号信息。
 *
 * 两个必须守住的约束：
 *
 * 1. **搜索范围限定在 `__INITIAL_STATE__.user` 子树**。全图搜索会命中信息流里其他作者的
 *    用户对象 —— 曾出现昵称随机变化（抓到的是推荐笔记作者）而 userId 却是本人的错配。
 *
 * 2. **nickname 必须和 userId 来自同一个对象**。分开收集就无法保证语义一致。
 *
 * 另外：evaluate 的回调会被序列化后送进浏览器执行，**内部不能出现具名函数**。
 * esbuild（tsx）的 keepNames 会给具名函数注入 `__name(...)` 包装，
 * 而 `__name` 只存在于 Node 侧，到了浏览器就是 ReferenceError。
 * 因此这里用显式栈做迭代，不写递归函数。
 */
async function readSelfInfo(page: Page): Promise<{ userId?: string; nickname?: string; redId?: string } | null> {
  try {
    const info = await page.evaluate(() => {
      const root = (window as unknown as Record<string, unknown>)['__INITIAL_STATE__'];
      if (!root || typeof root !== 'object') return null;

      const asRecord = root as Record<string, unknown>;
      const unwrap = asRecord['user'];
      let scope: unknown = root;
      if (unwrap && typeof unwrap === 'object') {
        const inner = (unwrap as Record<string, unknown>)['_value'];
        scope = inner && typeof inner === 'object' ? inner : unwrap;
      }

      const stack: unknown[] = [scope];
      const seen = new Set<unknown>();
      const holders: Array<Record<string, unknown>> = [];
      let budget = 20000;

      while (stack.length > 0 && budget > 0) {
        budget -= 1;
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);

        if (Array.isArray(node)) {
          for (const item of node) stack.push(item);
          continue;
        }

        const dict = node as Record<string, unknown>;
        const uid = dict['userId'] ?? dict['user_id'];
        if (typeof uid === 'string' && uid.length >= 16) holders.push(dict);

        for (const key of Object.keys(dict)) {
          const value = dict[key];
          if (value && typeof value === 'object') {
            const inner = (value as Record<string, unknown>)['_value'];
            stack.push(inner === undefined ? value : inner);
          }
        }
      }

      // 优先取「同时带 nickname」的那个对象，保证字段同源
      let best: Record<string, unknown> | null = null;
      for (const holder of holders) {
        if (typeof holder['nickname'] === 'string') {
          best = holder;
          break;
        }
      }
      if (!best && holders.length > 0) best = holders[0] ?? null;
      if (!best) return null;

      const uid = best['userId'] ?? best['user_id'];
      const nick = best['nickname'] ?? best['nickName'] ?? best['name'];
      const red = best['redId'] ?? best['red_id'];
      return {
        userId: typeof uid === 'string' ? uid : undefined,
        nickname: typeof nick === 'string' ? nick : undefined,
        redId: typeof red === 'string' ? red : undefined,
      };
    });
    return info as { userId?: string; nickname?: string; redId?: string } | null;
  } catch (err) {
    log('readSelfInfo failed', (err as Error).message);
    return null;
  }
}

export async function readAuthState(): Promise<AuthState> {
  const ctx = await getContext();
  const { ok, count } = await hasSessionCookie(ctx);
  const persisted = readStateFile();
  const state: AuthState = {
    loggedIn: ok,
    cookieCount: count,
    checkedAt: new Date().toISOString(),
    userId: persisted.userId,
    nickname: persisted.nickname,
    redId: persisted.redId,
    infoSource: 'none',
  };

  if (ok) {
    const page = await getPage();
    const info = await readSelfInfo(page);
    if (info) {
      state.userId = info.userId ?? state.userId;
      state.nickname = info.nickname ?? state.nickname;
      state.redId = info.redId ?? state.redId;
      // 注意：www 的全局状态里**只有 userId 没有 nickname**。
      // 只读到 userId 就标 live 会把缓存昵称伪装成实时值（上一版就错在这里）。
      state.infoSource = info.nickname ? 'live' : persisted.nickname ? 'cache' : 'none';
      writeStateFile(info);
    } else {
      // 读不到页面状态只说明解析失败，不代表未登录（cookie 才是唯一判据）。
      state.infoSource = persisted.userId ? 'cache' : 'none';
    }
  }
  return state;
}

/**
 * 用独立标签页探活 www 域，完成后关闭，不干扰主页面。
 * 未登录时小红书会 302 到 /login?redirectPath=...，这是唯一可靠的信号——
 * explore 首页游客也能看，不能用来判定。
 */
async function probeWwwSession(userId: string | undefined): Promise<{ ok: boolean; url: string }> {
  const ctx = await getContext();
  const target = userId
    ? `https://www.xiaohongshu.com/user/profile/${userId}`
    : 'https://www.xiaohongshu.com/messages';
  const probe = await ctx.newPage();
  try {
    await probe.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await sleep(2500);
    const url = probe.url();
    return { ok: !/\/login/i.test(url), url };
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** 完整诊断：cookie + 两个域各自探活。比 readAuthState 慢（多一次页面导航），只给 auth_status 用。 */
export async function diagnoseAuth(): Promise<AuthDiagnosis> {
  const state = await readAuthState();
  const ctx = await getContext();

  // creator 域：能读到账号信息（或至少不被重定向到登录页）即为可用
  let creatorLoggedIn = false;
  try {
    const page = await getPage();
    await page.goto(URLS.creatorNoteManage, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await sleep(3000);
    creatorLoggedIn = !/\/login/i.test(page.url());
  } catch {
    creatorLoggedIn = false;
  }

  const www = state.loggedIn ? await probeWwwSession(state.userId) : { ok: false, url: '(无 cookie，未探活)' };

  let hint: string;
  if (creatorLoggedIn && www.ok) {
    hint = '创作者中心与 www 均已登录，全部工具可用。';
  } else if (creatorLoggedIn && !www.ok) {
    hint =
      '创作者中心登录有效，www 域的 web_session 已被服务端注销——所以浏览器打开 xiaohongshu.com 会显示登录页。' +
      '实测这不影响任何工具：读列表走 creator 域，读详情用带 xsec_token 的链接游客也能打开。' +
      '如果介意看到登录页，重新扫码一次即可；creator 的凭据是另一套，通常不受影响。';
  } else if (!creatorLoggedIn && state.loggedIn) {
    hint = 'cookie 还在但创作者中心已跳转登录页，会话已失效：请调用 xhs_login 重新扫码。';
  } else {
    hint = '未登录：请调用 xhs_login 扫码。';
  }

  return {
    ...state,
    // loggedIn 表示「至少有一个域可用」，避免把 www 失效误报成完全未登录
    loggedIn: creatorLoggedIn || www.ok,
    creatorLoggedIn,
    wwwLoggedIn: www.ok,
    wwwProbeUrl: www.url,
    hint,
  };
}

async function tryOpenLoginDialog(page: Page): Promise<void> {
  const candidates = [
    page.locator('.login-btn'),
    page.getByRole('button', { name: '登录' }),
    page.getByText('登录', { exact: true }),
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) === 0) continue;
      const first = loc.first();
      if (!(await first.isVisible({ timeout: 1500 }))) continue;
      await first.click();
      await pacing(600, 1200);
      log('login dialog triggered');
      return;
    } catch {
      // 换下一个候选
    }
  }
  log('login dialog not found, assuming it is already visible');
}

/**
 * 扫码登录。不做账号密码登录：小红书网页版密码登录本身会触发滑块/短信验证，
 * 而且把密码落盘是这个方案里最不该有的风险。
 */
export async function login(timeoutMs: number = LIMITS.loginWaitMs): Promise<{ loggedIn: boolean; waitedMs: number; state: AuthState }> {
  const started = Date.now();
  const page = await getPage();

  const before = await readAuthState();
  if (before.loggedIn) {
    return { loggedIn: true, waitedMs: 0, state: before };
  }

  await page.goto(URLS.explore, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await tryOpenLoginDialog(page);

  while (Date.now() - started < timeoutMs) {
    await sleep(2000);
    const ctx = await getContext();
    const { ok } = await hasSessionCookie(ctx);
    if (ok) {
      await sleep(2000);
      const state = await readAuthState();
      return { loggedIn: true, waitedMs: Date.now() - started, state };
    }
  }

  const state = await readAuthState();
  return { loggedIn: state.loggedIn, waitedMs: Date.now() - started, state };
}

export async function requireLogin(): Promise<AuthState> {
  const state = await readAuthState();
  if (!state.loggedIn) {
    throw new Error('未登录：请先调用 xhs_login，在弹出的浏览器窗口用小红书 App 扫码。');
  }
  return state;
}
