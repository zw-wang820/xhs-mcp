/**
 * stdio 传输下 stdout 是协议通道，任何普通输出都会破坏 MCP 握手。
 * 因此所有日志一律走 stderr。
 */
export function log(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[xhs-mcp ${ts}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

export function logError(err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`[xhs-mcp ERROR] ${msg}\n`);
}

/** 启动时打印一次的注意事项。抑制环境变量固定为 XHS_MCP_QUIET=1，不做成配置项。 */
export function printDisclaimer(text: string): void {
  if (process.env['XHS_MCP_QUIET'] === '1') return;
  const line = '─'.repeat(68);
  process.stderr.write(`${line}\n${text}\n${line}\n`);
}
