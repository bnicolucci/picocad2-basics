# picoCAD 2 WebGL — Minimal Framework

A tiny, zero-dependency WebGL2 framework for making retro 3D scenes and games
from [picoCAD 2](https://johanpeitz.itch.io/picocad2) models. The coding style
is deliberately simple and beginner-friendly: import the shared `scene` and
`camera`, build things in `init`, move them in `update` — no renderer, matrix,
or WebGL calls in your code.

```ts
const box = cube({ uv: { tile: { u: 2, v: 2 } } });
box.position.set(-4.5, 1.5, 0);
scene.add(box);

const pig = new PicoCad2Loader().parse(pigText).instantiate();
scene.add(pig);

function update(dt: number, t: number): void {
    box.rotation.y += dt;
}

run({ width: 800, height: 600, retroScale: 0.5, init, update });
```

`src/main.ts` is the full demo — a checkered floor, spinning primitives, and
two animated models — and the reference for how code here should look.

## Requirements

- [Bun](https://bun.sh) (used exclusively — no npm/npx)

## Quick start

```sh
git clone https://github.com/bnicolucci/picocad2-basics.git
cd picocad2-basics
bun install
bun run dev
```

Open the Vite URL printed in the terminal for the demo (`index.html`), or open
`/editor_animation.html` for the Animation Editor (dev-only).

## Animations: one base model + a tiny tracks file

picoCAD 2 animation exports are near-full copies of the model, so five clips
would ship the mesh five times. Here they don't:

1. Export clips as `<mesh>-anim-<clip>.txt` next to the base `<mesh>.txt` in
   `src/assets/models/`.
2. Open `/editor_animation.html`, pick the mesh, curate which clips/nodes to
   keep, preview, **Save**.
3. Save generates `src/assets/models/<mesh>_animations.ts` — just the motion
   tracks, a few KB instead of a few hundred.
4. In code: `loadAnimationClips('thinktank')` then
   `playClip(model, clips.shoot)`.

The anim source files and the editor page never reach a production build.

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start the Vite dev server (demo + Animation Editor) |
| `bun run build` | Type-check and build `dist/` |
| `bun run preview` | Preview the production build locally |
| `bunx tsc --noEmit` | Type-check only |

Builds stay small: primitives you never call tree-shake out (model text
included), animation clips load as tiny lazy chunks, and every bundled model is
re-encoded at build time with a compact `pc2!` format — texture pixels
base64-packed two per byte, floats quantized to visually-lossless precision —
that the parser decodes transparently. The full demo — engine plus five models —
is ~33 KB gzipped.

## Project layout

```text
index.html              Demo entry point
editor_animation.html   Animation Editor (dev-only, never built)
src/main.ts             The app: init/update over the shared scene
src/run.ts              Harness: shared scene + camera, run() at a locked 60 fps
src/primitives.ts       cube()/sphere()/cylinder()/plane()/capsule() factories
src/lib/                Engine core — loader, scene graph, animator, renderer
src/assets/models/      Base models, anim sources, generated clip registries
src/assets/primitives/  Unit shapes (junction into picoCAD 2's export folder)
```

See [`CLAUDE.md`](CLAUDE.md) for the quick reference and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the developer guide. The earlier
Zelda-style game this repo used to host lives in git history (commit `60a3d51`
and earlier).

## Saving your work to GitHub (end-of-day flow)

When you're done for the day, save and upload your changes with three commands
run from the project folder:

```sh
git add -A                       # stage everything you changed
git commit -m "describe today's work"   # snapshot it locally
git push                         # upload to GitHub
```

Before or after, a few helpers:

```sh
git status        # see what changed / what's staged
git diff          # review the exact edits before committing
git log --oneline # browse past commits
```

Notes:

- `git add -A` respects `.gitignore`, so `node_modules/`, `dist/`, logs, and
  local settings are never uploaded.
- First push of a new branch needs `git push -u origin <branch>`; after that
  plain `git push` works.
- If someone else (or another machine) pushed first, run `git pull` before
  `git push` to merge their changes in.
