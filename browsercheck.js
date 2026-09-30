/* 真浏览器集成验证（CDP 驱动本机 Chromium 系浏览器，零依赖）
   跑法：
     1) 先把仓库目录用静态服务器挂起来（任选其一）
          python -m http.server 8080
          npx serve -l 8080
     2) node browsercheck.js
   可用环境变量：
     DNW_URL    默认 http://127.0.0.1:8080/index.html
     DNW_BROWSER  手动指定浏览器可执行文件（Edge / Chrome / Chromium 都行）
     DNW_PORT   调试端口，默认 9333
   输出：临时目录下的 browsercheck/*.png + 控制台结论
   退出码：0 通过（或找不到浏览器而跳过）/ 1 未通过 */
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

const EDGE = findBrowser();
const URL_GAME = process.env.DNW_URL || 'http://127.0.0.1:8080/index.html';
const PORT = Number(process.env.DNW_PORT || 9333);
const OUT = path.join(os.tmpdir(), 'browsercheck');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error('页面里报错: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        return new CDP(ws);
      }
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('连不上 Edge 的调试端口');
}

let pass = true;
const check = (name, ok, detail) => {
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
};

(async () => {
  if (!EDGE) {
    console.log('没找到 Edge / Chrome / Chromium —— 跳过真浏览器验证（不算失败）。');
    console.log('可以手动指定：DNW_BROWSER=/path/to/chrome node browsercheck.js');
    process.exit(0);
  }
  console.log('浏览器：' + EDGE);
  console.log('页面：' + URL_GAME + '\n');

  const profile = path.join(os.tmpdir(), 'edge-cdp-profile-' + Date.now());
  const proc = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900',
    URL_GAME
  ], { stdio: 'ignore' });

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await sleep(2500);          // 等贴图 decode + boot

    const errs = [];
    const warns = [];
    const drain = () => {
      for (const e of cdp.events.splice(0)) {
        if (e.method === 'Runtime.exceptionThrown') {
          errs.push('exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
        } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
          const t = e.params.entry.text || '';
          const u = e.params.entry.url || '';
          /* vibrate 被拦是浏览器的策略提示（无用户手势），不是我们的 bug */
          if (/navigator\.vibrate/.test(t)) { warns.push('vibrate 策略提示（无害）'); continue; }
          /* favicon 没放，浏览器自己会去要一次 —— 跟游戏无关 */
          if (/favicon\.ico/.test(t) || /favicon\.ico/.test(u)) { warns.push('favicon 404（无害）'); continue; }
          errs.push('console.error: ' + t + (u ? '  <' + u + '>' : ''));
        } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'warning') {
          warns.push('console.warn: ' + e.params.entry.text);
        }
      }
    };
    drain();

    console.log('== 桌面端 ==');

    /* 1. 基本装载 */
    const boot = await cdp.eval(`(() => ({
      hasDNW: !!window.__DNW__,
      hasAuto: !!window.DNW_AUTO,
      hasBoard: !!window.DanaiwaBoard,
      balls: __DNW__.state.balls.length,
      pending: __DNW__.state.pending,
      next: __DNW__.state.next,
      speed: __DNW__.state.speed,
      badgeHidden: document.getElementById('autoBadge').hidden,
      speedHidden: document.getElementById('autoSpeed').hidden,
      canvasW: document.getElementById('game').width,
      btnText: document.getElementById('autoBtn').textContent.trim(),
      tips: document.querySelector('.tips').textContent.indexOf('自动') >= 0
    }))()`);
    check('game.js 暴露了 __DNW__', boot.hasDNW === true);
    check('autoplay.js 已加载并暴露 DNW_AUTO', boot.hasAuto === true,
      'hasAuto=' + boot.hasAuto + (warns.length ? '  警告: ' + warns.join(' | ') : ''));
    check('autoplay.js 在 index.html 里被引用了',
      await cdp.eval(`Array.from(document.scripts).some(s => /autoplay\\.js/.test(s.src))`));
    check('开局已备好两颗水果（pending/next）', boot.pending !== undefined && boot.next !== undefined,
      'pending=' + boot.pending + ' next=' + boot.next);
    check('棋盘 canvas 有实际尺寸', boot.canvasW > 100, 'width=' + boot.canvasW);
    check('初始速度 = 1×', boot.speed === 1, 'speed=' + boot.speed);
    check('徽标默认隐藏 / 倍速选择默认隐藏', boot.badgeHidden === true && boot.speedHidden === true);
    check('按钮文案是「自动」', boot.btnText.indexOf('自动') >= 0, boot.btnText);
    check('提示文案提到了自动模式', boot.tips === true);

    /* 2. 点按钮开启自动 */
    const on = await cdp.eval(`(() => {
      document.getElementById('autoBtn').click();
      return {
        enabled: DNW_AUTO.enabled,
        speed: __DNW__.state.speed,
        badgeHidden: document.getElementById('autoBadge').hidden,
        badge: document.getElementById('autoBadge').textContent,
        speedHidden: document.getElementById('autoSpeed').hidden,
        btnText: document.getElementById('autoBtn').textContent.trim(),
        aria: document.getElementById('autoBtn').getAttribute('aria-pressed')
      };
    })()`);
    check('点「自动」能开启', on.enabled === true);
    check('徽标出现并显示状态', on.badgeHidden === false && /自动/.test(on.badge), on.badge);
    check('倍速选择出现', on.speedHidden === false);
    check('按钮变成「停止」+ aria-pressed', on.btnText.indexOf('停止') >= 0 && on.aria === 'true', on.btnText);

    /* 3. 切 4× */
    const sp = await cdp.eval(`(() => {
      document.querySelector('#autoSpeed button[data-speed="4"]').click();
      return {
        speed: __DNW__.state.speed,
        active: document.querySelector('#autoSpeed button[data-speed="4"]').classList.contains('active'),
        badge: document.getElementById('autoBadge').textContent
      };
    })()`);
    check('点 4× 后 state.speed = 4', sp.speed === 4, 'speed=' + sp.speed);
    check('4× 按钮高亮', sp.active === true);
    check('徽标跟着显示 4×', /4×/.test(sp.badge), sp.badge);

    /* 3b. 还有更快的 8× */
    const sp8 = await cdp.eval(`(() => {
      document.querySelector('#autoSpeed button[data-speed="8"]').click();
      return { speed: __DNW__.state.speed,
               active: document.querySelector('#autoSpeed button[data-speed="8"]').classList.contains('active'),
               badge: document.getElementById('autoBadge').textContent };
    })()`);
    check('点 8× 后 state.speed = 8', sp8.speed === 8, 'speed=' + sp8.speed);
    check('8× 按钮高亮且徽标跟着走', sp8.active === true && /8×/.test(sp8.badge), sp8.badge);

    /* 4. 让它真的玩一会儿 */
    const before = await cdp.eval('__DNW__.state.score');
    await sleep(9000);
    const play = await cdp.eval(`(() => {
      const s = __DNW__.state;
      let maxTier = 0;
      for (const b of s.balls) if (!b.dead && b.tier > maxTier) maxTier = b.tier;
      return {
        score: s.score, balls: s.balls.length, maxTier: maxTier,
        drops: DNW_AUTO.stats.drops, status: DNW_AUTO.status,
        scoreText: document.getElementById('score').textContent,
        badge: document.getElementById('autoBadge').textContent,
        best: s.best
      };
    })()`);
    check('AI 真的在下（投放次数 > 0）', play.drops > 0, '投放 ' + play.drops + ' 次');
    check('分数在涨', play.score > before, before + ' → ' + play.score);
    check('侧边栏分数跟着更新', Number(play.scoreText) === play.score, 'DOM=' + play.scoreText);
    check('徽标在报状态', /自动/.test(play.badge), play.badge);

    /* 5. 自动模式默认照常记分（record:true） */
    const bestRec = await cdp.eval(`(() => {
      const raw = localStorage.getItem('danaiwa.best.v1');
      return { stored: raw, memBest: __DNW__.state.best, score: __DNW__.state.score,
               bestText: document.getElementById('best').textContent,
               record: window.DNW_AUTO && DNW_AUTO.record };
    })()`);
    check('默认 record:true —— 自动模式的最高分照常写 localStorage',
      bestRec.record === true && bestRec.stored !== null && Number(bestRec.stored) > 0,
      'record=' + bestRec.record + '  localStorage=' + bestRec.stored +
      '  内存 best=' + bestRec.memBest + '  当前分=' + bestRec.score);

    const shot1 = await cdp.shot('desktop-auto');
    console.log('  截图：' + shot1);

    /* 6. 手动碰棋盘应退出自动 */
    const quit = await cdp.eval(`(() => {
      const st = document.getElementById('stage');
      const r = st.getBoundingClientRect();
      st.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, pointerType: 'mouse'
      }));
      return { enabled: DNW_AUTO.enabled, speed: __DNW__.state.speed,
               badgeHidden: document.getElementById('autoBadge').hidden };
    })()`);
    check('手动点棋盘会退出自动模式', quit.enabled === false);
    check('退出后倍速复位为 1×', quit.speed === 1, 'speed=' + quit.speed);
    check('退出后徽标隐藏', quit.badgeHidden === true);

    /* 7. 键盘 T 开关 */
    const key = await cdp.eval(`(() => {
      const send = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      send('KeyT');
      const a = DNW_AUTO.enabled;
      send('KeyT');
      return { afterFirst: a, afterSecond: DNW_AUTO.enabled, speed: __DNW__.state.speed };
    })()`);
    check('T 键能开关自动模式', key.afterFirst === true && key.afterSecond === false);

    /* 8. 结束后自动重开 */
    /* 先确认页面的 rAF 还活着（不然是浏览器节流，不是我们的 bug） */
    await cdp.eval(`(() => { window.__rafProbe = 0;
      const f = () => { window.__rafProbe++; requestAnimationFrame(f); };
      requestAnimationFrame(f); return 1; })()`);
    await sleep(600);
    const rafProbe = await cdp.eval('window.__rafProbe');

    await cdp.eval('DNW_AUTO.setEnabled(true)');
    await cdp.eval('__DNW__.state.over = true');
    await sleep(400);
    const mid8 = await cdp.eval(`(() => ({
      enabled: DNW_AUTO.enabled, overAt: Math.round(DNW_AUTO.overAt),
      status: DNW_AUTO.status, games: DNW_AUTO.stats.games,
      now: Math.round(performance.now()), over: __DNW__.state.over,
      delay: DNW_AUTO.CFG.restartDelay, rafProbe: window.__rafProbe,
      dbg: DNW_AUTO.debug()
    }))()`);
    await sleep(2200);
    /* 关键：这里**不许**手动调 DNW_AUTO.step()。
       手动调就绕开了 tick()，测不出「rAF 主循环自己会把下一局开起来」。
       只观察 —— 这才是这个用例存在的意义。 */
    const afterOver = await cdp.eval(`(() => ({
      over: __DNW__.state.over, score: __DNW__.state.score,
      balls: __DNW__.state.balls.length, games: DNW_AUTO.stats.games,
      enabled: DNW_AUTO.enabled, status: DNW_AUTO.status,
      overAt: Math.round(DNW_AUTO.overAt), drops: DNW_AUTO.stats.drops,
      dbg: DNW_AUTO.debug()
    }))()`);
    check('结束后自动开下一局（纯 rAF 主循环，不手动调 step）',
      afterOver.over === false && afterOver.games >= 1 && afterOver.enabled === true,
      JSON.stringify({ rafProbe600ms: rafProbe, mid: mid8, after: afterOver }));

    drain();
    check('桌面端全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    /* 9. ?auto=1 打开就全自动（重新导航一次，验证自启） */
    console.log('\n== 打开就全自动 (?auto=1&speed=4) ==');
    const autoUrl = URL_GAME + (URL_GAME.indexOf('?') >= 0 ? '&' : '?') + 'auto=1&speed=4';
    await cdp.send('Page.navigate', { url: autoUrl });
    await sleep(2500);
    const autoBoot = await cdp.eval(`(() => ({
      enabled: window.DNW_AUTO && DNW_AUTO.enabled,
      speed: __DNW__.state.speed,
      badgeHidden: document.getElementById('autoBadge').hidden,
      badge: document.getElementById('autoBadge').textContent,
      btn: document.getElementById('autoBtn').textContent.trim()
    }))()`);
    check('一进页面自动模式就是开着的', autoBoot.enabled === true, JSON.stringify(autoBoot));
    check('倍速按参数定好了', autoBoot.speed === 4, 'speed=' + autoBoot.speed);
    check('徽标直接亮起 + 按钮是「停止」',
      autoBoot.badgeHidden === false && /自动/.test(autoBoot.badge) && autoBoot.btn.indexOf('停止') >= 0,
      autoBoot.badge + ' / ' + autoBoot.btn);

    const ad1 = await cdp.eval('DNW_AUTO.stats.drops');
    await sleep(6000);
    const ad2 = await cdp.eval(`(() => ({ drops: DNW_AUTO.stats.drops,
      score: __DNW__.state.score, enabled: DNW_AUTO.enabled }))()`);
    check('没人碰它，它自己在投', ad2.drops > ad1, ad1 + ' → ' + ad2.drops + ' 次');
    check('自启后还开着', ad2.enabled === true);

    drain();
    check('自启模式无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    /* 10. ?record=0 才关掉记分 */
    console.log('\n== ?record=0 关掉记分 ==');
    const recUrl = URL_GAME + (URL_GAME.indexOf('?') >= 0 ? '&' : '?') + 'auto=1&speed=4&record=0';
    await cdp.send('Page.navigate', { url: recUrl });
    await sleep(2500);
    const recBoot = await cdp.eval(`(() => ({
      record: window.DNW_AUTO && DNW_AUTO.record,
      stored: localStorage.getItem('danaiwa.best.v1')
    }))()`);
    check('?record=0 把 record 关掉了', recBoot.record === false, JSON.stringify(recBoot));

    /* 清掉上一节留下的最高分，再让它玩一会儿，看会不会又写回去 */
    await cdp.eval(`localStorage.removeItem('danaiwa.best.v1')`);
    await sleep(6000);
    const recAfter = await cdp.eval(`(() => ({
      stored: localStorage.getItem('danaiwa.best.v1'),
      memBest: __DNW__.state.best, score: __DNW__.state.score
    }))()`);
    check('?record=0 时最高分不写 localStorage',
      recAfter.stored === null,
      'localStorage=' + recAfter.stored + '  内存 best=' + recAfter.memBest +
      '  当前分=' + recAfter.score);

    drain();
    check('?record=0 模式无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    /* 11. 上游功能回归：赞助弹窗。
       我们的补丁也改了 index.html / style.css —— 恰好是赞助弹窗依赖的两个文件，
       所以这里放一道回归线，免得以后合上游改动时把它悄悄碰坏。
       没这个按钮的版本（老提交）自动跳过。 */
    const hasSponsor = await cdp.eval(`!!document.getElementById('sponsorBtn')`);
    if (hasSponsor) {
      console.log('\n== 上游功能回归：赞助弹窗 ==');
      const sp = await cdp.eval(`(() => {
        const btn = document.getElementById('sponsorBtn');
        const modal = document.getElementById('sponsorModal');
        const shownBefore = modal.classList.contains('show');
        btn.click();
        const shownAfter = modal.classList.contains('show');
        const ariaAfter = modal.getAttribute('aria-hidden');
        document.getElementById('sponsorOk').click();
        const shownClosed = modal.classList.contains('show');
        return { shownBefore: shownBefore, shownAfter: shownAfter,
                 ariaAfter: ariaAfter, shownClosed: shownClosed };
      })()`);
      check('点「辣条」能打开赞助弹窗',
        sp.shownBefore === false && sp.shownAfter === true && sp.ariaAfter === 'false',
        JSON.stringify(sp));
      check('点「关闭」能收起赞助弹窗', sp.shownClosed === false, JSON.stringify(sp));
      drain();
      check('赞助弹窗无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    } else {
      console.log('\n（这个版本没有赞助弹窗，跳过该项）');
    }

    /* 12. 移动端视口 */
    console.log('\n== 移动端 (390×844) ==');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await sleep(1200);
    const mob = await cdp.eval(`(() => {
      const q = (s) => document.querySelector(s);
      const rect = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
      const panel = rect('.panel'), stage = rect('.stage');
      const cs = getComputedStyle(document.querySelector('.auto-speed'));
      const btn = rect('#autoBtn');
      const badge = rect('#autoBadge');
      return {
        panelTop: panel && Math.round(panel.top),
        stageTop: stage && Math.round(stage.top),
        panelAboveStage: panel && stage && panel.bottom <= stage.top + 2,
        speedDisplay: cs.display,
        hintDisplay: getComputedStyle(q('.auto-badge-hint')).display,
        badgeH: badge && Math.round(badge.height),
        badgeText: q('#autoBadge').textContent,
        lblHidden: getComputedStyle(q('#autoBtn .lbl')).display,
        btnH: btn && Math.round(btn.height),
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        bodyOverflow: document.documentElement.scrollHeight - window.innerHeight
      };
    })()`);
    check('窄屏下信息条被提到棋盘上方', mob.panelAboveStage === true,
      'panel.bottom=' + (mob.panelTop) + ' stage.top=' + mob.stageTop);
    check('窄屏下倍速按钮收起', mob.speedDisplay === 'none', 'display=' + mob.speedDisplay);
    check('窄屏徽标带「点我换倍速」提示',
      mob.hintDisplay !== 'none' && /点我换倍速/.test(mob.badgeText),
      'display=' + mob.hintDisplay + '  文案=' + mob.badgeText);
    check('窄屏下自动按钮只留图标', mob.lblHidden === 'none', 'lbl display=' + mob.lblHidden);
    check('触摸目标 ≥ 46px', mob.btnH >= 46, btnHText(mob));
    check('窄屏没有横向溢出', mob.scrollW <= mob.clientW + 1,
      'scrollW=' + mob.scrollW + ' clientW=' + mob.clientW);

    /* 窄屏点徽标换倍速：从当前档位往后滚一圈 */
    const cyc = await cdp.eval(`(() => {
      const b = document.getElementById('autoBadge');
      const before = __DNW__.state.speed;
      b.click(); const a1 = __DNW__.state.speed;
      b.click(); const a2 = __DNW__.state.speed;
      b.click(); const a3 = __DNW__.state.speed;
      return { before: before, seq: [a1, a2, a3], text: b.textContent };
    })()`);
    const order = { 1: [2, 4, 8], 2: [4, 8, 1], 4: [8, 1, 2], 8: [1, 2, 4] };
    check('窄屏点徽标按 1→2→4→8→1 循环',
      order[cyc.before] && cyc.seq.join() === order[cyc.before].join(),
      JSON.stringify(cyc));

    /* 关键：点徽标换倍速时**不能**被当成「碰棋盘」而退出自动模式。
       注意要把事件派发在徽标上（target 才是徽标）—— 派发在 stage 上模拟不出真实点击。 */
    const badgeTouch = await cdp.eval(`(() => {
      const b = document.getElementById('autoBadge');
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, pointerType: 'touch'
      }));
      return { enabled: DNW_AUTO.enabled, speed: __DNW__.state.speed };
    })()`);
    check('摸徽标不会退出自动模式（只有摸棋盘才退）', badgeTouch.enabled === true,
      JSON.stringify(badgeTouch));

    const shot2 = await cdp.shot('mobile-auto');
    console.log('  截图：' + shot2);

    drain();
    check('移动端无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    /* 13. URL 参数：?target= 设目标分、?record=all 每局都交榜。
       这两个只解析参数、不用真打到目标，所以很快。
       顺带把「record 的三种取值」钉住 —— 默认 true 只是**刷新最高分才交**，
       因为排行榜只看最近 20 条（leaderboard.min.js 的 WINDOW=20），
       每局都交会把自己的高分挤出窗口。 */
    console.log('\n== URL 参数：?target= / ?record=all ==');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const qUrl = URL_GAME + (URL_GAME.indexOf('?') >= 0 ? '&' : '?') +
                 'auto=1&speed=8&target=5000&record=all';
    await cdp.send('Page.navigate', { url: qUrl });
    await sleep(2200);
    const qBoot = await cdp.eval(`(() => ({
      target: DNW_AUTO.CFG.targetScore,
      record: DNW_AUTO.record,
      speed: __DNW__.state.speed,
      reached: DNW_AUTO.reached,
      stat: document.getElementById('autoStat').textContent
    }))()`);
    check('?target=5000 写进了 CFG.targetScore', qBoot.target === 5000, JSON.stringify(qBoot));
    check('?record=all 让自动模式每局都交榜', qBoot.record === 'all', 'record=' + qBoot.record);
    check('信息条会显示目标分', /目标\s*5000/.test(qBoot.stat), qBoot.stat);
    drain();
    check('URL 参数模式无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) {
    console.log('  [NG] 验证脚本自己挂了：' + e.message);
    pass = false;
  } finally {
    try { proc.kill(); } catch (e) {}
  }

  console.log('\n' + (pass ? '真浏览器集成验证通过' : '真浏览器集成验证未通过'));
  console.log('截图目录：' + OUT);
  process.exit(pass ? 0 : 1);
})();

function btnHText(mob) { return '按钮高 ' + mob.btnH + 'px'; }
