import os from 'node:os';
import path from 'node:path';

/**
 * 运行时数据根目录。
 *
 * 默认 `~/.xhs-mcp`。支持用环境变量 `XHS_MCP_HOME` 覆盖，用于两种场景：
 *  - 同一台机器上跑多个实例、彼此不共享登录态
 *  - 把数据放到指定磁盘（例如放在加密卷里）
 *
 * 这个目录里存的是**浏览器登录态**，等同于账号凭据，不要提交到版本库、
 * 不要打包进 npm、不要分享给他人。
 */
export const ROOT = process.env['XHS_MCP_HOME']
  ? path.resolve(process.env['XHS_MCP_HOME'])
  : path.join(os.homedir(), '.xhs-mcp');
/** 独立浏览器 profile，不与日常 Chrome 共用，避免文件锁冲突，也更像真人环境 */
export const PROFILE_DIR = path.join(ROOT, 'profile');
export const CAPTURE_DIR = path.join(ROOT, 'captures');
export const STATE_FILE = path.join(ROOT, 'state.json');

export const URLS = {
  explore: 'https://www.xiaohongshu.com/explore',
  creatorHome: 'https://creator.xiaohongshu.com/creator/home',
  /** 旧路径 /creator/notemanage 会 302 到这里，直接写落点省一次跳转 */
  creatorNoteManage: 'https://creator.xiaohongshu.com/new/note-manager',
  /**
   * 发布页。
   * 默认落点是「上传视频」模式；带 target=image 才直接进图文模式
   * （实测 file input 的 accept 会从视频格式变成 .jpg/.jpeg/.png/.webp）。
   */
  creatorPublish: 'https://creator.xiaohongshu.com/publish/publish?target=image',
  creatorDataCenter: 'https://creator.xiaohongshu.com/statistics/data-analysis',
} as const;

/**
 * 接口特征表。
 *
 * 小红书前端会给请求加 x-s / x-t 签名，自己造签名的收益远低于维护成本，且随时失效。
 * 所以这里的原则是：只截获页面自己发出的请求，绝不伪造请求。
 *
 * 改版导致匹配失效时，用 `npm run capture -- <页面地址>` 或 `node scripts/probe.mjs`
 * 抓一遍真实响应，把新的 URL 片段补进来即可 —— 改动只发生在这个文件里。
 *
 * 标注 [已验证] 的条目是 2026-10-22 用真实账号抓到的。
 */
export const API_PATTERNS = {
  /** 个人主页的作品列表 */
  userPosted: ['/api/sns/web/v1/user_posted'],
  /** 笔记详情（正文、标签、图片、互动数） */
  feedDetail: ['/api/sns/web/v1/feed'],
  /** 创作者中心笔记管理列表 [已验证] */
  creatorNoteList: ['/api/galaxy/v2/creator/note/user/posted', '/api/galaxy/creator/note/user/posted'],
  /** 创作者中心：当前登录账号信息 [已验证] */
  creatorUserInfo: ['/api/galaxy/user/info'],
  /** 单篇笔记数据 */
  creatorNoteStats: ['/data/note', '/note/analysis', '/note/detail'],
  /** 账号维度数据概览 */
  creatorAccountStats: ['/data/account', '/data/overview'],
  /**
   * 数据中心：单篇笔记分析列表 [已验证]
   *
   * 三个必须知道的实测事实：
   * 1. 只返回**近 30 天发布**的笔记。要覆盖更早的作品，得把 post_begin_time /
   *    post_end_time 一起前移到对应时间窗。
   * 2. 用 page.request 自己构造请求一律 406 —— 除了 cookie，页面还会带上算出来的
   *    签名参数，外部构造必被拒。只能让页面自己发请求，我们旁观响应。
   * 3. page_size 只认 10；返回体里的 total 是当前时间窗内的总条数。
   */
  noteAnalyzeList: ['/api/galaxy/creator/datacenter/note/analyze/list'],
  /** 数据中心权限与展示范围 [已验证] */
  dataCenterPermission: ['/api/galaxy/creator/datacenter/permission/query'],
} as const;

export const LIMITS = {
  /**
   * 两次真实发布之间的最小间隔。
   *
   * **这个值故意不读环境变量**：它是唯一能实质降低封号概率的手动闸门，
   * 一旦允许配置，迟早会有人在「我就试一下」的时候把它设成 0，
   * 然后账号被限流。要改只能改源码并自己承担后果。
   */
  publishMinIntervalMs: 10 * 60 * 1000,
  /**
   * 同一次会话内任意两次**写入类**调用的最小间隔（毫秒）。
   * 与上面的发布间隔不同，这层管的是「连续填表/连续操作」的节奏。
   */
  writeMinIntervalMs: 8 * 1000,
  navigationTimeoutMs: 45_000,
  responseTimeoutMs: 30_000,
  loginWaitMs: 180_000,
  /** 逐字符输入的基础延迟区间 */
  typeDelayMs: [60, 160] as [number, number],
} as const;

/** 启动时打印一次的免责声明。改成常量是为了让它在所有入口（MCP / CLI）统一出现。 */
export const DISCLAIMER = [
  'xhs-mcp 是本地自动化工具，通过驱动你自己的浏览器操作你自己的账号。',
  '使用前请知悉：',
  '  · 自动化操作可能触发平台风控，存在限流或封号风险，风险由使用者自行承担；',
  '  · 请遵守小红书用户协议，不要用于刷量、批量养号、数据爬取倒卖；',
  '  · 登录态保存在本机 ' + ROOT + '，等同于账号凭据，请勿分享或提交到版本库；',
  '  · 本项目与小红书官方无关，未获其授权或认可。',
].join('\n');

export const MAX_TITLE_LEN = 20;
