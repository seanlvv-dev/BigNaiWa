/* ============================================================
 *  参数对比台（临时件，调参用）—— 取代 sweep2.sh
 *
 *  为什么不用 bash 并行：Windows 上多个进程 >> 追加同一个文件会重复/串行错乱，
 *  实测出现过同一行写两遍。这里改成每个子进程各跑各的，父进程直接收 stdout，
 *  不落中间文件，天然没有竞态。
 *
 *  用法：
 *    node bench2.js --seeds 1,2,3,4,5 --maxf 48000 --jobs 6 \
 *                   --configs 'base|{}' 'more|{"simCandidates":16}'
 *  也可以把配置写成 JSON 文件：--file cfgs.json
 *    [{ "tag": "base", "cfg": {} }, ...]
 *
 *  输出：每个配置一行汇总（平均/中位/最低/最高/≥5000/撞上限/推演步数）
 * ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = __dirname;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(s => Number(s.trim())).filter(n => n > 0);
const MAXF = Number(arg('maxf', 48000));
const JOBS = Number(arg('jobs', 6));
const GAMES = Number(arg('games', 1));
const OUTDIR = arg('out', './_bench2');

/* —— 解析配置 —— */
let configs = [];
const file = arg('file', '');
if (file) {
  configs = JSON.parse(fs.readFileSync(file, 'utf8'));
} else {
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== '--configs') continue;
    for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) {
      const raw = process.argv[j];
      const k = raw.indexOf('|');
      configs.push({ tag: k < 0 ? raw : raw.slice(0, k), cfg: k < 0 ? {} : JSON.parse(raw.slice(k + 1)) });
    }
  }
}
if (!configs.length) configs = [{ tag: 'base', cfg: {} }];

/* —— 任务队列：每个 (配置, 种子) 一个子进程 —— */
const tasks = [];
for (const c of configs) for (const s of SEEDS) tasks.push({ tag: c.tag, cfg: c.cfg, seed: s });

const results = {};   // tag -> [row]
let done = 0, running = 0, cursor = 0;

function runOne(t) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, {
      DNW_QUIET: '1',
      DNW_TAG: t.tag,
      DNW_CFG: JSON.stringify(t.cfg),
      DNW_MAX_FRAMES: String(MAXF)
    });
    const p = spawn(NODE, ['autoplay.test.js', String(GAMES), String(t.seed)], { cwd: ROOT, env });
    let buf = '';
    p.stdout.on('data', d => { buf += d.toString(); });
    p.stderr.on('data', () => {});
    p.on('close', code => {
      const line = buf.split('\n').find(l => l.startsWith('RESULT '));
      if (line) {
        try {
          const row = JSON.parse(line.slice(7));
          (results[t.tag] = results[t.tag] || []).push(row);
        } catch (e) {
          (results[t.tag + '_ERR'] = results[t.tag + '_ERR'] || []).push({ err: String(e), raw: line.slice(0, 200) });
        }
      } else {
        (results[t.tag + '_ERR'] = results[t.tag + '_ERR'] || []).push({ err: 'no RESULT, exit ' + code });
      }
      done++;
      process.stdout.write('\r  完成 ' + done + '/' + tasks.length + '  ');
      resolve();
    });
  });
}

(async function main() {
  const t0 = Date.now();
  const queue = tasks.slice();
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      await runOne(t);
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, tasks.length) }, worker));
  process.stdout.write('\n\n');

  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, 'raw.json'), JSON.stringify(results, null, 2));

  const NAMES = ['葡萄', '樱桃', '橘子', '柠檬', '猕猴桃', '番茄', '桃子', '菠萝', '椰子', '半西瓜', '大西瓜'];
  console.log('=== 配置对比（' + SEEDS.length + ' 个种子 × ' + GAMES + ' 局，上限 ' + MAXF + ' 帧）===');
  for (const c of configs) {
    const rows = results[c.tag] || [];
    if (!rows.length) { console.log(c.tag.padEnd(10) + ' 没有结果'); continue; }
    const scores = [].concat(...rows.map(r => r.scores)).sort((a, b) => a - b);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const med = scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2);
    const dist = {};
    for (const r of rows) dist[NAMES[r.maxTier]] = (dist[NAMES[r.maxTier]] || 0) + 1;
    console.log(
      c.tag.padEnd(10) +
      ' n=' + String(scores.length).padStart(2) +
      ' | 平均 ' + String(avg).padStart(5) +
      ' | 中位 ' + String(med).padStart(5) +
      ' | 最低 ' + String(scores[0]).padStart(5) +
      ' | 最高 ' + String(scores[scores.length - 1]).padStart(5) +
      ' | ≥5000 ' + scores.filter(s => s >= 5000).length + '/' + scores.length +
      ' | 撞上限 ' + rows.reduce((a, r) => a + (r.capped || 0), 0) +
      ' | 推演/步 ' + Math.round(rows.reduce((a, r) => a + r.callsPerStep, 0) / rows.length) +
      ' | ' + JSON.stringify(dist));
    console.log('           分数 ' + scores.join(', '));
  }
  const errs = Object.keys(results).filter(k => k.endsWith('_ERR'));
  if (errs.length) console.log('\n有 ' + errs.length + ' 个配置出现异常：' + JSON.stringify(results[errs[0]]).slice(0, 300));
  console.log('\n总耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's，原始数据 ' + path.join(OUTDIR, 'raw.json'));
})();
