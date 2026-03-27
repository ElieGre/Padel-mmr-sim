import { useState, useEffect, useRef, useMemo } from "react";

// ─── MMR Engine (V4 Core Logic) ───────────────────────────────────────
const NUM_PLAYERS = 44;
const GAMES_PER_PLAYER_TARGET = 1000;
const CALIBRATION_GAMES = 10;
const MMR_START = 1000;
const K_MAX = 200;
const K_MIN = 20;
const K_DECAY_RATE = 40;
const UPSET_BONUS_SCALE = 0.6;
const MAX_GAIN_MULTIPLIER = 2.0;
const MIN_GAIN_MULTIPLIER = 0.4;
const MARGIN_MULTIPLIERS = { stomp: 1.25, clear: 1.1, normal: 1.0, close: 0.85 };
const TEAMMATE_DIFF_FACTOR = 0.15;
const TRUE_SKILL_MIN = 10.0;
const TRUE_SKILL_MAX = 40.0;

const RANK_TIERS = [
  [0,    "F",  "#CD5C5C", "F"],
  [350,  "D",  "#CD853F", "D"],
  [700,  "C",  "#4169E1", "C"],
  [1100, "B",  "#32CD32", "B"],
  [1500, "A",  "#FFD700", "A"],
  [1900, "A+", "#FF4500", "A+"],
];

const NAMES = [
  "Carlos", "Maria", "Ahmed", "Fatima", "Luca", "Sofia", "Omar", "Nadia",
  "Pablo", "Elena", "Karim", "Leila", "Marco", "Ana", "Hassan", "Marta",
  "Diego", "Clara", "Sami", "Yasmin", "Jorge", "Lucia", "Rami", "Sara",
  "Mateo", "Julia", "Fadi", "Rita", "Elie", "Maya", "Leo", "Ines",
  "Alex", "Dina", "Hugo", "Layla", "Rayan", "Nour", "Tomas", "Zara",
  "Sam", "Nina", "Felix", "Petra"
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


function createPlayer(id, name, trueSkill, startMmr = 0) {
  return {
    id,
    name,
    trueSkill,
    mmr: startMmr,
    startMmr,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    peakMmr: startMmr,
    recentOpponents: [],
    history: [],
    get isProvisional() {
      return this.gamesPlayed < CALIBRATION_GAMES;
    },
    get kFactor() {
      return K_MIN + (K_MAX - K_MIN) * Math.exp(-this.gamesPlayed / K_DECAY_RATE);
    },
    get rank() {
      return getRank(this.mmr);
    },
    get trueMmr() {
      return ((this.trueSkill - TRUE_SKILL_MIN) / (TRUE_SKILL_MAX - TRUE_SKILL_MIN)) * 2000;
    },
    get winRate() {
      return this.gamesPlayed > 0 ? ((this.wins / this.gamesPlayed) * 100).toFixed(0) : "0";
    },
  };
}

function simulateMatch(teamA, teamB, rng) {
  const a = teamA.reduce((s, p) => s + p.trueSkill, 0);
  const b = teamB.reduce((s, p) => s + p.trueSkill, 0);
  const pa = 1 / (1 + Math.pow(10, (b - a) / 12));
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
  const diff = lMmr - wMmr;
  const am = Math.max(MIN_GAIN_MULTIPLIER, Math.min(MAX_GAIN_MULTIPLIER, 1.0 + (diff / 100) * UPSET_BONUS_SCALE));
  const lam = am;
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
    changes[p.id] = Math.round(gain * 10) / 10;
  }

  for (const p of lt) {
    const k = p.kFactor;
    let loss = k * (1.0 - expW) * lam * mm;
    const tm = lt.find((t) => t.id !== p.id);
    if (tm) {
      const ta = Math.max(0.8, Math.min(1.2, 1.0 + ((p.mmr - tm.mmr) / 100) * TEAMMATE_DIFF_FACTOR));
      loss *= ta;
    }
    if (p.streak < -3) loss *= 0.85;
    changes[p.id] = Math.round(-loss * 10) / 10;
  }

  return changes;
}

function createMatch(players, rng) {
  const eligible = players.filter((p) => p.gamesPlayed < GAMES_PER_PLAYER_TARGET + 3);
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
      Math.max(0.1, 1 - Math.abs(p.mmr - anchor.mmr) / 500) *
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

  // Exact pool: 3A 7B 14C 15D 5F = 44 players
  const gradeConfig = [
    { count: 3,  min: 33, max: 40 },  // A
    { count: 7,  min: 26, max: 33 },  // B
    { count: 14, min: 20, max: 26 },  // C
    { count: 15, min: 14, max: 20 },  // D
    { count: 5,  min: 10, max: 14 },  // F
  ];
  for (const g of gradeConfig) {
    for (let j = 0; j < g.count; j++) {
      let s = g.min + rng() * (g.max - g.min);
      skills.push(Math.max(TRUE_SKILL_MIN, Math.min(TRUE_SKILL_MAX, s)));
    }
  }
  // Fisher-Yates shuffle
  for (let i = skills.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [skills[i], skills[j]] = [skills[j], skills[i]];
  }

  const players = skills.map((s, i) => {
    const trueMmr = ((s - TRUE_SKILL_MIN) / (TRUE_SKILL_MAX - TRUE_SKILL_MIN)) * 2000;
    const noise = (rng() - 0.5) * 300; // +-150 MMR noise around true level
    const startMmr = Math.max(0, Math.round(trueMmr + noise));
    return createPlayer(i, NAMES[i], s, startMmr);
  });
  const matches = [];
  let gc = 0;
  let cp = 0;

  while (gc < 10000) {
    const avg = players.reduce((s, p) => s + p.gamesPlayed, 0) / players.length;
    if (avg >= GAMES_PER_PLAYER_TARGET) break;

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
    }

    for (const p of actual === 0 ? teamB : teamA) {
      p.losses++;
      p.gamesPlayed++;
      p.streak = p.streak <= 0 ? p.streak - 1 : -1;
    }

    matches.push(matchRecord);
  }

  return { players, matches, totalMatches: gc, correctPredictions: cp };
}

// ─── Rank Icon SVG ────────────────────────────────────────────────────
function RankBadge({ mmr, size = 32 }) {
  const [, name, color] = getRank(mmr);
  const tierGroup = name.split(" ")[0];

  const shapes = {
    F: (
      <g>
        <circle cx="16" cy="16" r="12" fill="none" stroke={color} strokeWidth="2" opacity="0.5" />
        <line x1="10" y1="10" x2="22" y2="22" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <line x1="22" y1="10" x2="10" y2="22" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      </g>
    ),
    D: (
      <g>
        <circle cx="16" cy="16" r="12" fill="none" stroke={color} strokeWidth="2" opacity="0.6" />
        <circle cx="16" cy="16" r="6" fill={color} opacity="0.7" />
      </g>
    ),
    C: (
      <g>
        <polygon points="16,2 28,16 16,30 4,16" fill="none" stroke={color} strokeWidth="2" opacity="0.6" />
        <polygon points="16,8 22,16 16,24 10,16" fill={color} opacity="0.85" />
      </g>
    ),
    B: (
      <g>
        <polygon points="16,2 20,12 30,12 22,18 25,28 16,22 7,28 10,18 2,12 12,12" fill={color} opacity="0.9" />
      </g>
    ),
    A: (
      <g>
        <polygon points="16,2 28,16 16,30 4,16" fill={color} opacity="0.3" />
        <polygon points="16,6 24,16 16,26 8,16" fill={color} opacity="0.7" />
        <polygon points="16,10 20,16 16,22 12,16" fill={color} />
      </g>
    ),
    "A+": (
      <g>
        <polygon points="16,0 19,10 30,10 21,17 24,28 16,21 8,28 11,17 2,10 13,10" fill={color} />
        <polygon points="16,5 18,12 24,12 19,16 21,23 16,19 11,23 13,16 8,12 14,12" fill="#fff" opacity="0.4" />
      </g>
    ),
  };

  const shape = shapes[tierGroup] || shapes.F;

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
  grid-template-columns: repeat(4, minmax(80px, 1fr));
  gap: 20px;
  max-width: 720px;
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
function MmrChart({ history, trueMmr, startMmr = 0 }) {
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
    const allVals = [...mmrs, trueMmr, startMmr];
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

    const startY = toY(startMmr);
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = "rgba(138,143,168,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, startY);
    ctx.lineTo(W - pad.right, startY);
    ctx.stroke();
    ctx.setLineDash([]);

    const last = mmrs[mmrs.length - 1];
    const lineColor = last >= startMmr ? "#22c55e" : "#ef4444";
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
    gradient.addColorStop(0, last >= startMmr ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)");
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

  const sim = useMemo(() => runSimulation(seed), [seed]);
  const { players, matches, totalMatches, correctPredictions } = sim;
  const sorted = useMemo(() => [...players].sort((a, b) => b.mmr - a.mmr), [players]);

  const predAcc = totalMatches > 0 ? ((correctPredictions / totalMatches) * 100).toFixed(1) : "0";
  const mmrSpread = Math.round(Math.max(...players.map((p) => p.mmr)) - Math.min(...players.map((p) => p.mmr)));

  const GRADE_BANDS = [
    { label: "A+", min: 1900, color: "#FF4500" },
    { label: "A",  min: 1500, color: "#FFD700" },
    { label: "B",  min: 1100, color: "#32CD32" },
    { label: "C",  min: 700,  color: "#4169E1" },
    { label: "D",  min: 350,  color: "#CD853F" },
    { label: "F",  min: 0,    color: "#CD5C5C" },
  ];
  const gradeCounts = useMemo(() => {
    const counts = {};
    for (const g of GRADE_BANDS) counts[g.label] = 0;
    for (const p of players) {
      const g = [...GRADE_BANDS].find(g => p.mmr >= g.min) || GRADE_BANDS[GRADE_BANDS.length - 1];
      counts[g.label]++;
    }
    return counts;
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
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
          {GRADE_BANDS.map((g) => (
            <div key={g.label} style={{ textAlign: "center", minWidth: 48 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: g.color }}>{gradeCounts[g.label]}</div>
              <div style={{ fontSize: 11, color: g.color, opacity: 0.7, letterSpacing: 1 }}>{g.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="tabs">
        {[
  "how it works",
  "leaderboard",
  "matches",
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
          const delta = p.mmr - p.startMmr;
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
                  <MmrChart history={p.history} trueMmr={p.trueMmr} startMmr={p.startMmr} />
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

        {tab === "how it works" && (
          <>
            <div className="how-section">
              <div className="how-title">Start Here</div>
              <div className="how-card">
                <h4>What this page is showing</h4>
                <p>
                  This page is a simulation of a padel rating system. It creates {NUM_PLAYERS} players,
                  assigns each a hidden skill level, simulates matches, and updates each
                  player's MMR after every result.
                </p>
                <p style={{ marginTop: 12 }}>
                  The goal is simple: players who consistently perform better should rise,
                  and players who perform worse should drop. The more matches played, the
                  more accurate and stable the ratings become.
                </p>
              </div>
              <div className="how-card">
                <h4>What "simulation" means here</h4>
                <p>
                  Nothing on this page is typed in by hand. The leaderboard, match history,
                  win rates, streaks, and charts are all generated by code. Each run:
                </p>
                <p style={{ marginTop: 12 }}>
                  1. Creates a pool of {NUM_PLAYERS} players with realistic skill distribution.<br />
                  2. Assigns each a hidden true skill value (A through F grade).<br />
                  3. All players start at <code>{MMR_START}</code> MMR.<br />
                  4. Players are paired into 2v2 matches by MMR proximity.<br />
                  5. Match outcomes are decided by hidden true skill.<br />
                  6. MMR updates after every match.<br />
                  7. Repeats for ~{GAMES_PER_PLAYER_TARGET} games per player.
                </p>
              </div>
              <div className="how-card">
                <h4>Why use MMR</h4>
                <p>
                  MMR (Matchmaking Rating) estimates how strong a player is based on results
                  over time. It adjusts continuously rather than locking players into a fixed
                  level. The more matches played, the more accurate the estimate becomes.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">Grade Bands</div>
              <div className="how-card">
                <h4>MMR ranges map to grades</h4>
                <p>
                  Instead of named tiers, this system uses letter grades with fixed MMR
                  thresholds that reflect real padel skill distribution:
                </p>
                <p style={{ marginTop: 12 }}>
                  • <strong style={{ color: "#FF4500" }}>A+</strong> — 1900+ MMR<br />
                  • <strong style={{ color: "#FFD700" }}>A</strong> — 1500–1900 MMR<br />
                  • <strong style={{ color: "#32CD32" }}>B</strong> — 1100–1500 MMR<br />
                  • <strong style={{ color: "#4169E1" }}>C</strong> — 700–1100 MMR<br />
                  • <strong style={{ color: "#CD853F" }}>D</strong> — 350–700 MMR<br />
                  • <strong style={{ color: "#CD5C5C" }}>F</strong> — 0–350 MMR
                </p>
                <p style={{ marginTop: 12 }}>
                  The spread should emerge naturally from the simulation — not because
                  players are placed into grades, but because better players win more and
                  accumulate more MMR over time.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">Key Mechanics</div>
              <div className="how-card">
                <h4>True Skill</h4>
                <p>
                  True Skill is the hidden ability assigned to each player at the start.
                  It never changes. It is only used to decide who wins each match —
                  the rating system itself never sees it.
                </p>
                <p style={{ marginTop: 12 }}>
                  The player pool is distributed like a real padel community:<br />
                  • A grade: ~5% of players<br />
                  • B grade: ~20%<br />
                  • C grade: ~35%<br />
                  • D grade: ~30%<br />
                  • F grade: ~10%
                </p>
                <p style={{ marginTop: 12 }}>
                  A good rating system should make MMR converge toward each player's true
                  level as more games are played.
                </p>
              </div>

              <div className="how-card">
                <h4>K-Factor — Exponential Decay</h4>
                <p>
                  K-Factor controls how much MMR can change per match. This system uses a
                  smooth exponential decay instead of hard steps:
                </p>
                <p style={{ marginTop: 12 }}>
                  <code>K = {K_MIN} + {K_MAX - K_MIN} x e^(-games / {K_DECAY_RATE})</code>
                </p>
                <p style={{ marginTop: 12 }}>
                  In practice this means:
                </p>
                <div className="k-bar-container">
                  {[
                    { label: "Game 0", k: K_MAX, color: "var(--accent)" },
                    { label: "Game 30", k: Math.round(K_MIN + (K_MAX - K_MIN) * Math.exp(-1)), color: "var(--green)" },
                    { label: "Game 100", k: Math.round(K_MIN + (K_MAX - K_MIN) * Math.exp(-100 / K_DECAY_RATE)), color: "var(--blue)" },
                  ].map((item) => (
                    <div key={item.label} className="k-bar-row">
                      <div className="k-bar-label">{item.label}</div>
                      <div
                        className="k-bar"
                        style={{
                          width: `${(item.k / K_MAX) * 220}px`,
                          background: item.color,
                        }}
                      />
                      <div className="k-bar-value">{item.k}</div>
                    </div>
                  ))}
                </div>
                <p style={{ marginTop: 12 }}>
                  New players are volatile — their MMR moves fast so the system can find
                  their level quickly. Experienced players are stable — small changes reflect
                  genuine performance shifts.
                </p>
              </div>

              <div className="how-card">
                <h4>Provisional Status</h4>
                <p>
                  Players are considered provisional for their first <code>{CALIBRATION_GAMES}</code> games.
                  During this window their K is at its highest, so the system can place them
                  quickly without locking them into an inaccurate rating early on.
                </p>
              </div>

              <div className="how-card">
                <h4>Expected Result & Upset Bonus</h4>
                <p>
                  Before each match the system calculates which team is expected to win based
                  on average MMR. If the favourite wins, the MMR change is smaller. If the
                  underdog wins, the change is larger.
                </p>
                <p style={{ marginTop: 12 }}>
                  This is the Elo principle: beating stronger opponents is worth more than
                  beating weaker ones.
                </p>
              </div>

              <div className="how-card">
                <h4>Score Margin</h4>
                <p>
                  How convincingly you win also matters. A dominant result changes MMR more
                  than a narrow one — it carries more information about the real skill gap.
                </p>
                <p style={{ marginTop: 12 }}>
                  • Stomp (8+ point diff) = <code>{MARGIN_MULTIPLIERS.stomp}x</code><br />
                  • Clear win (4+ diff) = <code>{MARGIN_MULTIPLIERS.clear}x</code><br />
                  • Normal win = <code>{MARGIN_MULTIPLIERS.normal}x</code><br />
                  • Close win (≤2 diff) = <code>{MARGIN_MULTIPLIERS.close}x</code>
                </p>
              </div>

              <div className="how-card">
                <h4>Teammate Adjustment</h4>
                <p>
                  The system also factors in the MMR gap between teammates. Winning while
                  carrying a weaker partner gives a slight bonus. Winning with a stronger
                  partner gives slightly less — the win was partly credited to them.
                </p>
              </div>

              <div className="how-card">
                <h4>Streak Bonus</h4>
                <p>
                  Winning streaks add a small MMR bonus per win. Long losing streaks slightly
                  reduce the MMR lost. This softens extreme swings and gives the system a
                  small sensitivity to recent form.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">How to Read the Page</div>
              <div className="how-card">
                <h4>Leaderboard</h4>
                <p>
                  Ranked from highest to lowest MMR. Each row shows:<br />
                  • MMR — current rating<br />
                  • Rank — letter grade based on MMR band<br />
                  • Record — wins / losses<br />
                  • WR% — win rate<br />
                  • Streak — current consecutive wins or losses<br />
                  • Trend — sparkline of recent MMR movement
                </p>
              </div>
              <div className="how-card">
                <h4>Player Profile</h4>
                <p>
                  Click any player to open their full profile: current MMR, peak MMR,
                  games played, win/loss record, current K-Factor, full MMR history chart,
                  and recent match-by-match changes.
                </p>
                <p style={{ marginTop: 12 }}>
                  The dashed line on the chart is the player's True Skill target. If the
                  system is working, the MMR line should trend toward it over time.
                </p>
              </div>
              <div className="how-card">
                <h4>Match History</h4>
                <p>
                  Every match result with exact MMR deltas for all four players. This makes
                  the rating changes fully transparent rather than just showing a final number.
                </p>
              </div>
            </div>

            <div className="how-section">
              <div className="how-title">Current Simulation Settings</div>
              <div className="how-card">
                <p>
                  <code>NUM_PLAYERS = {NUM_PLAYERS}</code> — total players in the pool<br />
                  <code>GAMES_PER_PLAYER_TARGET = {GAMES_PER_PLAYER_TARGET}</code> — avg games per player<br />
                  <code>MMR_START = {MMR_START}</code> — everyone starts here<br />
                  <code>K_MAX = {K_MAX}</code> — K at game 0<br />
                  <code>K_MIN = {K_MIN}</code> — K floor for veterans<br />
                  <code>K_DECAY_RATE = {K_DECAY_RATE}</code> — games to decay by ~63%<br />
                  <code>UPSET_BONUS_SCALE = {UPSET_BONUS_SCALE}</code> — upset reward multiplier<br />
                  <code>TEAMMATE_DIFF_FACTOR = {TEAMMATE_DIFF_FACTOR}</code> — teammate adjustment weight
                </p>
                <p style={{ marginTop: 12 }}>
                  Changing the seed generates a different player pool and match sequence
                  while keeping all the same rules.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}