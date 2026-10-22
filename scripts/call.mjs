/**
 * 命令行直连调用器：绕过 MCP 客户端，直接对一个工具发一次 tools/call。
 *
 * 用法：
 *   node scripts/call.mjs <toolName> ['{"参数":"JSON"}']
 *   node scripts/call.mjs --list
 *
 * 示例：
 *   node scripts/call.mjs xhs_auth_status
 *   node scripts/call.mjs xhs_list_my_notes '{"limit":5}'
 *   node scripts/call.mjs xhs_get_note '{"target":"https://www.xiaohongshu.com/explore/xxx?xsec_token=xxx"}'
 *
 * 环境变量：
 *   CALL_TIMEOUT_MS  单次调用超时，默认 180000（浏览器操作较慢）
 *
 * 注意：MCP 托管浏览器使用独立 profile 目录，同一时刻只能被一个进程占用。
 * 如果 WorkBuddy 里已经跑着 xhs-mcp，请先把那边的浏览器关掉（xhs_close_browser）再在本机跑这个脚本。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'server.js');
const TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS ?? 180000);

const [, , toolName, rawArgs] = process.argv;
if (!toolName) {
  console.error("用法：node scripts/call.mjs <toolName> ['{JSON 参数}']   或   --list");
  process.exit(1);
}

let args = {};
if (rawArgs && rawArgs.trim() !== '') {
  try {
    args = JSON.parse(rawArgs);
  } catch (err) {
    console.error(`参数不是合法 JSON：${err.message}`);
    process.exit(1);
  }
}

const child = spawn(process.execPath, [serverEntry], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const responses = new Map();

child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
});

child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function waitFor(id, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(tick);
        resolve(responses.get(id));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`等待 id=${id} 响应超时（${timeoutMs}ms）`));
      }
    }, 150);
  });
}

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'xhs-mcp-call', version: '0.0.1' },
    },
  });
  await waitFor(1, 15000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  if (toolName === '--list') {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await waitFor(2, 15000);
    for (const tool of list.result?.tools ?? []) {
      const props = Object.entries(tool.inputSchema?.properties ?? {});
      const required = new Set(tool.inputSchema?.required ?? []);
      const paramText = props
        .map(([key, schema]) => `${key}${required.has(key) ? '' : '?'}:${schema?.type ?? '?'}`)
        .join(' ');
      console.log(`${tool.name}  ${paramText || '(无参数)'}`);
      console.log(`    ${tool.description?.slice(0, 90) ?? ''}`);
    }
    process.exit(0);
  }

  console.log(`→ 调用 ${toolName} ${Object.keys(args).length ? JSON.stringify(args) : ''}`.trim());
  const started = Date.now();
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: args } });
  const res = await waitFor(3);

  if (res.error) {
    console.error(`协议错误：${JSON.stringify(res.error)}`);
    process.exitCode = 1;
  } else if (res.result?.isError) {
    console.error(`\n工具返回失败：`);
    console.error(res.result.content?.map(c => c.text).join('\n') ?? JSON.stringify(res.result));
    process.exitCode = 1;
  } else {
    const text = res.result?.content?.map(c => c.text).join('\n') ?? JSON.stringify(res.result);
    // 内容本身已是格式化 JSON 时原样输出，避免二次转义难读
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
    console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
} catch (err) {
  console.error(`调用失败：${err.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 500);
}
