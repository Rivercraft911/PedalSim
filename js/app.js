(() => {
  const D = globalThis.Dowdy;
  document.addEventListener("DOMContentLoaded", () => {
    D.Builds.load();
    D.UI.buildKnobs();
    D.UI.wire();
    D.Plots.runSweep("driveR");
    D.UI.render();
    document.getElementById("start-button").addEventListener(
      "click",
      async () => {
        D.Audio.build();
        await D.Audio.data().context.resume();
        D.Audio.startTone();
        D.UI.renderSource();
        D.UI.render();
        D.Plots.start();
        document.getElementById("start-gate").classList.add("hidden");
      },
      { once: true },
    );
  });
})();
