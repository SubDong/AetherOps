/**
 * 刷新页面恢复终端 tab 时用到的「输出整形」纯函数。
 *
 * 单独放一个文件是为了能在 Node 里直接跑验证（本机没有可用的浏览器自动化），
 * 拿真实的 pwsh 启动字节喂进来即可断言。
 */

/**
 * 启动横幅里的清屏（ED 2 / ED 3）。
 * 恢复时见到它就说明新会话的启动输出吐得差不多了，可以把历史铺上去。
 */
export const STARTUP_CLEAR_RE = /\x1b\[[23]J/;

/**
 * 去掉启动横幅里的清屏与光标归位。
 *
 * 历史已经铺在上面了，这里再来一发 \x1b[2J 等于什么都没恢复；
 * 光标归位（\x1b[H / \x1b[1;1H）同理会把后面的输出写回屏幕顶部、盖住历史。
 * 只吃这两类，其余转义（颜色、隐藏/显示光标、标题等）原样保留。
 */
export function stripStartupClears(octets: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < octets.length; i++) {
    if (octets[i] === 0x1b && octets[i + 1] === 0x5b) {
      let j = i + 2;
      let params = '';
      while (j < octets.length && octets[j] >= 0x30 && octets[j] <= 0x3b) {
        params += String.fromCharCode(octets[j]);
        j++;
      }
      const isErase = octets[j] === 0x4a; // 'J'
      const isHome = octets[j] === 0x48; // 'H'
      if ((isErase && (params === '2' || params === '3')) || (isHome && (params === '' || params === '1;1'))) {
        i = j;
        continue;
      }
    }
    out.push(octets[i]);
  }
  return out;
}
