import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MAX_TITLE_LEN, DISCLAIMER } from './config.js';
import { closeBrowser } from './browser.js';
import { diagnoseAuth, login, readAuthState } from './auth.js';
import { getNote, listMyNotes } from './tools/notes.js';
import { createNote } from './tools/publish.js';
import { getNoteStats, listNoteStats } from './tools/stats.js';
import { log, logError, printDisclaimer } from './logger.js';

const server = new McpServer(
  { name: 'xhs-mcp', version: '0.1.0' },
  {
    instructions:
      '小红书本地 MCP。所有操作通过驱动一个有头浏览器完成，请提醒用户不要关闭弹出的浏览器窗口。\n' +
      '写入能力默认存草稿；真正发布需要显式传 confirm=true，且有 10 分钟频率下限。',
  },
);

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logError(err);
  return { isError: true, content: [{ type: 'text' as const, text: `失败：${message}` }] };
}

server.registerTool(
  'xhs_auth_status',
  {
    title: '检查登录状态',
    description:
      '检查登录态并分别报告两个域的状态：创作者中心（读列表/发布用）与 www 域（打开笔记详情用）。' +
      '这两个域是独立会话，可能一个有效一个失效，只看 cookie 会误判，所以本工具会做真实页面探活。',
    inputSchema: {},
  },
  async () => {
    try {
      const state = await diagnoseAuth();
      return ok({
        ...state,
        guidance: state.hint,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_login',
  {
    title: '扫码登录',
    description:
      '打开有头浏览器并等待用户用小红书 App 扫码登录。登录态会持久化到本地 profile，通常只需做一次。' +
      '不使用账号密码：网页版密码登录会触发滑块/短信验证，且密码落盘风险不可接受。',
    inputSchema: {
      timeoutSeconds: z.number().int().min(30).max(600).default(180).describe('等待扫码的最长秒数'),
    },
  },
  async ({ timeoutSeconds }) => {
    try {
      const result = await login(timeoutSeconds * 1000);
      return ok({
        loggedIn: result.loggedIn,
        waitedMs: result.waitedMs,
        nickname: result.state.nickname,
        userId: result.state.userId,
        infoSource: result.state.infoSource,
        message: result.loggedIn ? '登录成功，登录态已保存。' : '等待超时，浏览器窗口仍开着，可以继续扫码后再调用 xhs_auth_status。',
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_list_my_notes',
  {
    title: '列出我的笔记',
    description: '读取我发布过的笔记列表（标题、笔记 ID、链接、互动数据）。数据来自创作者中心列表接口。',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20).describe('返回条数上限'),
    },
  },
  async ({ limit }) => {
    try {
      return ok(await listMyNotes(limit));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_get_note',
  {
    title: '读取单篇笔记',
    description: '传入笔记链接或笔记 ID，返回正文、话题标签、图片地址、作者与互动数据。',
    inputSchema: {
      target: z.string().min(1).describe('笔记完整 URL 或 24 位笔记 ID'),
    },
  },
  async ({ target }) => {
    try {
      return ok(await getNote(target));
    } catch (err) {
      return fail(err);
    }
  },
);

const noteContentShape = {
  title: z.string().min(1).max(MAX_TITLE_LEN).describe('笔记标题，上限 20 字'),
  content: z.string().min(1).describe('笔记正文'),
  images: z.array(z.string()).default([]).describe('本地图片绝对路径，最多 18 张'),
  tags: z.array(z.string()).default([]).describe('话题标签，不带 # 号'),
};

server.registerTool(
  'xhs_save_draft',
  {
    title: '填写内容但不提交',
    description:
      '把标题、正文、图片、话题填进发布页，然后停在页面上等你确认，**不会提交任何内容**。' +
      '小红书图文发布页没有独立的「存草稿」按钮（草稿是在离开页面时弹窗保存的），' +
      '所以这个工具的真实语义是「准备好内容，交给人来按下最后一步」。写入类操作默认走这条路。',
    inputSchema: noteContentShape,
  },
  async ({ title, content, images, tags }) => {
    try {
      return ok(await createNote({ title, content, images, tags, mode: 'draft' }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_publish_note',
  {
    title: '发布笔记',
    description:
      '真正对外发布一篇图文笔记（会自动点「发布笔记」）。必须显式传 confirm=true，且有 10 分钟频率下限。' +
      '除非用户明确要求直接发布，否则应优先使用 xhs_save_draft。',
    inputSchema: {
      ...noteContentShape,
      confirm: z.literal(true).describe('必须为 true，表示确认本次是对外发布而非存草稿'),
    },
  },
  async ({ title, content, images, tags }) => {
    try {
      return ok(await createNote({ title, content, images, tags, mode: 'publish' }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_get_note_stats',
  {
    title: '单篇笔记数据',
    description:
      '返回单篇笔记的曝光、观看、点赞、收藏、评论、分享、涨粉、人均观看时长、封面点击率。' +
      '数据来自创作者中心数据中心，只覆盖近 30 天发布的笔记（工具会自动扩大时间窗探测）。' +
      '同时返回该时间窗内所有笔记的汇总与这篇的曝光排名，用于判断数据好坏。',
    inputSchema: {
      target: z.string().min(1).describe('笔记完整 URL 或 24 位笔记 ID'),
      days: z
        .number()
        .int()
        .min(7)
        .max(400)
        .optional()
        .describe('只看最近多少天发布的笔记。不传则依次尝试 30 / 90 / 400 天'),
    },
  },
  async ({ target, days }) => {
    try {
      return ok(await getNoteStats(target, { days }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_list_note_stats',
  {
    title: '笔记数据排行',
    description:
      '列出某个时间窗内的全部笔记数据，按曝光从高到低排序，附整体汇总。' +
      '适合回答「我哪篇笔记表现最好」「最近一个月涨了多少粉」这类问题。',
    inputSchema: {
      days: z.number().int().min(7).max(400).default(30).describe('统计最近多少天发布的笔记'),
      limit: z.number().int().min(1).max(50).default(10).describe('返回条数上限（按曝光降序）'),
    },
  },
  async ({ days, limit }) => {
    try {
      return ok(await listNoteStats({ days, limit }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xhs_close_browser',
  {
    title: '关闭浏览器',
    description: '关闭 MCP 托管的浏览器进程，释放 profile 锁。登录态已持久化，下次调用会自动重新拉起。',
    inputSchema: {},
  },
  async () => {
    await closeBrowser();
    return ok('浏览器已关闭，登录态保留。');
  },
);

async function main(): Promise<void> {
  printDisclaimer(DISCLAIMER);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('server ready on stdio');
}

process.on('SIGINT', () => {
  void closeBrowser().finally(() => process.exit(0));
});

main().catch(err => {
  logError(err);
  process.exit(1);
});
