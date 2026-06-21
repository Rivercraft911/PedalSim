(() => {
  const D = globalThis.Dowdy,
    C = D.Circuit;
  const defs = [
    ["inputGain", "Input gain", "gain"],
    ["driveR", "R1 drive", "r"],
    ["toneR", "R2 tone", "r"],
    ["toneC", "C1 tone", "c"],
    ["tilt", "Tilt", "db"],
    ["level", "Level", "gain"],
  ];
  const $ = (id) => document.getElementById(id);
  const set = (key, value, snap = false) => {
    if (snap && (key === "driveR" || key === "toneR"))
      value = C.snap(value, C.E12);
    if (snap && key === "toneC") value = C.snap(value, C.caps);
    D.state[key] = value;
    D.Audio.apply();
    render();
  };
  const knob = ([key, label, kind]) => {
    const wrap = document.createElement("div");
    wrap.className = "knob";
    wrap.innerHTML = `<div class="knob-name">${label}</div><svg viewBox="0 0 80 80" tabindex="0"><circle cx="40" cy="40" r="33" fill="#151510" stroke="#615d4f"/><path class="arc" fill="none" stroke="#e59a08" stroke-width="3"/><circle cx="40" cy="40" r="24" fill="#29271e"/><line class="needle" x1="40" y1="40" x2="40" y2="20" stroke="#ffc34a" stroke-width="3" stroke-linecap="round"/></svg><div class="knob-value"></div>`;
    const svg = wrap.querySelector("svg"),
      needle = wrap.querySelector(".needle"),
      arc = wrap.querySelector(".arc"),
      value = wrap.querySelector(".knob-value");
    let startY,
      startValue,
      dragging = false;
    const update = () => {
      const [min, max] = C.ranges[key],
        current = D.state[key],
        t =
          key === "level" || key === "tilt"
            ? C.clamp((current - min) / (max - min), 0, 1)
            : C.clamp(C.logNorm(min, max, current), 0, 1),
        angle = -135 + 270 * t,
        rad = (a) => ((a - 90) * Math.PI) / 180;
      needle.setAttribute("transform", `rotate(${angle} 40 40)`);
      const x = 40 + 29 * Math.cos(rad(-135 + 90)),
        y = 40 + 29 * Math.sin(rad(-135 + 90)),
        ex = 40 + 29 * Math.cos(rad(angle + 90)),
        ey = 40 + 29 * Math.sin(rad(angle + 90));
      arc.setAttribute(
        "d",
        `M${x} ${y} A29 29 0 ${angle > -45 ? 1 : 0} 1 ${ex} ${ey}`,
      );
      value.textContent = C.format(current, kind);
    };
    const move = (event) => {
      if (!dragging) return;
      const y = event.touches ? event.touches[0].clientY : event.clientY,
        [min, max] = C.ranges[key],
        start =
          key === "level" || key === "tilt"
            ? (startValue - min) / (max - min)
            : C.logNorm(min, max, startValue),
        t = C.clamp(start + (startY - y) / 190, 0, 1),
        next =
          key === "level" || key === "tilt"
            ? min + t * (max - min)
            : C.logValue(min, max, t);
      set(key, next, true);
      event.preventDefault();
    };
    svg.addEventListener("pointerdown", (event) => {
      dragging = true;
      startY = event.clientY;
      startValue = D.state[key];
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", () => (dragging = false));
    svg.addEventListener("dblclick", () => {
      const answer = prompt(
        `Set ${label}`,
        C.format(D.state[key], kind).replace(/[Ωµ×]/g, ""),
      );
      if (answer === null) return;
      const parsed =
        key === "level" || key === "tilt" || key === "inputGain"
          ? Number(answer)
          : C.parse(answer, D.state[key], kind);
      const [min, max] = C.directRanges[key];
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max)
        set(key, parsed);
      else
        alert(
          `Use a value from ${C.format(min, kind)} to ${C.format(max, kind)}.`,
        );
    });
    wrap.update = update;
    return wrap;
  };
  const buildKnobs = () => {
    const host = $("knob-grid");
    host.replaceChildren(...defs.map(knob));
  };
  const renderKnobs = () =>
    document.querySelectorAll(".knob").forEach((node) => node.update());
  const renderSchematic = () => {
    const state = D.state,
      params = C.params(state);
    $("sch-gain").textContent =
      state.gainBlock === "unity" ? "1×" : C.format(state.inputGain, "gain");
    $("sch-clip-name").textContent =
      state.clipperBlock === "feedback" ? "FEEDBACK CLIP" : "SHUNT CLIP";
    $("sch-r1").textContent = C.format(state.driveR, "r");
    $("sch-tone-name").textContent =
      state.toneBlock === "highpass"
        ? "HIGH PASS"
        : state.toneBlock === "tilt"
          ? "TILT SHELF"
          : "LOW PASS";
    $("sch-tone").textContent =
      state.toneBlock === "tilt"
        ? C.format(state.tilt, "db")
        : `${C.format(state.toneR, "r")} · ${C.format(state.toneC, "c")}`;
    $("clip-readout").textContent =
      `${params.label}${state.symmetric ? " · sym" : " · asym"}`;
    $("cutoff-readout").textContent = frequency(C.cutoff(state));
  };
  const frequency = (value) =>
    value >= 1000
      ? `${(value / 1000).toFixed(2).replace(/\.0+$/, "")} kHz`
      : `${Math.round(value)} Hz`;
  const renderRack = () => {
    const state = D.state;
    $("gain-block").value = state.gainBlock;
    $("clipper-block").value = state.clipperBlock;
    $("tone-block").value = state.toneBlock;
    $("diode-select").value = state.diode;
    $("symmetry-button").textContent = state.symmetric
      ? "Symmetric"
      : "Asymmetric";
    $("custom-diode").classList.toggle("hidden", state.diode !== "custom");
    $("is-slider").value = Math.round(
      C.logNorm(1e-12, 1e-5, state.customIs) * 1000,
    );
    $("n-slider").value = Math.round(state.customN * 100);
    document
      .querySelectorAll("[data-bypass]")
      .forEach((button) =>
        button.classList.toggle("on", state.bypass[button.dataset.bypass]),
      );
  };
  const renderParts = () => {
    const state = D.state,
      rows = [
        [
          "IN",
          "Input gain (sim)",
          state.gainBlock === "unity"
            ? "1×"
            : C.format(state.inputGain, "gain"),
        ],
        [
          "R1",
          state.clipperBlock === "feedback"
            ? "Feedback resistor"
            : "Clipper resistor",
          C.format(state.driveR, "r"),
        ],
        [
          "D1·D2",
          C.params(state).label,
          state.symmetric ? "symmetric" : "asymmetric",
        ],
        ["R2", "Tone resistor", C.format(state.toneR, "r")],
        ["C1", "Tone capacitor", C.format(state.toneC, "c")],
        ["LVL", "Output level (sim)", C.format(state.level, "gain")],
      ];
    $("parts-body").innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`,
      )
      .join("");
    $("cutoff-note").textContent =
      `${state.toneBlock === "highpass" ? "High-pass" : "Tone"} corner ≈ ${frequency(C.cutoff(state))}`;
  };
  const renderBuilds = () => {
    const list = $("build-list"),
      options = [
        ["", "Current build"],
        ...D.Builds.all.map((build) => [build.id, build.name]),
      ];
    list.innerHTML =
      D.Builds.all
        .map(
          (build) =>
            `<div class="build-item"><button class="name" data-load="${build.id}">${build.name}</button><button data-duplicate="${build.id}">Copy</button><button data-delete="${build.id}">×</button></div>`,
        )
        .join("") || "<small>No saved builds yet.</small>";
    ["overlay-a", "overlay-b"].forEach((id, slot) => {
      $(id).innerHTML = options
        .map(
          ([value, name]) =>
            `<option value="${value}">${slot ? "B" : "A"} · ${name}</option>`,
        )
        .join("");
      $(id).value = D.Builds.overlays[slot] || "";
    });
  };
  const renderSweep = () => {
    $("sweep-values").innerHTML = D.Plots.sweepValues
      .map(
        (value, index) =>
          `<button data-sweep-value="${value}">${index + 1}: ${C.format(value, $("sweep-part").value === "toneC" ? "c" : "r")}</button>`,
      )
      .join("");
  };
  const render = () => {
    renderKnobs();
    renderRack();
    renderSchematic();
    renderParts();
    renderBuilds();
    D.Plots.transfer();
    D.Plots.response();
    renderSweep();
  };
  const wire = () => {
    $("gain-block").addEventListener("change", (event) => {
      D.state.gainBlock = event.target.value;
      D.Audio.apply();
      render();
    });
    $("clipper-block").addEventListener("change", (event) => {
      D.state.clipperBlock = event.target.value;
      D.Audio.apply();
      render();
    });
    $("tone-block").addEventListener("change", (event) => {
      D.state.toneBlock = event.target.value;
      D.Audio.apply();
      render();
    });
    $("diode-select").addEventListener("change", (event) => {
      D.state.diode = event.target.value;
      D.Audio.apply();
      render();
    });
    $("symmetry-button").addEventListener("click", () => {
      D.state.symmetric = !D.state.symmetric;
      D.Audio.apply();
      render();
    });
    $("is-slider").addEventListener("input", (event) => {
      D.state.customIs = C.logValue(1e-12, 1e-5, event.target.value / 1000);
      D.state.diode = "custom";
      D.Audio.apply();
      render();
    });
    $("n-slider").addEventListener("input", (event) => {
      D.state.customN = event.target.value / 100;
      D.state.diode = "custom";
      D.Audio.apply();
      render();
    });
    document.querySelectorAll("[data-bypass]").forEach((button) =>
      button.addEventListener("click", () => {
        const key = button.dataset.bypass;
        D.state.bypass[key] = !D.state.bypass[key];
        D.Audio.apply();
        render();
      }),
    );
    document.querySelectorAll(".source").forEach((button) =>
      button.addEventListener("click", async () => {
        const source = button.dataset.source;
        if (source === "file") return $("file-input").click();
        if (source === "mic") {
          $("mic-warning").classList.remove("hidden");
          return;
        }
        await D.Audio.source(source);
        renderSource();
      }),
    );
    $("file-input").addEventListener("change", async (event) => {
      if (event.target.files[0]) {
        await D.Audio.startFile(event.target.files[0]);
        D.state.source = "file";
        renderSource();
      }
    });
    $("mic-cancel").addEventListener("click", () =>
      $("mic-warning").classList.add("hidden"),
    );
    $("mic-confirm").addEventListener("click", async () => {
      $("mic-warning").classList.add("hidden");
      await D.Audio.source("mic");
      renderSource();
    });
    $("reset-button").addEventListener("click", () => {
      Object.assign(D.state, structuredClone(D.defaults));
      D.Audio.apply();
      render();
    });
    $("save-build").addEventListener("click", () => {
      D.Builds.save($("build-name").value);
      $("build-name").value = "";
      render();
    });
    $("build-list").addEventListener("click", (event) => {
      const id =
        event.target.dataset.load ||
        event.target.dataset.duplicate ||
        event.target.dataset.delete;
      if (!id) return;
      if (event.target.dataset.load) {
        D.Builds.apply(id);
        D.Audio.apply();
        render();
      }
      if (event.target.dataset.duplicate) {
        D.Builds.duplicate(id);
        render();
      }
      if (event.target.dataset.delete) {
        D.Builds.remove(id);
        render();
      }
    });
    ["overlay-a", "overlay-b"].forEach((id, slot) =>
      $(id).addEventListener("change", (event) => {
        D.Builds.setOverlay(slot, event.target.value);
        D.Plots.transfer();
        D.Plots.response();
      }),
    );
    $("run-sweep").addEventListener("click", () => {
      D.Plots.runSweep($("sweep-part").value);
      renderSweep();
    });
    $("sweep-values").addEventListener("click", (event) => {
      const value = Number(event.target.dataset.sweepValue);
      if (!value) return;
      set($("sweep-part").value, value);
    });
    $("copy-parts").addEventListener("click", () =>
      copyText($("parts-body").innerText),
    );
  };
  const renderSource = () =>
    document
      .querySelectorAll(".source")
      .forEach((button) =>
        button.classList.toggle(
          "active",
          button.dataset.source === D.state.source,
        ),
      );
  const copyText = (text) => {
    if (navigator.clipboard && window.isSecureContext)
      return navigator.clipboard.writeText(text);
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied
      ? Promise.resolve()
      : Promise.reject(new Error("Copy unavailable"));
  };
  D.UI = { buildKnobs, wire, render, renderSource };
})();
