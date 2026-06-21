'use strict';

// =====================================================================
// Dowdy Distortion — analog pedal lab
// Single-file vanilla JS. No frameworks.
// =====================================================================

// ----- Physical constants -----
const Vt = 0.02585;          // thermal voltage at ~300K
const Vmax = 3.0;            // voltage domain modeled by the WaveShaper curve
const CURVE_N = 2048;        // samples in baked curve

// ----- Parameter ranges -----
const RANGE = {
  driveR: { min: 1e3,   max: 470e3, scale: 'log',    unit: 'Ω', kind: 'R' },
  toneR:  { min: 1e3,   max: 100e3, scale: 'log',    unit: 'Ω', kind: 'R' },
  toneC:  { min: 1e-9,  max: 470e-9,scale: 'log',    unit: 'F', kind: 'C' },
  level:  { min: 0,     max: 2,     scale: 'linear', unit: 'x', kind: 'level' },
  customIs:{ min: 1e-12, max: 1e-5, scale: 'log',    unit: 'A', kind: 'Is' },
  customN: { min: 1.0,   max: 2.5,  scale: 'linear', unit: '',  kind: 'n' },
};

const DIODES = {
  si:  { Is: 4e-9,   n: 1.9, vf: 0.6,  short: 'Si', long: 'Silicon 1N4148' },
  ge:  { Is: 200e-9, n: 1.7, vf: 0.28, short: 'Ge', long: 'Germanium 1N34A (approx)' },
  led: { Is: 1e-12,  n: 2.0, vf: 1.9,  short: 'LED', long: 'LED red (approx)' },
};

const PRESETS = {
  ts:    { driveR: 10e3,  diode: 'si',  symmetric: true,  toneR: 10e3, toneC: 47e-9,  level: 0.9 },
  fuzz:  { driveR: 2.2e3, diode: 'ge',  symmetric: true,  toneR: 10e3, toneC: 100e-9, level: 1.0 },
  boost: { driveR: 100e3, diode: 'led', symmetric: false, toneR: 22e3, toneC: 22e-9,  level: 1.2 },
};

// =====================================================================
// State
// =====================================================================
const state = {
  preset:   'ts',
  driveR:   10e3,
  diode:    'si',
  symmetric:true,
  customIs: 4e-9,
  customN:  1.9,
  toneR:    10e3,
  toneC:    47e-9,
  level:    0.9,
  bypass:   { clip: false, tone: false, level: false },
  source:   'tone',
  mode:     'eng',     // 'eng' | 'easy'
  abSlot:   'A',
  micWarned:false,
};

const snapshots = { A: null, B: null };

// =====================================================================
// Audio graph
// =====================================================================
let ctx = null;
let nodes = null;
let sourceNode = null;
let micStream = null;
let fileBuffer = null;
let testToneSeq = null;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  return ctx;
}

function buildGraph() {
  const c = ensureCtx();
  nodes = {
    inGain:     c.createGain(),
    analyserIn: c.createAnalyser(),
    shaperGain: c.createGain(),   // pre-clipper gain (Drive coupling) + 1/Vmax
    shaper:     c.createWaveShaper(),
    filter:     c.createBiquadFilter(),
    levelGain:  c.createGain(),
    analyserOut:c.createAnalyser(),
  };
  nodes.inGain.gain.value = 1;
  nodes.shaper.oversample = '4x';
  nodes.filter.type = 'lowpass';
  nodes.filter.Q.value = 0.707;
  nodes.analyserIn.fftSize = 2048;
  nodes.analyserOut.fftSize = 2048;
  routeChain();
}

function disconnectAll() {
  if (!nodes) return;
  for (const k of Object.keys(nodes)) {
    try { nodes[k].disconnect(); } catch(_) {}
  }
}

// Reconnect the chain honoring bypass flags.
function routeChain() {
  if (!nodes) return;
  disconnectAll();
  const c = ctx;
  // Always: inGain → analyserIn → ...
  nodes.inGain.connect(nodes.analyserIn);

  let cursor = nodes.analyserIn;
  if (!state.bypass.clip) {
    cursor.connect(nodes.shaperGain);
    nodes.shaperGain.connect(nodes.shaper);
    cursor = nodes.shaper;
  }
  if (!state.bypass.tone) {
    cursor.connect(nodes.filter);
    cursor = nodes.filter;
  }
  if (!state.bypass.level) {
    cursor.connect(nodes.levelGain);
    cursor = nodes.levelGain;
  }
  cursor.connect(nodes.analyserOut);
  nodes.analyserOut.connect(c.destination);

  if (sourceNode) {
    try { sourceNode.disconnect(); } catch(_) {}
    sourceNode.connect(nodes.inGain);
  }
}

// =====================================================================
// Newton-Raphson diode clipper curve
// =====================================================================
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// Symmetric (same diode in both directions) — uses sinh form.
// Newton with step damping; initial guess Vin/2 keeps us off the saturation
// region where the tangent is so steep Newton stalls.
function solveSymmetric(Vin, R, Is, n) {
  let Vo = Vin * 0.5;
  const nVt = n * Vt;
  const maxStep = 4 * nVt;
  for (let i = 0; i < 80; i++) {
    const arg = clamp(Vo / nVt, -50, 50);
    const s = Math.sinh(arg);
    const c = Math.cosh(arg);
    const f  = (Vin - Vo) / R - 2 * Is * s;
    const fp = -1 / R - (2 * Is * c) / nVt;
    let d = f / fp;
    if (d >  maxStep) d =  maxStep;
    if (d < -maxStep) d = -maxStep;
    Vo -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return Vo;
}

// Asymmetric — forward diode (Is, n) on the positive half, 2 diodes in series
// (so effective ideality doubles) on the negative half.
function solveAsymmetric(Vin, R, Is, n) {
  let Vo = Vin * 0.5;
  const nVt = n * Vt;
  const nVt2 = 2 * n * Vt;
  const maxStep = 4 * nVt;
  for (let i = 0; i < 80; i++) {
    const argP = clamp( Vo / nVt,  -50, 50);
    const argN = clamp(-Vo / nVt2, -50, 50);
    const expP = Math.exp(argP);
    const expN = Math.exp(argN);
    const Idp =  Is * (expP - 1);
    const Idn =  Is * (expN - 1);
    const f  = (Vin - Vo) / R - Idp + Idn;
    const fp = -1 / R - (Is * expP) / nVt - (Is * expN) / nVt2;
    let d = f / fp;
    if (d >  maxStep) d =  maxStep;
    if (d < -maxStep) d = -maxStep;
    Vo -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return Vo;
}

function bakeDiodeCurve({ R, Is, n, symmetric }) {
  const curve = new Float32Array(CURVE_N);
  const solve = symmetric ? solveSymmetric : solveAsymmetric;
  for (let i = 0; i < CURVE_N; i++) {
    const t = i / (CURVE_N - 1);
    const Vin = -Vmax + 2 * Vmax * t;
    const Vo = solve(Vin, R, Is, n);
    // Normalize to [-1, 1] range so WaveShaper output stays reasonable.
    curve[i] = clamp(Vo / Vmax, -1, 1);
  }
  return curve;
}

// =====================================================================
// Drive coupling: lower R → more pre-clip gain (mimics op-amp before clipping).
// =====================================================================
function drivePreGain(R) {
  const t = (Math.log(R) - Math.log(RANGE.driveR.min))
          / (Math.log(RANGE.driveR.max) - Math.log(RANGE.driveR.min));
  // R=min → preGain≈60. R=max → preGain≈1.5.
  const logG = Math.log(1.5) + (1 - t) * (Math.log(60) - Math.log(1.5));
  return Math.exp(logG);
}

// =====================================================================
// Apply state → audio + DOM
// =====================================================================
let lastCurveKey = '';
let cachedCurve = null;

function diodeParams() {
  if (state.diode === 'custom') return { Is: state.customIs, n: state.customN };
  const d = DIODES[state.diode];
  return { Is: d.Is, n: d.n };
}

function applyAudio() {
  if (!nodes) return;
  const { Is, n } = diodeParams();
  const key = [state.driveR, Is, n, state.symmetric].join('|');
  if (key !== lastCurveKey) {
    cachedCurve = bakeDiodeCurve({ R: state.driveR, Is, n, symmetric: state.symmetric });
    lastCurveKey = key;
    nodes.shaper.curve = cachedCurve;
    drawTransferCurve();
  }
  const pre = drivePreGain(state.driveR);
  nodes.shaperGain.gain.setTargetAtTime(pre / Vmax, ctx.currentTime, 0.01);

  const fc = 1 / (2 * Math.PI * state.toneR * state.toneC);
  nodes.filter.frequency.setTargetAtTime(clamp(fc, 20, 20000), ctx.currentTime, 0.01);

  nodes.levelGain.gain.setTargetAtTime(state.level, ctx.currentTime, 0.01);
}

function applyAll() {
  applyAudio();
  renderKnobs();
  renderBypass();
  renderSchematicLabels();
  renderBuildSheet();
  renderRawSliders();
  renderDiodeSelect();
  renderSymSeg();
  renderPresetSelect();
  drawFreqResponse();
}

// =====================================================================
// Knobs (hand-rolled SVG, vertical drag, log/linear-aware)
// =====================================================================
const KNOB_DEFS = [
  { key: 'driveR', label: 'Drive', stateKey: 'driveR', range: RANGE.driveR, format: fmtResistor },
  { key: 'toneR',  label: 'Tone R', stateKey: 'toneR', range: RANGE.toneR,  format: fmtResistor },
  { key: 'toneC',  label: 'Tone C', stateKey: 'toneC', range: RANGE.toneC,  format: fmtCapacitor },
  { key: 'level',  label: 'Level',  stateKey: 'level', range: RANGE.level,  format: v => v.toFixed(2) + 'x' },
];

const knobEls = {};

function buildKnobs() {
  const host = document.getElementById('knob-row');
  host.innerHTML = '';
  for (const def of KNOB_DEFS) {
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    wrap.innerHTML = `
      <span class="name">${def.label}</span>
      <svg viewBox="0 0 80 80" tabindex="0" data-knob="${def.key}">
        <circle cx="40" cy="40" r="34" fill="#1a1815" stroke="#6E6A57" stroke-width="1.2"/>
        <g class="tick-group"></g>
        <circle cx="40" cy="40" r="26" fill="#26241F" stroke="#3f3d33" stroke-width="1"/>
        <line class="indicator" x1="40" y1="40" x2="40" y2="20" stroke="#D98E04" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="40" cy="40" r="2.5" fill="#D98E04"/>
      </svg>
      <span class="val">--</span>
    `;
    host.appendChild(wrap);
    const tg = wrap.querySelector('.tick-group');
    for (let i = 0; i <= 10; i++) {
      const ang = -135 + (i / 10) * 270;
      const r1 = 35, r2 = 38;
      const x1 = 40 + r1 * Math.sin(ang * Math.PI / 180);
      const y1 = 40 - r1 * Math.cos(ang * Math.PI / 180);
      const x2 = 40 + r2 * Math.sin(ang * Math.PI / 180);
      const y2 = 40 - r2 * Math.cos(ang * Math.PI / 180);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('stroke', '#6E6A57');
      line.setAttribute('stroke-width', '1');
      tg.appendChild(line);
    }
    knobEls[def.key] = {
      wrap,
      svg: wrap.querySelector('svg'),
      indicator: wrap.querySelector('.indicator'),
      val: wrap.querySelector('.val'),
      def,
    };
    attachKnobDrag(def);
  }
}

function valueToNorm(val, range) {
  if (range.scale === 'log') {
    return Math.log(val / range.min) / Math.log(range.max / range.min);
  }
  return (val - range.min) / (range.max - range.min);
}
function normToValue(t, range) {
  t = clamp(t, 0, 1);
  if (range.scale === 'log') {
    return range.min * Math.pow(range.max / range.min, t);
  }
  return range.min + t * (range.max - range.min);
}

function renderKnobs() {
  for (const def of KNOB_DEFS) {
    const v = state[def.stateKey];
    const t = valueToNorm(v, def.range);
    const ang = -135 + t * 270; // -135 = full left, +135 = full right
    const el = knobEls[def.key];
    el.indicator.setAttribute('transform', `rotate(${ang} 40 40)`);
    el.val.textContent = def.format(v);
  }
}

function attachKnobDrag(def) {
  const el = knobEls[def.key];
  let dragging = false;
  let startY = 0;
  let startVal = 0;
  const onDown = (e) => {
    dragging = true;
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    startVal = state[def.stateKey];
    e.preventDefault();
    document.body.style.userSelect = 'none';
  };
  const onMove = (e) => {
    if (!dragging) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    const dy = startY - y;
    // 200px drag = full range
    const startNorm = valueToNorm(startVal, def.range);
    const newNorm = clamp(startNorm + dy / 200, 0, 1);
    const newVal = normToValue(newNorm, def.range);
    setParam(def.stateKey, newVal);
    e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    document.body.style.userSelect = '';
  };
  el.svg.addEventListener('mousedown', onDown);
  el.svg.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
  el.svg.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 0.001 : 0.01);
    let norm = valueToNorm(state[def.stateKey], def.range);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { norm += step; e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { norm -= step; e.preventDefault(); }
    else return;
    setParam(def.stateKey, normToValue(clamp(norm, 0, 1), def.range));
  });
  el.svg.addEventListener('dblclick', () => {
    // Open inline edit on the knob value
    openInlineEditOnKnob(def);
  });
}

function setParam(key, val) {
  state[key] = val;
  // If a value diverges from any preset, mark Custom.
  if (state.preset !== 'custom' && key !== 'level') {
    const p = PRESETS[state.preset];
    if (p && Math.abs(p[key] - val) > 1e-6) state.preset = 'custom';
  }
  applyAll();
}

// =====================================================================
// Value formatting & parsing
// =====================================================================
function fmtResistor(R) {
  if (R >= 1e6) return (R / 1e6).toFixed(R >= 10e6 ? 0 : 2).replace(/\.?0+$/, '') + ' MΩ';
  if (R >= 1e3) return (R / 1e3).toFixed(R >= 100e3 ? 0 : (R >= 10e3 ? 1 : 2)).replace(/\.?0+$/, '') + ' kΩ';
  return R.toFixed(0) + ' Ω';
}
function fmtCapacitor(C) {
  if (C >= 1e-6)  return (C * 1e6).toFixed(2).replace(/\.?0+$/, '') + ' µF';
  if (C >= 1e-9)  return (C * 1e9).toFixed(C >= 100e-9 ? 0 : 1).replace(/\.?0+$/, '') + ' nF';
  return (C * 1e12).toFixed(0) + ' pF';
}
function fmtFreq(f) {
  if (f >= 1000) return (f / 1000).toFixed(2).replace(/\.?0+$/, '') + ' kHz';
  return f.toFixed(0) + ' Hz';
}

// Parse strings like "22k", "4.7n", "1M", "470p", "1.5u", "100".
// Case-sensitive on the suffix: "M" = mega, "m" = milli.
function parseValue(s) {
  if (typeof s !== 'string') return NaN;
  const stripped = s.trim().replace(/Ω|ω/g, '').replace(/F\b/g, '').replace(/Hz|hz|HZ/g, '');
  const m = stripped.match(/^([0-9]*\.?[0-9]+)\s*([pPnNuUµmMkKgG]?)$/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  const suf = m[2];
  const mulMap = {
    p: 1e-12, P: 1e-12,
    n: 1e-9,  N: 1e-9,
    u: 1e-6,  U: 1e-6,  µ: 1e-6,
    m: 1e-3,  M: 1e6,
    k: 1e3,   K: 1e3,
    g: 1e9,   G: 1e9,
    '': 1,
  };
  return num * (mulMap[suf] ?? 1);
}

// E12 series for resistors.
const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
function snapToE12(R) {
  if (!isFinite(R) || R <= 0) return R;
  const decade = Math.pow(10, Math.floor(Math.log10(R)));
  const norm = R / decade;
  let best = E12[0], bestDist = Infinity;
  for (const v of E12) {
    const d = Math.abs(Math.log(v) - Math.log(norm));
    if (d < bestDist) { bestDist = d; best = v; }
  }
  return best * decade;
}
const CAP_VALUES = [1,2.2,3.3,4.7,6.8,10,15,22,33,47,68,100,150,220,330,470,680];
function snapToStandardCap(C) {
  if (!isFinite(C) || C <= 0) return C;
  const decade = Math.pow(10, Math.floor(Math.log10(C)));
  const norm = C / decade;
  let best = CAP_VALUES[0], bestDist = Infinity;
  for (const v of CAP_VALUES) {
    const d = Math.abs(Math.log(v) - Math.log(norm));
    if (d < bestDist) { bestDist = d; best = v; }
  }
  return best * decade;
}

// =====================================================================
// Build Sheet
// =====================================================================
function renderBuildSheet() {
  const R1 = snapToE12(state.driveR);
  const R2 = snapToE12(state.toneR);
  const C1 = snapToStandardCap(state.toneC);
  const fc = 1 / (2 * Math.PI * R2 * C1);
  let diodeText;
  if (state.diode === 'custom') {
    diodeText = `Custom: Is=${state.customIs.toExponential(2)} A, n=${state.customN.toFixed(2)}`;
  } else {
    diodeText = DIODES[state.diode].long;
  }
  const symText = state.symmetric ? 'symmetric (antiparallel pair)' : 'asymmetric (1 vs 2 in series)';

  const lines = [
    `R1  (Drive resistor):      ${pad(fmtResistor(R1), 8)}`,
    `D1,D2 (clipping diodes):   ${diodeText}, ${symText}`,
    `R2  (Tone resistor):       ${pad(fmtResistor(R2), 8)}`,
    `C1  (Tone capacitor):      ${pad(fmtCapacitor(C1), 8)}    → cutoff ≈ ${fmtFreq(fc)}`,
    `Output level:              ${state.level.toFixed(2)}x  (sim only — not a board value)`,
    ``,
    `Bypass state:              clip=${state.bypass.clip?'ON':'in'}, tone=${state.bypass.tone?'ON':'in'}, level=${state.bypass.level?'ON':'in'}`,
  ];
  document.getElementById('build-sheet-text').textContent = lines.join('\n');
}
function pad(s, n) { while (s.length < n) s += ' '; return s; }

// =====================================================================
// Schematic SVG (built once, labels updated live)
// =====================================================================
const SCH_VIEWBOX = '0 0 880 320';

function buildSchematic() {
  const host = document.getElementById('schematic-host');
  host.style.position = 'relative';
  host.innerHTML = `
<svg id="schematic-svg" viewBox="${SCH_VIEWBOX}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#3f3d33" stroke-width="0.4" opacity="0.3"/>
    </pattern>
  </defs>
  <rect width="880" height="320" fill="url(#grid)"/>

  <!-- IN jack -->
  <g transform="translate(20,150)">
    <circle r="9" class="sch-jack" stroke="#EDE6D2" stroke-width="1.4" fill="none"/>
    <circle r="3.5" class="sch-jack"/>
    <text x="0" y="34" text-anchor="middle" class="sch-text label">INPUT</text>
  </g>

  <!-- Wire IN → R1 -->
  <line x1="30" y1="150" x2="90" y2="150" class="sch-wire seg-input"/>

  <!-- R1 (zigzag) -->
  <g id="sch-R1" class="seg-clip">
    <path d="M 90 150 L 100 150 L 105 140 L 115 160 L 125 140 L 135 160 L 145 140 L 155 160 L 165 140 L 175 160 L 180 150 L 190 150"
          class="sch-component"/>
    <text x="140" y="125" text-anchor="middle" class="sch-text label">R1</text>
    <text x="140" y="180" text-anchor="middle" class="sch-text value-text" data-edit="driveR">10 kΩ</text>
  </g>

  <!-- Junction after R1 -->
  <circle cx="190" cy="150" r="3" fill="#EDE6D2" class="sch-junction seg-clip"/>

  <!-- Diode pair to GND -->
  <g id="sch-diodes" class="seg-clip">
    <!-- Vertical wire down from junction -->
    <line x1="190" y1="153" x2="190" y2="200" class="sch-wire"/>
    <!-- Diode 1 (forward to ground): triangle pointing down, bar below -->
    <polygon points="180,200 200,200 190,215" class="sch-component sch-diode-fill" data-diode-fill="1"/>
    <line x1="180" y1="217" x2="200" y2="217" class="sch-component"/>
    <text x="155" y="212" class="sch-text label">D1</text>
    <!-- Vertical between two diodes -->
    <line x1="190" y1="217" x2="190" y2="225" class="sch-wire"/>
    <!-- Diode 2 (reverse parallel): triangle pointing up -->
    <polygon points="180,240 200,240 190,225" class="sch-component sch-diode-fill" data-diode-fill="2"/>
    <line x1="180" y1="222" x2="200" y2="222" class="sch-component"/>
    <text x="155" y="240" class="sch-text label">D2</text>
    <!-- Down to GND -->
    <line x1="190" y1="240" x2="190" y2="270" class="sch-wire"/>
    <!-- GND symbol -->
    <line x1="178" y1="270" x2="202" y2="270" class="sch-component" stroke-width="2"/>
    <line x1="183" y1="276" x2="197" y2="276" class="sch-component"/>
    <line x1="187" y1="282" x2="193" y2="282" class="sch-component"/>

    <text x="245" y="218" class="sch-text value-text" data-edit="diode" style="cursor:default">Si 1N4148, sym</text>
  </g>

  <!-- Wire from junction → op-amp -->
  <line x1="190" y1="150" x2="320" y2="150" class="sch-wire seg-tone"/>

  <!-- Op-amp triangle (buffer/gain stage) -->
  <g id="sch-opamp">
    <polygon points="320,125 320,175 365,150" class="sch-component"/>
    <line x1="325" y1="138" x2="332" y2="138" class="sch-component"/>
    <line x1="328.5" y1="134.5" x2="328.5" y2="141.5" class="sch-component"/>
    <line x1="325" y1="162" x2="332" y2="162" class="sch-component"/>
    <text x="342" y="113" class="sch-text label">buffer</text>
  </g>

  <!-- Wire op-amp → R2 -->
  <line x1="365" y1="150" x2="430" y2="150" class="sch-wire seg-tone"/>

  <!-- R2 (zigzag) -->
  <g id="sch-R2" class="seg-tone">
    <path d="M 430 150 L 440 150 L 445 140 L 455 160 L 465 140 L 475 160 L 485 140 L 495 160 L 505 140 L 515 160 L 520 150 L 540 150"
          class="sch-component"/>
    <text x="480" y="125" text-anchor="middle" class="sch-text label">R2</text>
    <text x="480" y="180" text-anchor="middle" class="sch-text value-text" data-edit="toneR">10 kΩ</text>
  </g>

  <!-- Junction after R2 -->
  <circle cx="540" cy="150" r="3" fill="#EDE6D2" class="sch-junction seg-tone"/>

  <!-- C1 to GND -->
  <g id="sch-C1" class="seg-tone">
    <line x1="540" y1="153" x2="540" y2="200" class="sch-wire"/>
    <line x1="520" y1="200" x2="560" y2="200" class="sch-component" stroke-width="2.4"/>
    <line x1="520" y1="210" x2="560" y2="210" class="sch-component" stroke-width="2.4"/>
    <line x1="540" y1="210" x2="540" y2="260" class="sch-wire"/>
    <line x1="528" y1="260" x2="552" y2="260" class="sch-component" stroke-width="2"/>
    <line x1="533" y1="266" x2="547" y2="266" class="sch-component"/>
    <line x1="537" y1="272" x2="543" y2="272" class="sch-component"/>
    <text x="570" y="207" class="sch-text label">C1</text>
    <text x="570" y="225" class="sch-text value-text" data-edit="toneC">47 nF</text>
  </g>

  <!-- Wire to Level / OUT -->
  <line x1="540" y1="150" x2="660" y2="150" class="sch-wire seg-level"/>

  <!-- Level (small triangle = output gain) -->
  <g id="sch-level" class="seg-level">
    <polygon points="660,130 660,170 700,150" class="sch-component"/>
    <text x="678" y="118" class="sch-text label">level</text>
    <text x="680" y="185" text-anchor="middle" class="sch-text value-text" data-edit="level">0.9x</text>
  </g>

  <!-- Wire to OUT -->
  <line x1="700" y1="150" x2="820" y2="150" class="sch-wire seg-output"/>

  <!-- OUT jack -->
  <g transform="translate(830,150)">
    <circle r="9" class="sch-jack" stroke="#EDE6D2" stroke-width="1.4" fill="none"/>
    <circle r="3.5" class="sch-jack"/>
    <text x="0" y="34" text-anchor="middle" class="sch-text label">OUTPUT</text>
  </g>

  <text x="440" y="305" text-anchor="middle" class="sch-text label" style="letter-spacing:0.18em">DOWDY DISTORTION · v1</text>
</svg>
  `;

  // Attach click-to-edit on value labels.
  host.querySelectorAll('[data-edit]').forEach(el => {
    const key = el.getAttribute('data-edit');
    if (key === 'diode' || key === 'level') return; // diode handled via select; level editable
    el.addEventListener('click', () => openInlineEdit(el, key));
  });
  host.querySelector('[data-edit="level"]').addEventListener('click', (e) => openInlineEdit(e.currentTarget, 'level'));
}

function renderSchematicLabels() {
  const svg = document.getElementById('schematic-svg');
  if (!svg) return;
  svg.querySelector('[data-edit="driveR"]').textContent = fmtResistor(snapToE12(state.driveR));
  svg.querySelector('[data-edit="toneR"]').textContent  = fmtResistor(snapToE12(state.toneR));
  svg.querySelector('[data-edit="toneC"]').textContent  = fmtCapacitor(snapToStandardCap(state.toneC));
  svg.querySelector('[data-edit="level"]').textContent  = state.level.toFixed(2) + 'x';
  const dText = (state.diode === 'custom')
    ? `Custom Is/n, ${state.symmetric ? 'sym' : 'asym'}`
    : `${DIODES[state.diode].short} ${DIODES[state.diode].long.replace(/^.* /, '').replace(/ \(.*$/, '')}, ${state.symmetric ? 'sym' : 'asym'}`;
  const dEl = svg.querySelector('[data-edit="diode"]');
  if (dEl) dEl.textContent = dText;

  // Bypass-driven dimming of segments
  svg.querySelectorAll('.seg-clip').forEach(el => el.classList.toggle('dim', state.bypass.clip));
  svg.querySelectorAll('.seg-tone').forEach(el => el.classList.toggle('dim', state.bypass.tone));
  svg.querySelectorAll('.seg-level').forEach(el => el.classList.toggle('dim', state.bypass.level));

  // Diode color hint
  const dF = DIODES[state.diode] || { short: 'Cu' };
  let fill = '#EDE6D2';
  if (state.diode === 'ge') fill = '#C99560';
  else if (state.diode === 'led') fill = '#FF6B5C';
  svg.querySelectorAll('[data-diode-fill]').forEach(el => el.setAttribute('fill', state.bypass.clip ? '#3f3d33' : fill));
}

// ----- Inline editor -----
let activeEditor = null;

function openInlineEdit(textEl, key) {
  closeInlineEdit();
  const host = document.getElementById('schematic-host');
  const hostRect = host.getBoundingClientRect();
  const elRect = textEl.getBoundingClientRect();
  const editor = document.createElement('div');
  editor.className = 'value-editor';
  editor.style.left = (elRect.left - hostRect.left) + 'px';
  editor.style.top  = (elRect.top - hostRect.top - 4) + 'px';
  editor.innerHTML = `<input type="text" />`;
  host.appendChild(editor);
  const input = editor.querySelector('input');
  input.value = textEl.textContent.replace(/\s|Ω/g, '').replace('µF', 'u').replace('nF', 'n').replace('kΩ', 'k').replace('MΩ', 'M').replace('x', '');
  input.focus();
  input.select();

  const commit = () => {
    const raw = input.value.trim();
    let v;
    if (key === 'level') v = parseFloat(raw);
    else v = parseValue(raw, key);
    const range = RANGE[key];
    if (!isFinite(v) || (range && (v < range.min || v > range.max))) {
      editor.classList.add('err');
      return;
    }
    setParam(key, v);
    closeInlineEdit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') closeInlineEdit();
  });
  input.addEventListener('blur', () => setTimeout(closeInlineEdit, 80));
  activeEditor = editor;
}
function closeInlineEdit() {
  if (activeEditor) { activeEditor.remove(); activeEditor = null; }
}
function openInlineEditOnKnob(def) {
  // Find the knob's val element and treat as editable
  const el = knobEls[def.key].val;
  openInlineEditElement(el, def.stateKey);
}
function openInlineEditElement(textEl, key) {
  closeInlineEdit();
  const rect = textEl.getBoundingClientRect();
  const editor = document.createElement('div');
  editor.className = 'value-editor';
  editor.style.position = 'fixed';
  editor.style.left = rect.left + 'px';
  editor.style.top  = (rect.top - 4) + 'px';
  editor.innerHTML = `<input type="text" />`;
  document.body.appendChild(editor);
  const input = editor.querySelector('input');
  input.value = textEl.textContent.replace(/\s|Ω/g, '').replace('µF', 'u').replace('nF', 'n').replace('kΩ', 'k').replace('MΩ', 'M').replace('x', '');
  input.focus(); input.select();
  const commit = () => {
    const raw = input.value.trim();
    let v;
    if (key === 'level') v = parseFloat(raw);
    else v = parseValue(raw, key);
    const range = RANGE[key];
    if (!isFinite(v) || (range && (v < range.min || v > range.max))) {
      editor.classList.add('err'); return;
    }
    setParam(key, v);
    closeInlineEdit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') closeInlineEdit();
  });
  input.addEventListener('blur', () => setTimeout(closeInlineEdit, 80));
  activeEditor = editor;
}

// =====================================================================
// Sources
// =====================================================================
function stopCurrentSource() {
  if (testToneSeq) { testToneSeq.stop(); testToneSeq = null; }
  if (sourceNode) {
    try { sourceNode.stop && sourceNode.stop(); } catch(_) {}
    try { sourceNode.disconnect(); } catch(_) {}
    sourceNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
}

function startTestTone() {
  stopCurrentSource();
  const c = ensureCtx();
  // A repeating arpeggio plucked synth.
  const notes = [196.00, 246.94, 293.66, 196.00, 246.94, 329.63, 261.63, 196.00]; // G3-B3-D4-G3-B3-E4-C4-G3
  const stepMs = 420;
  const out = c.createGain();
  out.gain.value = 0.35;
  out.connect(nodes.inGain);
  let i = 0;
  let cancelled = false;
  let timer = null;
  const playNote = () => {
    if (cancelled) return;
    const f = notes[i % notes.length];
    i++;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const env = c.createGain();
    env.gain.value = 0;
    const t0 = c.currentTime;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.005);
    env.gain.exponentialRampToValueAtTime(0.4, t0 + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    // gentle lowpass on the source
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    osc.connect(lp); lp.connect(env); env.connect(out);
    osc.start(t0);
    osc.stop(t0 + 0.65);
    timer = setTimeout(playNote, stepMs);
  };
  playNote();
  sourceNode = out;
  testToneSeq = { stop: () => { cancelled = true; if (timer) clearTimeout(timer); try { out.disconnect(); } catch(_){} } };
}

async function startMic() {
  stopCurrentSource();
  const c = ensureCtx();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });
    sourceNode = c.createMediaStreamSource(micStream);
    sourceNode.connect(nodes.inGain);
  } catch (e) {
    alert('Could not access microphone: ' + e.message);
    document.querySelector('[data-source="tone"]').click();
  }
}

async function loadFileSource(file) {
  stopCurrentSource();
  const c = ensureCtx();
  const arrayBuf = await file.arrayBuffer();
  fileBuffer = await c.decodeAudioData(arrayBuf);
  startFileSource();
}
function startFileSource() {
  if (!fileBuffer) return;
  stopCurrentSource();
  const c = ensureCtx();
  const src = c.createBufferSource();
  src.buffer = fileBuffer;
  src.loop = true;
  src.connect(nodes.inGain);
  src.start();
  sourceNode = src;
}

// =====================================================================
// Oscilloscopes
// =====================================================================
let scopeRAF = null;
function startScopes() {
  if (scopeRAF) return;
  const cIn  = document.getElementById('scope-in');
  const cOut = document.getElementById('scope-out');
  // Set canvas physical size to match displayed size.
  const fit = (canvas) => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
  };
  fit(cIn); fit(cOut);
  window.addEventListener('resize', () => { fit(cIn); fit(cOut); });
  const ctxIn = cIn.getContext('2d');
  const ctxOut = cOut.getContext('2d');
  const buf = new Float32Array(nodes.analyserIn.fftSize);
  const buf2 = new Float32Array(nodes.analyserOut.fftSize);

  const draw = () => {
    nodes.analyserIn.getFloatTimeDomainData(buf);
    nodes.analyserOut.getFloatTimeDomainData(buf2);
    drawScopeFrame(ctxIn, cIn, buf);
    drawScopeFrame(ctxOut, cOut, buf2);
    scopeRAF = requestAnimationFrame(draw);
  };
  scopeRAF = requestAnimationFrame(draw);
}
function drawScopeFrame(g, canvas, buf) {
  const w = canvas.width, h = canvas.height;
  g.fillStyle = '#1a1815';
  g.fillRect(0, 0, w, h);
  // grid
  g.strokeStyle = 'rgba(110,106,87,0.25)';
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const y = h * i / 8;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  for (let i = 1; i < 10; i++) {
    const x = w * i / 10;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  // zero line brighter
  g.strokeStyle = 'rgba(110,106,87,0.55)';
  g.beginPath(); g.moveTo(0, h/2); g.lineTo(w, h/2); g.stroke();

  // upward zero-crossing trigger
  let start = 0;
  for (let i = 1; i < buf.length / 2; i++) {
    if (buf[i-1] <= 0 && buf[i] > 0) { start = i; break; }
  }
  const N = Math.min(buf.length - start, Math.floor(buf.length * 0.6));

  g.strokeStyle = '#D98E04';
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / N) * w;
    const v = buf[start + i];
    const y = h/2 - v * (h/2) * 0.9;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

// =====================================================================
// Engineering plots
// =====================================================================
function drawTransferCurve() {
  const canvas = document.getElementById('curve-plot');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const g = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  g.fillStyle = '#1a1815'; g.fillRect(0,0,w,h);
  // grid
  g.strokeStyle = 'rgba(110,106,87,0.3)';
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const y = h * i / 8;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  for (let i = 1; i < 10; i++) {
    const x = w * i / 10;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  // axes
  g.strokeStyle = 'rgba(110,106,87,0.6)';
  g.beginPath(); g.moveTo(0, h/2); g.lineTo(w, h/2); g.stroke();
  g.beginPath(); g.moveTo(w/2, 0); g.lineTo(w/2, h); g.stroke();

  // curve: x = Vin (-Vmax..+Vmax), y = Vout (normalized [-1,1] = ±Vmax)
  if (!cachedCurve) return;
  g.strokeStyle = '#D98E04';
  g.lineWidth = 1.8;
  g.beginPath();
  const N = cachedCurve.length;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * w;
    const y = h/2 - cachedCurve[i] * (h/2) * 0.92;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();

  // axis labels
  g.fillStyle = '#6E6A57';
  g.font = `${10 * dpr}px "Martian Mono", monospace`;
  g.fillText(`+${Vmax}V`, w - 36*dpr, h/2 - 4*dpr);
  g.fillText(`-${Vmax}V`, 4*dpr, h/2 - 4*dpr);
  g.fillText('Vout +', w/2 + 4*dpr, 12*dpr);
  g.fillText('Vout -', w/2 + 4*dpr, h - 4*dpr);
}

function drawFreqResponse() {
  const canvas = document.getElementById('freq-plot');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const g = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  g.fillStyle = '#1a1815'; g.fillRect(0,0,w,h);

  const fMin = 20, fMax = 20000;
  const logF = (f) => Math.log10(f / fMin) / Math.log10(fMax / fMin);
  const yFor = (dB) => {
    // map dB: [+6, -40] → [0, h]
    const top = 6, bot = -40;
    return ((top - dB) / (top - bot)) * h;
  };

  // grid: octaves
  g.strokeStyle = 'rgba(110,106,87,0.3)';
  g.lineWidth = 1;
  for (let decade = 1; decade <= 4; decade++) {
    for (let mul = 1; mul <= 9; mul++) {
      const f = fMin * Math.pow(10, decade - 1) * mul;
      if (f > fMax) break;
      const x = logF(f) * w;
      g.globalAlpha = (mul === 1) ? 0.7 : 0.3;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  }
  g.globalAlpha = 1;
  // dB grid
  g.strokeStyle = 'rgba(110,106,87,0.3)';
  for (let dB = 0; dB >= -40; dB -= 10) {
    const y = yFor(dB);
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  // 0 dB line
  g.strokeStyle = 'rgba(110,106,87,0.6)';
  g.beginPath(); g.moveTo(0, yFor(0)); g.lineTo(w, yFor(0)); g.stroke();

  // Curve
  const R = state.toneR, C = state.toneC;
  g.strokeStyle = '#D98E04';
  g.lineWidth = 1.8;
  g.beginPath();
  const STEPS = 256;
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1);
    const f = fMin * Math.pow(fMax / fMin, t);
    const omegaRC = 2 * Math.PI * f * R * C;
    const mag = 1 / Math.sqrt(1 + omegaRC * omegaRC);
    const dB = 20 * Math.log10(mag);
    const x = logF(f) * w;
    const y = yFor(clamp(dB, -50, 10));
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();

  // Cutoff marker
  const fc = 1 / (2 * Math.PI * R * C);
  if (fc > fMin && fc < fMax) {
    g.strokeStyle = '#6F8F4D';
    g.lineWidth = 1.2;
    g.setLineDash([4*dpr, 4*dpr]);
    const x = logF(fc) * w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#6F8F4D';
    g.font = `${11 * dpr}px "Martian Mono", monospace`;
    g.fillText('fc = ' + fmtFreq(fc), x + 4*dpr, 14*dpr);
  }

  // Axis labels
  g.fillStyle = '#6E6A57';
  g.font = `${10 * dpr}px "Martian Mono", monospace`;
  g.fillText('20 Hz', 4*dpr, h - 4*dpr);
  g.fillText('20 kHz', w - 50*dpr, h - 4*dpr);
  g.fillText('0 dB', 4*dpr, yFor(0) - 2*dpr);
  g.fillText('-20 dB', 4*dpr, yFor(-20) - 2*dpr);
}

// =====================================================================
// Bypass / Sym / Preset / Diode UI updates
// =====================================================================
function renderBypass() {
  document.querySelectorAll('[data-bypass]').forEach(b => {
    const key = b.getAttribute('data-bypass');
    b.classList.toggle('bypassed', !!state.bypass[key]);
    b.textContent = (state.bypass[key] ? 'Bypassed: ' : 'Bypass ') + key;
  });
}
function renderSymSeg() {
  document.querySelectorAll('#sym-seg [data-sym]').forEach(b => {
    b.classList.toggle('active', (b.getAttribute('data-sym') === 'sym') === state.symmetric);
  });
}
function renderPresetSelect() {
  document.getElementById('preset-select').value = state.preset;
}
function renderDiodeSelect() {
  document.getElementById('diode-select').value = state.diode;
  document.getElementById('raw-row').style.display = (state.diode === 'custom') ? '' : 'none';
}
function renderRawSliders() {
  const isS = document.getElementById('is-slider');
  const nS  = document.getElementById('n-slider');
  const isR = document.getElementById('is-readout');
  const nR  = document.getElementById('n-readout');
  if (!isS) return;
  isS.value = Math.round(valueToNorm(state.customIs, RANGE.customIs) * 1000);
  nS.value  = Math.round(state.customN * 100);
  isR.textContent = state.customIs.toExponential(1).replace('e-', 'e-') + ' A';
  nR.textContent  = state.customN.toFixed(2);
}

// =====================================================================
// Wiring all DOM events
// =====================================================================
function wireEvents() {
  // Start gate
  const gate = document.getElementById('start-gate');
  document.getElementById('start-btn').addEventListener('click', async () => {
    buildGraph();
    applyAll();
    startTestTone();
    startScopes();
    gate.classList.add('hidden');
    if (ctx.state === 'suspended') await ctx.resume();
  });

  // Source switcher
  document.querySelectorAll('#source-seg [data-source]').forEach(b => {
    b.addEventListener('click', async () => {
      const src = b.getAttribute('data-source');
      if (src === 'mic') {
        if (!state.micWarned) {
          const modal = document.getElementById('headphone-modal');
          modal.classList.remove('hidden');
          document.getElementById('hp-cancel').onclick = () => modal.classList.add('hidden');
          document.getElementById('hp-ok').onclick = async () => {
            state.micWarned = true;
            modal.classList.add('hidden');
            await switchSource('mic');
          };
        } else {
          await switchSource('mic');
        }
      } else if (src === 'file') {
        document.getElementById('file-input').click();
      } else {
        await switchSource('tone');
      }
    });
  });
  document.getElementById('file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await loadFileSource(f);
    state.source = 'file';
    updateSourceSeg();
  });

  // Mode toggle
  document.querySelectorAll('#mode-seg [data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      state.mode = b.getAttribute('data-mode');
      updateModeUI();
    });
  });

  // Preset / diode / sym
  document.getElementById('preset-select').addEventListener('change', (e) => {
    state.preset = e.target.value;
    if (state.preset !== 'custom') {
      const p = PRESETS[state.preset];
      Object.assign(state, p);
    }
    applyAll();
  });
  document.getElementById('diode-select').addEventListener('change', (e) => {
    state.diode = e.target.value;
    if (state.preset !== 'custom') state.preset = 'custom';
    applyAll();
  });
  document.querySelectorAll('#sym-seg [data-sym]').forEach(b => {
    b.addEventListener('click', () => {
      state.symmetric = (b.getAttribute('data-sym') === 'sym');
      if (state.preset !== 'custom') state.preset = 'custom';
      applyAll();
    });
  });

  // Bypass
  document.querySelectorAll('[data-bypass]').forEach(b => {
    b.addEventListener('click', () => {
      const key = b.getAttribute('data-bypass');
      state.bypass[key] = !state.bypass[key];
      routeChain();
      renderBypass();
      renderSchematicLabels();
      renderBuildSheet();
    });
  });

  // Raw Is / n sliders
  document.getElementById('is-slider').addEventListener('input', (e) => {
    const t = e.target.value / 1000;
    state.customIs = normToValue(t, RANGE.customIs);
    if (state.diode !== 'custom') state.diode = 'custom';
    if (state.preset !== 'custom') state.preset = 'custom';
    applyAll();
  });
  document.getElementById('n-slider').addEventListener('input', (e) => {
    state.customN = e.target.value / 100;
    if (state.diode !== 'custom') state.diode = 'custom';
    if (state.preset !== 'custom') state.preset = 'custom';
    applyAll();
  });

  // Copy as text
  document.getElementById('copy-btn').addEventListener('click', () => {
    const txt = document.getElementById('build-sheet-text').textContent;
    navigator.clipboard.writeText(txt).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.classList.add('copy-flash');
      const orig = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('copy-flash'); btn.textContent = orig; }, 900);
    });
  });

  // Export SVG / PNG
  document.getElementById('export-svg').addEventListener('click', exportSchematicSVG);
  document.getElementById('export-png').addEventListener('click', exportSchematicPNG);

  // A/B
  document.getElementById('ab-save-a').addEventListener('click', () => { saveSnapshot('A'); });
  document.getElementById('ab-save-b').addEventListener('click', () => { saveSnapshot('B'); });
  document.getElementById('ab-a').addEventListener('click', () => loadSnapshot('A'));
  document.getElementById('ab-b').addEventListener('click', () => loadSnapshot('B'));

  // Window resize → redraw plots
  window.addEventListener('resize', () => {
    drawTransferCurve();
    drawFreqResponse();
  });
}

async function switchSource(src) {
  state.source = src;
  updateSourceSeg();
  if (src === 'tone') startTestTone();
  else if (src === 'mic') await startMic();
  else if (src === 'file') startFileSource();
}
function updateSourceSeg() {
  document.querySelectorAll('#source-seg [data-source]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-source') === state.source);
  });
}
function updateModeUI() {
  document.querySelectorAll('#mode-seg [data-mode]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-mode') === state.mode);
  });
  document.querySelectorAll('.engineering-only').forEach(el => {
    el.classList.toggle('hidden', state.mode !== 'eng');
  });
  // Repaint plots on mode change (they may have been hidden).
  if (state.mode === 'eng') {
    requestAnimationFrame(() => { drawTransferCurve(); drawFreqResponse(); });
  }
}

// =====================================================================
// A/B snapshots
// =====================================================================
function snapshotState() {
  return JSON.parse(JSON.stringify({
    preset: state.preset, driveR: state.driveR, diode: state.diode, symmetric: state.symmetric,
    customIs: state.customIs, customN: state.customN, toneR: state.toneR, toneC: state.toneC,
    level: state.level,
  }));
}
function saveSnapshot(slot) {
  snapshots[slot] = snapshotState();
  localStorage.setItem('dd_snap_' + slot, JSON.stringify(snapshots[slot]));
  flashAbButton(slot, true);
}
function loadSnapshot(slot) {
  const s = snapshots[slot];
  if (!s) { flashAbButton(slot, false); return; }
  Object.assign(state, s);
  state.abSlot = slot;
  document.getElementById('ab-a').classList.toggle('active', slot === 'A');
  document.getElementById('ab-b').classList.toggle('active', slot === 'B');
  applyAll();
}
function flashAbButton(slot, success) {
  const btn = document.getElementById('ab-save-' + slot.toLowerCase());
  const orig = btn.textContent;
  btn.textContent = success ? '✓' : '–';
  btn.style.color = success ? 'var(--good)' : 'var(--bad)';
  setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 700);
}
function loadSnapshotsFromStorage() {
  try {
    const a = localStorage.getItem('dd_snap_A');
    const b = localStorage.getItem('dd_snap_B');
    if (a) snapshots.A = JSON.parse(a);
    if (b) snapshots.B = JSON.parse(b);
  } catch(_) {}
}

// =====================================================================
// Export schematic SVG / PNG
// =====================================================================
function exportSchematicSVG() {
  const svg = document.getElementById('schematic-svg');
  const clone = svg.cloneNode(true);
  // Inline current background
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Apply computed styles to text/component classes so they render standalone.
  const styles = `
    <style>
      .sch-wire { stroke: #26241F; stroke-width: 1.6; fill: none; }
      .sch-wire.dim { stroke: #999; }
      .sch-component { fill: none; stroke: #26241F; stroke-width: 1.6; }
      .sch-component.dim { stroke: #999; }
      .sch-diode-fill { fill: #26241F; }
      .sch-text { font-family: 'Martian Mono', monospace; font-size: 11px; fill: #26241F; }
      .sch-text.label { fill: #6E6A57; font-size: 10px; }
      .sch-text.value-text { fill: #D98E04; font-weight: 500; }
      .sch-jack { fill: #26241F; }
    </style>
  `;
  // Replace any url(#grid) fill with a plain light bg.
  const bgRect = clone.querySelector('rect');
  if (bgRect) bgRect.setAttribute('fill', '#FAF6E8');
  clone.insertBefore(new DOMParser().parseFromString(styles, 'image/svg+xml').documentElement, clone.firstChild);
  const ser = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([ser], { type: 'image/svg+xml' });
  downloadBlob(blob, schematicFilename('svg'));
}
function exportSchematicPNG() {
  const svg = document.getElementById('schematic-svg');
  const ser = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([ser], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = 880 * scale; canvas.height = 320 * scale;
    const g = canvas.getContext('2d');
    g.fillStyle = '#FAF6E8'; g.fillRect(0,0,canvas.width,canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((pngBlob) => {
      downloadBlob(pngBlob, schematicFilename('png'));
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.src = url;
}
function schematicFilename(ext) {
  const dial = `${fmtResistor(snapToE12(state.driveR))}_${state.diode}${state.symmetric?'sym':'asym'}_${fmtResistor(snapToE12(state.toneR))}_${fmtCapacitor(snapToStandardCap(state.toneC))}`
    .replace(/\s|Ω|µ/g, '').replace(/[^A-Za-z0-9._-]/g, '');
  return `dowdy-distortion_${dial}.${ext}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =====================================================================
// Init
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {
  buildKnobs();
  buildSchematic();
  wireEvents();
  // Initialize from default preset.
  Object.assign(state, PRESETS.ts, { preset: 'ts' });
  loadSnapshotsFromStorage();
  // Initial DOM render without audio (the start gate is up).
  renderKnobs();
  renderBypass();
  renderSchematicLabels();
  renderBuildSheet();
  renderRawSliders();
  renderDiodeSelect();
  renderSymSeg();
  renderPresetSelect();
  updateSourceSeg();
  updateModeUI();
});
