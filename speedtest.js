/* ============================================================
 *  真浏览器「吞吐」测速台 —— 回答「一分钟到底能拿多少分」
 *
 *  为什么需要它：无头自测（autoplay.test.js）走的是**虚拟时钟**，
 *  时间预算永远不生效（详见 SKILL 里的说明），所以它测不出"卡不卡"。
 *  真浏览器里 performance.now() 是真实时间，7ms 的思考预算真的会咬住，
 *  加一层搜索是**抢**第 1 层的预算。所以速度这件事只能在这里量。
 *
 *  每个用例：开一个独立浏览器（独立端口 + 独立 profile，避免
 *  localStorage 里的最高分互相串），跑固定墙钟时长，量：
 *    投放次数 / 分钟      ← 这就是"快不快"
 *    思考 ms / 次投放      ← AI 自己花掉的部分（其余是在等棋盘落定）
 *    分数 / 分钟          ← 最终用户真正在意的
 *
 *  用法：
 *    node speedtest.js --secs 60 --speed 8 \
 *      --cases '1层|index.html?auto=1' \
 *              '2层|index.html?auto=1&ply2=0.5'
 *  （--cases 里给相对路径就行，会拼到 --base 上；也可以直接给完整 URL）
 * ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const BASE = arg('base', 'http://127.0.0.1:8080/');
const SECS = Number(arg('secs', 60));
const SPEED = arg('speed', '8');
const PORT0 = Number(arg('port', 9400));
const WARM = Number(arg('warm', 3));          // 预热秒数（等它起来、开始投）
/* 每个用例重复几轮。**单局 60 秒的方差极大** —— 同一个配置两次跑出过
   95 和 173 次投放/分钟，方向都能反过来。所以只跑一轮的数字不能用来下结论，
   要比配置就 --reps 3 起步，看中位数（本脚本报中位）。 */
const REPS = Math.max(1, Number(arg('reps', 1)));
/* CPU 降频倍数，用来模拟慢机器（手机 / 老笔记本）。
   AI 的思考预算是**墙上时间**（CFG.budgetMs），所以 CPU 越慢，
   每帧能算完的候选越少 → 棋力会下降。README 里写了"手机也能用"，
   这句话必须在这儿验一遍，不能靠想当然。
   --throttle 4 大致相当于中端手机。 */
const THROTTLE = Number(arg('throttle', 0));

/* —— 找浏览器 —— */
function findBrowser() {
  const cands = [
    process.env.DNW_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}
const BROWSER = findBrowser();

/* —— 用例 —— */
const cases = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--cases') continue;
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) {
    const raw = process.argv[j];
    const k = raw.indexOf('|');
    const tag = k < 0 ? raw : raw.slice(0, k);
    let url = k < 0 ? '' : raw.slice(k + 1);
    if (!url) url = 'index.html?auto=1';
    if (!/^https?:\/\//.test(url)) {
      url = BASE.replace(/\/$/, '/') + url.replace(/^\//, '');
    }
    if (!/speed=/.test(url)) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'speed=' + SPEED;
    cases.push({ tag: tag, url: url });
  }
}
if (!cases.length) {
  console.log('没有用例。示例：\n  node speedtest.js --secs 60 --cases \'1层|index.html?auto=1\' \'2层|index.html?auto=1&ply2=0.5\'');
  process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
}

/* 一次采样：拿到自动模式自己的计数（drops / thinkMs / score / games） */
const SAMPLE = `(() => {
  const s = __DNW__.state, A = window.DNW_AUTO;
  return {
    t: Math.round(performance.now()),
    score: s.score,
    over: s.over,
    enabled: A ? A.enabled : null,
    games: A ? A.stats.games : -1,
    drops: A ? A.stats.drops : -1,
    thinkMs: A ? A.stats.thinkMs : -1,
    ply2: A && A.stats.ply2 ? A.stats.ply2 : 0,
    speed: s.speed
  };
})()`;

async function runCase(c, port) {
  const profile = path.join(os.tmpdir(), 'edge-speed-' + port + '-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,900', c.url
  ], { stdio: 'ignore' });

  try {
    let cdp = null;
    for (let i = 0; i < 60 && !cdp; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
          cdp = new CDP(ws);
        }
      } catch (e) {}
      if (!cdp) await sleep(500);
    }
    if (!cdp) throw new Error('连不上调试端口 ' + port);
    await cdp.send('Runtime.enable');
    if (THROTTLE > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    }
    await sleep(WARM * 1000);

    const a = await cdp.eval(SAMPLE);
    if (a.enabled !== true) throw new Error('自动模式没开：' + JSON.stringify(a));

    const t0 = Date.now();
    await sleep(SECS * 1000);
    const b = await cdp.eval(SAMPLE);
    const wall = (Date.now() - t0) / 1000;

    const dDrops = b.drops - a.drops;
    const dThink = b.thinkMs - a.thinkMs;
    const dGames = b.games - a.games;
    return {
      tag: c.tag, url: c.url,
      speed: b.speed,
      secs: wall,
      drops: dDrops,
      dropsPerMin: dDrops / wall * 60,
      thinkPerDrop: dDrops > 0 ? dThink / dDrops : -1,
      // 分数：若中途跨局，b.score 是本局的分，不能直接相减；只报"当前局分"和局数
      scoreNow: b.score,
      games: dGames,
      ply2: b.ply2,
      ok: true
    };
  } finally {
    try { proc.kill(); } catch (e) {}
    await sleep(400);
  }
}

(async () => {
  if (!findBrowser()) {
    console.log('没找到 Edge / Chrome —— 跳过（可用 DNW_BROWSER 指定路径）');
    process.exit(0);
  }
  console.log('浏览器：' + BROWSER);
  console.log('时长：每个用例 ' + SECS + 's（预热 ' + WARM + 's）' +
              (THROTTLE > 1 ? '，CPU 降频 ' + THROTTLE + '×' : '') + '\n');

  const rows = [];
  let port = PORT0;
  for (const c of cases) {
    for (let rep = 0; rep < REPS; rep++) {
      process.stdout.write('跑 ' + c.tag + (REPS > 1 ? ' #' + (rep + 1) : '') + ' … ');
      try {
        const r = await runCase(c, port++);
        rows.push(r);
        process.stdout.write('投放 ' + r.drops + ' 次 / ' + r.secs.toFixed(0) + 's\n');
      } catch (e) {
        rows.push({ tag: c.tag, ok: false, err: String(e && e.message || e) });
        process.stdout.write('失败：' + (e && e.message || e) + '\n');
      }
    }
  }

  const median = (a) => {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2]
                        : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  console.log('\n=== 吞吐对比（真浏览器，' + SPEED + '×' +
              (THROTTLE > 1 ? '，CPU 降频 ' + THROTTLE + '×' : '') +
              (REPS > 1 ? '，每例 ' + REPS + ' 轮取中位' : '，单轮') + '）===');
  console.log('用例'.padEnd(12) + '投放/分' + '   思考ms/次' + '   轮数');
  for (const c of cases) {
    const rs = rows.filter(r => r.ok && r.tag === c.tag);
    if (!rs.length) {
      const bad = rows.find(r => !r.ok && r.tag === c.tag);
      console.log(c.tag.padEnd(12) + '失败：' + (bad ? bad.err : '无数据'));
      continue;
    }
    console.log(
      c.tag.padEnd(12) +
      String(Math.round(median(rs.map(r => r.dropsPerMin)))).padStart(7) +
      String(median(rs.map(r => r.thinkPerDrop)).toFixed(1)).padStart(12) +
      String(rs.length).padStart(7) +
      (rs.length > 1
        ? '   各轮投放/分 ' + rs.map(r => Math.round(r.dropsPerMin)).join(', ')
        : '')
    );
  }
  console.log('\n注意：单局分数方差极大，这里的"当前局分"只作参考；');
  console.log('      要看棋力请用无头自测的多局中位数（node bench2.js）。');
  if (REPS === 1 && cases.length > 1) {
    console.log('      ⚠️ 只跑了 1 轮：同配置两次能差一倍，别用这个数字下结论，'
                + '加 --reps 3。');
  }
})();
