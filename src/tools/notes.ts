import type { Page } from 'playwright';
import { API_PATTERNS, LIMITS, URLS } from '../config.js';
import { getPage, sleep } from '../browser.js';
import { attachCollector, captureJson, findArrayByKeys, findDeepString, pickNumber, pickString, type JsonCapture } from '../net.js';
import { requireLogin, writeStateFile } from '../auth.js';
import { log } from '../logger.js';

export type NoteSummary = {
  noteId?: string;
  title?: string;
  type?: string;
  publishTime?: string;
  viewCount?: number;
  likeCount?: number;
  collectCount?: number;
  commentCount?: number;
  shareCount?: number;
  url?: string;
  xsecToken?: string;
};

type Dict = Record<string, unknown>;

/**
 * 拼笔记地址。
 *
 * 小红书的笔记页现在必须带 xsec_token 才允许访问，裸 ID 会返回「当前笔记暂时无法浏览」。
 * token 由列表接口下发，所以「先 list 再 get」是唯一可行链路，
 * 也让 getNote 的入参天然应该是 list 返回的 url 而不是 noteId。
 */
function buildNoteUrl(noteId?: string, xsecToken?: string, xsecSource?: string): string | undefined {
  if (!noteId) return undefined;
  const base = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (!xsecToken) return base;
  const params = new URLSearchParams({ xsec_token: xsecToken, xsec_source: xsecSource ?? 'pc_creatormng' });
  return `${base}?${params.toString()}`;
}

/**
 * 字段名以 2026-10-22 抓到的真实响应为准（创作者中心 v2 列表接口）：
 * id / display_title / likes / collected_count / comments_count / shared_count / view_count / xsec_token
 * 同时保留驼峰写法作为不同接口的兼容分支。
 */
function normalizeNote(item: Dict): NoteSummary {
  const card = (item['noteCard'] ?? item['note_card'] ?? item) as Dict;
  const interact = (item['interactInfo'] ?? item['interact_info'] ?? card['interactInfo'] ?? {}) as Dict;
  const noteId = pickString(card, ['id', 'noteId', 'note_id']);
  const xsecToken = pickString(card, ['xsec_token', 'xsecToken']);
  const xsecSource = pickString(card, ['xsec_source', 'xsecSource']);

  return {
    noteId,
    title: pickString(card, ['display_title', 'displayTitle', 'title']),
    type: pickString(card, ['type', 'noteType', 'note_type']),
    publishTime: pickString(card, ['time', 'publishTime', 'publish_time', 'createTime']),
    viewCount: pickNumber(card, ['view_count', 'viewCount', 'read_count', 'readCount']) ?? pickNumber(interact, ['viewCount', 'readCount']),
    likeCount: pickNumber(card, ['likes', 'liked_count', 'likedCount', 'likeCount']) ?? pickNumber(interact, ['likedCount', 'liked_count']),
    collectCount: pickNumber(card, ['collected_count', 'collectedCount', 'collectCount']) ?? pickNumber(interact, ['collectedCount']),
    commentCount: pickNumber(card, ['comments_count', 'commentCount']) ?? pickNumber(interact, ['commentCount']),
    shareCount: pickNumber(card, ['shared_count', 'shareCount']) ?? pickNumber(interact, ['shareCount']),
    url: buildNoteUrl(noteId, xsecToken, xsecSource),
    xsecToken,
  };
}

function bestCapture(hits: JsonCapture[]): JsonCapture | null {
  if (hits.length === 0) return null;
  return hits[hits.length - 1] ?? null;
}

/**
 * 我发布的笔记列表。
 * 首选创作者中心（数据字段最全，且不需要 userId），失败再退回个人主页。
 */
export async function listMyNotes(limit = 20): Promise<{
  source: 'creator' | 'profile' | 'none';
  count: number;
  notes: NoteSummary[];
  hint?: string;
}> {
  await requireLogin();
  const page = await getPage();

  const creator = await collectFrom(page, URLS.creatorNoteManage, API_PATTERNS.creatorNoteList, ['noteList', 'notes', 'list', 'items']);
  if (creator.length > 0) {
    return { source: 'creator', count: creator.length, notes: creator.slice(0, limit) };
  }

  const profile = await collectFrom(page, URLS.explore, API_PATTERNS.userPosted, ['notes', 'list', 'items']);
  if (profile.length > 0) {
    return { source: 'profile', count: profile.length, notes: profile.slice(0, limit) };
  }

  const domNotes = await scrapeNoteListFromDom(page);
  if (domNotes.length > 0) {
    return { source: 'profile', count: domNotes.length, notes: domNotes.slice(0, limit) };
  }

  return {
    source: 'none',
    count: 0,
    notes: [],
    hint: '没有截获到笔记列表接口，可能是登录态失效或前端改版。请先跑 `npm run capture -- https://creator.xiaohongshu.com/creator/notemanage` 看真实接口地址。',
  };
}

async function collectFrom(page: Page, url: string, patterns: readonly string[], arrayKeys: string[]): Promise<NoteSummary[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  const notesCollector = attachCollector(page, patterns);
  // 顺手补昵称：www 页面的全局状态只给 userId，不含 nickname，
  // 创作者中心的 user/info 接口才是权威来源。既然已经打开这个页面，就零成本捎上。
  const userCollector = attachCollector(page, API_PATTERNS.creatorUserInfo);
  await sleep(6000);
  const userHits = await userCollector.stop();
  const hits = await notesCollector.stop();

  for (const hit of userHits) {
    // 创作者中心把昵称放在 userName，不是 nickname（2026-10-22 实测）
    const nickname = findDeepString(hit.body, ['userName', 'nickname', 'nickName']);
    const creatorUserId = findDeepString(hit.body, ['userId', 'user_id']);
    const redId = findDeepString(hit.body, ['redId', 'red_id']);
    if (nickname || creatorUserId) {
      writeStateFile({ nickname, creatorUserId, redId });
      log('account info refreshed from creator center:', nickname ?? '(无昵称)');
      break;
    }
  }

  const shot = bestCapture(hits);
  if (!shot) {
    log('no api hit for', url);
    return [];
  }
  const items = findArrayByKeys(shot.body, arrayKeys);
  return items.map(normalizeNote).filter(n => Boolean(n.noteId) || Boolean(n.title));
}

/** 接口全挂时的兜底：直接从列表页 DOM 取标题和链接 */
async function scrapeNoteListFromDom(page: Page): Promise<NoteSummary[]> {
  try {
    const rows = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]'));
      const out: Array<{ href: string; title: string }> = [];
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const title = (a.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (href && title) out.push({ href, title });
      }
      return out;
    });
    const seen = new Set<string>();
    const notes: NoteSummary[] = [];
    for (const row of rows) {
      if (seen.has(row.href)) continue;
      seen.add(row.href);
      const noteId = row.href.split('/').pop();
      notes.push({ noteId, title: row.title.slice(0, 60), url: row.href });
    }
    return notes;
  } catch {
    return [];
  }
}

export type NoteDetail = {
  noteId?: string;
  title?: string;
  desc?: string;
  tags: string[];
  images: string[];
  author?: string;
  likeCount?: number;
  collectCount?: number;
  commentCount?: number;
  shareCount?: number;
  url: string;
  source: 'api' | 'dom';
};

export async function getNote(target: string): Promise<NoteDetail> {
  await requireLogin();
  const page = await getPage();
  const url = target.startsWith('http') ? target : `https://www.xiaohongshu.com/explore/${target}`;

  const capture = await captureJson(
    page,
    API_PATTERNS.feedDetail,
    async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    LIMITS.responseTimeoutMs,
  );

  const noteId = url.split('/').pop()?.split('?')[0];

  if (capture) {
    const items = findArrayByKeys(capture.body, ['items', 'notes', 'list']);
    const first = items[0];
    if (first) {
      const card = (first['noteCard'] ?? first['note_card'] ?? first) as Dict;
      const interact = (card['interactInfo'] ?? card['interact_info'] ?? {}) as Dict;
      const imageList = (card['imageList'] ?? card['image_list'] ?? []) as Dict[];
      const tagList = (card['tagList'] ?? card['tag_list'] ?? []) as Dict[];
      const user = (card['user'] ?? {}) as Dict;
      return {
        noteId,
        title: pickString(card, ['title', 'displayTitle', 'display_title']),
        desc: pickString(card, ['desc', 'description', 'content']),
        tags: tagList.map(t => pickString(t, ['name', 'tagName']) ?? '').filter(Boolean),
        images: imageList
          .map(img => pickString(img, ['urlDefault', 'url_default', 'url', 'urlPre']) ?? '')
          .filter(Boolean),
        author: pickString(user, ['nickname', 'nickName', 'name']),
        likeCount: pickNumber(interact, ['likedCount', 'liked_count', 'likeCount']),
        collectCount: pickNumber(interact, ['collectedCount', 'collected_count', 'collectCount']),
        commentCount: pickNumber(interact, ['commentCount', 'comment_count']),
        shareCount: pickNumber(interact, ['shareCount', 'share_count']),
        url,
        source: 'api' as const,
      };
    }
  }

  const dom = await page.evaluate(() => {
    // 标题不能用通用的 .title：小红书登录弹窗也有 .title，会抓成「手机号登录」。
    const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
    const detailTitle = document.querySelector('#detail-title')?.textContent ?? '';
    const docTitle = (document.title ?? '').replace(/\s*[-|]\s*小红书.*$/, '');
    const rawTitle = detailTitle.trim() || metaTitle.trim() || docTitle.trim();

    const desc = document.querySelector('#detail-desc, .note-text, .desc')?.textContent ?? '';
    const tags = Array.from(document.querySelectorAll('#detail-desc .tag, .note-text .tag')).map(
      el => (el.textContent ?? '').trim(),
    );
    const images = Array.from(document.querySelectorAll('.swiper-slide img, .note-slider img')).map(
      el => (el as HTMLImageElement).src,
    );
    const bodyText = document.body?.innerText ?? '';
    return {
      // 登录弹窗标题这类噪音直接判为无效
      title: /登录|注册/.test(rawTitle) ? '' : rawTitle,
      desc: desc.trim(),
      tags: tags.filter(Boolean),
      images: images.filter(Boolean),
      blocked: /无法浏览|笔记不存在|当前内容无法查看/.test(bodyText),
    };
  });

  if (dom.blocked) {
    throw new Error(
      target.startsWith('http')
        ? `笔记页拒绝访问：${target}\n可能原因：xsec_token 已过期，或该链接来自页面外的分享。请先用 xhs_list_my_notes 取一条带 token 的最新 url。`
        : `只给笔记 ID 无法访问。小红书要求笔记页必须带 xsec_token 参数，\n请先调用 xhs_list_my_notes，把返回结果里的 url 字段（含 token）作为 target 传入。`,
    );
  }

  return { noteId, title: dom.title, desc: dom.desc, tags: dom.tags, images: dom.images, url, source: 'dom' };
}
