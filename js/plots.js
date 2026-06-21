(() => {
  const D = globalThis.Dowdy,
    C = D.Circuit;
  let raf,
    sweepPart = "driveR",
    sweepValues = [];
  const colors = ["#e59a08", "#76a6bf", "#d65a43"];
  const canvas = (id) => document.getElementById(id);
  const fit = (el) => {
    const dpr = devicePixelRatio || 1,
      box = el.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width * dpr));
    const height = Math.max(1, Math.round(box.height * dpr));
    if (el.width !== width || el.height !== height) {
      el.width = width;
      el.height = height;
    }
    return el.getContext("2d");
  };
  const grid = (g, w, h) => {
    g.fillStyle = "#11110e";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(233,225,202,.1)";
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      g.beginPath();
      g.moveTo(0, (h * i) / 8);
      g.lineTo(w, (h * i) / 8);
      g.stroke();
    }
    for (let i = 1; i < 10; i++) {
      g.beginPath();
      g.moveTo((w * i) / 10, 0);
      g.lineTo((w * i) / 10, h);
      g.stroke();
    }
  };
  const line = (g, points, color, width = 1.6) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  };
  const scope = (id, analyser) => {
    const el = canvas(id),
      g = fit(el),
      w = el.width,
      h = el.height;
    grid(g, w, h);
    if (!analyser) return;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let start = 0;
    for (let i = 1; i < data.length / 2; i++)
      if (data[i - 1] <= 0 && data[i] > 0) {
        start = i;
        break;
      }
    const n = Math.min(data.length - start, Math.floor(data.length * 0.6));
    line(
      g,
      Array.from({ length: n }, (_, i) => [
        (i * w) / n,
        h / 2 - data[start + i] * h * 0.43,
      ]),
      "#ffc34a",
    );
  };
  const spectrum = (analyser) => {
    const el = canvas("spectrum"),
      g = fit(el),
      w = el.width,
      h = el.height;
    grid(g, w, h);
    if (!analyser) return;
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    const nyquist = analyser.context.sampleRate / 2,
      min = 30,
      max = 20000;
    const points = [];
    for (let i = 1; i < data.length; i++) {
      const f = (i * nyquist) / data.length;
      if (f < min || f > max) continue;
      const x = (Math.log(f / min) / Math.log(max / min)) * w,
        y = ((0 - C.clamp(data[i], -80, 0)) / 80) * h;
      points.push([x, y]);
    }
    line(g, points, "#ffc34a");
    label(g, "30 Hz", 4, h - 5);
    label(g, "20 kHz", w - 45, h - 5);
  };
  const transfer = () => {
    const el = canvas("transfer"),
      g = fit(el),
      w = el.width,
      h = el.height;
    grid(g, w, h);
    g.strokeStyle = "rgba(233,225,202,.35)";
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.moveTo(w / 2, 0);
    g.lineTo(w / 2, h);
    g.stroke();
    const states = [
      D.state,
      ...D.Builds.overlayStates().map((build) => build.state),
    ];
    states.forEach((state, index) => {
      const curve = C.curve(state);
      line(
        g,
        Array.from(curve, (v, i) => [
          (i * w) / (curve.length - 1),
          h / 2 - v * h * 0.45,
        ]),
        colors[index],
      );
    });
  };
  const response = () => {
    const el = canvas("response"),
      g = fit(el),
      w = el.width,
      h = el.height;
    grid(g, w, h);
    const states = [
      D.state,
      ...D.Builds.overlayStates().map((build) => build.state),
    ];
    states.forEach((state, index) => {
      const points = [];
      for (let i = 0; i < 220; i++) {
        const f = 20 * Math.pow(1000, i / 219),
          db = 20 * Math.log10(Math.max(0.0001, C.response(state, f))),
          x = (i * w) / 219,
          y = ((6 - C.clamp(db, -50, 6)) / 56) * h;
        points.push([x, y]);
      }
      line(g, points, colors[index]);
    });
    label(g, "20 Hz", 4, h - 5);
    label(g, "20 kHz", w - 45, h - 5);
  };
  const sweep = () => {
    const el = canvas("sweep"),
      g = fit(el),
      w = el.width,
      h = el.height;
    grid(g, w, h);
    sweepValues.forEach((value, index) => {
      const state = structuredClone(D.state);
      state[sweepPart] = value;
      const points = [];
      for (let i = 0; i < 180; i++) {
        const f = 20 * Math.pow(1000, i / 179),
          db = 20 * Math.log10(Math.max(0.0001, C.response(state, f))),
          x = (i * w) / 179,
          y = ((6 - C.clamp(db, -50, 6)) / 56) * h;
        points.push([x, y]);
      }
      line(
        g,
        points,
        index === 4 ? "#ffc34a" : "rgba(233,225,202,.25)",
        index === 4 ? 1.8 : 1,
      );
    });
  };
  const label = (g, text, x, y) => {
    g.fillStyle = "#aaa18b";
    g.font = "10px Martian Mono";
    g.fillText(text, x, y);
  };
  const db = (analyser) => {
    if (!analyser) return -Infinity;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(
      data.reduce((sum, v) => sum + v * v, 0) / data.length,
    );
    return rms ? 20 * Math.log10(rms) : -Infinity;
  };
  const harmonic = (analyser) => {
    if (!analyser) return "—";
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    const peak = Math.max(...data);
    return `${Math.round(peak)} dB`;
  };
  const render = () => {
    const data = D.Audio.data();
    scope("scope-in", data.input);
    scope("scope-out", data.output);
    spectrum(data.output);
    document.getElementById("input-meter").textContent = niceDb(db(data.input));
    document.getElementById("output-meter").textContent = niceDb(
      db(data.output),
    );
    document.getElementById("harmonic-readout").textContent = harmonic(
      data.output,
    );
    raf = requestAnimationFrame(render);
  };
  const niceDb = (value) =>
    Number.isFinite(value) ? `${Math.round(value)} dB` : "−∞";
  const start = () => {
    cancelAnimationFrame(raf);
    transfer();
    response();
    sweep();
    render();
    window.addEventListener("resize", () => {
      transfer();
      response();
      sweep();
    });
  };
  const runSweep = (part) => {
    sweepPart = part;
    sweepValues = C.sweep(D.state, part);
    return sweepValues;
  };
  D.Plots = {
    start,
    transfer,
    response,
    runSweep,
    get sweepValues() {
      return sweepValues;
    },
  };
})();
