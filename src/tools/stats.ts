import type { Page } from 'playwright';
import { API_PATTERNS, URLS } from '../config.js';
import { attachCollector, pickNumber, pickString, type JsonCapture } from '../net.js';
import { requireLogin } from '../auth.js';
import { getPage, sleep } from '../browser.js';
import { log } from '../logger.js';

/**
 * 单篇笔记的数据指标。
 *
 * 字段名是 2026-10-22 用真实账号抓到的，不是猜的：
 *   imp_count          曝光（小红书数据中心的「曝光」口径）
 *   read_count         观看
 *   like_count         点赞
 *   fav_count          收藏（注意不是 collect_count / collected_count）
 *   comment_count      评论
 *   share_count        分享
 *   increase_fans_count 涨粉
 *   view_time_avg      人均观看时长（秒）
 *   coverClickRate     封面点击率（0-1 小数）
 */
export type NoteStats = {
  noteId: string;
  title?: string;
  postTime?: string;
  /** 曝光 */
  impressions?: number;
  /** 观看/阅读 */
  reads?: number;
  likes?: number;
  collects?: number;
  comments?: number;
  shares?: number;
  /** 因这篇笔记新增的粉丝数 */
  fansGained?: number;
  /** 人均观看时长（秒） */
  avgViewSeconds?: number;
  /** 封面点击率，小数形式 */
  coverClickRate?: number;
  /** 点击率百分比字符串，便于直接展示 */
  coverClickRateText?: string;
};

export type NoteStatsResult = {
  /** 实际覆盖的时间窗 */
  window: { days: number; begin: string; end: string };
  /** 该时间窗内发布的笔记总数（接口返回的 total） */
  totalInWindow: number;
  note?: NoteStats;
  /** 时间窗内的汇总，用于看整体表现 */
  summary?: {
    notes: number;
    impressions: number;
    reads: number;
    likes: number;
    collects: number;
    comments: number;
    shares: number;
    fansGained: number;
  };
  /** 排名信息：这篇在窗口内按曝光排第几 */
  rankByImpressions?: { position: number; of: number };
  /** 该篇笔记不在任何已探测时间窗内时给出说明 */
  found: boolean;
  message?: string;
  /** 所有探测过的时间窗，便于排查为什么没找到 */
  probedWindows: Array<{ days: number; begin: string; end: string; total: number }>;
};

type Dict = Record<string, unknown>;

function toDate(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 时间窗：从 end 当天 23:59:59 往回推 days 天 */
function windowOf(days: number): { begin: number; end: number; beginText: string; endText: string } {
  const end = new Date();
  end.setHours(23, 59, 59, 0);
  const begin = new Date(end);
  begin.setDate(begin.getDate() - (days - 1));
  begin.setHours(0, 0, 0, 0);
  const fmt = (d: Date): string => toDate(d.getTime()) ?? '';
  return { begin: begin.getTime(), end: end.getTime(), beginText: fmt(begin), endText: fmt(end) };
}

function normalizeStats(item: Dict): NoteStats {
  const ctr = pickNumber(item, ['coverClickRate']);
  return {
    noteId: pickString(item, ['id', 'note_id', 'noteId']) ?? '',
    title: pickString(item, ['title', 'display_title', 'displayTitle']),
    postTime: toDate(pickNumber(item, ['post_time', 'postTime', 'time'])),
    impressions: pickNumber(item, ['imp_count', 'impCount', 'impression_count']),
    reads: pickNumber(item, ['read_count', 'readCount', 'view_count']),
    likes: pickNumber(item, ['like_count', 'likeCount', 'likes']),
    collects: pickNumber(item, ['fav_count', 'collect_count', 'collected_count']),
    comments: pickNumber(item, ['comment_count', 'commentCount']),
    shares: pickNumber(item, ['share_count', 'shared_count', 'shareCount']),
    fansGained: pickNumber(item, ['increase_fans_count', 'increaseFansCount']),
    avgViewSeconds: pickNumber(item, ['view_time_avg', 'viewTimeAvg']),
    coverClickRate: ctr,
    coverClickRateText: typeof ctr === 'number' ? `${(ctr * 100).toFixed(1)}%` : undefined,
  };
}

/** 从命中里取 note_infos 与 total；结构固定，不必做全图探测 */
function extractList(capture: JsonCapture): { items: Dict[]; total: number } | null {
  let node: unknown = capture.body;
  for (const key of ['data']) {
    if (node && typeof node === 'object' && key in (node as Dict)) node = (node as Dict)[key];
  }
  if (!node || typeof node !== 'object') return null;
  const dict = node as Dict;
  const infos = dict['note_infos'];
  if (!Array.isArray(infos)) return null;
  const total = typeof dict['total'] === 'number' ? dict['total'] : infos.length;
  return { items: infos.filter(i => i && typeof i === 'object') as Dict[], total };
}

/**
 * 打开数据中心并截获指定时间窗的统计列表。
 *
 * 为什么不用 page.request：这个接口除了 cookie 还校验页面算出的签名参数，
 * 外部构造一律 406。所以这里只做「打开页面 + 旁观页面自己发的请求」。
 */
async function fetchWindow(page: Page, days: number): Promise<{ items: Dict[]; total: number } | null> {
  const w = windowOf(days);
  const collector = attachCollector(page, API_PATTERNS.noteAnalyzeList);

  const target = `${URLS.creatorDataCenter}?post_begin_time=${w.begin}&post_end_time=${w.end}`;
  await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  // 数据表格要等接口回来再渲染，给足重试窗口
  await sleep(9000);

  const hits = await collector.stop();
  if (hits.length === 0) {
    log('noteAnalyzeList 未命中，可能页面结构与预期不同');
    return null;
  }

  // 取最后一条：时间窗最符合当前导航的那次请求
  const last = hits[hits.length - 1];
  if (!last) return null;
  return extractList(last);
}

/**
 * 单篇笔记数据。
 *
 * 核心难点：接口按「发布时间窗」返回，不是按 noteId 查询。所以流程是
 *   1. 先用默认 30 天窗试一次
 *   2. 没找到就扩大窗口
 * 找到后顺带算窗口内的汇总和排名，这样「曝光 347」这种数字才有参照系。
 *
 * **窗口扩大的实测规律（2026-10-22）**：把窗口从 30 天扩到 400 天，接口返回的
 * total 依然是 3——说明这个接口本身只覆盖近期笔记，与时间参数无关。因此扩大窗口
 * 收益很低，只在 total 变大时才值得继续探，否则多跑一次纯属浪费十几秒。
 */
export async function getNoteStats(target: string, options: { days?: number } = {}): Promise<NoteStatsResult> {
  await requireLogin();
  const page = await getPage();

  // 从 URL 或裸 ID 里取 24 位 noteId
  const match = target.match(/[0-9a-f]{24}/i);
  if (!match) {
    throw new Error(`无法从「${target}」中解析出笔记 ID，请传笔记链接或 24 位 ID。`);
  }
  const noteId = match[0].toLowerCase();

  const windows = options.days ? [options.days] : [30, 90, 400];
  const probedWindows: NoteStatsResult['probedWindows'] = [];

  let previousTotal = -1;

  for (let i = 0; i < windows.length; i += 1) {
    const days = windows[i] as number;
    const w = windowOf(days);
    const result = await fetchWindow(page, days);
    if (!result) {
      probedWindows.push({ days, begin: w.beginText, end: w.endText, total: -1 });
      continue;
    }
    probedWindows.push({ days, begin: w.beginText, end: w.endText, total: result.total });

    const all = result.items.map(normalizeStats);
    const hit = all.find(n => n.noteId.toLowerCase() === noteId);

    const sum = (key: keyof NoteStats): number => all.reduce((acc, n) => acc + (typeof n[key] === 'number' ? (n[key] as number) : 0), 0);
    const summary = {
      notes: all.length,
      impressions: sum('impressions'),
      reads: sum('reads'),
      likes: sum('likes'),
      collects: sum('collects'),
      comments: sum('comments'),
      shares: sum('shares'),
      fansGained: sum('fansGained'),
    };

    if (hit) {
      const byImp = [...all].sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));
      const position = byImp.findIndex(n => n.noteId.toLowerCase() === noteId) + 1;
      return {
        window: { days, begin: w.beginText, end: w.endText },
        totalInWindow: result.total,
        note: hit,
        summary,
        rankByImpressions: position > 0 ? { position, of: byImp.length } : undefined,
        found: true,
        probedWindows,
      };
    }

    // 找到底了：最后一次探测，或扩大窗口后 total 没变（接口覆盖面已到顶）
    const isLast = i === windows.length - 1;
    const noGain = previousTotal >= 0 && result.total <= previousTotal;
    previousTotal = result.total;

    if (options.days || isLast || noGain) {
      return {
        window: { days, begin: w.beginText, end: w.endText },
        totalInWindow: result.total,
        summary,
        found: false,
        message:
          `没有找到笔记 ${noteId}。` +
          (noGain
            ? `已把时间窗从近 ${windows[0]} 天扩到近 ${days} 天，可统计的笔记数没有增加（都是 ${result.total} 篇），` +
              '说明数据中心的单篇分析只保留近期数据，更早的作品查不到。'
            : '数据中心的单篇分析只覆盖近期发布的笔记；刚发布的笔记数据回填也有延迟。'),
        probedWindows,
      };
    }
  }

  return {
    window: { days: windows[0] ?? 30, begin: '', end: '' },
    totalInWindow: 0,
    found: false,
    message: '数据中心的单篇分析列表没有返回任何数据，可能是账号没有数据中心权限，或页面结构已改版。',
    probedWindows,
  };
}

/**
 * 时间窗内的全部笔记数据（排行榜视角）。
 * 读同一个接口，只是不做 noteId 匹配，适合「我哪篇笔记表现最好」这类问题。
 */
export async function listNoteStats(options: { days?: number; limit?: number } = {}): Promise<{
  window: { days: number; begin: string; end: string };
  totalInWindow: number;
  notesReturned: number;
  truncated: boolean;
  summary: NoteStatsResult['summary'];
  notes: NoteStats[];
  message?: string;
}> {
  await requireLogin();
  const page = await getPage();
  const days = options.days ?? 30;
  const limit = options.limit ?? 10;
  const w = windowOf(days);

  const result = await fetchWindow(page, days);
  if (!result) {
    throw new Error('数据中心的单篇分析列表未返回数据，可能是页面改版或该账号无权限。');
  }

  const all = result.items.map(normalizeStats);
  const sorted = [...all].sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0)).slice(0, limit);
  const sum = (key: keyof NoteStats): number => all.reduce((acc, n) => acc + (typeof n[key] === 'number' ? (n[key] as number) : 0), 0);

  return {
    window: { days, begin: w.beginText, end: w.endText },
    totalInWindow: result.total,
    notesReturned: sorted.length,
    truncated: result.total > all.length,
    summary: {
      notes: all.length,
      impressions: sum('impressions'),
      reads: sum('reads'),
      likes: sum('likes'),
      collects: sum('collects'),
      comments: sum('comments'),
      shares: sum('shares'),
      fansGained: sum('fansGained'),
    },
    notes: sorted,
    message: result.total > all.length ? `窗口内共 ${result.total} 篇，接口单页只返回 ${all.length} 篇，结果已截断。` : undefined,
  };
}
