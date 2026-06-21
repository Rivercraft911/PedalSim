(() => {
  const D = globalThis.Dowdy,
    C = D.Circuit;
  let ctx,
    nodes,
    sourceNode,
    micStream,
    fileBuffer,
    toneLoop,
    curveKey = "";
  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: "interactive" });
    }
    return ctx;
  };
  const stopSource = () => {
    if (toneLoop) {
      toneLoop.stop();
      toneLoop = null;
    }
    if (sourceNode) {
      try {
        sourceNode.stop?.();
      } catch (_) {}
      try {
        sourceNode.disconnect();
      } catch (_) {}
      sourceNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
  };
  const disconnect = () =>
    Object.values(nodes).forEach((node) => {
      try {
        node.disconnect();
      } catch (_) {}
    });
  const route = () => {
    if (!nodes) return;
    disconnect();
    let cursor = nodes.input;
    nodes.input.connect(nodes.analyserIn);
    cursor = nodes.analyserIn;
    cursor.connect(nodes.preamp);
    cursor = nodes.preamp;
    if (!D.state.bypass.clip) {
      cursor.connect(nodes.shaper);
      cursor = nodes.shaper;
    }
    if (!D.state.bypass.tone) {
      if (D.state.toneBlock === "tilt") {
        cursor.connect(nodes.tiltLow);
        nodes.tiltLow.connect(nodes.tiltHigh);
        cursor = nodes.tiltHigh;
      } else {
        cursor.connect(nodes.filter);
        cursor = nodes.filter;
      }
    }
    if (!D.state.bypass.level) {
      cursor.connect(nodes.level);
      cursor = nodes.level;
    }
    cursor.connect(nodes.analyserOut);
    nodes.analyserOut.connect(ctx.destination);
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_) {}
      sourceNode.connect(nodes.input);
    }
  };
  const build = () => {
    const c = ensure();
    nodes = {
      input: c.createGain(),
      preamp: c.createGain(),
      shaper: c.createWaveShaper(),
      filter: c.createBiquadFilter(),
      tiltLow: c.createBiquadFilter(),
      tiltHigh: c.createBiquadFilter(),
      level: c.createGain(),
      analyserIn: c.createAnalyser(),
      analyserOut: c.createAnalyser(),
    };
    nodes.shaper.oversample = "4x";
    nodes.analyserIn.fftSize = nodes.analyserOut.fftSize = 2048;
    nodes.tiltLow.type = "lowshelf";
    nodes.tiltHigh.type = "highshelf";
    nodes.tiltLow.frequency.value = nodes.tiltHigh.frequency.value = 800;
    route();
    apply();
  };
  const apply = () => {
    if (!nodes) return;
    const key = JSON.stringify([
      D.state.clipperBlock,
      D.state.driveR,
      D.state.diode,
      D.state.customIs,
      D.state.customN,
      D.state.symmetric,
    ]);
    if (key !== curveKey) {
      nodes.shaper.curve = C.curve(D.state);
      curveKey = key;
    }
    const gain = D.state.gainBlock === "unity" ? 1 : D.state.inputGain;
    nodes.preamp.gain.setTargetAtTime(gain / 3, ctx.currentTime, 0.01);
    nodes.level.gain.setTargetAtTime(D.state.level, ctx.currentTime, 0.01);
    nodes.filter.type =
      D.state.toneBlock === "highpass" ? "highpass" : "lowpass";
    nodes.filter.frequency.setTargetAtTime(
      C.clamp(C.cutoff(D.state), 10, 20000),
      ctx.currentTime,
      0.01,
    );
    nodes.tiltLow.gain.setTargetAtTime(-D.state.tilt, ctx.currentTime, 0.01);
    nodes.tiltHigh.gain.setTargetAtTime(D.state.tilt, ctx.currentTime, 0.01);
    route();
  };
  const startTone = () => {
    stopSource();
    const c = ensure(),
      out = c.createGain();
    out.gain.value = 0.35;
    sourceNode = out;
    const notes = [196, 246.94, 293.66, 196, 246.94, 329.63, 261.63, 196];
    let index = 0,
      timer,
      stopped = false;
    const play = () => {
      if (stopped) return;
      const osc = c.createOscillator(),
        env = c.createGain(),
        lp = c.createBiquadFilter(),
        now = c.currentTime;
      osc.type = "sawtooth";
      osc.frequency.value = notes[index++ % notes.length];
      lp.type = "lowpass";
      lp.frequency.value = 3000;
      env.gain.setValueAtTime(0.0001, now);
      env.gain.exponentialRampToValueAtTime(1, now + 0.008);
      env.gain.exponentialRampToValueAtTime(0.4, now + 0.12);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
      osc.connect(lp);
      lp.connect(env);
      env.connect(out);
      osc.start(now);
      osc.stop(now + 0.65);
      timer = setTimeout(play, 420);
    };
    toneLoop = {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
        try {
          out.disconnect();
        } catch (_) {}
      },
    };
    play();
    route();
  };
  const startMic = async () => {
    stopSource();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      sourceNode = ensure().createMediaStreamSource(micStream);
      route();
    } catch (error) {
      alert(`Could not access microphone: ${error.message}`);
      D.state.source = "tone";
      startTone();
    }
  };
  const startFile = async (file) => {
    stopSource();
    const c = ensure();
    fileBuffer = await c.decodeAudioData(await file.arrayBuffer());
    const src = c.createBufferSource();
    src.buffer = fileBuffer;
    src.loop = true;
    src.start();
    sourceNode = src;
    route();
  };
  const source = async (kind) => {
    D.state.source = kind;
    if (kind === "mic") await startMic();
    else if (kind === "file") return;
    else startTone();
  };
  const data = () => ({
    input: nodes?.analyserIn,
    output: nodes?.analyserOut,
    context: ctx,
  });
  D.Audio = {
    build,
    apply,
    source,
    startTone,
    startFile,
    route,
    data,
    get ready() {
      return !!nodes;
    },
  };
})();
