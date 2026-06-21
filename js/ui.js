(() => {
  const D = globalThis.Dowdy;
  const C = D.Circuit;
  const defs = [
    ["inputGain", "Input gain", "gain"],
    ["driveR", "R1 drive", "r"],
    ["toneR", "R2 tone", "r"],
    ["toneC", "C1 tone", "c"],
    ["tilt", "Tilt", "db"],
    ["level", "Level", "gain"],
  ];
  const $ = (id) => document.getElementById(id);
  const linear = (key) => key === "level" || key === "tilt";
  const component = (key) => ["driveR", "toneR", "toneC"].includes(key);
  const physicalRange = (key) => C.ranges[key];
  const directRange = (key) => C.directRanges[key];

  const norm = (key, value) => {
    const [min, max] = physicalRange(key);
    return linear(key)
      ? C.clamp((value - min) / (max - min), 0, 1)
      : C.clamp(C.logNorm(min, max, value), 0, 1);
  };
  const fromNorm = (key, amount) => {
    const [min, max] = physicalRange(key);
    const t = C.clamp(amount, 0, 1);
    return linear(key) ? min + t * (max - min) : C.logValue(min, max, t);
  };
  const formatRange = (key, kind) => {
    const [min, max] = directRange(key);
    return `${C.format(min, kind)}–${C.format(max, kind)}`;
  };
  const status = (message) => {
    $("status-line").textContent = message;
  };
  const normalizeValue = (key, value, snap) => {
    const [min, max] = directRange(key);
    let next = C.clamp(value, min, max);
    if (snap && (key === "driveR" || key === "toneR"))
      next = C.snap(next, C.E12);
    if (snap && key === "toneC") next = C.snap(next, C.caps);
    return C.clamp(next, min, max);
  };
  const set = (key, value, options = {}) => {
    if (!Number.isFinite(value)) return false;
    const next = normalizeValue(key, value, component(key));
    D.state[key] = next;
    D.Audio.apply();
    render();
    if (options.announce)
      status(`${options.label || key} set to ${C.format(next, options.kind)}`);
    return true;
  };
  const updateState = (key, value) => {
    D.state[key] = value;
    D.Audio.apply();
    render();
  };
  const arcPath = (amount) => {
    const start = -135;
    const end = start + C.clamp(amount, 0, 1) * 270;
    const point = (angle) => {
      const radians = (angle * Math.PI) / 180;
      return [40 + 29 * Math.sin(radians), 40 - 29 * Math.cos(radians)];
    };
    const [x1, y1] = point(start);
    const [x2, y2] = point(end);
    if (end - start < 0.5) return `M ${x1} ${y1}`;
    return `M ${x1} ${y1} A 29 29 0 ${end - start > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const ticks = () =>
    Array.from({ length: 11 }, (_, index) => {
      const angle = -135 + index * 27;
      const radians = (angle * Math.PI) / 180;
      const point = (radius) => [
        40 + radius * Math.sin(radians),
        40 - radius * Math.cos(radians),
      ];
      const [x1, y1] = point(34.5);
      const [x2, y2] = point(37.5);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#615d4f" stroke-width="1"/>`;
    }).join("");

  const knob = ([key, label, kind]) => {
    const wrap = document.createElement("div");
    wrap.className = "knob";
    wrap.innerHTML = `<div class="knob-name">${label}</div><svg viewBox="0 0 80 80" tabindex="0" role="slider" aria-label="${label}" aria-valuemin="0" aria-valuemax="100"><ellipse cx="40" cy="44" rx="32" ry="31" fill="rgba(0,0,0,.45)"/><circle cx="40" cy="40" r="33" fill="#11110e" stroke="#615d4f"/>${ticks()}<path class="arc" fill="none" stroke="#e59a08" stroke-width="3" stroke-linecap="round"/><circle cx="40" cy="40" r="24" fill="#29271e" stroke="#070705"/><line class="needle" x1="40" y1="40" x2="40" y2="20" stroke="#ffc34a" stroke-width="3" stroke-linecap="round"/><circle cx="40" cy="40" r="2.5" fill="#ffc34a"/></svg><div class="knob-value"><button type="button" aria-label="Enter exact ${label} value"></button></div>`;
    const svg = wrap.querySelector("svg");
    const needle = wrap.querySelector(".needle");
    const arc = wrap.querySelector(".arc");
    const value = wrap.querySelector("button");
    let startY = 0;
    let startNorm = 0;
    let dragging = false;
    const update = () => {
      const current = D.state[key];
      const amount = norm(key, current);
      const angle = -135 + amount * 270;
      needle.setAttribute("transform", `rotate(${angle} 40 40)`);
      arc.setAttribute("d", arcPath(amount));
      svg.setAttribute("aria-valuenow", String(Math.round(amount * 100)));
      svg.setAttribute("aria-valuetext", C.format(current, kind));
      value.textContent = C.format(current, kind);
      value.title = `Exact range: ${formatRange(key, kind)}`;
    };
    const finish = (event) => {
      if (
        event?.pointerId !== undefined &&
        svg.hasPointerCapture(event.pointerId)
      )
        svg.releasePointerCapture(event.pointerId);
      dragging = false;
    };
    svg.addEventListener("pointerdown", (event) => {
      dragging = true;
      startY = event.clientY;
      startNorm = norm(key, D.state[key]);
      svg.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    svg.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      set(key, fromNorm(key, startNorm + (startY - event.clientY) / 190));
      event.preventDefault();
    });
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
    svg.addEventListener("keydown", (event) => {
      const current = norm(key, D.state[key]);
      let next = current;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 1;
      else if (event.key === "ArrowUp" || event.key === "ArrowRight")
        next += event.shiftKey ? 0.1 : 0.02;
      else if (event.key === "ArrowDown" || event.key === "ArrowLeft")
        next -= event.shiftKey ? 0.1 : 0.02;
      else return;
      event.preventDefault();
      set(key, fromNorm(key, next));
    });
    svg.addEventListener("dblclick", () => openEditor(value, key, label, kind));
    value.addEventListener("click", () => openEditor(value, key, label, kind));
    wrap.update = update;
    return wrap;
  };
  const buildKnobs = () => $("knob-grid").replaceChildren(...defs.map(knob));
  const renderKnobs = () =>
    document.querySelectorAll(".knob").forEach((node) => node.update());

  let editor;
  const closeEditor = () => {
    editor?.remove();
    editor = undefined;
  };
  const editorText = (key, kind) =>
    C.format(D.state[key], kind).replace(/[Ω×]/g, "");
  const openEditor = (target, key, label, kind) => {
    closeEditor();
    const rect = target.getBoundingClientRect();
    editor = document.createElement("form");
    editor.className = "value-editor";
    editor.innerHTML = `<input aria-label="${label} exact value" inputmode="decimal" /><button type="submit">Set</button>`;
    editor.style.left = `${Math.max(8, rect.left)}px`;
    editor.style.top = `${Math.max(8, rect.bottom + 5)}px`;
    const input = editor.querySelector("input");
    input.value = editorText(key, kind);
    const commit = () => {
      const parsed =
        linear(key) || key === "inputGain"
          ? Number(input.value)
          : C.parse(input.value, D.state[key], kind);
      if (!set(key, parsed, { announce: true, label, kind })) {
        editor.classList.add("error");
        status(`Use ${formatRange(key, kind)} for ${label}`);
        return false;
      }
      closeEditor();
      return true;
    };
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      commit();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeEditor();
    });
    document.body.appendChild(editor);
    input.focus();
    input.select();
  };

  const clipName = () =>
    ({
      shunt: "SHUNT CLIPPER",
      feedback: "FEEDBACK CLIPPER",
      hard: "HARD CLIPPER",
    })[D.state.clipperBlock];
  const toneName = () =>
    ({ lowpass: "RC LOW-PASS", highpass: "RC HIGH-PASS", tilt: "TILT SHELF" })[
      D.state.toneBlock
    ];
  const gainName = () =>
    D.state.gainBlock === "unity"
      ? "UNITY BUFFER"
      : D.state.gainBlock === "pad"
        ? "INPUT PAD · 0.45×"
        : `CLEAN BOOST · ${C.format(D.state.inputGain, "gain")}`;
  const renderSchematic = () => {
    const state = D.state;
    $("sch-gain").textContent = gainName();
    $("sch-clip-name").textContent = clipName();
    $("sch-tone-name").textContent = toneName();
    $("sch-diode").textContent =
      `${C.params(state).label} · ${state.symmetric ? "symmetric" : "1 + 2 pair"}`;
    document.querySelector('[data-edit="driveR"]').textContent = C.format(
      state.driveR,
      "r",
    );
    document.querySelector('[data-edit="toneR"]').textContent = C.format(
      state.toneR,
      "r",
    );
    document.querySelector('[data-edit="toneC"]').textContent = C.format(
      state.toneC,
      "c",
    );
    document.querySelector('[data-edit="level"]').textContent = C.format(
      state.level,
      "gain",
    );
    document.querySelectorAll("[data-stage]").forEach((stage) => {
      const key = stage.dataset.stage;
      const muted =
        key === "clip"
          ? state.bypass.clip
          : key === "tone"
            ? state.bypass.tone
            : key === "level"
              ? state.bypass.level
              : false;
      stage.classList.toggle("muted", muted);
      stage.classList.toggle("active", !muted);
    });
    $("clip-readout").textContent =
      `${C.params(state).label} · ${state.symmetric ? "sym" : "asym"}`;
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
      : "1 + 2 pair";
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
    const state = D.state;
    const rows = [
      [
        "IN",
        "Input gain (simulation)",
        state.gainBlock === "unity"
          ? "1×"
          : state.gainBlock === "pad"
            ? "0.45×"
            : C.format(state.inputGain, "gain"),
      ],
      [
        "R1",
        state.clipperBlock === "feedback"
          ? "Feedback network resistor"
          : "Clipper resistor",
        C.format(state.driveR, "r"),
      ],
      [
        "D1·D2",
        C.params(state).label,
        state.symmetric ? "symmetric pair" : "1 + 2 pair",
      ],
      ["R2", "Tone resistor", C.format(state.toneR, "r")],
      ["C1", "Tone capacitor", C.format(state.toneC, "c")],
      ["LVL", "Output level (simulation)", C.format(state.level, "gain")],
    ];
    $("parts-body").innerHTML = rows
      .map(
        (row) =>
          `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`,
      )
      .join("");
    $("cutoff-note").textContent =
      `${toneName()} corner ≈ ${frequency(C.cutoff(state))} · model values shown`;
  };
  const renderBuilds = () => {
    const list = $("build-list");
    const options = [
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
    const kind = $("sweep-part").value === "toneC" ? "c" : "r";
    $("sweep-values").innerHTML = D.Plots.sweepValues
      .map(
        (value, index) =>
          `<button data-sweep-value="${value}">${index + 1}: ${C.format(value, kind)}</button>`,
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
  const wire = () => {
    [
      ["gain-block", "gainBlock"],
      ["clipper-block", "clipperBlock"],
      ["tone-block", "toneBlock"],
      ["diode-select", "diode"],
    ].forEach(([id, key]) =>
      $(id).addEventListener("change", (event) =>
        updateState(key, event.target.value),
      ),
    );
    $("symmetry-button").addEventListener("click", () =>
      updateState("symmetric", !D.state.symmetric),
    );
    $("is-slider").addEventListener("input", (event) => {
      D.state.customIs = C.logValue(1e-12, 1e-5, event.target.value / 1000);
      updateState("diode", "custom");
    });
    $("n-slider").addEventListener("input", (event) => {
      D.state.customN = event.target.value / 100;
      updateState("diode", "custom");
    });
    document.querySelectorAll("[data-bypass]").forEach((button) =>
      button.addEventListener("click", () => {
        D.state.bypass[button.dataset.bypass] =
          !D.state.bypass[button.dataset.bypass];
        D.Audio.apply();
        render();
      }),
    );
    document.querySelectorAll("[data-edit]").forEach((target) => {
      const key = target.dataset.edit;
      const def = defs.find(([candidate]) => candidate === key);
      target.addEventListener("click", () =>
        openEditor(target, key, def[1], def[2]),
      );
    });
    document.querySelectorAll(".source").forEach((button) =>
      button.addEventListener("click", async () => {
        const source = button.dataset.source;
        if (source === "file") return $("file-input").click();
        if (source === "mic")
          return $("mic-warning").classList.remove("hidden");
        await D.Audio.source(source);
        renderSource();
      }),
    );
    $("file-input").addEventListener("change", async (event) => {
      if (!event.target.files[0]) return;
      await D.Audio.startFile(event.target.files[0]);
      D.state.source = "file";
      renderSource();
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
      status("Reset to the reference circuit");
    });
    $("save-build").addEventListener("click", () => {
      const build = D.Builds.save($("build-name").value);
      $("build-name").value = "";
      status(`Saved ${build.name}`);
      render();
    });
    $("build-list").addEventListener("click", (event) => {
      const { load, duplicate, delete: remove } = event.target.dataset;
      if (load) {
        D.Builds.apply(load);
        D.Audio.apply();
        render();
      }
      if (duplicate) {
        D.Builds.duplicate(duplicate);
        render();
      }
      if (remove) {
        D.Builds.remove(remove);
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
      if (value) set($("sweep-part").value, value);
    });
    $("copy-parts").addEventListener("click", () => {
      const rows = [...$("parts-body").rows].map((row) =>
        [...row.cells].map((cell) => cell.textContent).join("\t"),
      );
      copyText(
        `DOWDY DISTORTION — PARTS LIST\nRef\tPart\tValue\n${rows.join("\n")}\n\n${$("cutoff-note").textContent}`,
      ).then(() => status("Parts list copied"));
    });
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
  D.UI = { buildKnobs, wire, render, renderSource };
})();
