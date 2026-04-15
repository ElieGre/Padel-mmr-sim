import { useState, useEffect, useRef, useMemo } from "react";

// ─── MMR Engine (V4 Core Logic) ───────────────────────────────────────
const NUM_PLAYERS = 40;
const GAMES_PER_PLAYER_TARGET = 300;
const CALIBRATION_GAMES = 20;
const MMR_START = 300;
const BASE_K = 40;
const K_CALIBRATION = 96;
const K_VETERAN = 48;
const K_VETERAN_THRESHOLD = 100;
const UPSET_BONUS_SCALE = 0.6;
const MAX_GAIN_MULTIPLIER = 2.0;
const MIN_GAIN_MULTIPLIER = 0.4;
const MARGIN_MULTIPLIERS = { stomp: 1.45, clear: 1.15, normal: 1.0, close: 0.75 };
const TEAMMATE_DIFF_FACTOR = 0.15;
const MIN_MMR_CHANGE = 5;
const TRUE_SKILL_MIN = 10.0;
const TRUE_SKILL_MAX = 40.0;
const PERF_WINDOW = 20;
const PERF_THRESHOLDS = [
  [0.70, 1.8],
  [0.65, 1.5],
  [0.60, 1.25],
  [0.55, 1.1],
];

const RANK_TIERS = [
  [0, "Bronze III", "#8B6914", "I"],
  [600, "Bronze II", "#A07828", "II"],
  [750, "Bronze I", "#CD9B1D", "III"],
  [900, "Silver III", "#8A939B", "IV"],
  [1000, "Silver II", "#A8B4BE", "V"],
  [1100, "Silver I", "#C0CDD8", "VI"],
  [1250, "Gold III", "#B8860B", "VII"],
  [1400, "Gold II", "#DAA520", "VIII"],
  [1550, "Gold I", "#FFD700", "IX"],
  [1700, "Plat III", "#4A8B8B", "X"],
  [1850, "Plat II", "#5CACAC", "XI"],
  [2000, "Plat I", "#7FFFFF", "XII"],
  [2200, "Dia III", "#4169E1", "XIII"],
  [2400, "Dia II", "#6495ED", "XIV"],
  [2600, "Dia I", "#87CEEB", "XV"],
  [2800, "Champion", "#DA70D6", "XVI"],
  [3000, "Grand Champ", "#FF4500", "XVII"],
  [3500, "Legend", "#FF0000", "XVIII"],
];

const NAMES = [
  "Carlos", "Maria", "Ahmed", "Fatima", "Luca", "Sofia", "Omar", "Nadia",
  "Pablo", "Elena", "Karim", "Leila", "Marco", "Ana", "Hassan", "Marta",
  "Diego", "Clara", "Sami", "Yasmin", "Jorge", "Lucia", "Rami", "Sara",
  "Mateo", "Julia", "Fadi", "Rita", "Elie", "Maya", "Leo", "Ines",
  "Alex", "Dina", "Hugo", "Layla", "Rayan", "Nour", "Tomas", "Zara"
];

function getRank(mmr) {
  let rank = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (mmr >= tier[0]) rank = tier;
  }
  return rank;
}

function expectedScore(ra, rb) {
  return 1.0 / (1.0 + Math.pow(10.0, (rb - ra) / 400.0));
}

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function gaussianRandom(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function createPlayer(id, name, trueSkill) {
  return {
    id,
    name,
    trueSkill,
    mmr: MMR_START,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    peakMmr: MMR_START,
    recentOpponents: [],
    recentResults: [],
    history: [],
    get isProvisional() {
      return this.gamesPlayed < CALIBRATION_GAMES;
    },
    get performanceMultiplier() {
      if (this.recentResults.length < 8) return 1.0;
      const recent = this.recentResults.slice(-PERF_WINDOW);
      const wr = recent.reduce((s, r) => s + r, 0) / recent.length;
      
      // Upward accelerators
      for (const [threshold, mult] of PERF_THRESHOLDS) {
        if (wr >= threshold) return mult;
      }
      
      // Downward accelerators (symmetric for losers)
      if (wr <= 0.30) return 1.8;  // chronic loser, gains are tiny anyway
      if (wr <= 0.35) return 1.5;
      if (wr <= 0.40) return 1.25;
      
      return 1.0;
    },
    get performanceLossShield() {
      if (this.recentResults.length < 8) return 1.0;
      const recent = this.recentResults.slice(-PERF_WINDOW);
      const wr = recent.reduce((s, r) => s + r, 0) / recent.length;
      
      // Only shield if average delta is also positive (confirming underrated, not lucky)
      const recentHistory = this.history.slice(-PERF_WINDOW);
      const avgDelta = recentHistory.length > 0
        ? recentHistory.reduce((s, h) => s + h.delta, 0) / recentHistory.length
        : 0;
      
      if (avgDelta <= 0) return 1.0; // not climbing → no shield
      
      if (wr >= 0.70) return 0.6;
      if (wr >= 0.65) return 0.75;
      if (wr >= 0.60) return 0.85;
      return 1.0;
    },
    get kFactor() {
      if (this.gamesPlayed < CALIBRATION_GAMES) {
        const p = this.gamesPlayed / CALIBRATION_GAMES;
        return K_CALIBRATION - (K_CALIBRATION - BASE_K) * p;
      } else if (this.gamesPlayed >= K_VETERAN_THRESHOLD) {
        return K_VETERAN;
      } else {
        const p = (this.gamesPlayed - CALIBRATION_GAMES) / (K_VETERAN_THRESHOLD - CALIBRATION_GAMES);
        return BASE_K - (BASE_K - K_VETERAN) * p;
      }
    },
    get rank() {
      return getRank(this.mmr);
    },
    get trueMmr() {
      return 200 + ((this.trueSkill - TRUE_SKILL_MIN) / (TRUE_SKILL_MAX - TRUE_SKILL_MIN)) * 1800;
    },
    get winRate() {
      return this.gamesPlayed > 0 ? ((this.wins / this.gamesPlayed) * 100).toFixed(0) : "0";
    },
  };
}

function simulateMatch(teamA, teamB, rng) {
  const a = teamA.reduce((s, p) => s + p.trueSkill, 0);
  const b = teamB.reduce((s, p) => s + p.trueSkill, 0);
  const pa = 1 / (1 + Math.pow(10, (b - a) / (400 / 15)));
  return rng() < pa ? 0 : 1;
}

function getMargin(diff) {
  const d = Math.abs(diff);
  if (d > 8) return "stomp";
  if (d > 4) return "clear";
  if (d > 2) return "normal";
  return "close";
}

function getScore(margin, rng) {
  const scores = {
    stomp: ["6-1 6-1", "6-0 6-2"],
    clear: ["6-3 6-2", "6-2 6-4"],
    normal: ["6-4 6-4", "7-5 6-4"],
    close: ["7-6 4-6 6-4", "6-4 4-6 7-5"],
  };
  const opts = scores[margin] || scores.normal;
  return opts[Math.floor(rng() * opts.length)];
}

function calcMmrChanges(teamA, teamB, winner, margin) {
  const wt = winner === 0 ? teamA : teamB;
  const lt = winner === 0 ? teamB : teamA;
  const wMmr = wt.reduce((s, p) => s + p.mmr, 0) / wt.length;
  const lMmr = lt.reduce((s, p) => s + p.mmr, 0) / lt.length;
  const expW = expectedScore(wMmr, lMmr);
  const mm = MARGIN_MULTIPLIERS[margin] || 1.0;

  // diff > 0 = upset (winner was lower rated)
  const diff = lMmr - wMmr;

  // Winners: rewarded MORE for upsets (diff > 0), LESS for expected wins (diff < 0)
  const am = Math.max(MIN_GAIN_MULTIPLIER, Math.min(MAX_GAIN_MULTIPLIER,
    1.0 + (diff / 100) * UPSET_BONUS_SCALE
  ));

  // Losers: penalized MORE when they LOST to a weaker team (diff > 0 = they were favored)
  // Invert diff so the loser's multiplier mirrors the upset logic independently
  const lam = Math.max(MIN_GAIN_MULTIPLIER, Math.min(MAX_GAIN_MULTIPLIER,
    1.0 + (-diff / 100) * UPSET_BONUS_SCALE  // ← negative diff: favored team loses more
  ));

  const changes = {};

  for (const p of wt) {
    const k = p.kFactor;
    let gain = k * (1.0 - expW) * am * mm;
    const tm = wt.find((t) => t.id !== p.id);
    if (tm) {
      const ta = Math.max(0.8, Math.min(1.2, 1.0 + ((tm.mmr - p.mmr) / 100) * TEAMMATE_DIFF_FACTOR));
      gain *= ta;
    }
    if (p.streak > 0) gain += Math.min(p.streak * 0.5, 3.0);
    // Performance accelerator: sustained high WR boosts gains
    gain *= p.performanceMultiplier;
    // Floor only during calibration to help initial placement
    const floor = p.gamesPlayed < CALIBRATION_GAMES ? MIN_MMR_CHANGE : 0;
    changes[p.id] = Math.max(floor, Math.round(gain * 10) / 10);
  }

  for (const p of lt) {
    const k = p.kFactor;
    let loss = k * (1.0 - expW) * lam * mm;
    const tm = lt.find((t) => t.id !== p.id);
    if (tm) {
      const ta = Math.max(0.8, Math.min(1.2, 1.0 + ((p.mmr - tm.mmr) / 100) * TEAMMATE_DIFF_FACTOR));
      loss *= ta;
    }
    // Performance shield: high WR players lose less on occasional losses
    loss *= p.performanceLossShield;
    loss *= p.performanceMultiplier;
    changes[p.id] = Math.round(-loss * 10) / 10;
  }

  return changes;
}

function createMatch(players, rng) {
  const eligible = players.filter((p) => p.gamesPlayed < GAMES_PER_PLAYER_TARGET);
  const pool = eligible.length >= 4 ? eligible : [...players];
  const weights = pool.map((p) => Math.max(1, GAMES_PER_PLAYER_TARGET - p.gamesPlayed));

  function weightedPick(candidates, cWeights) {
    const total = cWeights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= cWeights[i];
      if (r <= 0) return i;
    }
    return candidates.length - 1;
  }

  const anchorIdx = weightedPick(pool, weights);
  const anchor = pool[anchorIdx];
  let cands = pool.filter((p) => p.id !== anchor.id && !anchor.recentOpponents.slice(-4).includes(p.id));
  if (cands.length < 3) cands = pool.filter((p) => p.id !== anchor.id);

  const cw = cands.map(
    (p) =>
      Math.max(0.1, 1 - Math.abs(p.mmr - anchor.mmr) / 800) *
      Math.max(1, GAMES_PER_PLAYER_TARGET - p.gamesPlayed)
  );

  const selected = [anchor];
  const remCands = [...cands];
  const remW = [...cw];

  for (let i = 0; i < 3 && remCands.length > 0; i++) {
    const idx = weightedPick(remCands, remW);
    selected.push(remCands[idx]);
    remCands.splice(idx, 1);
    remW.splice(idx, 1);
  }

  if (selected.length < 4) return [[], []];

  selected.sort((a, b) => b.mmr - a.mmr);
  const teamA = [selected[0], selected[3]];
  const teamB = [selected[1], selected[2]];

  for (const p of teamA) {
    for (const o of teamB) {
      p.recentOpponents.push(o.id);
      p.recentOpponents = p.recentOpponents.slice(-8);
    }
  }

  for (const p of teamB) {
    for (const o of teamA) {
      p.recentOpponents.push(o.id);
      p.recentOpponents = p.recentOpponents.slice(-8);
    }
  }

  return [teamA, teamB];
}

function runSimulation(seed = 42) {
  const rng = seededRandom(seed);
  const skills = [];

  for (let i = 0; i < NUM_PLAYERS; i++) {
    const r = rng();
    const tier = r < 0.25 ? "b" : r < 0.75 ? "i" : "a";
    const means = { b: 15, i: 25, a: 35 };
    const stds = { b: 2.5, i: 3, a: 2.5 };
    let s = means[tier] + gaussianRandom(rng) * stds[tier];
    s = Math.max(TRUE_SKILL_MIN, Math.min(TRUE_SKILL_MAX, s));
    skills.push(s);
  }

  const players = skills.map((s, i) => createPlayer(i, NAMES[i], s));
  const matches = [];
  let gc = 0;
  let cp = 0;

  while (gc < 4000) {
    const minGames = Math.min(...players.map((p) => p.gamesPlayed));
    if (minGames >= GAMES_PER_PLAYER_TARGET) break;

    const [teamA, teamB] = createMatch(players, rng);
    if (teamA.length < 2 || teamB.length < 2) continue;

    gc++;
    const tamAvg = (teamA[0].mmr + teamA[1].mmr) / 2;
    const tbmAvg = (teamB[0].mmr + teamB[1].mmr) / 2;
    const pred = tamAvg >= tbmAvg ? 0 : 1;
    const actual = simulateMatch(teamA, teamB, rng);
    if (pred === actual) cp++;

    const td = teamA.reduce((s, p) => s + p.trueSkill, 0) - teamB.reduce((s, p) => s + p.trueSkill, 0);
    const wd = actual === 0 ? td : -td;
    const margin = getMargin(wd);
    const score = getScore(margin, rng);
    const changes = calcMmrChanges(teamA, teamB, actual, margin);

    const matchRecord = {
      id: gc,
      teamA: teamA.map((p) => ({ id: p.id, name: p.name, mmrBefore: p.mmr, change: changes[p.id] })),
      teamB: teamB.map((p) => ({ id: p.id, name: p.name, mmrBefore: p.mmr, change: changes[p.id] })),
      winner: actual,
      score,
      margin,
    };

    for (const p of [...teamA, ...teamB]) {
      p.mmr += changes[p.id];
      p.mmr = Math.max(0, p.mmr);
      p.history.push({ match: gc, mmr: p.mmr, delta: changes[p.id] });
      if (p.mmr > p.peakMmr) p.peakMmr = p.mmr;
    }

    for (const p of actual === 0 ? teamA : teamB) {
      p.wins++;
      p.gamesPlayed++;
      p.streak = p.streak >= 0 ? p.streak + 1 : 1;
      p.recentResults.push(1);
      if (p.recentResults.length > PERF_WINDOW) p.recentResults.shift();
    }

    for (const p of actual === 0 ? teamB : teamA) {
      p.losses++;
      p.gamesPlayed++;
      p.streak = p.streak <= 0 ? p.streak - 1 : -1;
      p.recentResults.push(0);
      if (p.recentResults.length > PERF_WINDOW) p.recentResults.shift();
    }

    matches.push(matchRecord);
  }

  return { players, matches, totalMatches: gc, correctPredictions: cp };
}

// ─── Diagnostics Stats ───────────────────────────────────────────────
function computeDiagnostics(players) {
  const n = players.length;
  const xs = players.map((p) => p.trueSkill);
  const ys = players.map((p) => p.mmr);
  const targets = players.map((p) => p.trueMmr);

  // Linear regression: MMR vs trueSkill
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0, ssXX = 0, ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (xs[i] - xMean) * (ys[i] - yMean);
    ssXX += (xs[i] - xMean) * (xs[i] - xMean);
    ssTot += (ys[i] - yMean) * (ys[i] - yMean);
  }
  const slope = ssXX > 0 ? ssXY / ssXX : 0;
  const intercept = yMean - slope * xMean;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    ssRes += (ys[i] - predicted) * (ys[i] - predicted);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // MAE: final MMR vs trueMmr target
  const mae = targets.reduce((s, t, i) => s + Math.abs(ys[i] - t), 0) / n;

  // Spearman rank correlation
  const rankBy = (arr) => {
    const sorted = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i][1]] = i + 1;
    return ranks;
  };
  const rTrue = rankBy(xs);
  const rMmr = rankBy(ys);
  let dSq = 0;
  for (let i = 0; i < n; i++) dSq += (rTrue[i] - rMmr[i]) ** 2;
  const spearman = 1 - (6 * dSq) / (n * (n * n - 1));

  // Convergence: % of players within 200 MMR of their trueMmr
  const converged = players.filter((p) => Math.abs(p.mmr - p.trueMmr) < 200).length;
  const convergePct = ((converged / n) * 100).toFixed(0);

  // Biggest over/under performers
  const deviations = players.map((p) => ({
    name: p.name,
    mmr: p.mmr,
    trueMmr: p.trueMmr,
    diff: p.mmr - p.trueMmr,
  }));
  deviations.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const outliers = deviations.slice(0, 5);

  return { slope, intercept, r2, mae, spearman, convergePct, converged, n, outliers, xs, ys, targets };
}

// ─── Scatter Plot Canvas ──────────────────────────────────────────────
function ScatterPlot({ players, diagnostics }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !diagnostics) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const pad = { top: 24, right: 24, bottom: 40, left: 56 };

    const { xs, ys, slope, intercept } = diagnostics;
    const xMin = Math.min(...xs) - 2;
    const xMax = Math.max(...xs) + 2;
    const yMin = Math.min(...ys) - 50;
    const yMax = Math.max(...ys) + 50;

    const toX = (v) => pad.left + ((v - xMin) / (xMax - xMin)) * (W - pad.left - pad.right);
    const toY = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.top - pad.bottom);

    ctx.clearRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(42,46,56,0.6)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) / 4) * i;
      const y = toY(v);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = "#5a5f78";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(v).toString(), pad.left - 8, y + 3);
    }
    for (let i = 0; i <= 4; i++) {
      const v = xMin + ((xMax - xMin) / 4) * i;
      const x = toX(v);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, H - pad.bottom); ctx.stroke();
      ctx.fillStyle = "#5a5f78";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(v.toFixed(0), x, H - pad.bottom + 16);
    }

    // Perfect line (trueMmr mapping)
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(34,197,94,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const perfY1 = 200 + ((xMin - TRUE_SKILL_MIN) / (TRUE_SKILL_MAX - TRUE_SKILL_MIN)) * 1800;
    const perfY2 = 200 + ((xMax - TRUE_SKILL_MIN) / (TRUE_SKILL_MAX - TRUE_SKILL_MIN)) * 1800;
    ctx.moveTo(toX(xMin), toY(perfY1));
    ctx.lineTo(toX(xMax), toY(perfY2));
    ctx.stroke();
    ctx.setLineDash([]);

    // Regression line
    ctx.strokeStyle = "rgba(245,158,11,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(xMin), toY(slope * xMin + intercept));
    ctx.lineTo(toX(xMax), toY(slope * xMax + intercept));
    ctx.stroke();

    // Data points
    for (let i = 0; i < xs.length; i++) {
      const x = toX(xs[i]);
      const y = toY(ys[i]);
      const target = players[i].trueMmr;
      const err = Math.abs(ys[i] - target);
      const color = err < 100 ? "#22c55e" : err < 200 ? "#f59e0b" : "#ef4444";

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Labels
    ctx.fillStyle = "#5a5f78";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("TRUE SKILL", W / 2, H - 4);
    ctx.save();
    ctx.translate(12, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("FINAL MMR", 0, 0);
    ctx.restore();
  }, [players, diagnostics]);

  return (
    <canvas
      ref={canvasRef}
      className="chart-canvas"
      style={{ width: "100%", height: 320 }}
    />
  );
}

// ─── Glicko-2 / Bayesian Engine ───────────────────────────────────────
const G2_MU_START = 1000;
const G2_SIGMA_START = 350;
const G2_SIGMA_FLOOR = 60;
const G2_DISPLAY_K = 1.8;
const G2_MARGIN_EVIDENCE = { stomp: 0.9, clear: 0.7, normal: 0.5, close: 0.25 };
const G2_INDIVIDUAL_WEIGHT = 0.7;

function g2CreatePlayer(id, name, trueSkill) {
  return {
    id,
    name,
    trueSkill,
    mu: G2_MU_START,
    sigma: G2_SIGMA_START,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    peakMu: G2_MU_START,
    history: [],
    recentOpponents: [],
    get displayRating() {
      return Math.max(0, this.mu - G2_DISPLAY_K * this.sigma);
    },
    get mmr() { return this.mu; },
    get trueMmr() {
      return 200 + ((this.trueSkill - TRUE_SKILL_MIN) / (TRUE_SKILL_MAX - TRUE_SKILL_MIN)) * 1800;
    },
    get winRate() {
      return this.gamesPlayed > 0 ? ((this.wins / this.gamesPlayed) * 100).toFixed(0) : "0";
    },
    get rank() { return getRank(this.mu); },
  };
}

function g2Expected(playerMu, playerSigma, teammateMu, oppAvgMu, oppAvgSigma) {
  const effective = playerMu * G2_INDIVIDUAL_WEIGHT + teammateMu * (1 - G2_INDIVIDUAL_WEIGHT);
  const g = 1 / Math.sqrt(1 + 3 * (playerSigma * playerSigma + oppAvgSigma * oppAvgSigma) / (Math.PI * Math.PI * 400 * 400 / (Math.log(10) * Math.log(10))));
  return 1 / (1 + Math.pow(10, -g * (effective - oppAvgMu) / 400));
}

function g2CalcChanges(teamA, teamB, winner, margin) {
  const wt = winner === 0 ? teamA : teamB;
  const lt = winner === 0 ? teamB : teamA;
  const evidence = G2_MARGIN_EVIDENCE[margin] || 0.5;
  const changes = {};

  const wAvgMu = wt.reduce((s, p) => s + p.mu, 0) / wt.length;
  const lAvgMu = lt.reduce((s, p) => s + p.mu, 0) / lt.length;
  const wAvgSigma = wt.reduce((s, p) => s + p.sigma, 0) / wt.length;
  const lAvgSigma = lt.reduce((s, p) => s + p.sigma, 0) / lt.length;

  for (const p of wt) {
    const tm = wt.find((t) => t.id !== p.id);
    const tmMu = tm ? tm.mu : p.mu;
    const exp = g2Expected(p.mu, p.sigma, tmMu, lAvgMu, lAvgSigma);
    const surprise = 1 - exp;
    const sigmaFactor = p.sigma / G2_SIGMA_START;
    const muDelta = p.sigma * sigmaFactor * surprise * (1 + evidence * 0.5) * 2.5;
    const sigmaReduce = p.sigma * evidence * 0.04;
    changes[p.id] = {
      muDelta: Math.round(muDelta * 10) / 10,
      sigmaNew: Math.max(G2_SIGMA_FLOOR, p.sigma - sigmaReduce),
    };
  }

  for (const p of lt) {
    const tm = lt.find((t) => t.id !== p.id);
    const tmMu = tm ? tm.mu : p.mu;
    const exp = g2Expected(p.mu, p.sigma, tmMu, wAvgMu, wAvgSigma);
    const sigmaFactor = p.sigma / G2_SIGMA_START;
    const muDelta = p.sigma * sigmaFactor * exp * (1 + evidence * 0.3) * 2.5;
    const sigmaReduce = p.sigma * evidence * 0.03;
    changes[p.id] = {
      muDelta: Math.round(-muDelta * 10) / 10,
      sigmaNew: Math.max(G2_SIGMA_FLOOR, p.sigma - sigmaReduce),
    };
  }

  return changes;
}

function g2CreateMatch(players, rng) {
  const eligible = players.filter((p) => p.gamesPlayed < GAMES_PER_PLAYER_TARGET);
  const pool = eligible.length >= 4 ? eligible : [...players];
  const weights = pool.map((p) => Math.max(1, GAMES_PER_PLAYER_TARGET - p.gamesPlayed));

  function weightedPick(candidates, cWeights) {
    const total = cWeights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= cWeights[i];
      if (r <= 0) return i;
    }
    return candidates.length - 1;
  }

  const anchorIdx = weightedPick(pool, weights);
  const anchor = pool[anchorIdx];
  let cands = pool.filter((p) => p.id !== anchor.id && !anchor.recentOpponents.slice(-4).includes(p.id));
  if (cands.length < 3) cands = pool.filter((p) => p.id !== anchor.id);

  const cw = cands.map((p) => {
    const proximity = Math.max(0.1, 1 - Math.abs(p.mu - anchor.mu) / 800);
    const needGames = Math.max(1, GAMES_PER_PLAYER_TARGET - p.gamesPlayed);
    // High-sigma players get probed with more diverse opponents
    const probeBonus = p.sigma > 200 ? 0.3 * (Math.abs(p.mu - anchor.mu) / 800) : 0;
    return (proximity + probeBonus) * needGames;
  });

  const selected = [anchor];
  const remCands = [...cands];
  const remW = [...cw];

  for (let i = 0; i < 3 && remCands.length > 0; i++) {
    const idx = weightedPick(remCands, remW);
    selected.push(remCands[idx]);
    remCands.splice(idx, 1);
    remW.splice(idx, 1);
  }

  if (selected.length < 4) return [[], []];

  selected.sort((a, b) => b.mu - a.mu);
  const teamA = [selected[0], selected[3]];
  const teamB = [selected[1], selected[2]];

  for (const p of teamA) {
    for (const o of teamB) {
      p.recentOpponents.push(o.id);
      p.recentOpponents = p.recentOpponents.slice(-8);
    }
  }
  for (const p of teamB) {
    for (const o of teamA) {
      p.recentOpponents.push(o.id);
      p.recentOpponents = p.recentOpponents.slice(-8);
    }
  }

  return [teamA, teamB];
}

function runGlickoSimulation(seed = 42) {
  const rng = seededRandom(seed);
  const skills = [];

  for (let i = 0; i < NUM_PLAYERS; i++) {
    const r = rng();
    const tier = r < 0.25 ? "b" : r < 0.75 ? "i" : "a";
    const means = { b: 15, i: 25, a: 35 };
    const stds = { b: 2.5, i: 3, a: 2.5 };
    let s = means[tier] + gaussianRandom(rng) * stds[tier];
    s = Math.max(TRUE_SKILL_MIN, Math.min(TRUE_SKILL_MAX, s));
    skills.push(s);
  }

  const players = skills.map((s, i) => g2CreatePlayer(i, NAMES[i], s));
  const matches = [];
  let gc = 0;
  let cp = 0;

  while (gc < 4000) {
    const minGames = Math.min(...players.map((p) => p.gamesPlayed));
    if (minGames >= GAMES_PER_PLAYER_TARGET) break;

    const [teamA, teamB] = g2CreateMatch(players, rng);
    if (teamA.length < 2 || teamB.length < 2) continue;

    gc++;
    const tamAvg = (teamA[0].mu + teamA[1].mu) / 2;
    const tbmAvg = (teamB[0].mu + teamB[1].mu) / 2;
    const pred = tamAvg >= tbmAvg ? 0 : 1;
    const actual = simulateMatch(teamA, teamB, rng);
    if (pred === actual) cp++;

    const td = teamA.reduce((s, p) => s + p.trueSkill, 0) - teamB.reduce((s, p) => s + p.trueSkill, 0);
    const wd = actual === 0 ? td : -td;
    const margin = getMargin(wd);
    const changes = g2CalcChanges(teamA, teamB, actual, margin);

    const matchRecord = {
      id: gc,
      teamA: teamA.map((p) => ({ id: p.id, name: p.name, mmrBefore: p.mu, change: changes[p.id].muDelta })),
      teamB: teamB.map((p) => ({ id: p.id, name: p.name, mmrBefore: p.mu, change: changes[p.id].muDelta })),
      winner: actual,
      margin,
    };

    for (const p of [...teamA, ...teamB]) {
      const c = changes[p.id];
      p.mu += c.muDelta;
      p.mu = Math.max(0, p.mu);
      p.sigma = c.sigmaNew;
      p.history.push({ match: gc, mmr: p.mu, delta: c.muDelta });
      if (p.mu > p.peakMu) p.peakMu = p.mu;
    }

    for (const p of actual === 0 ? teamA : teamB) {
      p.wins++;
      p.gamesPlayed++;
    }
    for (const p of actual === 0 ? teamB : teamA) {
      p.losses++;
      p.gamesPlayed++;
    }

    matches.push(matchRecord);
  }

  return { players, matches, totalMatches: gc, correctPredictions: cp };
}

function computeG2Diagnostics(players) {
  const n = players.length;
  const xs = players.map((p) => p.trueSkill);
  const ys = players.map((p) => p.mu);
  const targets = players.map((p) => p.trueMmr);

  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0, ssXX = 0, ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (xs[i] - xMean) * (ys[i] - yMean);
    ssXX += (xs[i] - xMean) * (xs[i] - xMean);
    ssTot += (ys[i] - yMean) * (ys[i] - yMean);
  }
  const slope = ssXX > 0 ? ssXY / ssXX : 0;
  const intercept = yMean - slope * xMean;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    ssRes += (ys[i] - predicted) * (ys[i] - predicted);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const mae = targets.reduce((s, t, i) => s + Math.abs(ys[i] - t), 0) / n;

  const rankBy = (arr) => {
    const sorted = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i][1]] = i + 1;
    return ranks;
  };
  const rTrue = rankBy(xs);
  const rMmr = rankBy(ys);
  let dSq = 0;
  for (let i = 0; i < n; i++) dSq += (rTrue[i] - rMmr[i]) ** 2;
  const spearman = 1 - (6 * dSq) / (n * (n * n - 1));

  const converged = players.filter((p) => Math.abs(p.mu - p.trueMmr) < 100).length;
  const convergePct = ((converged / n) * 100).toFixed(0);
  const avgSigma = Math.round(players.reduce((s, p) => s + p.sigma, 0) / n);

  return { slope, intercept, r2, mae, spearman, convergePct, converged, n, avgSigma, xs, ys, targets };
}

// ─── Rank Icon SVG ────────────────────────────────────────────────────
function RankBadge({ mmr, size = 32 }) {
  const [, name, color] = getRank(mmr);
  const tierGroup = name.split(" ")[0];

  const shapes = {
    Bronze: (
      <g>
        <circle cx="16" cy="16" r="12" fill="none" stroke={color} strokeWidth="2" opacity="0.6" />
        <circle cx="16" cy="16" r="6" fill={color} opacity="0.8" />
      </g>
    ),
    Silver: (
      <g>
        <polygon points="16,4 20,14 16,12 12,14" fill={color} opacity="0.8" />
        <polygon points="16,28 20,18 16,20 12,18" fill={color} opacity="0.8" />
        <circle cx="16" cy="16" r="4" fill={color} />
      </g>
    ),
    Gold: (
      <g>
        <polygon points="16,2 20,12 28,12 22,18 24,28 16,22 8,28 10,18 4,12 12,12" fill={color} opacity="0.9" />
      </g>
    ),
    Plat: (
      <g>
        <polygon points="16,3 19,13 29,13 21,19 24,29 16,23 8,29 11,19 3,13 13,13" fill="none" stroke={color} strokeWidth="1.5" />
        <polygon points="16,8 18,14 24,14 19,18 21,24 16,20 11,24 13,18 8,14 14,14" fill={color} opacity="0.8" />
      </g>
    ),
    Dia: (
      <g>
        <polygon points="16,2 28,16 16,30 4,16" fill={color} opacity="0.3" />
        <polygon points="16,6 24,16 16,26 8,16" fill={color} opacity="0.7" />
        <polygon points="16,10 20,16 16,22 12,16" fill={color} />
      </g>
    ),
    Champion: (
      <g>
        <polygon points="16,1 20,11 30,11 22,18 25,28 16,22 7,28 10,18 2,11 12,11" fill={color} />
        <circle cx="16" cy="14" r="3" fill="#fff" opacity="0.5" />
      </g>
    ),
    Grand: (
      <g>
        <polygon points="16,0 19,10 30,10 21,17 24,28 16,21 8,28 11,17 2,10 13,10" fill="#FF4500" />
        <polygon points="16,5 18,12 24,12 19,16 21,23 16,19 11,23 13,16 8,12 14,12" fill="#FFD700" />
      </g>
    ),
    Legend: (
      <g>
        <circle cx="16" cy="16" r="14" fill="none" stroke="#FF0000" strokeWidth="2">
          <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="8s" repeatCount="indefinite" />
        </circle>
        <polygon points="16,2 20,12 30,12 22,18 25,28 16,22 7,28 10,18 2,12 12,12" fill="#FF0000" />
        <polygon points="16,7 18,13 24,13 19,17 21,23 16,19 11,23 13,17 8,13 14,13" fill="#FFD700" />
      </g>
    ),
  };

  const shape = shapes[tierGroup] || shapes.Bronze;

  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      {shape}
    </svg>
  );
}

// ─── Sparkline ────────────────────────────────────────────────────────
function Sparkline({ data, width = 120, height = 32 }) {
  if (!data || data.length < 2) return null;

  const mmrs = data.map((d) => d.mmr);
  const min = Math.min(...mmrs);
  const max = Math.max(...mmrs);
  const range = max - min || 1;

  const points = mmrs
    .map((v, i) => {
      const x = (i / (mmrs.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  const lastVal = mmrs[mmrs.length - 1];
  const firstVal = mmrs[0];
  const color = lastVal >= firstVal ? "#22c55e" : "#ef4444";

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <circle
        cx={width}
        cy={height - ((lastVal - min) / range) * (height - 4) - 2}
        r="2.5"
        fill={color}
      />
    </svg>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --bg-primary: #0a0c10;
  --bg-secondary: #111318;
  --bg-card: #161920;
  --bg-hover: #1c2028;
  --border: #2a2e38;
  --border-accent: #3a3e48;
  --text-primary: #e8eaf0;
  --text-secondary: #8a8fa8;
  --text-muted: #5a5f78;
  --accent: #f59e0b;
  --accent-dim: #b27308;
  --green: #22c55e;
  --red: #ef4444;
  --blue: #3b82f6;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  width: 100%;
  min-height: 100%;
  overflow-x: hidden;
}

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: 'Chakra Petch', sans-serif;
  -webkit-font-smoothing: antialiased;
}

.app {
  width: 100%;
  min-height: 100vh;
}

/* Header */
.hero {
  position: relative;
  width: 100%;
  padding: 48px 20px 40px;
  text-align: center;
  background: linear-gradient(180deg, #0d1117 0%, #0a0c10 100%);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}

.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 600px 300px at 50% 0%, rgba(245,158,11,0.06) 0%, transparent 100%),
    radial-gradient(ellipse 400px 200px at 30% 100%, rgba(59,130,246,0.04) 0%, transparent 100%);
  pointer-events: none;
}

.hero-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 12px;
  opacity: 0.8;
}

.hero h1 {
  font-size: clamp(30px, 6vw, 54px);
  font-weight: 700;
  letter-spacing: -0.5px;
  line-height: 1.1;
  background: linear-gradient(135deg, #e8eaf0 30%, #f59e0b 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 12px;
}

.hero-sub {
  color: var(--text-secondary);
  font-size: 15px;
  max-width: 620px;
  margin: 0 auto 28px;
  line-height: 1.6;
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(80px, 1fr));
  gap: 20px;
  max-width: 820px;
  margin: 0 auto;
}

.hero-stat {
  text-align: center;
}

.hero-stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}

.hero-stat-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* Tabs */
.tabs {
  display: flex;
  justify-content: center;
  gap: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.tab {
  padding: 14px 24px;
  font-family: 'Chakra Petch', sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
  position: relative;
  transition: color 0.2s;
  white-space: nowrap;
  flex: 0 0 auto;
}

.tab:hover {
  color: var(--text-secondary);
}

.tab.active {
  color: var(--accent);
}

.tab.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 16px;
  right: 16px;
  height: 2px;
  background: var(--accent);
}

/* Content */
.content {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 16px 64px;
}

/* Leaderboard */
.lb-wrap {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
}

.lb-table {
  min-width: 860px;
}

.lb-header {
  display: grid;
  grid-template-columns: 44px 1fr 90px 80px 70px 60px 60px 120px;
  padding: 10px 16px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  gap: 8px;
  align-items: center;
}

.lb-row {
  display: grid;
  grid-template-columns: 44px 1fr 90px 80px 70px 60px 60px 120px;
  padding: 10px 16px;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid rgba(42,46,56,0.5);
  cursor: pointer;
  transition: background 0.15s;
}

.lb-row:last-child {
  border-bottom: none;
}

.lb-row:hover {
  background: var(--bg-hover);
}

.lb-row.selected {
  background: rgba(245,158,11,0.06);
  border-left: 2px solid var(--accent);
}

.lb-rank {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted);
  text-align: center;
}

.lb-rank.top-3 {
  color: var(--accent);
}

.lb-player {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.lb-name {
  font-weight: 600;
  font-size: 14px;
}

.lb-tag {
  display: inline-block;
  margin-top: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  padding: 2px 5px;
  border-radius: 3px;
  letter-spacing: 0.5px;
}

.lb-tag.prov {
  background: rgba(245,158,11,0.15);
  color: var(--accent);
}

.lb-tag.cal {
  background: rgba(34,197,94,0.12);
  color: var(--green);
}

.lb-mmr {
  font-family: 'JetBrains Mono', monospace;
  font-size: 15px;
  font-weight: 600;
}

.lb-rank-name {
  font-size: 12px;
  font-weight: 500;
}

.lb-record {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-secondary);
}

.lb-wr {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

.lb-streak {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
}

/* Player Profile */
.profile {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 24px;
}

.profile-top {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 28px 28px 20px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.profile-badge {
  flex-shrink: 0;
}

.profile-info {
  flex: 1;
  min-width: 220px;
}

.profile-name {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 4px;
}

.profile-rank-label {
  font-size: 14px;
  font-weight: 600;
}

.profile-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.profile-mmr-block {
  margin-left: auto;
}

.profile-mmr-big {
  font-family: 'JetBrains Mono', monospace;
  font-size: 36px;
  font-weight: 700;
  text-align: right;
  flex-shrink: 0;
}

.profile-mmr-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  text-align: right;
}

.profile-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 1px;
  background: var(--border);
}

.profile-stat {
  background: var(--bg-card);
  padding: 16px 20px;
  text-align: center;
}

.profile-stat-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 20px;
  font-weight: 600;
}

.profile-stat-lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-top: 4px;
}

.profile-chart {
  padding: 20px 28px;
}

.profile-chart-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

/* Match Log */
.match-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.match-card:hover {
  border-color: var(--border-accent);
}

.match-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: rgba(255,255,255,0.01);
  flex-wrap: wrap;
}

.match-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
}

.match-score {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.match-margin {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  letter-spacing: 0.5px;
}

.match-margin.stomp {
  background: rgba(239,68,68,0.15);
  color: var(--red);
}
.match-margin.clear {
  background: rgba(245,158,11,0.12);
  color: var(--accent);
}
.match-margin.normal {
  background: rgba(59,130,246,0.1);
  color: var(--blue);
}
.match-margin.close {
  background: rgba(34,197,94,0.1);
  color: var(--green);
}

.match-teams {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--border);
}

.match-team {
  padding: 8px 16px;
  background: var(--bg-card);
}

.match-team.winner {
  background: rgba(34,197,94,0.03);
}

.match-team.loser {
  background: rgba(239,68,68,0.02);
}

.match-team-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.match-team-label.w {
  color: var(--green);
}

.match-team-label.l {
  color: var(--red);
}

.match-player {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
  font-size: 13px;
}

.match-delta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
}

.match-delta.pos {
  color: var(--green);
}

.match-delta.neg {
  color: var(--red);
}

/* How it works */
.how-section {
  margin-bottom: 32px;
}

.how-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.how-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 20px 24px;
  margin-bottom: 12px;
}

.how-card h4 {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 8px;
}

.how-card p {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.how-card p + p {
  margin-top: 10px;
}

.how-card code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  background: rgba(245,158,11,0.08);
  color: var(--accent);
  padding: 1px 5px;
  border-radius: 3px;
}

.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.tier-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
  border: 1px solid var(--border);
}

.tier-name {
  font-size: 12px;
  font-weight: 600;
}

.tier-mmr {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted);
}

/* K-factor visualization */
.k-bar-container {
  margin-top: 12px;
}

.k-bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.k-bar-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-secondary);
  width: 80px;
  text-align: right;
}

.k-bar {
  height: 16px;
  border-radius: 3px;
  transition: width 0.3s;
}

.k-bar-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted);
  width: 36px;
}

/* MMR Chart */
.chart-canvas {
  width: 100%;
  border-radius: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
}

/* Responsive */
@media (max-width: 768px) {
  .hero {
    padding: 36px 16px 28px;
  }

  .hero h1 {
    font-size: 36px;
  }

  .hero-sub {
    font-size: 14px;
    max-width: 100%;
  }

  .hero-stats {
    grid-template-columns: repeat(2, minmax(100px, 1fr));
    gap: 16px;
  }

  .profile-top {
    padding: 20px;
    align-items: flex-start;
  }

  .profile-info {
    min-width: 100%;
  }

  .profile-mmr-block {
    margin-left: 0;
    width: 100%;
  }

  .profile-mmr-big,
  .profile-mmr-label {
    text-align: left;
  }

  .profile-chart {
    padding: 16px;
  }

  .match-teams {
    grid-template-columns: 1fr;
  }

  .tabs {
    justify-content: flex-start;
  }

  .tab {
    padding: 12px 16px;
    font-size: 12px;
  }

  .k-bar-row {
    gap: 8px;
  }

  .k-bar-label {
    width: 72px;
    font-size: 10px;
  }
}

@media (max-width: 480px) {
  .content {
    padding: 16px 10px 40px;
  }

  .hero {
    padding: 28px 12px 22px;
  }

  .hero-label {
    font-size: 10px;
    letter-spacing: 2px;
  }

  .hero h1 {
    font-size: 30px;
  }

  .hero-sub {
    font-size: 13px;
  }

  .hero-stat-value {
    font-size: 18px;
  }

  .profile-name {
    font-size: 20px;
  }

  .profile-mmr-big {
    font-size: 26px;
  }

  .profile-stats {
    grid-template-columns: repeat(2, 1fr);
  }

  .match-header {
    gap: 8px;
  }

  .match-player {
    font-size: 12px;
  }

  .how-card {
    padding: 16px;
  }

  .tier-grid {
    grid-template-columns: 1fr;
  }
}
`;

// ─── Full-width MMR Chart using Canvas ────────────────────────────────
function MmrChart({ history, trueMmr }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !history || history.length < 2) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const pad = { top: 20, right: 26, bottom: 28, left: 50 };

    const mmrs = history.map((d) => d.mmr);
    const allVals = [...mmrs, trueMmr, MMR_START];
    const minV = Math.min(...allVals) - 30;
    const maxV = Math.max(...allVals) + 30;
    const rangeV = maxV - minV || 1;

    const toX = (i) => pad.left + (i / (mmrs.length - 1)) * (W - pad.left - pad.right);
    const toY = (v) => pad.top + (1 - (v - minV) / rangeV) * (H - pad.top - pad.bottom);

    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(42,46,56,0.6)";
    ctx.lineWidth = 0.5;
    const steps = 5;

    for (let i = 0; i <= steps; i++) {
      const v = minV + (rangeV / steps) * i;
      const y = toY(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();

      ctx.fillStyle = "#5a5f78";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(v).toString(), pad.left - 8, y + 3);
    }

    const trueY = toY(trueMmr);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(245,158,11,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, trueY);
    ctx.lineTo(W - pad.right, trueY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(245,158,11,0.5)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("TRUE", W - pad.right + 4, trueY + 3);

    const startY = toY(MMR_START);
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = "rgba(138,143,168,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, startY);
    ctx.lineTo(W - pad.right, startY);
    ctx.stroke();
    ctx.setLineDash([]);

    const last = mmrs[mmrs.length - 1];
    const lineColor = last >= MMR_START ? "#22c55e" : "#ef4444";
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();

    mmrs.forEach((v, i) => {
      const x = toX(i);
      const y = toY(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, toY(maxV), 0, toY(minV));
    gradient.addColorStop(0, last >= MMR_START ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    mmrs.forEach((v, i) => {
      if (i === 0) ctx.moveTo(toX(i), toY(v));
      else ctx.lineTo(toX(i), toY(v));
    });
    ctx.lineTo(toX(mmrs.length - 1), H - pad.bottom);
    ctx.lineTo(toX(0), H - pad.bottom);
    ctx.closePath();
    ctx.fill();

    const lastX = toX(mmrs.length - 1);
    const lastY = toY(last);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lastX, lastY, 2, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();

    ctx.fillStyle = "#5a5f78";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("GAMES PLAYED", W / 2, H - 4);
  }, [history, trueMmr]);

  return (
    <canvas
      ref={canvasRef}
      className="chart-canvas"
      style={{ width: "100%", height: 180 }}
    />
  );
}

// ─── Main App ─────────────────────────────────────────────────────────
export default function PadelMMR() {
  const [tab, setTab] = useState("leaderboard");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [seed, setSeed] = useState(42);
  const [lbMode, setLbMode] = useState("v4"); // "v4" or "bayesian"

  const sim = useMemo(() => runSimulation(seed), [seed]);
  const g2sim = useMemo(() => runGlickoSimulation(seed), [seed]);
  const { players, matches, totalMatches, correctPredictions } = sim;
  const sorted = useMemo(() => [...players].sort((a, b) => b.mmr - a.mmr), [players]);
  const g2sorted = useMemo(() => [...g2sim.players].sort((a, b) => b.mu - a.mu), [g2sim.players]);

  const predAcc = totalMatches > 0 ? ((correctPredictions / totalMatches) * 100).toFixed(1) : "0";
  const mmrSpread = Math.round(Math.max(...players.map((p) => p.mmr)) - Math.min(...players.map((p) => p.mmr)));
  const convergence = useMemo(() => {
    const conv = players.filter((p) => Math.abs(p.mmr - p.trueMmr) < 100).length;
    return ((conv / players.length) * 100).toFixed(0);
  }, [players]);

  const viewPlayer = (p) => {
    setSelectedPlayer(p);
    setTab("profile");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app">
      <style>{CSS}</style>

      <div className="hero">
        <div className="hero-label">Padel Rating System V4</div>
        <h1>Uncapped MMR</h1>
        <p className="hero-sub">
          Dota-style asymmetric rating system for competitive 2v2 padel.
          Beat higher-rated teams for big gains. Score margins matter.
        </p>
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="hero-stat-value">{players.length}</div>
            <div className="hero-stat-label">Players</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-value">{totalMatches}</div>
            <div className="hero-stat-label">Matches</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-value">{predAcc}%</div>
            <div className="hero-stat-label">Pred. Accuracy</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-value">{mmrSpread}</div>
            <div className="hero-stat-label">MMR Spread</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-value" style={{ color: parseInt(convergence, 10) >= 70 ? 'var(--green)' : parseInt(convergence, 10) >= 40 ? 'var(--accent)' : 'var(--red)' }}>{convergence}%</div>
            <div className="hero-stat-label">Convergence</div>
          </div>
        </div>
      </div>

      <div className="tabs">
        {[
  "how it works",
  "leaderboard",
  "matches",
  "diagnostics",
  "compare",
].map((t) => (
  <button
    key={t}
    className={`tab ${tab === t ? "active" : ""}`}
    onClick={() => setTab(t)}
  >
    {t}
    {t === "how it works" && (
      <span
        style={{
          color: "#ef4444",
          marginLeft: 8,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.8,
        }}
      >
        PLEASE READ First
      </span>
    )}
  </button>
))}
      </div>

      <div className="content">
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 16,
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            SEED:
          </span>
          {[42, 7, 99, 256, 1337].map((s) => (
            <button
              key={s}
              onClick={() => {
                setSeed(s);
                setSelectedPlayer(null);
                setTab("leaderboard");
              }}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                padding: "4px 10px",
                borderRadius: 4,
                border: `1px solid ${seed === s ? "var(--accent)" : "var(--border)"}`,
                background: seed === s ? "rgba(245,158,11,0.1)" : "var(--bg-card)",
                color: seed === s ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {tab === "leaderboard" && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {["v4", "bayesian"].map((m) => (
                <button
                  key={m}
                  onClick={() => setLbMode(m)}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    padding: "6px 16px",
                    borderRadius: 4,
                    border: `1px solid ${lbMode === m ? (m === "v4" ? "var(--accent)" : "var(--blue)") : "var(--border)"}`,
                    background: lbMode === m ? (m === "v4" ? "rgba(245,158,11,0.1)" : "rgba(59,130,246,0.1)") : "var(--bg-card)",
                    color: lbMode === m ? (m === "v4" ? "var(--accent)" : "var(--blue)") : "var(--text-muted)",
                    cursor: "pointer",
                    fontWeight: lbMode === m ? 700 : 400,
                  }}
                >
                  {m === "v4" ? "V4 Elo" : "Bayesian μ/σ"}
                </button>
              ))}
            </div>

            {lbMode === "v4" && (
              <div className="lb-wrap">
                <div className="lb-table">
                  <div className="lb-header">
                    <div>#</div>
                    <div>Player</div>
                    <div>MMR</div>
                    <div>Rank</div>
                    <div>Record</div>
                    <div>WR%</div>
                    <div>Streak</div>
                    <div>Trend</div>
                  </div>

                  {sorted.map((p, i) => {
                    const rank = i + 1;
                    const [, rankName, rankColor] = p.rank;

                    return (
                      <div
                        key={p.id}
                        className={`lb-row ${selectedPlayer?.id === p.id ? "selected" : ""}`}
                        onClick={() => viewPlayer(p)}
                      >
                        <div className={`lb-rank ${rank <= 3 ? "top-3" : ""}`}>{rank}</div>
                        <div className="lb-player">
                          <RankBadge mmr={p.mmr} size={26} />
                          <div>
                            <div className="lb-name">{p.name}</div>
                            <span className={`lb-tag ${p.isProvisional ? "prov" : "cal"}`}>
                              {p.isProvisional ? "PROV" : "CAL"}
                            </span>
                            <span style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 9,
                              color: "var(--text-muted)",
                              opacity: 0.5,
                              marginLeft: 6,
                            }}>
                              True: {Math.round(p.trueMmr)}
                            </span>
                          </div>
                        </div>
                        <div className="lb-mmr" style={{ color: rankColor }}>
                          {Math.round(p.mmr)}
                        </div>
                        <div className="lb-rank-name" style={{ color: rankColor }}>
                          {rankName}
                        </div>
                        <div className="lb-record">
                          {p.wins}-{p.losses}
                        </div>
                        <div
                          className="lb-wr"
                          style={{
                            color: parseInt(p.winRate, 10) >= 50 ? "var(--green)" : "var(--red)",
                          }}
                        >
                          {p.winRate}%
                        </div>
                        <div
                          className="lb-streak"
                          style={{
                            color:
                              p.streak > 0
                                ? "var(--green)"
                                : p.streak < 0
                                ? "var(--red)"
                                : "var(--text-muted)",
                          }}
                        >
                          {p.streak > 0 ? `W${p.streak}` : p.streak < 0 ? `L${Math.abs(p.streak)}` : "—"}
                        </div>
                        <div>
                          <Sparkline data={p.history} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {lbMode === "bayesian" && (
              <div className="lb-wrap">
                <div className="lb-table">
                  <div className="lb-header" style={{ gridTemplateColumns: "44px 1fr 80px 80px 80px 70px 60px 120px" }}>
                    <div>#</div>
                    <div>Player</div>
                    <div>μ (Skill)</div>
                    <div>Display</div>
                    <div>σ</div>
                    <div>Record</div>
                    <div>WR%</div>
                    <div>Trend</div>
                  </div>

                  {g2sorted.map((p, i) => {
                    const [, rankName, rankColor] = getRank(p.mu);

                    return (
                      <div
                        key={p.id}
                        className="lb-row"
                        style={{ gridTemplateColumns: "44px 1fr 80px 80px 80px 70px 60px 120px", cursor: "default" }}
                      >
                        <div className={`lb-rank ${i < 3 ? "top-3" : ""}`}>{i + 1}</div>
                        <div className="lb-player">
                          <RankBadge mmr={p.mu} size={26} />
                          <div>
                            <div className="lb-name">{p.name}</div>
                            <span style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 9,
                              color: "var(--text-muted)",
                            }}>
                              True: {Math.round(p.trueMmr)}
                            </span>
                          </div>
                        </div>
                        <div className="lb-mmr" style={{ color: rankColor }}>
                          {Math.round(p.mu)}
                        </div>
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 14,
                          fontWeight: 600,
                          color: "var(--blue)",
                        }}>
                          {Math.round(p.displayRating)}
                        </div>
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          color: p.sigma > 200 ? "var(--red)" : p.sigma > 100 ? "var(--accent)" : "var(--green)",
                        }}>
                          ±{Math.round(p.sigma)}
                        </div>
                        <div className="lb-record">
                          {p.wins}-{p.losses}
                        </div>
                        <div
                          className="lb-wr"
                          style={{
                            color: parseInt(p.winRate, 10) >= 50 ? "var(--green)" : "var(--red)",
                          }}
                        >
                          {p.winRate}%
                        </div>
                        <div>
                          <Sparkline data={p.history} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {tab === "profile" && selectedPlayer && (() => {
          const p = players.find((pl) => pl.id === selectedPlayer.id);
          if (!p) {
            return (
              <div style={{ color: "var(--text-muted)", padding: 40, textAlign: "center" }}>
                Player not found
              </div>
            );
          }

          const [, rankName, rankColor] = p.rank;
          const delta = p.mmr - MMR_START;
          const playerMatches = matches
            .filter((m) => m.teamA.some((t) => t.id === p.id) || m.teamB.some((t) => t.id === p.id))
            .reverse();

          return (
            <>
              <div className="profile">
                <div className="profile-top">
                  <div className="profile-badge">
                    <RankBadge mmr={p.mmr} size={56} />
                  </div>

                  <div className="profile-info">
                    <div className="profile-name">{p.name}</div>
                    <div className="profile-rank-label" style={{ color: rankColor }}>
                      {rankName}
                    </div>
                    <div className="profile-meta">
                      <span>K-Factor: {p.kFactor.toFixed(0)}</span>
                      <span>Peak: {Math.round(p.peakMmr)}</span>
                      <span>{p.isProvisional ? "Provisional" : "Calibrated"}</span>
                    </div>
                  </div>

                  <div className="profile-mmr-block">
                    <div className="profile-mmr-big" style={{ color: rankColor }}>
                      {Math.round(p.mmr)}
                    </div>
                    <div className="profile-mmr-label">
                      <span style={{ color: delta >= 0 ? "var(--green)" : "var(--red)" }}>
                        {delta >= 0 ? "+" : ""}
                        {Math.round(delta)} from start
                      </span>
                    </div>
                  </div>
                </div>

                <div className="profile-stats">
                  <div className="profile-stat">
                    <div className="profile-stat-val">{p.gamesPlayed}</div>
                    <div className="profile-stat-lbl">Games</div>
                  </div>
                  <div className="profile-stat">
                    <div className="profile-stat-val" style={{ color: "var(--green)" }}>
                      {p.wins}
                    </div>
                    <div className="profile-stat-lbl">Wins</div>
                  </div>
                  <div className="profile-stat">
                    <div className="profile-stat-val" style={{ color: "var(--red)" }}>
                      {p.losses}
                    </div>
                    <div className="profile-stat-lbl">Losses</div>
                  </div>
                  <div className="profile-stat">
                    <div
                      className="profile-stat-val"
                      style={{
                        color: parseInt(p.winRate, 10) >= 50 ? "var(--green)" : "var(--red)",
                      }}
                    >
                      {p.winRate}%
                    </div>
                    <div className="profile-stat-lbl">Win Rate</div>
                  </div>
                  <div className="profile-stat">
                    <div className="profile-stat-val">{Math.round(p.peakMmr)}</div>
                    <div className="profile-stat-lbl">Peak MMR</div>
                  </div>
                  <div className="profile-stat">
                    <div
                      className="profile-stat-val"
                      style={{
                        color:
                          p.streak > 0
                            ? "var(--green)"
                            : p.streak < 0
                            ? "var(--red)"
                            : "var(--text-muted)",
                      }}
                    >
                      {p.streak > 0 ? `W${p.streak}` : p.streak < 0 ? `L${Math.abs(p.streak)}` : "—"}
                    </div>
                    <div className="profile-stat-lbl">Streak</div>
                  </div>
                </div>

                <div className="profile-chart">
                  <div className="profile-chart-title">
                    MMR History <span style={{ opacity: 0.5 }}>(dashed = true skill target)</span>
                  </div>
                  <MmrChart history={p.history} trueMmr={p.trueMmr} />
                </div>
              </div>

              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
                Match History ({playerMatches.length} games)
              </div>

              {playerMatches.slice(0, 30).map((m) => {
                const inA = m.teamA.some((t) => t.id === p.id);
                const won = (m.winner === 0 && inA) || (m.winner === 1 && !inA);

                return (
                  <div key={m.id} className="match-card">
                    <div className="match-header">
                      <div className="match-id">#{m.id}</div>
                      <div className="match-score">{m.score}</div>
                      <span className={`match-margin ${m.margin}`}>{m.margin.toUpperCase()}</span>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                          fontWeight: 600,
                          color: won ? "var(--green)" : "var(--red)",
                        }}
                      >
                        {won ? "WIN" : "LOSS"}
                      </div>
                    </div>

                    <div className="match-teams">
                      <div className={`match-team ${m.winner === 0 ? "winner" : "loser"}`}>
                        <div className={`match-team-label ${m.winner === 0 ? "w" : "l"}`}>
                          {m.winner === 0 ? "WINNERS" : "LOSERS"}
                        </div>
                        {m.teamA.map((t) => (
                          <div key={t.id} className="match-player">
                            <span style={{ fontWeight: t.id === p.id ? 700 : 400 }}>{t.name}</span>
                            <span className={`match-delta ${t.change >= 0 ? "pos" : "neg"}`}>
                              {t.change >= 0 ? "+" : ""}
                              {t.change}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className={`match-team ${m.winner === 1 ? "winner" : "loser"}`}>
                        <div className={`match-team-label ${m.winner === 1 ? "w" : "l"}`}>
                          {m.winner === 1 ? "WINNERS" : "LOSERS"}
                        </div>
                        {m.teamB.map((t) => (
                          <div key={t.id} className="match-player">
                            <span style={{ fontWeight: t.id === p.id ? 700 : 400 }}>{t.name}</span>
                            <span className={`match-delta ${t.change >= 0 ? "pos" : "neg"}`}>
                              {t.change >= 0 ? "+" : ""}
                              {t.change}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button
                  onClick={() => setTab("leaderboard")}
                  style={{
                    fontFamily: "'Chakra Petch', sans-serif",
                    padding: "10px 24px",
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  ← Back to Leaderboard
                </button>
              </div>
            </>
          );
        })()}

        {tab === "profile" && !selectedPlayer && (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>
            <div style={{ fontSize: 18, marginBottom: 8 }}>No player selected</div>
            <div style={{ fontSize: 14 }}>Click on a player in the leaderboard to view their profile</div>
            <button
              onClick={() => setTab("leaderboard")}
              style={{
                marginTop: 20,
                fontFamily: "'Chakra Petch', sans-serif",
                padding: "10px 24px",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Go to Leaderboard
            </button>
          </div>
        )}

        {tab === "matches" && (
          <>
            <div style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 16 }}>
              Showing {Math.min(50, matches.length)} of {matches.length} matches (most recent first)
            </div>

            {[...matches].reverse().slice(0, 50).map((m) => (
              <div key={m.id} className="match-card">
                <div className="match-header">
                  <div className="match-id">Match #{m.id}</div>
                  <div className="match-score">{m.score}</div>
                  <span className={`match-margin ${m.margin}`}>{m.margin.toUpperCase()}</span>
                </div>

                <div className="match-teams">
                  <div className={`match-team ${m.winner === 0 ? "winner" : "loser"}`}>
                    <div className={`match-team-label ${m.winner === 0 ? "w" : "l"}`}>
                      {m.winner === 0 ? "WINNERS" : "LOSERS"}
                    </div>
                    {m.teamA.map((t) => (
                      <div key={t.id} className="match-player">
                        <span>{t.name}</span>
                        <span className={`match-delta ${t.change >= 0 ? "pos" : "neg"}`}>
                          {t.change >= 0 ? "+" : ""}
                          {t.change}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className={`match-team ${m.winner === 1 ? "winner" : "loser"}`}>
                    <div className={`match-team-label ${m.winner === 1 ? "w" : "l"}`}>
                      {m.winner === 1 ? "WINNERS" : "LOSERS"}
                    </div>
                    {m.teamB.map((t) => (
                      <div key={t.id} className="match-player">
                        <span>{t.name}</span>
                        <span className={`match-delta ${t.change >= 0 ? "pos" : "neg"}`}>
                          {t.change >= 0 ? "+" : ""}
                          {t.change}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === "diagnostics" && (() => {
          const diag = computeDiagnostics(players);
          const grade = (val, thresholds) => {
            if (val >= thresholds[0]) return { label: "Excellent", color: "var(--green)" };
            if (val >= thresholds[1]) return { label: "Good", color: "var(--accent)" };
            if (val >= thresholds[2]) return { label: "Fair", color: "var(--text-secondary)" };
            return { label: "Poor", color: "var(--red)" };
          };

          const r2Grade = grade(diag.r2, [0.9, 0.75, 0.5]);
          const spearmanGrade = grade(diag.spearman, [0.9, 0.75, 0.5]);
          const maeGrade = grade(1 - diag.mae / 500, [0.7, 0.5, 0.3]);
          const convGrade = grade(parseInt(diag.convergePct, 10) / 100, [0.7, 0.5, 0.3]);

          return (
            <>
              <div className="how-section">
                <div className="how-title">System Quality Metrics</div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 12,
                  marginBottom: 24,
                }}>
                  {[
                    { label: "R² (Variance Explained)", value: diag.r2.toFixed(4), g: r2Grade, desc: "How much of MMR variance is explained by true skill. Target: > 0.85" },
                    { label: "Spearman Rank Corr.", value: diag.spearman.toFixed(4), g: spearmanGrade, desc: "Are players ranked in the right order? Target: > 0.90" },
                    { label: "Mean Abs. Error", value: `${Math.round(diag.mae)} MMR`, g: maeGrade, desc: "Average gap between final MMR and true MMR target. Lower is better." },
                    { label: "Convergence (±200)", value: `${diag.convergePct}% (${diag.converged}/${diag.n})`, g: convGrade, desc: "Players within 200 MMR of their true target." },
                  ].map((m) => (
                    <div key={m.label} style={{
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "20px 20px 16px",
                    }}>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        letterSpacing: 1.5,
                        textTransform: "uppercase",
                        color: "var(--text-muted)",
                        marginBottom: 8,
                      }}>{m.label}</div>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 24,
                        fontWeight: 700,
                        color: m.g.color,
                        marginBottom: 4,
                      }}>{m.value}</div>
                      <div style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: m.g.color,
                        marginBottom: 8,
                      }}>{m.g.label}</div>
                      <div style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        lineHeight: 1.5,
                      }}>{m.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="how-section">
                <div className="how-title">Regression Details</div>
                <div className="how-card">
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 16,
                  }}>
                    <div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Slope</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>{diag.slope.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Expected ≈ 60 (MMR per skill point)</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Intercept</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>{diag.intercept.toFixed(0)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Expected ≈ -400 (with slope ~60)</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Formula</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 500, color: "var(--accent)" }}>
                        MMR = {diag.slope.toFixed(1)} × skill + {diag.intercept.toFixed(0)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="how-section">
                <div className="how-title">
                  True Skill vs Final MMR
                  <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-muted)", marginLeft: 12 }}>
                    <span style={{ color: "var(--accent)" }}>—</span> regression &nbsp;
                    <span style={{ color: "rgba(34,197,94,0.5)" }}>- -</span> perfect &nbsp;
                    <span style={{ color: "#22c55e" }}>●</span> &lt;100 err &nbsp;
                    <span style={{ color: "#f59e0b" }}>●</span> &lt;200 err &nbsp;
                    <span style={{ color: "#ef4444" }}>●</span> &gt;200 err
                  </span>
                </div>
                <ScatterPlot players={players} diagnostics={diag} />
              </div>

              <div className="how-section">
                <div className="how-title">Biggest Outliers</div>
                <div style={{ display: "grid", gap: 8 }}>
                  {diag.outliers.map((o) => (
                    <div key={o.name} style={{
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "12px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      flexWrap: "wrap",
                    }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{o.name}</span>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginLeft: 12,
                        }}>
                          Target: {Math.round(o.trueMmr)} → Actual: {Math.round(o.mmr)}
                        </span>
                      </div>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 14,
                        fontWeight: 600,
                        color: o.diff > 0 ? "var(--green)" : "var(--red)",
                      }}>
                        {o.diff > 0 ? "+" : ""}{Math.round(o.diff)} MMR off
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="how-section">
                <div className="how-title">What These Numbers Mean</div>
                <div className="how-card">
                  <h4>R² (Coefficient of Determination)</h4>
                  <p>
                    Measures how much of the variation in final MMR is explained by true skill.
                    A value of 1.0 means perfect prediction. Below 0.75 means the system is not
                    reliably separating players by skill.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Spearman Rank Correlation</h4>
                  <p>
                    Checks if the ordering is correct regardless of exact numbers. Even if MMR
                    values are compressed, a high Spearman means the best players are still
                    ranked above the worst. Target: above 0.90.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Mean Absolute Error</h4>
                  <p>
                    Average difference between each player's final MMR and their true skill
                    target in MMR units. Lower is better. Under 100 is strong; over 200 means
                    significant misranking.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Convergence</h4>
                  <p>
                    Percentage of players whose final MMR is within 200 points of their true
                    target. Higher means the system is placing more players correctly. Over 70%
                    is a good sign after 100 games per player.
                  </p>
                </div>
              </div>
            </>
          );
        })()}

        {tab === "compare" && (() => {
          const diagV4 = computeDiagnostics(players);
          const diagG2 = computeG2Diagnostics(g2sim.players);

          const grade = (val, thresholds) => {
            if (val >= thresholds[0]) return { label: "Excellent", color: "var(--green)" };
            if (val >= thresholds[1]) return { label: "Good", color: "var(--accent)" };
            if (val >= thresholds[2]) return { label: "Fair", color: "var(--text-secondary)" };
            return { label: "Poor", color: "var(--red)" };
          };

          const metrics = [
            { label: "R²", v4: diagV4.r2.toFixed(4), g2: diagG2.r2.toFixed(4), v4g: grade(diagV4.r2, [0.9, 0.75, 0.5]), g2g: grade(diagG2.r2, [0.9, 0.75, 0.5]), better: diagG2.r2 > diagV4.r2 ? "g2" : diagV4.r2 > diagG2.r2 ? "v4" : "tie" },
            { label: "Spearman", v4: diagV4.spearman.toFixed(4), g2: diagG2.spearman.toFixed(4), v4g: grade(diagV4.spearman, [0.9, 0.75, 0.5]), g2g: grade(diagG2.spearman, [0.9, 0.75, 0.5]), better: diagG2.spearman > diagV4.spearman ? "g2" : diagV4.spearman > diagG2.spearman ? "v4" : "tie" },
            { label: "MAE", v4: `${Math.round(diagV4.mae)}`, g2: `${Math.round(diagG2.mae)}`, v4g: grade(1 - diagV4.mae / 500, [0.7, 0.5, 0.3]), g2g: grade(1 - diagG2.mae / 500, [0.7, 0.5, 0.3]), better: diagG2.mae < diagV4.mae ? "g2" : diagV4.mae < diagG2.mae ? "v4" : "tie" },
            { label: "Convergence", v4: `${diagV4.convergePct}%`, g2: `${diagG2.convergePct}%`, v4g: grade(parseInt(diagV4.convergePct) / 100, [0.7, 0.5, 0.3]), g2g: grade(parseInt(diagG2.convergePct) / 100, [0.7, 0.5, 0.3]), better: parseInt(diagG2.convergePct) > parseInt(diagV4.convergePct) ? "g2" : parseInt(diagV4.convergePct) > parseInt(diagG2.convergePct) ? "v4" : "tie" },
            { label: "Slope", v4: diagV4.slope.toFixed(1), g2: diagG2.slope.toFixed(1), v4g: grade(1 - Math.abs(diagV4.slope - 60) / 60, [0.7, 0.5, 0.3]), g2g: grade(1 - Math.abs(diagG2.slope - 60) / 60, [0.7, 0.5, 0.3]), better: Math.abs(diagG2.slope - 60) < Math.abs(diagV4.slope - 60) ? "g2" : "v4" },
          ];

          const v4Wins = metrics.filter((m) => m.better === "v4").length;
          const g2Wins = metrics.filter((m) => m.better === "g2").length;

          const g2sorted = [...g2sim.players].sort((a, b) => b.mu - a.mu);

          return (
            <>
              <div className="how-section">
                <div className="how-title">
                  V4 Elo vs Bayesian (μ/σ) — Head to Head
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 12 }}>
                    Seed: {seed}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
                  <div style={{
                    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, textAlign: "center",
                    borderColor: v4Wins > g2Wins ? "var(--accent)" : "var(--border)",
                  }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: 1.5, color: "var(--text-muted)", marginBottom: 8 }}>V4 ELO SYSTEM</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: v4Wins > g2Wins ? "var(--accent)" : "var(--text-secondary)" }}>{v4Wins} wins</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{totalMatches} matches · K: {K_CALIBRATION}/{BASE_K}/{K_VETERAN}</div>
                  </div>
                  <div style={{
                    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, textAlign: "center",
                    borderColor: g2Wins > v4Wins ? "var(--blue)" : "var(--border)",
                  }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: 1.5, color: "var(--text-muted)", marginBottom: 8 }}>BAYESIAN μ/σ SYSTEM</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: g2Wins > v4Wins ? "var(--blue)" : "var(--text-secondary)" }}>{g2Wins} wins</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{g2sim.totalMatches} matches · Avg σ: {diagG2.avgSigma}</div>
                  </div>
                </div>

                <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{
                    display: "grid", gridTemplateColumns: "120px 1fr 40px 1fr", gap: 0,
                    padding: "10px 16px", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: 1.5, color: "var(--text-muted)",
                    borderBottom: "1px solid var(--border)",
                  }}>
                    <div>METRIC</div>
                    <div style={{ textAlign: "center" }}>V4 ELO</div>
                    <div />
                    <div style={{ textAlign: "center" }}>BAYESIAN</div>
                  </div>
                  {metrics.map((m) => (
                    <div key={m.label} style={{
                      display: "grid", gridTemplateColumns: "120px 1fr 40px 1fr", gap: 0,
                      padding: "12px 16px", borderBottom: "1px solid rgba(42,46,56,0.5)", alignItems: "center",
                    }}>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{m.label}</div>
                      <div style={{ textAlign: "center" }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 600, color: m.v4g.color }}>{m.v4}</span>
                        <span style={{ fontSize: 10, color: m.v4g.color, marginLeft: 6 }}>{m.v4g.label}</span>
                      </div>
                      <div style={{ textAlign: "center", fontSize: 14, fontWeight: 700, color: m.better === "v4" ? "var(--accent)" : m.better === "g2" ? "var(--blue)" : "var(--text-muted)" }}>
                        {m.better === "v4" ? "◀" : m.better === "g2" ? "▶" : "="}
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 600, color: m.g2g.color }}>{m.g2}</span>
                        <span style={{ fontSize: 10, color: m.g2g.color, marginLeft: 6 }}>{m.g2g.label}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="how-section">
                <div className="how-title">Scatter Plots — Side by Side</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: 1.5, color: "var(--accent)", marginBottom: 8, textAlign: "center" }}>V4 ELO</div>
                    <ScatterPlot players={players} diagnostics={diagV4} />
                  </div>
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: 1.5, color: "var(--blue)", marginBottom: 8, textAlign: "center" }}>BAYESIAN μ/σ</div>
                    <ScatterPlot players={g2sim.players} diagnostics={diagG2} />
                  </div>
                </div>
              </div>

              <div className="how-section">
                <div className="how-title">Bayesian Leaderboard (μ − {G2_DISPLAY_K}σ display rating)</div>
                <div className="lb-wrap">
                  <div className="lb-table">
                    <div className="lb-header" style={{ gridTemplateColumns: "44px 1fr 90px 90px 80px 70px 60px 120px" }}>
                      <div>#</div>
                      <div>Player</div>
                      <div>μ (Skill)</div>
                      <div>Display</div>
                      <div>σ (Uncert.)</div>
                      <div>Record</div>
                      <div>WR%</div>
                      <div>Trend</div>
                    </div>
                    {g2sorted.map((p, i) => {
                      const [, , rankColor] = getRank(p.mu);
                      return (
                        <div key={p.id} className="lb-row" style={{ gridTemplateColumns: "44px 1fr 90px 90px 80px 70px 60px 120px", cursor: "default" }}>
                          <div className={`lb-rank ${i < 3 ? "top-3" : ""}`}>{i + 1}</div>
                          <div className="lb-player">
                            <RankBadge mmr={p.mu} size={26} />
                            <div>
                              <div className="lb-name">{p.name}</div>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)" }}>
                                True: {Math.round(p.trueMmr)}
                              </span>
                            </div>
                          </div>
                          <div className="lb-mmr" style={{ color: rankColor }}>{Math.round(p.mu)}</div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: "var(--blue)" }}>{Math.round(p.displayRating)}</div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: p.sigma > 200 ? "var(--red)" : p.sigma > 100 ? "var(--accent)" : "var(--green)" }}>
                            ±{Math.round(p.sigma)}
                          </div>
                          <div className="lb-record">{p.wins}-{p.losses}</div>
                          <div className="lb-wr" style={{ color: parseInt(p.winRate, 10) >= 50 ? "var(--green)" : "var(--red)" }}>{p.winRate}%</div>
                          <div><Sparkline data={p.history} /></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="how-section">
                <div className="how-title">How the Bayesian System Differs</div>
                <div className="how-card">
                  <h4>μ (mu) and σ (sigma) instead of single MMR</h4>
                  <p>
                    Each player has two numbers: μ is the skill estimate and σ is how uncertain
                    the system is. New players start with high σ ({G2_SIGMA_START}) so their rating
                    moves fast. As they play, σ shrinks (floor: {G2_SIGMA_FLOOR}) and results matter less.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Display Rating: μ − {G2_DISPLAY_K}σ</h4>
                  <p>
                    The visible rating is conservative — it subtracts uncertainty. A player
                    who has played 3 games at μ=1200 with σ=300 shows as {Math.round(1200 - G2_DISPLAY_K * 300)}.
                    A player at μ=1200 with σ=80 after 200 games shows as {Math.round(1200 - G2_DISPLAY_K * 80)}.
                    You earn your visible rank through consistent play.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Individual Skill Decoupling</h4>
                  <p>
                    Updates weight individual skill at {(G2_INDIVIDUAL_WEIGHT * 100).toFixed(0)}%
                    and teammate contribution at {((1 - G2_INDIVIDUAL_WEIGHT) * 100).toFixed(0)}%.
                    Your rating is less hostage to your partner compared to the V4 system.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Margin as Evidence, Not Multiplier</h4>
                  <p>
                    Match margins affect both the skill shift and the confidence gain. A stomp
                    provides strong evidence ({G2_MARGIN_EVIDENCE.stomp}) — it moves μ more AND reduces σ
                    faster. A close game ({G2_MARGIN_EVIDENCE.close}) is weak evidence that barely
                    changes confidence.
                  </p>
                </div>
                <div className="how-card">
                  <h4>Probe Matchmaking</h4>
                  <p>
                    Players with high uncertainty (σ &gt; 200) are occasionally matched against more
                    diverse opponents specifically to gather diagnostic signal about where they really belong.
                  </p>
                </div>
              </div>
            </>
          );
        })()}

        {tab === "how it works" && (
          <>
            <div className="how-section">
              <div className="how-title">Start Here</div>
              <div className="how-card">
                <h4>What this page is showing</h4>
                <p>
                  This page is a simulation of a padel rating system. It creates players,
                  gives each player a hidden skill level, simulates many matches, and then
                  updates each player's MMR after every result.
                </p>
                <p style={{ marginTop: 12 }}>
                  The goal of the system is simple: players who consistently perform better
                  over time should move higher, and players who perform worse over time
                  should move lower. The more matches that are played, the more stable and
                  fair the ratings become.
                </p>
              </div>
              <div className="how-card">
                <h4>What “simulation” means here</h4>
                <p>
                  Nothing on this page is typed in by hand. The leaderboard, match history,
                  win rates, streaks, and charts are generated by code.
                </p>
                <p style={{ marginTop: 12 }}>
                  Each time the simulation runs, it:
                </p>
                <p style={{ marginTop: 12 }}>
                  1. Creates a pool of players.<br />
                  2. Gives each player a hidden skill value.<br />
                  3. Pairs players into teams and matches.<br />
                  4. Simulates match results.<br />
                  5. Updates MMR after every match.<br />
                  6. Repeats until the target number of games is reached.
                </p>
              </div>
              <div className="how-card">
                <h4>Why use MMR</h4>
                <p>
                  MMR stands for Matchmaking Rating. It is a number that estimates how strong
                  a player is based on actual results over time.
                </p>
                <p style={{ marginTop: 12 }}>
                  Systems like this are commonly used in competitive games, including Dota,
                  because they adjust ratings continuously instead of placing players into a
                  fixed level forever. This makes the system more flexible and usually fairer,
                  especially once enough matches have been played.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">Key Terms</div>
              <div className="how-card">
                <h4>MMR</h4>
                <p>
                  MMR is the visible rating number shown beside each player. A higher MMR
                  means the system currently believes that player is stronger.
                </p>
                <p style={{ marginTop: 12 }}>
                  In this simulation, every player starts at <code>{MMR_START}</code>. After
                  that, their MMR goes up when they win and goes down when they lose.
                </p>
              </div>

              <div className="how-card">
                <h4>True Skill</h4>
                <p>
                  True Skill is the hidden skill level used internally by the simulation.
                  It is not the same as MMR.
                </p>
                <p style={{ marginTop: 12 }}>
                  True Skill is the player's actual underlying ability in the simulated world.
                  MMR is the system's estimate of that ability based only on match results.
                </p>
                <p style={{ marginTop: 12 }}>
                  A good rating system should make MMR move closer and closer to a player's
                  True Skill as more games are played.
                </p>
              </div>

              <div className="how-card">
                <h4>Calibration / Provisional Status</h4>
                <p>
                  New players do not have enough match data yet, so the system is less
                  certain about their rating.
                </p>
                <p style={{ marginTop: 12 }}>
                  During the first <code>{CALIBRATION_GAMES}</code> games, players are
                  treated as provisional. That means their MMR can move more quickly so the
                  system can find the correct level faster.
                </p>
              </div>

              <div className="how-card">
                <h4>K-Factor</h4>
                <p>
                  K-Factor controls how much a player's MMR is allowed to change after a match.
                </p>
                <p style={{ marginTop: 12 }}>
                  A high K-Factor means the rating moves more. A low K-Factor means the
                  rating moves less.
                </p>
                <p style={{ marginTop: 12 }}>
                  In simple terms:
                </p>
                <p style={{ marginTop: 12 }}>
                  • High K = faster adjustment<br />
                  • Low K = more stable rating
                </p>
                <p style={{ marginTop: 12 }}>
                  This system starts players with a high K-Factor and reduces it over time.
                  That way, new players can find their level quickly, while experienced
                  players get more stable ratings.
                </p>

                <div className="k-bar-container">
                  {[
                    { label: "Start", k: K_CALIBRATION, color: "var(--accent)" },
                    { label: `Game ${CALIBRATION_GAMES}`, k: BASE_K, color: "var(--green)" },
                    { label: `Game ${K_VETERAN_THRESHOLD}+`, k: K_VETERAN, color: "var(--blue)" },
                  ].map((item) => (
                    <div key={item.label} className="k-bar-row">
                      <div className="k-bar-label">{item.label}</div>
                      <div
                        className="k-bar"
                        style={{
                          width: `${(item.k / K_CALIBRATION) * 220}px`,
                          background: item.color,
                        }}
                      />
                      <div className="k-bar-value">{item.k.toFixed(0)}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="how-card">
                <h4>Expected Result</h4>
                <p>
                  Before each match, the system compares the average MMR of both teams and
                  calculates which team is expected to win.
                </p>
                <p style={{ marginTop: 12 }}>
                  If a stronger team wins, the result is considered expected, so the rating
                  change is smaller.
                </p>
                <p style={{ marginTop: 12 }}>
                  If a weaker team wins, the result is considered an upset, so the rating
                  change is larger.
                </p>
              </div>

              <div className="how-card">
                <h4>Upset Bonus</h4>
                <p>
                  The upset bonus increases rating gains when a lower-rated team beats a
                  higher-rated team.
                </p>
                <p style={{ marginTop: 12 }}>
                  This matters because not all wins mean the same thing. Beating a team that
                  was already expected to lose is less informative than beating a team that
                  was expected to win.
                </p>
              </div>

              <div className="how-card">
                <h4>Score Margin</h4>
                <p>
                  Score margin means how convincing the win was.
                </p>
                <p style={{ marginTop: 12 }}>
                  In this model, a very one-sided result changes MMR more than a very close
                  result. The idea is that a dominant win provides a stronger signal than a
                  narrow win.
                </p>
                <p style={{ marginTop: 12 }}>
                  The current multipliers are:
                </p>
                <p style={{ marginTop: 12 }}>
                  • Stomp = <code>{MARGIN_MULTIPLIERS.stomp}x</code><br />
                  • Clear win = <code>{MARGIN_MULTIPLIERS.clear}x</code><br />
                  • Normal win = <code>{MARGIN_MULTIPLIERS.normal}x</code><br />
                  • Close win = <code>{MARGIN_MULTIPLIERS.close}x</code>
                </p>
              </div>

              <div className="how-card">
                <h4>Teammate Adjustment</h4>
                <p>
                  This system also looks at the MMR difference between teammates.
                </p>
                <p style={{ marginTop: 12 }}>
                  If a player wins while paired with a weaker teammate, that player may gain
                  slightly more rating. If a player wins while paired with a stronger
                  teammate, that player may gain slightly less.
                </p>
                <p style={{ marginTop: 12 }}>
                  This is meant to reflect how difficult the win was relative to the help a
                  player had on their own team.
                </p>
              </div>

              <div className="how-card">
                <h4>Streak</h4>
                <p>
                  A streak is a record of consecutive wins or consecutive losses.
                </p>
                <p style={{ marginTop: 12 }}>
                  In this simulation, winning streaks can add a small bonus to gains, while
                  long losing streaks can slightly reduce losses. This softens extreme rating
                  swings and helps the system react to recent form without letting it dominate
                  the whole rating model.
                </p>
              </div>

              <div className="how-card">
                <h4>Veteran Threshold</h4>
                <p>
                  After <code>{K_VETERAN_THRESHOLD}</code> games, the player is treated as
                  more established.
                </p>
                <p style={{ marginTop: 12 }}>
                  At that point, the K-Factor becomes smaller and the player's MMR becomes
                  harder to move. That does not mean the rating is locked. It only means the
                  system is more confident in that rating.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">What the Variables Mean</div>
              <div className="how-card">
                <h4>Main values used in this build</h4>
                <p>
                  <code>NUM_PLAYERS = {NUM_PLAYERS}</code><br />
                  Total number of simulated players.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>GAMES_PER_PLAYER_TARGET = {GAMES_PER_PLAYER_TARGET}</code><br />
                  Target average number of games per player before the simulation stops.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>MMR_START = {MMR_START}</code><br />
                  Starting rating for every player.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>K_CALIBRATION = {K_CALIBRATION}</code><br />
                  High early K-Factor used while the system is still learning where a new
                  player belongs.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>BASE_K = {BASE_K}</code><br />
                  Standard mid-stage K-Factor.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>K_VETERAN = {K_VETERAN}</code><br />
                  Lower K-Factor used once a player has a large enough match history.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>K_VETERAN_THRESHOLD = {K_VETERAN_THRESHOLD}</code><br />
                  Number of games after which a player is treated as a veteran.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>UPSET_BONUS_SCALE = {UPSET_BONUS_SCALE}</code><br />
                  Controls how much extra reward is given for beating stronger opposition.
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>TEAMMATE_DIFF_FACTOR = {TEAMMATE_DIFF_FACTOR}</code><br />
                  Controls how much teammate strength affects the final rating change.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">How to Read Each Part of the Page</div>
              <div className="how-card">
                <h4>Leaderboard</h4>
                <p>
                  The leaderboard shows the current rating order from highest MMR to lowest
                  MMR.
                </p>
                <p style={{ marginTop: 12 }}>
                  It includes:
                </p>
                <p style={{ marginTop: 12 }}>
                  • MMR = current rating<br />
                  • Rank = label/tier based on MMR<br />
                  • Record = wins and losses<br />
                  • WR% = win rate percentage<br />
                  • Streak = current consecutive wins or losses<br />
                  • Trend = mini-chart of recent MMR movement
                </p>
              </div>

              <div className="how-card">
                <h4>Player Profile</h4>
                <p>
                  Clicking a player opens a more detailed profile.
                </p>
                <p style={{ marginTop: 12 }}>
                  That view shows:
                </p>
                <p style={{ marginTop: 12 }}>
                  • Current MMR<br />
                  • Peak MMR<br />
                  • Number of games played<br />
                  • Win/loss record<br />
                  • Current K-Factor<br />
                  • MMR history chart<br />
                  • Recent match-by-match changes
                </p>
              </div>

              <div className="how-card">
                <h4>MMR History Chart</h4>
                <p>
                  The chart in the profile shows how a player's MMR changed over time.
                </p>
                <p style={{ marginTop: 12 }}>
                  The dashed line represents the hidden True Skill target in the simulation.
                  If the rating system is working well, the player's visible MMR should move
                  closer to that dashed line as more games are played.
                </p>
              </div>

              <div className="how-card">
                <h4>Match History</h4>
                <p>
                  This shows individual match results and the exact MMR gained or lost by each
                  player in that match.
                </p>
                <p style={{ marginTop: 12 }}>
                  This is useful because it makes the rating changes transparent instead of
                  showing only the final leaderboard.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">Important Limitations</div>
              <div className="how-card">
                <h4>What this does not mean</h4>
                <p>
                  This is still a simulation, so it is not claiming to measure real-life padel
                  skill perfectly.
                </p>
                <p style={{ marginTop: 12 }}>
                  It is a model that tries to estimate skill from repeated match outcomes.
                  That means the rating improves as more information is collected, but it is
                  never based on one match alone.
                </p>
                <p style={{ marginTop: 12 }}>
                  In practical terms, ratings become more trustworthy when:
                </p>
                <p style={{ marginTop: 12 }}>
                  • players have many matches<br />
                  • opponents vary enough<br />
                  • match results are not based on too little data
                </p>
              </div>

              <div className="how-card">
                <h4>Why more games make it fairer</h4>
                <p>
                  With only a few games, luck can have a large effect. A player might face
                  unusually strong teams, unusually weak teams, or simply have a small sample
                  of results.
                </p>
                <p style={{ marginTop: 12 }}>
                  With many games, those random effects matter less. The system gets a clearer
                  picture of performance over time, and the rating becomes more stable and
                  more believable.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">About This Simulation</div>
              <div className="how-card">
                <p>
                  This version uses <code>{NUM_PLAYERS}</code> players and aims for about{" "}
                  <code>{GAMES_PER_PLAYER_TARGET}</code> games per player on average.
                </p>
                <p style={{ marginTop: 12 }}>
                  Every player starts at <code>{MMR_START}</code>, but they do not all have
                  the same hidden True Skill. The system has to discover that through results.
                </p>
                <p style={{ marginTop: 12 }}>
                  Changing the seed creates a different simulated player pool and different
                  match outcomes, while keeping the same rating rules.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}