(() => {
  const D = (globalThis.Dowdy = globalThis.Dowdy || {});
  const Vt = 0.02585;
  const ranges = {
    inputGain: [0.5, 20],
    driveR: [1e3, 470e3],
    toneR: [1e3, 100e3],
    toneC: [1e-9, 470e-9],
    level: [0, 2],
    tilt: [-18, 18],
  };
  const directRanges = {
    inputGain: [0.1, 100],
    driveR: [10, 10e6],
    toneR: [10, 10e6],
    toneC: [10e-12, 10e-6],
    level: [0, 2],
    tilt: [-18, 18],
  };
  const diodes = {
    si: { Is: 4e-9, n: 1.9, vf: 0.62, label: "Si 1N4148" },
    ge: { Is: 200e-9, n: 1.7, vf: 0.3, label: "Ge 1N34A" },
    schottky: { Is: 2e-6, n: 1.25, vf: 0.25, label: "Schottky BAT41" },
    led: { Is: 1e-12, n: 2, vf: 1.8, label: "Red LED" },
    greenLed: { Is: 6e-13, n: 2, vf: 2.15, label: "Green LED" },
    blueLed: { Is: 2e-13, n: 2.1, vf: 2.7, label: "Blue LED" },
  };
  const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  const caps = E12;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const logValue = (min, max, t) => min * Math.pow(max / min, clamp(t, 0, 1));
  const logNorm = (min, max, value) =>
    Math.log(value / min) / Math.log(max / min);
  const snap = (value, series) => {
    const decade = Math.pow(10, Math.floor(Math.log10(value)));
    const unit = value / decade;
    return (
      series.reduce(
        (best, next) =>
          Math.abs(Math.log(next / unit)) < Math.abs(Math.log(best / unit))
            ? next
            : best,
        series[0],
      ) * decade
    );
  };
  const format = (v, kind) => {
    if (kind === "gain") return `${trim(v.toFixed(2))}×`;
    if (kind === "db") return `${v > 0 ? "+" : ""}${trim(v.toFixed(1))} dB`;
    if (kind === "r")
      return v >= 1e6
        ? `${trim((v / 1e6).toFixed(2))} MΩ`
        : v >= 1e3
          ? `${trim((v / 1e3).toFixed(v >= 100e3 ? 0 : 2))} kΩ`
          : `${trim(v.toFixed(0))} Ω`;
    if (kind === "c")
      return v >= 1e-6
        ? `${trim((v * 1e6).toFixed(2))} µF`
        : v >= 1e-9
          ? `${trim((v * 1e9).toFixed(v >= 100e-9 ? 0 : 1))} nF`
          : `${trim((v * 1e12).toFixed(0))} pF`;
    return String(v);
  };
  const trim = (value) => value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  const parse = (raw, current, kind) => {
    const clean = raw.trim().replace(/Ω|ohms?|f|hz/gi, "");
    const match = clean.match(/^([0-9]*\.?[0-9]+)\s*([pnumkmgµ]?)$/i);
    if (!match) return NaN;
    const number = Number(match[1]);
    const suffix = match[2];
    const multipliers = {
      p: 1e-12,
      n: 1e-9,
      u: 1e-6,
      µ: 1e-6,
      m: 1e-3,
      k: 1e3,
      M: 1e6,
      g: 1e9,
      G: 1e9,
      "": 1,
    };
    if (suffix)
      return (
        number * (multipliers[suffix] || multipliers[suffix.toLowerCase()])
      );
    if (kind === "r")
      return number * (current >= 1e6 ? 1e6 : current >= 1e3 ? 1e3 : 1);
    if (kind === "c")
      return number * (current >= 1e-6 ? 1e-6 : current >= 1e-9 ? 1e-9 : 1e-12);
    return number;
  };
  const params = (state) =>
    state.diode === "custom"
      ? { Is: state.customIs, n: state.customN, label: "Custom" }
      : { ...diodes[state.diode] };
  const solveShunt = (vin, R, Is, n, asymmetric) => {
    let out = vin * 0.5;
    const nv = n * Vt;
    for (let i = 0; i < 70; i++) {
      const p = clamp(out / nv, -50, 50),
        q = clamp(-out / (asymmetric ? 2 * nv : nv), -50, 50);
      const ep = Math.exp(p),
        en = Math.exp(q);
      const f = (vin - out) / R - Is * (ep - 1) + Is * (en - 1);
      const fp =
        -1 / R - (Is * ep) / nv - (Is * en) / (asymmetric ? 2 * nv : nv);
      const delta = clamp(f / fp, -4 * nv, 4 * nv);
      out -= delta;
      if (Math.abs(delta) < 1e-9) break;
    }
    return out;
  };
  const curve = (state) => {
    const { Is, n, vf = 0.62 } = params(state);
    const points = new Float32Array(1024);
    for (let i = 0; i < points.length; i++) {
      const vin = -3 + (6 * i) / (points.length - 1);
      let out = solveShunt(vin, state.driveR, Is, n, !state.symmetric);
      if (state.clipperBlock === "feedback") {
        const threshold = vf * (state.symmetric ? 1 : 1.6);
        out = Math.tanh(vin / Math.max(0.08, threshold)) * threshold;
      }
      if (state.clipperBlock === "hard") {
        const threshold = vf * (state.symmetric ? 1 : 1.5);
        out = clamp(vin, -threshold, threshold);
      }
      points[i] = clamp(out / 3, -1, 1);
    }
    return points;
  };
  const cutoff = (state) => 1 / (2 * Math.PI * state.toneR * state.toneC);
  const response = (state, f) => {
    const x = 2 * Math.PI * f * state.toneR * state.toneC;
    if (state.toneBlock === "highpass") return x / Math.sqrt(1 + x * x);
    if (state.toneBlock === "tilt")
      return Math.pow(10, ((state.tilt / 20) * Math.log10(f / 800)) / 2);
    return 1 / Math.sqrt(1 + x * x);
  };
  const sweep = (state, key) => {
    const [min, max] = directRanges[key];
    return Array.from({ length: 9 }, (_, i) => logValue(min, max, i / 8));
  };
  D.Circuit = {
    ranges,
    directRanges,
    diodes,
    E12,
    caps,
    clamp,
    logValue,
    logNorm,
    snap,
    format,
    parse,
    params,
    curve,
    cutoff,
    response,
    sweep,
  };
  D.defaults = {
    gainBlock: "boost",
    clipperBlock: "shunt",
    toneBlock: "lowpass",
    inputGain: 4,
    driveR: 10e3,
    toneR: 10e3,
    toneC: 47e-9,
    level: 0.9,
    tilt: 0,
    diode: "si",
    symmetric: true,
    customIs: 4e-9,
    customN: 1.9,
    bypass: { clip: false, tone: false, level: false },
    source: "tone",
  };
  D.state = structuredClone(D.defaults);
})();
