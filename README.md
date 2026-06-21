# Dowdy Distortion

A static browser workbench for trying practical gain, clipping, and tone blocks before committing values to a first pedal PCB.

## Run it

Open `index.html` directly or publish the repository with GitHub Pages. Audio starts only after **Tap to start**. Use headphones for live mic input.

## Layout

- `js/circuit.js` — component math and value helpers
- `js/audio.js` — Web Audio signal chain and sources
- `js/plots.js` — scopes and analysis views
- `js/builds.js` — local named-build storage
- `js/ui.js` — controls, canvas labels, and workbench rendering
- `css/` — base tokens and workbench layout

## Verification

Run `node tests/check.js`, then open the GitHub Pages site and confirm audio sources, block changes, saved builds, overlays, and sweeps work without console errors.
