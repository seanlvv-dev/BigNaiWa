/* ============================================================
 *  合成大奶娃 · 自动模式（Auto Play）
 * ------------------------------------------------------------
 *  不猜也不蒙：每走一步，把几十个候选落点在“后台”用同一套物理引擎
 *  真跑一遍（静默模拟 —— 不发声、不喷粒子、不写存档），再按棋盘评分
 *  挑最好的一手。
 *
 *  评分看八件事：
 *    ① 这一步推演出来的合成得分
 *    ② 堆得多高（顶面越低越好）
 *    ③ 整堆的平均高度
 *    ④ 有没有顶到警戒线（二次惩罚，越线越怕）
 *    ⑤ 顶面平整度（坑坑洼洼容易滚歪、也容易埋掉能合的水果）
 *    ⑥ 同级别贴在一起的对数（= 下一步的合成机会）
 *    ⑦ 大果压底（把 tier 当质量算势能，大果越靠下越好）
 *    ⑧ 倒挂（大果压在比它小的果上 —— 堆会散会滚，是崩盘最常见的起点）
 *
 *  这个游戏的分数几乎只由「活多久」决定（实测 分数 ≈ 9.5 × 投放次数），
 *  所以②③⑤⑦⑧ 这些**结构项**才是主战场，① 只是别让它为了保命而完全不合成。
 *
 *  为了不卡主线程，推演是**分帧**做的：每帧只花几毫秒。
 *  每跑完一小批就把棋盘还原回快照，所以画面里始终是干净的真实棋盘，
 *  不会出现“候选结果闪一下”的鬼影。
 *
 *  依赖 game.js 暴露的 window.__DNW__
 *  （state / snapshotState / restoreState / setSim / tryDrop / stepPhysics /
 *    FRUITS / shapeOf / aimLimit / W / H / WALL / DANGER_Y / SUBSTEPS / FIXED）。
 * ============================================================ */
(function () {
  'use strict';

  const DNW = window.__DNW__;
  if (!DNW) {
    if (window.console) console.warn('[autoplay] 没找到 __DNW__，自动模式不可用');
    return;
  }

  const state = DNW.state;
  const FRUITS = DNW.FRUITS;
  const W = DNW.W, H = DNW.H, WALL = DNW.WALL, DANGER_Y = DNW.DANGER_Y;
  const SUBSTEPS = DNW.SUBSTEPS, FIXED = DNW.FIXED;
  const FLOOR = H - WALL;                 // 地板线

  /* ---------------------------------------------------------
   *  参数
   * ------------------------------------------------------- */

  const CFG = {
    /* —— 搜索规模 —— */
    grid: 21,             // 横铺的均匀候选点个数
    nearSame: 6,          // 额外在“同级别水果”旁边取的候选点（每个水果最多出 3 个）
    maxCandidates: 30,    // 粗筛前的候选上限
    simCandidates: 8,     // 精筛（真物理推演）保留几个
    simFrames: 110,       // 推演帧数**上限**（110 帧 ≈ 1.8 秒，够等大果慢慢落定）
    minFrames: 26,        // 至少推演这么多帧，再考虑提前结束
    quietFrames: 6,       // 连续这么多帧棋盘都是安静的 → 这步已经落定，提前收工
    budgetMs: 7,          // 每帧最多花多少毫秒做推演（越小越顺、越大越快想完）
    settleSpeed: 90,      // 低于这个速度才算“棋盘安静了”（px/s）
    settleTimeout: 2.0,   // 等这么久还没安静就强行开算（秒）
    restartDelay: 1.0,    // 结束后隔多久自动开下一局（秒，真实时间）
    minDropGap: 0.28,     // 两次投放之间至少隔多久（秒）—— 注意这是**真实**秒，
                          //   而游戏的投放冷却（0.36s）是**游戏**秒。倍速越高，
                          //   同一个真实秒对应的游戏时间越长，所以这个下限要跟着
                          //   倍速一起缩，否则 8× 会被它掐成 3× 都跑不到。
    restartDelayMin: 0.5, // 自动开下一局的最短真实间隔（倍速再高也别一闪而过）

    /* —— 评分权重 ——
       这一组是实测调出来的（同种子配对对比，4 种子 × 1 局）：
       中位分 3357 → 4078、≥5000 的局数 0/4 → 2/4，而推演次数几乎没涨
       （1545 → 1572 次/步）。关键是**别让即时收益压过结构项** ——
       wGain 调低、高度/起伏/倒挂各提一档，AI 才肯为了保命放弃眼前这一合。 */
    wGain: 8,             // 本次推演拿到的分数
    wHeight: 3.0,         // 顶面高度
    wAvg: 1.5,            // 平均高度
    wOver: 2.0,           // 越线（乘的是距离的平方）
    wFlat: 1.0,           // 顶面起伏
    wPair: 2.4,           // 同级别相邻
    wPairTier: 0.4,       // 同级别相邻的等级加成（高等级合更值钱）
    wEnergy: 1.0,         // 势能（大果压底）
    wInvert: 8.0,         // 倒挂：大果压在比它小的果上（堆会散、会滚，是崩盘主因）
    /* 空洞率（顶面以下还空着的格子占比）。
       动机：诊断早死局时看到底排有空洞、小果架成拱，看着像"空间浪费"。
       但**实测没用** —— 300 / 700 / 1400 三档同种子对比，
       中位 4078 → 4035 / 3738 / 4044，≥5000 的局数 2/4 → 1/4，全是持平或更差。
       所以默认 0（关）。留着是因为它是个干净的开关：
       `node bench2.js --configs 'a|{}' 'b|{"wVoid":300}'` 可以自己复现这个结论。 */
    wVoid: 0,
    wNext: 0.6,           // 给「下一颗」留的合成机会（0 = 关掉这层眼光）

    /* 目标分：>0 时，自动最高分一到就**停下来**（不无限开下一局）。
       单局分数方差很大，想"榜上留个 5000+"最省事的办法就是让它一直打到够为止 ——
       地址后面加 ?target=5000 即可。0 = 不设目标，一直挂机。 */
    targetScore: 0
  };

  /* ---------------------------------------------------------
   *  对外状态
   * ------------------------------------------------------- */

  const Auto = {
    enabled: false,
    record: true,         // true  = 自动成绩进排行榜，但**只在这局刷新本机最高分时才交**
                          //         （排行榜只看最近 20 条，每局都交会把自己挤出窗口）
                          // 'all' = 每局都交（想刷屏才用）
                          // false = 完全不交、也不写本机最高分（?record=0）
    speed: 1,             // 1 / 2 / 4 / 8 倍速
    status: 'idle',       // idle | thinking | dropping | settling
    plan: null,
    lastDropAt: -1e9,
    overAt: 0,
    stats: { games: 0, lastScore: 0, bestScore: 0, drops: 0, thinkMs: 0 },
    reached: 0            // 到了目标分就记在这儿（0 = 还没到）
  };
  window.DNW_AUTO = Auto;

  /* ---------------------------------------------------------
   *  小工具
   * ------------------------------------------------------- */

  const now = () => performance.now();

  /* 倍速越高，真实时间里的等待就该越短 —— 否则「8×」只是让物理跑得快，
     投放节奏还是被真实秒掐着，实际只快了两三倍。 */
  function dropGapMs() {
    return CFG.minDropGap * 1000 / Math.max(1, Auto.speed);
  }
  function restartDelayMs() {
    return Math.max(CFG.restartDelayMin, CFG.restartDelay / Math.max(1, Auto.speed)) * 1000;
  }

  function boardSettled() {
    const balls = state.balls;
    const lim = CFG.settleSpeed * CFG.settleSpeed;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead || !b.landed) return false;
      if (b.vx * b.vx + b.vy * b.vy > lim) return false;
    }
    return true;
  }

  /* 候选落点：均匀铺一层 + 在同级别水果旁边补点（贴着合最划算） */
  function makeCandidates(tier) {
    const shape = DNW.shapeOf(tier);
    const r = FRUITS[tier].r * (shape ? shape.rb : 1);
    const lo = WALL + r + 0.5;
    const hi = W - WALL - r - 0.5;
    const xs = [];

    if (hi - lo < 1) {
      xs.push((lo + hi) / 2);
    } else {
      const n = CFG.grid;
      for (let i = 0; i < n; i++) xs.push(lo + (hi - lo) * (i / (n - 1)));
    }

    /* 同级别水果的旁边各补几个点：落下去就能贴脸合成 */
    let added = 0;
    for (let i = 0; i < state.balls.length && added < CFG.nearSame; i++) {
      const b = state.balls[i];
      if (b.dead || b.tier !== tier) continue;
      xs.push(b.x);
      xs.push(b.x - r * 0.95);
      xs.push(b.x + r * 0.95);
      added++;
    }

    /* 夹回合法区间 + 去重（2px 以内算同一个点） */
    const out = [];
    for (let i = 0; i < xs.length; i++) {
      const x = Math.min(hi, Math.max(lo, xs[i]));
      let dup = false;
      for (let k = 0; k < out.length; k++) {
        if (Math.abs(out[k] - x) < 2) { dup = true; break; }
      }
      if (!dup) out.push(x);
    }

    /* 抽稀到上限 */
    if (out.length > CFG.maxCandidates) {
      const keep = [];
      const last = out.length - 1;
      for (let i = 0; i < CFG.maxCandidates; i++) {
        keep.push(out[Math.round(i * last / (CFG.maxCandidates - 1))]);
      }
      return keep;
    }
    return out;
  }

  /* ---------------------------------------------------------
   *  粗筛：解析预判
   *  不算物理，只做一件事 —— 假设水果竖直落下，看它会停在哪。
   *  便宜到可以给几十个落点各算一遍，用来挑出值得“真推演”的少数几个。
   * ------------------------------------------------------- */

  function predictLanding(x, tier) {
    const r = FRUITS[tier].r;
    let y = FLOOR - r;          // 先假设一路落到地板
    let hit = null;
    const balls = state.balls;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead) continue;
      const rr = r + b.r;
      const dx = x - b.x;
      if (dx * dx >= rr * rr) continue;          // 水平上够不着
      const yy = b.y - Math.sqrt(rr * rr - dx * dx);   // 竖直方向接触时的圆心高度
      if (yy < y) { y = yy; hit = b; }
    }
    return { x: x, y: y, hit: hit };
  }

  /* 粗筛打分：只看“能不能贴到同级别”“落点高不高”“会不会越线” */
  function quickScore(x, tier) {
    const p = predictLanding(x, tier);
    const r = FRUITS[tier].r;
    let s = 0;

    if (p.hit) {
      s += 6;                                   // 落在堆上比落在空地好（不浪费空间）
      if (p.hit.tier === tier) {
        s += 100 + tier * 12;                   // 贴到同级别 = 直接合成，最香
        /* 那个同级水果旁边要是还有一只同级别的 → 能连环合 */
        const balls = state.balls;
        for (let i = 0; i < balls.length; i++) {
          const b = balls[i];
          if (b === p.hit || b.dead || b.tier !== tier) continue;
          const dx = b.x - p.hit.x, dy = b.y - p.hit.y;
          const lim = b.r + p.hit.r + 12;
          if (dx * dx + dy * dy < lim * lim) { s += 60; break; }
        }
      }
    }

    s -= (FLOOR - p.y) * 0.45;                  // 落点越高越差
    if (p.y - r < DANGER_Y + 10) s -= 2000;     // 会顶到警戒线 → 基本一票否决
    s -= Math.abs(x - W / 2) * 0.02;            // 只用来打破同分：空盘时别老贴着左墙堆

    return s;
  }

  /* 从几十个落点里挑出值得真推演的几个 */
  function shortlist(tier) {
    const all = makeCandidates(tier);
    const scored = [];
    for (let i = 0; i < all.length; i++) scored.push({ x: all[i], s: quickScore(all[i], tier) });
    scored.sort(function (a, b) { return b.s - a.s; });

    const keep = [];
    for (let i = 0; i < scored.length && keep.length < CFG.simCandidates; i++) {
      keep.push(scored[i].x);
    }
    keep.sort(function (a, b) { return a - b; });
    return keep;
  }

  /* ---------------------------------------------------------
   *  棋盘评分
   * ------------------------------------------------------- */

  /* 顶面起伏：把宽度切成若干列，每列记“最高被占到哪”，相邻列落差之和就是起伏度 */
  function surfaceRoughness(balls) {
    const COLS = 16;
    const cw = (W - 2 * WALL) / COLS;
    const surf = new Float64Array(COLS);
    for (let c = 0; c < COLS; c++) surf[c] = FLOOR;

    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      let l = Math.floor((b.x - b.r - WALL) / cw);
      let rr = Math.floor((b.x + b.r - WALL) / cw);
      if (l < 0) l = 0;
      if (rr > COLS - 1) rr = COLS - 1;
      const top = b.y - b.r * 0.8;
      for (let c = l; c <= rr; c++) if (top < surf[c]) surf[c] = top;
    }

    let rug = 0;
    for (let c = 1; c < COLS; c++) rug += Math.abs(surf[c] - surf[c - 1]);
    return rug;
  }

  /* 第二层眼光：这一步落完之后，留给「下一颗」的机会值多少分。
     只用解析预判（不跑物理），所以几乎不花时间，但能避免“这一步合得爽、
     下一步没地方放”的死局。下一颗是什么在 tryDrop 之后就是 state.pending。 */
  function nextOpportunity(tier) {
    let best = 0;
    const N = 12;
    const step = (W - 2 * WALL) / N;
    for (let i = 0; i <= N; i++) {
      const x = WALL + step * i;
      const p = predictLanding(x, tier);
      let s = 0;
      if (p.hit && p.hit.tier === tier) s = 100 + tier * 12;
      s -= (FLOOR - p.y) * 0.45;
      if (s > best) best = s;
    }
    return best;
  }

  /* 倒挂：一只果压在比它小的果上面。
     好棋手会把堆码成“大的在下面、小的在上面”的次序；一旦反了，上面的果会滚、
     会把下面的小果埋死、整堆很快散架 —— 这是崩盘最常见的起点。
     只看“正下方那一个”（x 有重叠、y 比它大且最近的那个），够用而且便宜。 */
  function inversionPenalty(balls) {
    let pen = 0;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.dead) continue;
      let support = null;
      for (let j = 0; j < balls.length; j++) {
        if (j === i) continue;
        const b = balls[j];
        if (b.dead || b.y <= a.y) continue;              // 必须在下面
        if (Math.abs(b.x - a.x) >= a.r + b.r) continue;  // 水平上够不着
        if (!support || b.y < support.y) support = b;    // 取最近的那一个
      }
      if (support && support.tier < a.tier) pen += a.tier - support.tier;
    }
    return pen;
  }

  /* 空洞率：把棋盘下方区域切成格子，看"顶面以下"有多少格子是空的。
     诊断早死局时发现两个特征 —— 底排有**空洞**（水果架成拱、下面空着），
     以及**一侧堆出高塔**。两者其实是同一件事：堆得不密实，空间被浪费。
     这个量是**尺度无关**的：盘面本来就稀疏的早期，每列的顶面都贴近地板，
     被统计的格子很少，所以不会冤枉开局；只有"堆起来之后里面还空着"才扣分。 */
  const VCOLS = 12, VROWS = 20;
  function voidRatio(balls) {
    const cw = (W - 2 * WALL) / VCOLS;
    const ch = (FLOOR - DANGER_Y) / VROWS;
    const grid = new Uint8Array(VCOLS * VROWS);
    const surf = new Float64Array(VCOLS);
    for (let c = 0; c < VCOLS; c++) surf[c] = FLOOR;

    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      let l = Math.floor((b.x - b.r - WALL) / cw);
      let rr = Math.floor((b.x + b.r - WALL) / cw);
      if (l < 0) l = 0;
      if (rr > VCOLS - 1) rr = VCOLS - 1;
      const top = b.y - b.r;
      for (let c = l; c <= rr; c++) if (top < surf[c]) surf[c] = top;
      let y0 = Math.floor((b.y - b.r - DANGER_Y) / ch);
      let y1 = Math.floor((b.y + b.r - DANGER_Y) / ch);
      if (y0 < 0) y0 = 0;
      if (y1 > VROWS - 1) y1 = VROWS - 1;
      for (let y = y0; y <= y1; y++) {
        for (let c = l; c <= rr; c++) grid[y * VCOLS + c] = 1;
      }
    }

    let empty = 0, total = 0;
    for (let c = 0; c < VCOLS; c++) {
      let top = Math.floor((surf[c] - DANGER_Y) / ch);
      if (top < 0) top = 0;
      for (let y = top; y < VROWS; y++) {
        total++;
        if (!grid[y * VCOLS + c]) empty++;
      }
    }
    return total ? empty / total : 0;
  }

  function evaluateBoard(balls, gain) {
    let v = gain * CFG.wGain;
    const n = balls.length;
    if (!n) return v;

    let minTop = Infinity, sumTop = 0, energy = 0;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      const top = b.y - b.r;
      if (top < minTop) minTop = top;
      sumTop += top;
      energy += (b.tier + 1) * (FLOOR - b.y);
    }

    /* 堆高：顶面离地板多远 */
    v -= (FLOOR - minTop) * CFG.wHeight;
    /* 平均高度：整堆压低 */
    v -= (FLOOR - sumTop / n) * CFG.wAvg;

    /* 顶到警戒线：越线越怕（二次） */
    const over = DANGER_Y - minTop;
    if (over > 0) v -= over * over * CFG.wOver;

    /* 顶面起伏 */
    v -= surfaceRoughness(balls) * CFG.wFlat;

    /* 势能：大果压底 */
    v -= energy * CFG.wEnergy / 1000;

    /* 倒挂：大果压在小果上 —— 崩盘的主要起点 */
    v -= inversionPenalty(balls) * CFG.wInvert;

    /* 空洞：堆起来之后里面还空着 —— 空间被浪费，早晚要顶到线 */
    if (CFG.wVoid > 0) v -= voidRatio(balls) * CFG.wVoid;

    /* 给下一颗留的机会 */
    if (CFG.wNext > 0) v += CFG.wNext * nextOpportunity(state.pending);

    /* 同级别相邻 = 下一步的合成机会 */
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (a.tier !== b.tier) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const lim = a.r + b.r + 12;
        if (dx * dx + dy * dy < lim * lim) {
          v += CFG.wPair + a.tier * CFG.wPairTier;
        }
      }
    }

    return v;
  }

  /* ---------------------------------------------------------
   *  候选推演
   * ------------------------------------------------------- */

  /* 推演里判断“这步是不是已经落定了”：全都落地且都慢了，就没什么可再等的 */
  function quietNow() {
    const balls = state.balls;
    const lim = CFG.settleSpeed * CFG.settleSpeed;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead || !b.landed) return false;
      if (b.vx * b.vx + b.vy * b.vy > lim) return false;
    }
    return true;
  }

  /* 前提：当前 state 已经等于 snap（调用方保证） */
  function tryCandidate(x) {
    state.aimX = x;
    const before = state.score;
    const n0 = state.balls.length;
    DNW.tryDrop();
    if (state.balls.length === n0) return null;   // 没投出去（理论上不会发生）

    /* 推到“落定”为止：安静满 quietFrames 帧就提前收工。
       省下来的时间拿去把 simFrames 的上限调大 —— 该慢慢等的大果照样等得到，
       而绝大多数普通一手在 30 来帧就收工了。 */
    const sub = FIXED / SUBSTEPS;
    let quiet = 0;
    for (let f = 0; f < CFG.simFrames; f++) {
      for (let s = 0; s < SUBSTEPS; s++) DNW.stepPhysics(sub);
      if (f + 1 >= CFG.minFrames && quietNow()) {
        if (++quiet >= CFG.quietFrames) break;
      } else {
        quiet = 0;
      }
    }

    const gain = state.score - before;
    return { x: x, gain: gain, value: evaluateBoard(state.balls, gain) };
  }

  /* ---------------------------------------------------------
   *  主循环
   * ------------------------------------------------------- */

  let rafId = 0;
  let running = false;

  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  /* 控制台排查用：__DNW_AUTO__.debug() */
  Auto.debug = function () {
    return { running: running, rafId: rafId, enabled: Auto.enabled,
             status: Auto.status, hasPlan: !!Auto.plan, overAt: Auto.overAt };
  };

  function tick() {
    if (!Auto.enabled) { running = false; rafId = 0; return; }
    rafId = requestAnimationFrame(tick);
    /* 注意：这里不能加 if (!state.over) 的守卫 —— 结束后的“自动开下一局”
       逻辑就在 step() 里面，挡住了 step() 就永远重启不了。 */
    step();
  }

  function step() {
    const t = now();

    /* 结束了 → 等一下自动开下一局 */
    if (state.over) {
      if (!Auto.overAt) {
        Auto.overAt = t;
        Auto.plan = null;
        Auto.stats.games++;
        Auto.stats.lastScore = state.score;
        if (state.score > Auto.stats.bestScore) Auto.stats.bestScore = state.score;
        paint();
        /* 到了目标分就收工 —— 挂着不管也能停在目标上，不用人盯着 */
        if (CFG.targetScore > 0 && Auto.stats.bestScore >= CFG.targetScore) {
          Auto.reached = Auto.stats.bestScore;
          setEnabled(false);
          return;
        }
      }
      if (t - Auto.overAt > restartDelayMs()) {
        Auto.overAt = 0;
        DNW.reset();
        Auto.lastDropAt = -1e9;
        Auto.status = 'idle';
        paint();
      }
      return;
    }
    Auto.overAt = 0;

    /* 还在冷却 / 上一颗还没落地 → 等 */
    if (!state.ready) { Auto.plan = null; setStatus('settling'); return; }
    if (t - Auto.lastDropAt < dropGapMs()) return;

    const quiet = boardSettled();
    const waited = (t - Auto.lastDropAt) / 1000;
    if (!quiet && waited < CFG.settleTimeout) { Auto.plan = null; setStatus('settling'); return; }

    /* —— 开算 / 继续算 —— */
    if (!Auto.plan || Auto.plan.pending !== state.pending || Auto.plan.count !== state.balls.length) {
      Auto.plan = {
        pending: state.pending,
        count: state.balls.length,
        snap: DNW.snapshotState(),
        xs: shortlist(state.pending),
        i: 0,
        best: null,
        t0: t
      };
    }

    const plan = Auto.plan;
    const t0 = now();
    let done = 0;

    DNW.setSim(true);
    while (plan.i < plan.xs.length && now() - t0 < CFG.budgetMs) {
      DNW.restoreState(plan.snap);          // 每个候选都从同一张干净棋盘出发
      const res = tryCandidate(plan.xs[plan.i++]);
      if (res && (!plan.best || res.value > plan.best.value)) plan.best = res;
      done++;
    }
    DNW.restoreState(plan.snap);            // 棋盘还原干净，画面里不会出现推演的鬼影
    DNW.setSim(false);

    if (done) Auto.stats.thinkMs += now() - t0;

    if (plan.i < plan.xs.length) { setStatus('thinking'); return; }

    /* —— 想完了：落子 —— */
    const best = plan.best;
    Auto.plan = null;
    if (!best) { setStatus('idle'); return; }

    state.aimX = best.x;
    DNW.tryDrop();
    Auto.lastDropAt = now();
    Auto.stats.drops++;
    setStatus('dropping');
  }

  /* ---------------------------------------------------------
   *  开关
   * ------------------------------------------------------- */

  function setSpeed(v) {
    Auto.speed = v;
    state.speed = Auto.enabled ? v : 1;
    paint();
  }

  function setEnabled(on) {
    Auto.enabled = !!on;
    Auto.plan = null;
    Auto.overAt = 0;
    Auto.status = 'idle';
    if (on) Auto.reached = 0;      // 重新开自动 = 目标重新算
    state.speed = Auto.enabled ? Auto.speed : 1;
    Auto.lastDropAt = Auto.enabled ? now() : -1e9;
    if (Auto.enabled) start(); else stop();
    paint();
  }

  function toggle() { setEnabled(!Auto.enabled); }

  /* ---------------------------------------------------------
   *  界面
   * ------------------------------------------------------- */

  const elBtn = document.getElementById('autoBtn');
  const elBadge = document.getElementById('autoBadge');
  const elSpeed = document.getElementById('autoSpeed');
  const elStat = document.getElementById('autoStat');

  /* 倍速档位（窄屏靠点徽标循环切换） */
  const SPEEDS = [1, 2, 4, 8];

  const STATUS_TEXT = {
    idle: '待命',
    settling: '等棋盘稳',
    thinking: '推演中',
    dropping: '投放'
  };

  function setStatus(s) {
    if (Auto.status === s) return;
    Auto.status = s;
    paint();
  }

  function paint() {
    if (elBtn) {
      elBtn.classList.toggle('active', Auto.enabled);
      elBtn.setAttribute('aria-pressed', String(Auto.enabled));
      const ico = elBtn.querySelector('.ico');
      const lbl = elBtn.querySelector('.lbl');
      if (ico) ico.textContent = Auto.enabled ? '⏸' : '🤖';
      if (lbl) lbl.textContent = Auto.enabled ? '停止' : '自动';
    }
    if (elSpeed) elSpeed.hidden = !Auto.enabled;
    if (elBadge) {
      elBadge.hidden = !Auto.enabled;
      if (Auto.enabled) {
        /* 徽标同时是窄屏的倍速开关，所以带一句提示（桌面端由 CSS 藏起来） */
        elBadge.innerHTML = '🤖 自动 ' + Auto.speed + '× · ' +
          (STATUS_TEXT[Auto.status] || '') +
          '<span class="auto-badge-hint"> · 点我换倍速</span>';
      }
    }
    if (elStat) {
      let txt = Auto.stats.games
        ? ('自动已玩 ' + Auto.stats.games + ' 局 · 上局 ' + Auto.stats.lastScore +
           ' · 自动最高 ' + Auto.stats.bestScore)
        : '';
      if (CFG.targetScore > 0) {
        txt += (txt ? ' · ' : '') + '目标 ' + CFG.targetScore +
          (Auto.reached ? ' ✓ 已达标' : '');
      }
      elStat.textContent = txt;
    }
    if (elSpeed) {
      const btns = elSpeed.querySelectorAll('button');
      for (let i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', Number(btns[i].dataset.speed) === Auto.speed);
      }
    }
  }

  if (elBtn) elBtn.addEventListener('click', toggle);

  if (elSpeed) {
    elSpeed.addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !b.dataset.speed) return;
      setSpeed(Number(b.dataset.speed));
    });
  }

  /* 点徽标 = 往下滚一档 1× → 2× → 4× → 1×
     （窄屏没有倍速按钮，这是唯一的入口；桌面端点它也无害） */
  if (elBadge) {
    elBadge.addEventListener('click', function () {
      const i = SPEEDS.indexOf(Auto.speed);
      setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
    });
  }

  /* 手动碰棋盘就退出自动模式（不然人和 AI 会抢着投） */
  const stageEl = document.getElementById('stage');
  if (stageEl) {
    stageEl.addEventListener('pointerdown', function (e) {
      if (!Auto.enabled) return;
      /* 徽标虽然画在棋盘里，但它是个控件（点它换倍速），不算「碰棋盘」 */
      const t = e.target;
      if (t && t.closest && t.closest('#autoBadge')) return;
      setEnabled(false);
    }, true);
  }

  /* T 键：开 / 关自动模式 */
  window.addEventListener('keydown', function (e) {
    const t = e.target;
    if (t) {
      const tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t.isContentEditable === true) return;
    }
    if (e.code === 'KeyT') { toggle(); e.preventDefault(); }
  });

  paint();

  /* ---------------------------------------------------------
   *  打开就全自动：地址后面加参数
   *    ?auto=1              一进页面就开自动（不用点按钮）
   *    ?speed=8             顺带定好倍速（只认 1 / 2 / 4 / 8）
   *    ?record=0            别交排行榜、也别写本机最高分（默认是交的）
   *    ?record=all          每局都交（默认只在刷新本机最高分时交，免得刷屏）
   *    ?target=5000         打到自动最高分 ≥5000 就停下来（不设就无限挂机）
   *  放在 UI 接好线之后执行 —— setEnabled() 会调 paint()，
   *  paint() 要用上面那几个 el* 常量，早于它们跑会踩 TDZ。
   * ------------------------------------------------------- */
  (function autoFromQuery() {
    let q;
    try {
      q = new URLSearchParams(window.location.search);
    } catch (e) {
      return;                       // 老环境没有 URLSearchParams 就算了
    }
    if (q.has('record')) {
      const v = q.get('record');
      Auto.record = v === '0' ? false : (v === 'all' ? 'all' : true);
    }
    const tg = Number(q.get('target'));
    if (isFinite(tg) && tg > 0) CFG.targetScore = Math.round(tg);
    const sp = Number(q.get('speed'));
    if (SPEEDS.indexOf(sp) >= 0) Auto.speed = sp;
    if (q.has('auto') && q.get('auto') !== '0') setEnabled(true);
  })();

  /* 控制台句柄：__DNW_AUTO__.toggle() / .setEnabled(true) / .setSpeed(4)
     想现场调参就直接改 __DNW_AUTO__.CFG 里的权重，下一步立刻生效 */
  Auto.toggle = toggle;
  Auto.setEnabled = setEnabled;
  Auto.setSpeed = setSpeed;
  Auto.step = step;
  Auto.paint = paint;
  Auto.CFG = CFG;
})();
