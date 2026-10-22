/**
 * 冒烟测试：不启动浏览器，只验证 MCP 协议握手与工具注册。
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'server.js');

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
      process.stderr.write(`无法解析的响应行：${line}\n`);
    }
  }
});

child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function waitFor(id, timeoutMs = 15000) {
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
        reject(new Error(`等待 id=${id} 响应超时`));
      }
    }, 100);
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
      clientInfo: { name: 'xhs-mcp-smoke', version: '0.0.1' },
    },
  });
  const init = await waitFor(1);
  const serverName = init.result?.serverInfo?.name ?? '(unknown)';
  console.log(`握手成功：serverInfo.name = ${serverName}`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  const tools = list.result?.tools ?? [];
  console.log(`工具数量：${tools.length}`);
  for (const tool of tools) {
    const required = Object.entries(tool.inputSchema?.properties ?? {})
      .filter(([, v]) => v?.type !== undefined)
      .map(([k]) => k);
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 40) ?? ''} (${required.join(', ') || '无参数'})`);
  }
  if (tools.length === 0) {
    console.error('工具列表为空，注册失败。');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`冒烟测试失败：${err.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 500);
}
