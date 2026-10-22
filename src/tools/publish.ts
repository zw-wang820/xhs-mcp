import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { LIMITS, MAX_TITLE_LEN, ROOT, URLS } from '../config.js';
import { firstVisible, getPage, humanType, pacing, sleep } from '../browser.js';
import { readStateFile, requireLogin, writeStateFile } from '../auth.js';
import { log } from '../logger.js';

export type PublishInput = {
  title: string;
  content: string;
  images: string[];
  tags: string[];
  mode: 'draft' | 'publish';
};

export type PublishResult = {
  ok: boolean;
  mode: 'draft' | 'publish';
  message: string;
  images: number;
  tags: string[];
  errorScreenshot?: string;
};

const IMAGE_LIMIT = 18;

/**
 * 写入类调用的节流。
 *
 * 发布间隔（10 分钟）挡的是「连续发多篇」；这一层挡的是「同一个会话里连续打开发布页、
 * 连续上传」——那种节奏比真人快得多，是风控最容易注意到的地方。
 *
 * 与 publishMinIntervalMs 一样，**故意不读环境变量**。要放宽只能改源码。
 */
let lastWriteAt = 0;
async function throttleWrite(mode: PublishInput['mode']): Promise<void> {
  const gap = Date.now() - lastWriteAt;
  if (lastWriteAt > 0 && gap < LIMITS.writeMinIntervalMs) {
    const wait = LIMITS.writeMinIntervalMs - gap;
    log(`写入节流：等待 ${Math.round(wait / 100) / 10}s（${mode}）`);
    await sleep(wait);
  }
  lastWriteAt = Date.now();
}

/**
 * 页面结构全部来自 2026-10-22 的真机探测，不是猜的：
 * - 发布页默认是「上传视频」模式，URL 带 target=image 才进图文模式
 * - 图片选择框是隐藏的 input.upload-input，accept=.jpg,.jpeg,.png,.webp
 * - 标题框 input[placeholder="填写标题会有更多赞哦"]
 * - 正文是 ProseMirror 富文本 div.tiptap.ProseMirror
 * - 提交按钮 div.publish-video .btn-wrapper，文本「发布笔记」
 * - 没有「存草稿」按钮：草稿是离开页面时弹窗保存的
 */
const SELECTOR = {
  imageFileInput: 'input[type="file"][accept*="jpg"]',
  imageTab: '.creator-tab',
  titleInput: 'input[placeholder*="填写标题"]',
  contentEditor: 'div.tiptap.ProseMirror',
  submitButton: '.publish-video .btn-wrapper',
  thumbnails: '.img-container img, [class*="img-item"] img, .upload-item img',
} as const;

function validate(input: PublishInput): void {
  if (!input.content.trim()) throw new Error('正文不能为空。');
  if (input.title.length > MAX_TITLE_LEN) {
    throw new Error(`标题 ${input.title.length} 字，超过小红书上限 ${MAX_TITLE_LEN} 字，请先精简。`);
  }
  if (input.images.length === 0) {
    throw new Error('图文笔记至少需要 1 张图片。');
  }
  if (input.images.length > IMAGE_LIMIT) {
    throw new Error(`最多 ${IMAGE_LIMIT} 张图片，当前 ${input.images.length} 张。`);
  }
  for (const img of input.images) {
    const abs = path.resolve(img);
    if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`);
    if (!/\.(jpe?g|png|webp)$/i.test(abs)) throw new Error(`不支持的图片格式（需 jpg/png/webp）：${abs}`);
  }
}

async function saveErrorScreenshot(page: Page): Promise<string | undefined> {
  try {
    const dir = path.join(ROOT, 'errors');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `publish-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * 等图片上传完成。
 * 不用「上传中」文案判断：页面没有稳定的进度文案，
 * 改成轮询缩略图数量 —— 图片真的渲染出来了才算成功。
 */
async function waitForUpload(page: Page, expected: number, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  let last = 0;
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(sel => {
      const body = document.body?.innerText ?? '';
      return {
        failed: /上传失败|图片格式不支持/.test(body),
        thumbs: document.querySelectorAll(sel).length,
      };
    }, SELECTOR.thumbnails);

    last = state.thumbs;
    if (state.failed) throw new Error('图片上传失败：页面提示格式不支持或上传出错。');
    if (state.thumbs >= expected) {
      await sleep(1500);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`图片上传超时：期望 ${expected} 张，只渲染出 ${last} 张。`);
}

async function findTitleInput(page: Page): Promise<Locator> {
  const loc = await firstVisible([page.locator(SELECTOR.titleInput)]);
  if (!loc) throw new Error('找不到标题输入框，发布页可能改版。请跑 node scripts/inspect-editor.mjs 重新校准。');
  return loc;
}

async function findContentEditor(page: Page): Promise<Locator> {
  const loc = await firstVisible([page.locator(SELECTOR.contentEditor), page.locator('[contenteditable="true"]')]);
  if (!loc) throw new Error('找不到正文编辑器，发布页可能改版。请跑 node scripts/inspect-editor.mjs 重新校准。');
  return loc;
}

/**
 * 话题：在正文末尾输入 "#tag "，靠输入框自身的联想把它转成话题 chip。
 * 必须逐个输入并等联想，直接粘贴文本不会生成话题。
 */
async function applyTags(editor: Locator, tags: string[]): Promise<string[]> {
  const applied: string[] = [];
  for (const raw of tags) {
    const tag = raw.replace(/^#/, '').trim();
    if (!tag) continue;
    await editor.click();
    await editor.press('End');
    await editor.pressSequentially(` #${tag}`, { delay: 90 });
    await sleep(1200 + Math.random() * 600);
    await editor.press('Space');
    await pacing(400, 900);
    applied.push(tag);
  }
  return applied;
}

export async function createNote(input: PublishInput): Promise<PublishResult> {
  validate(input);
  await requireLogin();

  if (input.mode === 'publish') {
    const last = readStateFile().lastPublishAt ?? 0;
    const gap = Date.now() - last;
    if (gap < LIMITS.publishMinIntervalMs) {
      const waitMin = Math.ceil((LIMITS.publishMinIntervalMs - gap) / 60000);
      throw new Error(
        `发布频率保护：距离上次发布不足 ${Math.round(LIMITS.publishMinIntervalMs / 60000)} 分钟，请再等约 ${waitMin} 分钟后重试。`,
      );
    }
  }

  await throttleWrite(input.mode);

  const page = await getPage();
  try {
    log('opening publish page');
    await page.goto(URLS.creatorPublish, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTOR.imageFileInput, { state: 'attached', timeout: LIMITS.navigationTimeoutMs });
    await sleep(2500);

    // 兜底：万一 URL 参数没生效而落在视频模式，点一下「上传图文」
    const accept = await page.locator(SELECTOR.imageFileInput).first().getAttribute('accept');
    if (!accept?.includes('jpg')) {
      const tab = await firstVisible([page.locator(SELECTOR.imageTab).filter({ hasText: '上传图文' })], 3000);
      if (tab) {
        await tab.click();
        await pacing(1200, 2000);
      }
    }

    const fileInput = page.locator(SELECTOR.imageFileInput).first();
    await fileInput.setInputFiles(input.images.map(img => path.resolve(img)));
    log('files attached', input.images.length);
    await waitForUpload(page, input.images.length);
    await pacing(1200, 2200);

    const titleInput = await findTitleInput(page);
    await humanType(titleInput, input.title);
    await pacing(600, 1200);

    const editor = await findContentEditor(page);
    await humanType(editor, input.content);
    await pacing(800, 1500);

    const applied = await applyTags(editor, input.tags);
    await pacing(800, 1600);

    if (input.mode === 'draft') {
      // 小红书图文发布页没有独立「存草稿」按钮，草稿靠离开页面时弹窗保存。
      // 所以这里只把内容填好、把页面留在前台，由用户自己确认后发布或保存离开。
      return {
        ok: true,
        mode: 'draft',
        message:
          '内容已填入发布页，但未提交。小红书没有独立的存草稿按钮（草稿在离开页面时弹窗保存），' +
          '请在浏览器窗口里核对图片封面、话题和正文，然后手动点「发布笔记」或关闭页面选择保存草稿。',
        images: input.images.length,
        tags: applied,
      };
    }

    const submit = await firstVisible(
      [page.locator(SELECTOR.submitButton), page.getByText('发布笔记', { exact: true })],
      5000,
    );
    if (!submit) {
      const shot = await saveErrorScreenshot(page);
      throw new Error(`找不到「发布笔记」按钮，内容已填写但未提交。截图：${shot ?? '无'}`);
    }

    await submit.click();
    await sleep(5000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const success = /发布成功|已提交|审核中/.test(bodyText);

    if (success) writeStateFile({ lastPublishAt: Date.now() });

    return {
      ok: success,
      mode: 'publish',
      message: success
        ? '已提交发布，建议到创作中心确认审核状态。'
        : '未检测到明确成功提示，请打开浏览器窗口人工确认。',
      images: input.images.length,
      tags: applied,
      errorScreenshot: success ? undefined : await saveErrorScreenshot(page),
    };
  } catch (err) {
    const shot = await saveErrorScreenshot(page);
    throw new Error(`${(err as Error).message}${shot ? `（截图：${shot}）` : ''}`);
  }
}
