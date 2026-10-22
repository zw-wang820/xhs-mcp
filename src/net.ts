import type { Page, Response } from 'playwright';
import { log } from './logger.js';

export type JsonCapture = {
  url: string;
  status: number;
  body: unknown;
  capturedAt: string;
};

function matches(url: string, patterns: readonly string[]): boolean {
  return patterns.some(p => url.includes(p));
}

/**
 * 截获动作过程中命中的第一个目标响应并解析为 JSON。
 *
 * 用「拦截页面自己发起的请求」而非自己构造请求，是为了完全绕开 x-s 签名问题：
 * 页面已经把签名算好了，我们只做旁观者。
 */
export async function captureJson(
  page: Page,
  patterns: readonly string[],
  action: () => Promise<void>,
  timeoutMs: number,
): Promise<JsonCapture | null> {
  let waiter: Promise<Response> | null = null;
  try {
    waiter = page.waitForResponse(r => matches(r.url(), patterns), { timeout: timeoutMs });
  } catch {
    return null;
  }

  let response: Response;
  try {
    await action();
    response = await waiter;
  } catch (err) {
    log('capture missed', (err as Error).message);
    return null;
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    try {
      body = { raw: await response.text() };
    } catch {
      body = null;
    }
  }

  return { url: response.url(), status: response.status(), body, capturedAt: new Date().toISOString() };
}

/**
 * 动作本身不触发新请求时（页面已渲染完成），从已有响应里捞。
 *
 * stop() 必须 async：res.json() 是异步的，若同步返回数组，
 * 尚未解析完的响应会被漏掉（表现为「接口明明发了，hits 却是空」）。
 */
export function attachCollector(page: Page, patterns: readonly string[]): { stop: () => Promise<JsonCapture[]> } {
  const hits: JsonCapture[] = [];
  const pending: Array<Promise<void>> = [];
  const handler = (res: Response) => {
    if (!matches(res.url(), patterns)) return;
    pending.push(
      res
        .json()
        .then(body => {
          hits.push({ url: res.url(), status: res.status(), body, capturedAt: new Date().toISOString() });
        })
        .catch(() => undefined),
    );
  };
  page.on('response', handler);
  return {
    stop: async () => {
      page.off('response', handler);
      await Promise.allSettled(pending);
      return hits;
    },
  };
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 在未知的 JSON 结构里按 key 名找到第一个数组。
 * 小红书的响应外层包装（code/success/data/items）在不同接口间不一致，
 * 写死路径会在改版时全线崩溃，所以按特征探测。
 */
export function findArrayByKeys(root: unknown, preferredKeys: string[]): Dict[] {
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  let depthGuard = 0;

  while (queue.length > 0 && depthGuard < 5000) {
    depthGuard += 1;
    const node = queue.shift();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length > 0 && node.every(item => isDict(item))) return node as Dict[];
      queue.push(...node);
      continue;
    }

    const dict = node as Dict;
    for (const key of preferredKeys) {
      const value = dict[key];
      if (Array.isArray(value) && value.length > 0 && value.every(item => isDict(item))) {
        return value as Dict[];
      }
    }
    queue.push(...Object.values(dict));
  }
  return [];
}

export function pickString(source: Dict, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

export function pickNumber(source: Dict, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/**
 * 在任意深度的 JSON 里找第一个命中 key 的字符串。
 * 用于 <code>/api/galaxy/user/info</code> 这类外层包装固定、内层结构不固定的接口。
 */
export function findDeepString(root: unknown, keys: string[], maxDepth = 6): string | undefined {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<unknown>();
  let budget = 5000;

  while (queue.length > 0 && budget > 0) {
    budget -= 1;
    const current = queue.shift();
    if (!current) break;
    const { node, depth } = current;
    if (!node || typeof node !== 'object' || depth > maxDepth || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, depth: depth + 1 });
      continue;
    }

    const dict = node as Dict;
    for (const key of keys) {
      const value = dict[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    for (const value of Object.values(dict)) {
      if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
    }
  }
  return undefined;
}
