import { login } from '../auth.js';
import { closeBrowser } from '../browser.js';

const result = await login();

if (result.loggedIn) {
  const source =
    result.state.infoSource === 'live' ? '实时读取' : result.state.infoSource === 'cache' ? '本地缓存' : '未取到';
  process.stdout.write(
    [
      '登录成功。',
      `  昵称   ${result.state.nickname ?? '(未知)'}`,
      `  用户ID ${result.state.userId ?? '(未取到)'}`,
      `  信息源 ${source}`,
      '',
    ].join('\n'),
  );
} else {
  process.stdout.write('未检测到登录态，浏览器窗口保留，可继续扫码后再运行此命令。\n');
}

await closeBrowser();
process.exit(result.loggedIn ? 0 : 1);
