/* ============================================================
 *  目标分端到端验证 —— 「?target=5000 到底能不能自己打到 5000 然后停下」
 *
 *  为什么单独写：`browsercheck.js` 只验到"参数写进了 CFG.targetScore"，
 *  `autoplay.test.js` 只验到"强行把分数抬过目标后它会停"。
 *  **没有任何一个测过"真跑一局、真到 5000、真停下"** —— 而这恰好是
 *  用户唯一在意的承诺。承诺就得真验一遍。
 *
 *  顺带产出**最有用的那个数字**：要打几局才能碰到一次 5000。
 *  单局分数方差极大（同配置 2400~9500），"平均分"回答不了这个问题，
 *  只有"连打到达标为止、一共几局"才是真答案。
 *
 *  用法：
 *    node targettest.js --target 5000 --speed 8 --secs 1800
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
const TARGET = Number(arg('target', 5000));
const SPEED = arg('speed', '8');
const SECS = Number(arg('secs', 1800));       // 总时限（秒）
const PORT = Number(arg('port', 9500));

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

const URL_GAME = BASE.replace(/\/$/, '/') +
  'index.html?auto=1&speed=' + SPEED + '&target=' + TARGET;

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

const SAMPLE = `(() => {
  const s = __DNW__.state, A = window.DNW_AUTO;
  return {
    t: Math.round(performance.now()),
    score: s.score,
    over: s.over,
    enabled: A ? A.enabled : null,
    games: A ? A.stats.games : -1,
    lastScore: A ? A.stats.lastScore : -1,
    bestScore: A ? A.stats.bestScore : -1,
    drops: A ? A.stats.drops : -1,
    reached: A ? A.reached : -1,
    target: A ? A.CFG.targetScore : -1
  };
})()`;

(async () => {
  if (!BROWSER) {
    console.log('没找到 Edge / Chrome —— 跳过（可用 DNW_BROWSER 指定路径）');
    process.exit(0);
  }
  console.log('浏览器：' + BROWSER);
  console.log('页面：' + URL_GAME);
  console.log('时限：' + SECS + 's\n');

  const profile = path.join(os.tmpdir(), 'edge-target-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,900', URL_GAME
  ], { stdio: 'ignore' });

  let pass = false;
  try {
    let cdp = null;
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
    if (!cdp) throw new Error('连不上调试端口 ' + PORT);
    await cdp.send('Runtime.enable');
    await sleep(2500);

    const boot = await cdp.eval(SAMPLE);
    console.log('目标分 = ' + boot.target + '，倍速写进 state.speed = ' +
                (await cdp.eval('__DNW__.state.speed')));
    if (boot.target !== TARGET) throw new Error('目标分没写对：' + boot.target);

    const t0 = Date.now();
    const games = [];                 // 每局结束时的分数
    let lastGames = boot.games;
    let last = boot;
    let reached = false;

    while ((Date.now() - t0) / 1000 < SECS) {
      await sleep(3000);
      last = await cdp.eval(SAMPLE);
      if (last.games > lastGames) {
        for (let g = 0; g < last.games - lastGames; g++) games.push(last.lastScore);
        lastGames = last.games;
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        console.log('  t=' + el.padStart(4) + 's  第 ' + last.games + ' 局结束：' +
                    last.lastScore + ' 分（自动最高 ' + last.bestScore + '）');
      } else {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        process.stdout.write('\r  t=' + el.padStart(4) + 's  本局 ' + last.score +
                             ' 分 · 自动最高 ' + last.bestScore + ' · 投放 ' + last.drops + '   ');
      }
      if (last.reached > 0) { reached = true; break; }
    }
    process.stdout.write('\n');

    const elapsed = (Date.now() - t0) / 1000;
    const after = await cdp.eval(SAMPLE);

    console.log('\n=== 结果 ===');
    console.log('  用时            ' + elapsed.toFixed(0) + 's（' + (elapsed / 60).toFixed(1) + ' 分钟）');
    console.log('  打了局数        ' + games.length + (games.length ? '：' + games.join(', ') : ''));
    console.log('  自动最高分      ' + after.bestScore);
    console.log('  自动模式已停    ' + (after.enabled === false ? '是' : '否'));
    console.log('  reached         ' + after.reached);

    if (reached && after.enabled === false) {
      console.log('\n  [OK] 打到 ' + TARGET + ' 分后自己停了下来（enabled=false）');
      const hit = games.findIndex(s => s >= TARGET);
      console.log('  [OK] 达标那一局是第 ' + (hit + 1) + ' 局，' + games[hit] + ' 分');
      console.log('  信息：' + games.length + ' 局里 ' +
                  games.filter(s => s >= TARGET).length + ' 局 ≥ ' + TARGET);
      pass = true;
    } else if (reached) {
      console.log('\n  [NG] reached 到了但自动模式还开着');
    } else {
      console.log('\n  [NG] ' + SECS + 's 内没打到 ' + TARGET + ' 分（打了 ' + games.length +
                  ' 局，最高 ' + after.bestScore + '）—— 可能是时限太短，也可能是真的打不上去');
    }
  } catch (e) {
    console.log('  [NG] 脚本自己挂了：' + (e && e.message || e));
  } finally {
    try { proc.kill(); } catch (e) {}
  }

  console.log('\n' + (pass ? '目标分端到端验证通过' : '目标分端到端验证未通过'));
  process.exit(pass ? 0 : 1);
})();
