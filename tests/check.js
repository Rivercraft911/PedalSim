const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync("js/circuit.js", "utf8");
const storage = new Map();
const sandbox = {
  globalThis: {},
  structuredClone,
  Math,
  Float32Array,
  Date,
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  },
};
vm.runInNewContext(source, sandbox);
const { Circuit, defaults } = sandbox.globalThis.Dowdy;
const close = (a, b) => Math.abs(a - b) < Math.max(1e-18, Math.abs(b) * 1e-10);
for (const [input, current, kind, expected] of [
  ["150k", 10e3, "r", 150e3],
  ["155", 10e3, "r", 155e3],
  ["970k", 10e3, "r", 970e3],
  ["4.7u", 47e-9, "c", 4.7e-6],
]) {
  if (!close(Circuit.parse(input, current, kind), expected))
    throw new Error(`parse failed: ${input}`);
}
if (Circuit.snap(155e3, Circuit.E12) !== 150e3)
  throw new Error("E12 snap failed");
for (const state of [
  defaults,
  { ...defaults, clipperBlock: "feedback", toneBlock: "highpass" },
]) {
  const curve = Circuit.curve(state);
  if (![...curve].every(Number.isFinite))
    throw new Error("curve contains non-finite values");
  for (let i = 1; i < curve.length; i++)
    if (curve[i] < curve[i - 1]) throw new Error("curve is not monotonic");
}
const sweep = Circuit.sweep(defaults, "driveR");
if (
  sweep.length !== 9 ||
  sweep.some((value, index) => index && value <= sweep[index - 1])
)
  throw new Error("sweep invalid");
vm.runInNewContext(fs.readFileSync("js/builds.js", "utf8"), sandbox);
sandbox.globalThis.Dowdy.Builds.load();
const saved = sandbox.globalThis.Dowdy.Builds.save("first board");
if (
  saved.name !== "first board" ||
  sandbox.globalThis.Dowdy.Builds.all.length !== 1
)
  throw new Error("build save failed");
sandbox.globalThis.Dowdy.Builds.duplicate(saved.id);
if (sandbox.globalThis.Dowdy.Builds.all.length !== 2)
  throw new Error("build duplicate failed");
console.log("circuit checks passed");
