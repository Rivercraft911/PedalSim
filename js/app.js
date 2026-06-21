(() => {
  const D = globalThis.Dowdy;
  document.addEventListener("DOMContentLoaded", () => {
    D.Builds.load();
    D.UI.buildKnobs();
    D.UI.wire();
    D.Plots.runSweep("driveR");
    document.getElementById("start-button").addEventListener(
      "click",
      async () => {
        document.getElementById("start-gate").classList.add("hidden");
        try {
          D.Audio.build();
          await D.Audio.data().context.resume();
          D.Audio.startTone();
          D.UI.renderSource();
          D.Plots.start();
        } catch (_) {
          document.getElementById("status-line").textContent =
            "Audio start unavailable";
        }
        D.UI.render();
      },
      { once: true },
    );
    requestAnimationFrame(() => D.UI.render());
  });
})();
