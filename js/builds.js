(() => {
  const D = globalThis.Dowdy;
  const key = "dowdy-workbench-builds-v1";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let builds = [];
  let overlays = ["", ""];
  const load = () => {
    try {
      builds = JSON.parse(localStorage.getItem(key) || "[]").slice(0, 12);
    } catch (_) {
      builds = [];
    }
    return builds;
  };
  const persist = () => localStorage.setItem(key, JSON.stringify(builds));
  const save = (name, state = D.state) => {
    const clean = (name || `Build ${builds.length + 1}`).trim().slice(0, 32);
    const build = {
      id: `b${Date.now().toString(36)}`,
      name: clean,
      state: clone(state),
      note: "",
      savedAt: Date.now(),
    };
    builds = [build, ...builds].slice(0, 12);
    persist();
    return build;
  };
  const remove = (id) => {
    builds = builds.filter((build) => build.id !== id);
    overlays = overlays.map((id) =>
      builds.some((build) => build.id === id) ? id : "",
    );
    persist();
  };
  const duplicate = (id) => {
    const source = builds.find((build) => build.id === id);
    return source && save(`${source.name} copy`, source.state);
  };
  const apply = (id) => {
    const build = builds.find((item) => item.id === id);
    if (build) Object.assign(D.state, clone(build.state));
    return build;
  };
  const setOverlay = (slot, id) => {
    overlays[slot] = id;
  };
  const overlayStates = () =>
    overlays
      .map((id) => builds.find((build) => build.id === id))
      .filter(Boolean);
  D.Builds = {
    load,
    save,
    remove,
    duplicate,
    apply,
    setOverlay,
    overlayStates,
    get all() {
      return builds;
    },
    get overlays() {
      return overlays;
    },
  };
})();
