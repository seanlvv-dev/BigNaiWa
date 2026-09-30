/* 挂机压测：真浏览器里让自动模式连跑若干分钟，看会不会漏内存 / 卡死 / 报错
   跑法：
     1) python -m http.server 8080
     2) SOAK_MIN=4 SOAK_STRESS_MIN=2 node soak.js
   阶段 A：正常挂机（4×），每 15 秒采一次样
   阶段 B：每 3 秒强行把 state.over 置 true，逼它走几十次「结束 → 重开」
   可用环境变量：SOAK_MIN / SOAK_STRESS_MIN（分钟）、DNW_URL、DNW_BROWSER、DNW_PORT
   找不到浏览器时打印提示并跳过（退出码 0） */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* 找一台 Chromium 系浏览器：显式指定 > 各平台常见安装位置 */
function findBrowser() {
  if (process.env.DNW_BROWSER && fs.existsSync(process.env.DNW_BROWSER)) return process.env.DNW_BROWSER;
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ] : process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ] : [
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

const BROWSER = findBrowser();
const URL_GAME = process.env.DNW_URL ||
  'http://127.0.0.1:8080/index.html?auto=1&speed=4';
const PORT = Number(process.env.DNW_PORT || 9360);
const MIN_A = Number(process.env.SOAK_MIN || 4) * 60000;
const MIN_B = Number(process.env.SOAK_STRESS_MIN || 2) * 60000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
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

const SAMPLE = `(() => {
  const s = __DNW__.state, A = window.DNW_AUTO;
  const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
  return {
    t: Math.round(performance.now()),
    score: s.score, balls: s.balls.length,
    particles: s.particles ? s.particles.length : -1,
    floats: s.floats ? s.floats.length : -1,
    over: s.over, enabled: A ? A.enabled : null,
    games: A ? A.stats.games : -1,
    drops: A ? A.stats.drops : -1,
    thinkMs: A ? Math.round(A.stats.thinkMs) : -1,
    heap: mem
  };
})()`;

let pass = true;
const check = (n, ok, d) => { console.log((ok ? '  [OK] ' : '  [NG] ') + n + (d ? '  -- ' + d : '')); if (!ok) pass = false; };

(async () => {
  if (!BROWSER) {
    console.log('没找到 Edge / Chrome / Chromium —— 跳过挂机压测（不算失败）。');
    console.log('可以手动指定：DNW_BROWSER=/path/to/chrome node soak.js');
    process.exit(0);
  }
  console.log('浏览器：' + BROWSER);
  console.log('页面：' + URL_GAME);

  const profile = path.join(os.tmpdir(), 'edge-soak-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,900', URL_GAME
  ], { stdio: 'ignore' });

  try {
    let cdp;
    for (let i = 0; i < 60 && !cdp; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
          cdp = new CDP(ws);
        }
      } catch (e) {}
      if (!cdp) await sleep(500);
    }
    if (!cdp) throw new Error('连不上调试端口');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(2500);

    const boot = await cdp.eval(SAMPLE);
    check('挂机页起来了且自动模式开着', boot.enabled === true, JSON.stringify(boot));

    const samples = [boot];
    const errs = [];
    const collect = () => {
      for (const e of cdp.events.splice(0)) {
        if (e.method === 'Runtime.exceptionThrown') {
          errs.push('exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
        } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
          const t = e.params.entry.text || '', u = e.params.entry.url || '';
          if (/favicon\.ico|navigator\.vibrate/.test(t) || /favicon\.ico/.test(u)) continue;
          errs.push('console.error: ' + t);
        }
      }
    };

    /* ---------- 阶段 A：正常挂机 ---------- */
    console.log('\n== 阶段 A：正常挂机 ' + (MIN_A / 60000) + ' 分钟（4×）==');
    const tA = Date.now();
    let lastLog = 0;
    while (Date.now() - tA < MIN_A) {
      await sleep(15000);
      collect();
      const s = await cdp.eval(SAMPLE);
      samples.push(s);
      const el = Math.round((Date.now() - tA) / 1000);
      if (el - lastLog >= 60) {
        lastLog = el;
        console.log('  t=' + String(el).padStart(3) + 's  分=' + String(s.score).padStart(5) +
          '  球=' + String(s.balls).padStart(2) + '  粒子=' + String(s.particles).padStart(3) +
          '  飘分=' + String(s.floats).padStart(2) + '  局=' + s.games +
          '  投放=' + s.drops + '  heap=' + (s.heap ? (s.heap / 1048576).toFixed(1) + 'MB' : 'n/a'));
      }
    }

    /* ---------- 阶段 B：逼它反复「结束 → 重开」 ---------- */
    console.log('\n== 阶段 B：强制重开压测 ' + (MIN_B / 60000) + ' 分钟（每 3 秒结束一次）==');
    const gamesBefore = (await cdp.eval(SAMPLE)).games;
    const tB = Date.now();
    let forced = 0, restarts = 0;
    while (Date.now() - tB < MIN_B) {
      await cdp.eval('__DNW__.state.over = true');
      forced++;
      await sleep(3000);
      const s = await cdp.eval(SAMPLE);
      samples.push(s);
      if (s.over === false) restarts++;
      collect();
    }
    const gamesAfter = (await cdp.eval(SAMPLE)).games;

    console.log('  强制结束 ' + forced + ' 次，其中成功自动重开 ' + restarts + ' 次');
    check('每次强制结束后都能自动重开', restarts >= forced - 1,
      forced + ' 次里成功 ' + restarts + ' 次');
    check('局数计数器跟着涨', gamesAfter > gamesBefore,
      gamesBefore + ' → ' + gamesAfter);

    /* ---------- 汇总 ---------- */
    const nums = (k) => samples.map(s => s[k]).filter(v => typeof v === 'number' && v >= 0);
    const maxOf = (k) => Math.max.apply(null, nums(k));
    const heapS = nums('heap');
    const heapMB = (v) => (v / 1048576).toFixed(1) + 'MB';

    console.log('\n== 汇总 ==');
    console.log('  采样点数        ' + samples.length);
    console.log('  球数 峰值       ' + maxOf('balls'));
    console.log('  粒子 峰值       ' + maxOf('particles'));
    console.log('  飘分 峰值       ' + maxOf('floats'));
    console.log('  累计投放        ' + maxOf('drops'));
    console.log('  累计局数        ' + maxOf('games'));
    if (heapS.length) {
      console.log('  heap 首/末/峰   ' + heapMB(heapS[0]) + ' / ' +
        heapMB(heapS[heapS.length - 1]) + ' / ' + heapMB(Math.max.apply(null, heapS)));
    }

    const last = samples[samples.length - 1];
    check('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    check('挂机结束时自动模式还开着', last.enabled === true);
    check('粒子数没有无限堆积（峰值 < 4000）', maxOf('particles') < 4000, '峰值 ' + maxOf('particles'));
    check('飘分数没有无限堆积（峰值 < 200）', maxOf('floats') < 200, '峰值 ' + maxOf('floats'));
    check('球数没有无限堆积（峰值 < 80）', maxOf('balls') < 80, '峰值 ' + maxOf('balls'));
    if (heapS.length >= 3) {
      const grew = heapS[heapS.length - 1] - heapS[0];
      check('堆内存没有明显泄漏（增长 < 60MB）', grew < 60 * 1048576,
        '增长 ' + heapMB(Math.max(0, grew)));
    }
  } catch (e) {
    console.log('  [NG] 压测脚本自己挂了：' + e.message);
    pass = false;
  } finally {
    try { proc.kill(); } catch (e) {}
  }
  console.log(pass ? '\n挂机压测通过' : '\n挂机压测未通过');
  process.exit(pass ? 0 : 1);
})();
