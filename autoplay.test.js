/* ============================================================
 *  自动模式自检（无浏览器，用桩件模拟 DOM/Canvas）
 *
 *  运行：
 *    node autoplay.test.js                     # 默认连打 3 局，带判定
 *    node autoplay.test.js 8 12345             # 局数 / 随机种子
 *    DNW_CFG='{"wPair":8}' node autoplay.test.js 3 1   # 临时覆盖 AI 权重
 *    DNW_QUIET=1 node autoplay.test.js 3 1     # 只输出一行 RESULT（调参用）
 *
 *  在 Node 里跑真物理 + 真 AI，统计每局得分 / 最大合成等级 / 投放次数，
 *  以及每步推演的开销。Math.random 换成可复现的伪随机，
 *  所以同种子同权重下结果完全可复现，方便做 A/B 对比。
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = __dirname;

const GAMES = Number(process.argv[2] || 3);
const SEED = Number(process.argv[3] || 20260930);
const TAG = process.env.DNW_TAG || '';
const QUIET = !!process.env.DNW_QUIET;
/* 单局上限（虚拟帧），防死循环。
   默认 24000 帧 ≈ 6.7 分钟游戏时间 —— 够 AI 打出一局完整的、能上 5000 的对局，
   同时保证这个自检几分钟内跑得完。撞到上限的那一局会被标 capped:true，
   它的分数只是**下限**（本来还能更高），所以别拿它当"AI 只能打这么多"。
   想让它打到底：DNW_MAX_FRAMES=200000 node autoplay.test.js 1 7 */
const MAX_FRAMES = Number(process.env.DNW_MAX_FRAMES || 0) || (60 * 60 * 6.7 | 0);

const log = QUIET ? function () {} : function () { console.log.apply(console, arguments); };

/* ---------------- DOM / Canvas 桩件 ---------------- */

function makeCtx(id) {
  const g = { addColorStop() {} };
  return {
    _id: id,
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {},
    drawImage() {}, createLinearGradient: () => g, createRadialGradient: () => g,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: ''
  };
}

const listeners = new Map();
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', width: 680, height: 160, hidden: false, _c: new Set(),
    dataset: {},
    /* 浏览器里 textContent 会把 innerHTML 的标签剥掉，桩件也照做，
       否则徽标里那句「点我换倍速」在测试里就凭空消失了 */
    set innerHTML(v) { el._html = String(v); el.textContent = String(v).replace(/<[^>]*>/g, ''); },
    get innerHTML() { return el._html || ''; },
    classList: {
      add: c => el._c.add(c), remove: c => el._c.delete(c),
      contains: c => el._c.has(c), toggle: (c, on) => { on ? el._c.add(c) : el._c.delete(c); }
    },
    getContext: () => el._ctx || (el._ctx = makeCtx(id)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) { if (!listeners.has(el)) listeners.set(el, {}); listeners.get(el)[t] = fn; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {}, offsetWidth: 100
  };
  return el;
}
const els = {};
['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest',
 'next', 'chain', 'soundBtn', 'resetBtn', 'restartBtn',
 'autoBtn', 'autoBadge', 'autoSpeed', 'autoStat'].forEach(id => els[id] = makeEl(id));

/* ---------------- 虚拟时钟 + 可复现随机 ---------------- */

let vnow = 0;
let seed = SEED >>> 0;
const M = Object.create(Math);
M.random = function () {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const rafQueue = [];
const winListeners = {};
const sandbox = {
  console, Math: M, Date, JSON, Object, Array, Number, String, Boolean, Error, isNaN,
  performance: { now: () => vnow },
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame() {},
  setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  document: {
    readyState: 'complete', getElementById: id => els[id] || null,
    addEventListener() {}, createElement: () => makeEl('tmp')
  },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  addEventListener(t, fn) { winListeners[t] = fn; },
  navigator: {},
  Image: class {
    constructor() { this.width = 512; this.height = 512; this.naturalWidth = 512; this.onload = null; this.onerror = null; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'assets', 'fruits', 'parts.js'), 'utf8'), sandbox, { filename: 'parts.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), sandbox, { filename: 'game.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'autoplay.js'), 'utf8'), sandbox, { filename: 'autoplay.js' });

const DNW = sandbox.__DNW__;
const AUTO = sandbox.DNW_AUTO;
const S = DNW.state;

/* 临时覆盖权重（调参用） */
if (process.env.DNW_CFG) Object.assign(AUTO.CFG, JSON.parse(process.env.DNW_CFG));

function pump(frames) {
  for (let f = 0; f < frames; f++) {
    vnow += 1000 / 60;
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn(vnow);
  }
}

/* ---------------- 跑局 ---------------- */

let pass = true;
function check(name, ok, detail) {
  log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
}

/* 量 AI 推演真正花掉的墙钟时间：把 DNW.stepPhysics 包一层
   （game.js 内部走自己的 stepPhysics，不受影响，所以量到的只有 AI 的开销） */
const hr = () => Number(process.hrtime.bigint()) / 1e6;
const rawStep = DNW.stepPhysics;
let simMs = 0, simCalls = 0;
DNW.stepPhysics = function (dt) {
  const a = hr();
  rawStep(dt);
  simMs += hr() - a;
  simCalls++;
};

log('自动模式自检：连打 ' + GAMES + ' 局（真物理 + 真 AI，种子 ' + SEED + '）' +
    (TAG ? '  配置 ' + TAG : '') + '\n');

const results = [];
const t0 = Date.now();
let totalFrames = 0;

AUTO.setEnabled(true);

for (let g = 0; g < GAMES; g++) {
  let frames = 0;
  let maxTier = 0;
  const dropsBefore = AUTO.stats.drops;
  while (!S.over && frames < MAX_FRAMES) {
    pump(1);
    frames++;
    for (const b of S.balls) if (!b.dead && b.tier > maxTier) maxTier = b.tier;
  }
  const drops = AUTO.stats.drops - dropsBefore;
  const capped = frames >= MAX_FRAMES;
  results.push({ score: S.score, maxTier: maxTier, frames: frames, drops: drops, capped: capped });
  log('  第 ' + (g + 1) + ' 局：得分 ' + S.score +
      '  最大 ' + DNW.FRUITS[maxTier].name +
      '  投放 ' + drops + ' 次  用时 ' + (frames / 60).toFixed(1) + 's' +
      (capped ? '  ⚠️ 撞到帧上限，分数只是下限' : ''));
  totalFrames += frames;
  /* 等自动重开下一局 */
  pump(90);
  if (S.over) { DNW.reset(); pump(2); }
}

const wall = Date.now() - t0;
const scores = results.map(r => r.score).sort((a, b) => a - b);
const sum = scores.reduce((a, b) => a + b, 0);
const avg = Math.round(sum / scores.length);
const mid = scores[Math.floor(scores.length / 2)];
const max = scores[scores.length - 1];
const min = scores[0];
const maxTier = Math.max.apply(null, results.map(r => r.maxTier));
const totalDrops = results.reduce((a, r) => a + r.drops, 0);
const callsPerStep = simCalls / Math.max(1, totalDrops);

console.log('RESULT ' + JSON.stringify({
  tag: TAG, games: GAMES, seed: SEED,
  scores: results.map(r => r.score),
  avg: avg, mid: mid, min: min, max: max,
  maxTier: maxTier, drops: totalDrops, callsPerStep: Math.round(callsPerStep),
  capped: results.filter(r => r.capped).length,
  maxFrames: MAX_FRAMES
}));

if (!QUIET) {
  log('\n—— 统计 ——');
  log('  平均分 ' + avg + '   中位 ' + mid + '   最低 ' + min + '   最高 ' + max);
  log('  最大合成到：' + DNW.FRUITS[maxTier].name + '（第 ' + (maxTier + 1) + ' 级）');
  log('  合计投放 ' + totalDrops + ' 次，' + (totalDrops / results.length).toFixed(0) + ' 次/局');
  log('  推演 ' + simCalls + ' 次 stepPhysics，共 ' + simMs.toFixed(0) + 'ms → ' +
      callsPerStep.toFixed(0) + ' 次/步，' +
      (simMs / Math.max(1, totalDrops)).toFixed(1) + 'ms/步（Node 虚拟机比浏览器慢约 3~4 倍）');
  log('  墙钟总耗时 ' + (wall / 1000).toFixed(1) + 's（' + (totalFrames / (wall / 1000)).toFixed(0) + ' 虚拟帧/秒）');

  log('\n—— 判定 ——');
  log('  （分数只作参考：单局方差很大，同权重下 2000~6000 都正常，只有同种子才可比）');
  /* 「有没有卡死」不用单独断言 —— 主循环是 while(!over && frames<MAX_FRAMES)，
     撞上限必然退出，死循环在结构上就不可能。真正要防的是「AI 一步都不投」。
     阈值跟着帧上限走：至少每 60 帧（1 秒游戏时间）投一次，上限 100 次 ——
     这样把 DNW_MAX_FRAMES 调小做快速自检时，不会因为"还没玩够"而误报。 */
  check('投放节奏正常（至少每 60 帧投一次，不是卡住不动）',
    results.every(r => r.drops >= Math.min(100, Math.floor(r.frames / 60))),
    '各局投放 = ' + results.map(r => r.drops).join('/') +
    '（帧 ' + results.map(r => r.frames).join('/') + '）');
  check('每局都合到了椰子以上（第 9 级）', results.every(r => r.maxTier >= 8),
    '各局最大等级 = ' + results.map(r => r.maxTier).join('/'));
  check('每步推演 ≤ 2600 次 stepPhysics（浏览器里约 0.1 秒量级）', callsPerStep <= 2600,
    callsPerStep.toFixed(0) + ' 次/步');
  const cappedN = results.filter(r => r.capped).length;
  if (cappedN) {
    log('  注意：有 ' + cappedN + ' 局撞到帧上限（' + MAX_FRAMES +
        ' 帧），那几局的分数只是下限，不是 AI 的上限');
  }

  /* ---- 界面开关：按钮能开能关、徽标跟着走、倍速写进 state.speed ---- */
  const clickAuto = listeners.get(els.autoBtn).click;
  AUTO.setEnabled(false);
  clickAuto();
  check('点按钮能开自动模式', AUTO.enabled === true && els.autoBadge.hidden === false,
    '徽标 = "' + els.autoBadge.textContent + '"');
  AUTO.setSpeed(4);
  check('倍速写进 state.speed', DNW.state.speed === 4, 'speed = ' + DNW.state.speed);

  /* 点徽标 = 换倍速（窄屏唯一入口） */
  const clickBadge = listeners.get(els.autoBadge).click;
  AUTO.setSpeed(1);
  clickBadge(); const c1 = DNW.state.speed;
  clickBadge(); const c2 = DNW.state.speed;
  clickBadge(); const c3 = DNW.state.speed;
  clickBadge(); const c4 = DNW.state.speed;
  check('点徽标按 1→2→4→8→1 循环', c1 === 2 && c2 === 4 && c3 === 8 && c4 === 1,
    [c1, c2, c3, c4].join(' → '));
  check('徽标文案带着当前倍速和提示',
    els.autoBadge.textContent.indexOf(DNW.state.speed + '×') >= 0 &&
    /点我换倍速/.test(els.autoBadge.textContent),
    '徽标 = "' + els.autoBadge.textContent + '"');

  clickAuto();
  check('再点一次关掉，速度复位', AUTO.enabled === false && DNW.state.speed === 1,
    'speed = ' + DNW.state.speed);

  /* ---- 目标分：到了就自己停下来（?target=5000 的核心行为）----
     上面几项只验了"参数有没有写进去"，没验"到了目标真的会停"。
     这里真跑一小段，够分了就手动把 state.over 置 true 模拟"这局结束"，
     然后确认它**没有**再开下一局（enabled 变成 false）。 */
  DNW.reset();
  pump(2);
  AUTO.CFG.targetScore = 20;
  AUTO.reached = 0;
  AUTO.stats.bestScore = 0;
  AUTO.setEnabled(true);
  let tf = 0;
  while (DNW.state.score < 20 && tf < 4000) { pump(1); tf++; }
  const hitScore = DNW.state.score;
  DNW.state.over = true;              // 模拟这局结束
  pump(40);
  check('到了目标分，结束后自动模式自己停下（不再开下一局）',
    AUTO.enabled === false && AUTO.reached >= 20,
    '分数=' + hitScore + ' reached=' + AUTO.reached +
    ' enabled=' + AUTO.enabled + ' 用了 ' + tf + ' 帧');
  check('停下后倍速复位为 1×', DNW.state.speed === 1, 'speed=' + DNW.state.speed);
  AUTO.CFG.targetScore = 0;           // 还原，别影响别处

  console.log(pass ? '\n自动模式自检通过' : '\n自动模式自检未通过');
}

process.exit(QUIET ? 0 : (pass ? 0 : 1));
