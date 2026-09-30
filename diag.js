/* ============================================================
 *  诊断：一局到底是怎么输的 / 怎么赢的（临时件，调参用）
 *
 *  用法：  node diag.js <seed> [maxFrames] [everyDrops]
 *  输出：  每 N 次投放打一行 —— 分数 / 球数 / 堆高 / 离警戒线还差多少
 *          结束时把棋盘画成 ASCII 柱状图，并给出「高度趋势」
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = __dirname;

const SEED = Number(process.argv[2] || 5);
const MAX_FRAMES = Number(process.argv[3] || 48000);
const EVERY = Number(process.argv[4] || 40);

function makeCtx() {
  const g = { addColorStop() {} };
  return {
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {},
    drawImage() {}, createLinearGradient: () => g, createRadialGradient: () => g,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: ''
  };
}
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', width: 680, height: 160, hidden: false, _c: new Set(),
    dataset: {},
    set innerHTML(v) { el._html = String(v); el.textContent = String(v).replace(/<[^>]*>/g, ''); },
    get innerHTML() { return el._html || ''; },
    classList: { add: c => el._c.add(c), remove: c => el._c.delete(c), contains: c => el._c.has(c), toggle: (c, on) => { on ? el._c.add(c) : el._c.delete(c); } },
    getContext: () => el._ctx || (el._ctx = makeCtx()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) { listeners[t] = fn; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    setAttribute() {}, offsetWidth: 100
  };
  return el;
}
const listeners = {};
const els = {};
['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest',
 'next', 'chain', 'soundBtn', 'resetBtn', 'restartBtn',
 'autoBtn', 'autoBadge', 'autoSpeed', 'autoStat'].forEach(id => els[id] = makeEl(id));

let vnow = 0;
let seed = SEED >>> 0;
const M = Object.create(Math);
M.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const rafQueue = [];
const sandbox = {
  console, Math: M, Date, JSON, Object, Array, Number, String, Boolean, Error, isNaN,
  performance: { now: () => vnow },
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame() {},
  setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  document: { readyState: 'complete', getElementById: id => els[id] || null, addEventListener() {}, createElement: () => makeEl('tmp') },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  addEventListener() {}, navigator: {},
  Image: class { constructor() { this.width = 512; this.height = 512; this.naturalWidth = 512; this.onload = null; } set src(v) { this._src = v; if (this.onload) this.onload(); } get src() { return this._src; } }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'assets', 'fruits', 'parts.js'), 'utf8'), sandbox, { filename: 'parts.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), sandbox, { filename: 'game.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'autoplay.js'), 'utf8'), sandbox, { filename: 'autoplay.js' });

const DNW = sandbox.__DNW__, AUTO = sandbox.DNW_AUTO, S = DNW.state;
if (process.env.DNW_CFG) Object.assign(AUTO.CFG, JSON.parse(process.env.DNW_CFG));

const W = DNW.W, WALL = DNW.WALL, H = DNW.H, DANGER_Y = DNW.DANGER_Y;
const FLOOR = H - WALL;
const NAMES = DNW.FRUITS.map(f => f.name);

function metrics() {
  let minTop = Infinity, sumTop = 0, n = 0;
  const hist = {};
  for (const b of S.balls) {
    if (b.dead) continue;
    const top = b.y - b.r;
    if (top < minTop) minTop = top;
    sumTop += top; n++;
    hist[b.tier] = (hist[b.tier] || 0) + 1;
  }
  if (!n) return { n: 0, height: 0, avg: 0, margin: DANGER_Y, hist };
  return { n, height: Math.round(FLOOR - minTop), avg: Math.round(FLOOR - sumTop / n), margin: Math.round(minTop - DANGER_Y), hist };
}

function drawBoard() {
  const COLS = 60, ROWS = 26;
  const cw = (W - 2 * WALL) / COLS, ch = (FLOOR - 20) / ROWS;
  const grid = [];
  for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(' '));
  for (const b of S.balls) {
    if (b.dead) continue;
    const c0 = Math.max(0, Math.floor((b.x - b.r - WALL) / cw));
    const c1 = Math.min(COLS - 1, Math.ceil((b.x + b.r - WALL) / cw) - 1);
    const r0 = Math.max(0, Math.floor((b.y - b.r - 20) / ch));
    const r1 = Math.min(ROWS - 1, Math.ceil((b.y + b.r - 20) / ch) - 1);
    const ch2 = String(b.tier);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c] = ch2;
  }
  const dangerRow = Math.max(0, Math.floor((DANGER_Y - 20) / ch));
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    out.push((r === dangerRow ? '-!-' : '   ') + '|' + grid[r].join('') + '|' + (r === dangerRow ? '  <- 警戒线' : ''));
  }
  out.push('   +' + '-'.repeat(COLS) + '+');
  return out.join('\n');
}

AUTO.setEnabled(true);
let frames = 0, lastDrop = 0, prevH = 0;
const trace = [];
console.log('种子 ' + SEED + '  上限 ' + MAX_FRAMES + ' 帧\n');
console.log('投放   分数   球数   堆高   平均   离警戒  高等级分布');
while (!S.over && frames < MAX_FRAMES) {
  for (let f = 0; f < 60; f++) { vnow += 1000 / 60; const q = rafQueue.splice(0, rafQueue.length); for (const fn of q) fn(vnow); }
  frames += 60;
  if (AUTO.stats.drops - lastDrop >= EVERY) {
    lastDrop = AUTO.stats.drops;
    const m = metrics();
    const hi = Object.keys(m.hist).filter(t => t >= 6).sort((a, b) => a - b)
      .map(t => NAMES[t] + '×' + m.hist[t]).join(' ');
    trace.push(m.height);
    console.log(String(AUTO.stats.drops).padStart(4) + '  ' + String(S.score).padStart(6) +
      '  ' + String(m.n).padStart(5) + '  ' + String(m.height).padStart(5) +
      '  ' + String(m.avg).padStart(5) + '  ' + String(m.margin).padStart(6) + '  ' + hi);
  }
}
const m = metrics();
console.log('\n结束：' + (S.over ? '游戏结束' : '撞到帧上限（分数只是下限）') +
  '  分数 ' + S.score + '  投放 ' + AUTO.stats.drops + '  虚拟时长 ' + (frames / 60).toFixed(0) + 's');
console.log('最终堆高 ' + m.height + ' / 可用 ' + Math.round(FLOOR - DANGER_Y) + '  平均 ' + m.avg + '  球数 ' + m.n);
console.log('\n最终棋盘：\n' + drawBoard());
