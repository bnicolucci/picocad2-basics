# picoCAD2 minimal — a tiny WebGL2 framework for picoCAD2 models

A zero-dependency framework for making small retro 3D scenes/games from picoCAD2
models, with a deliberately simple, beginner-friendly coding style: import the
shared `scene`/`camera`, build things in `init`, move them in `update`. The
engine (`src/lib/`) parses picoCAD2 `.txt` models, keeps their node graphs live,
and draws them palette-shaded at chunky retro resolution.

The old Zelda-style demo game was removed (recoverable from git history, e.g.
commit `60a3d51`). `src/main.ts` is now the demo scene and the reference for how
code here should look.

**See [ARCHITECTURE.md](ARCHITECTURE.md)** for the developer guide. This file is
the quick reference.

## Package manager
Use **bun** / **bunx**. Never npm/npx.
- Install: `bun install`
- Dev server: `bun run dev`
- Build: `bun run build`
- Type-check: `bunx tsc --noEmit`

## Code style
- No comments unless the WHY is non-obvious
- Prefer targeted edits over rewrites
- No premature abstractions
- New code follows `src/main.ts`'s shape: no renderer/matrix/WebGL calls in user
  code — objects, `scene.add`, `run({ init, update })`

## Layout

```
src/
  main.ts        the app (demo scene): init/update over the shared scene
  run.ts         harness: shared scene + camera, run({ init, update }) @ 60 fps
  primitives.ts  cube() / sphere() / plane() ... factories -> Object3D
  controls.ts    GENERATED action buttons (editor_controls.html); move/held/pressed
  editor_animation.ts  dev-only Animation editor page (editor_animation.html)
  editor_controls.ts   dev-only Controls editor page (editor_controls.html)
  editor_entity.ts     dev-only Entity editor page (editor_entity.html)
  editor_dungeon.ts    dev-only Dungeon editor page (editor_dungeon.html)
  dungeon_play.ts      dev-only dungeon preview page (dungeon_play.html)
  lib/           engine core (no app logic)
  assets/        models + primitives (.txt), generated *_animations.ts clips,
                 GENERATED entities.ts registry, dungeon/ part libraries,
                 GENERATED dungeons/*.ts, palettes/
```

| File | Role |
|---|---|
| `index.html` | Owns the `PAGE` config — the page's single source of truth: `width`/`height` (fixed canvas size; omit both to fill the window), `retroScale`, `background`, `pageBackground`. An inline script turns it into CSS during HTML parse, so the very first paint is already the right size and colour (a JS-module config runs after first paint in dev and flashes — that's why it lives here). |
| `src/run.ts` | Exports the shared `scene` and `camera`; reads `PAGE` for `retroScale` and `background`. `run({ init, update })` runs `init` once, then `update(dt, t)` at a locked 60 steps/s, advances animators, renders. |
| `src/primitives.ts` | `cube({ color: 4 })`, `plane({ uv: { repeatU: 10 } })` … factories. Explicit imports + pure-annotated factories, so primitives you never call tree-shake out of the build with their model text. Geometry shared, parsed on first use. |
| `src/lib/picocad2_compact.ts` | Compact `pc2!` wire encoding for parsed models: tuples, bit-packed face flags, defaults omitted, pixels base64-packed (2/byte), floats quantized (1e-5; UVs 1e-3 px). The `picocad-compact` build plugin in `vite.config.ts` encodes every bundled `.txt?raw` model; `parsePicoCad2` decodes transparently. Dev uses raw files. |
| `src/lib/object3d.ts` | `Object3D` (position / rotation in radians / scale, `add`/`remove`, `getObjectByName`), `Scene` (+ `background` hex), `flattenScene` (tree → renderer `Instance[]`; the picoCAD X-mirror is applied at model roots). |
| `src/lib/loader.ts` | `new PicoCad2Loader().parse(text)` → `PicoCadModel`; `.instantiate(look?)` returns an `Object3D` tree mirroring the picoCAD node graph. `ModelLook`: flat `color`, per-instance `uv` (tile / repeat), or `part` — one named node of a multi-part file, sharing the file's single GPU upload (`model.parts` lists them). |
| `src/lib/animator.ts` | `playClip(model, clip)` binds by node name; animates pos/rot/scale/visibility and `tex` UV scrolls; `clipDuration`; `advanceAnimators` (called by the run loop). Same code path in editor preview and app. |
| `src/lib/picocad2.ts` | The picoCAD2 file format: types (incl. motion tracks + `PicoCadAnimationClip`), `parsePicoCad2`, `buildTexture`, `computeGraphBounds`. |
| `src/lib/picocad2_animation_extract.ts` | Pure extractor: anim-export files → verbatim track copies → `generateAnimationsModule` (registry text). |
| `src/lib/mesh.ts` | `buildModelGraph` walks a model into a live node tree + per-node GPU meshes (position, uv, normal, colorIndex, faceFlags; per-face vertex ranges for UV animation). |
| `src/lib/renderer.ts` | Minimal WebGL2. `render(viewProj, lightDir, instances)` uploads models on first sight (cached) and groups by model, then draws each mesh ONCE with `drawElementsInstanced` — the per-instance matrix / colour override / UV transform are vertex attributes (divisor 1), not uniforms, so draw calls scale with distinct meshes on screen, not object count (`renderer.drawCalls` reports the last frame). Palette shading with checker dither; `renderer.retroScale` for the pixelated upscale; `setBackground(hex)`. |
| `src/lib/camera.ts` | `PerspectiveCamera` (`position.set` + `lookAt`) and the view-space headlight that gives the picoCAD dither look. |
| `src/lib/input.ts` | Keyboard + gamepad input. Movement is ALWAYS WASD/arrows/stick via `move()` → `{x, z}`; named action buttons come from the generated `src/controls.ts`. `pressed(name)` is true for exactly one update step; the run loop consumes edges (`stepInput`) and polls the pad (`pollGamepad`). |
| `src/controls.ts` | GENERATED by the Controls editor: the action list (4 max) plus typed wrappers — `ActionName` is a literal union, so `pressed('shoot')` autocompletes and a stale name is a compile error. App code imports `move`/`held`/`pressed` from here. |
| `src/lib/entity.ts` | Entities: `EntityBlueprint` (parts of models/primitives + `forward`/`radius`/`tags`), `instantiateEntity`, and `faceToward(obj, x, z)` — yaws an object so its nose points along a movement vector. `forward` is the VISIBLE nose direction (what you see in picoCAD2/the editor, any of 6 axes — never raw file space, which the X-mirror makes unobservable). `Object3D.forward` holds it. |
| `src/assets/entities.ts` | GENERATED by the Entity editor: the blueprint registry + typed `spawnEntity('pig')` (`EntityName` union). Imports only the mesh texts entities use, so the rest tree-shakes. |
| `src/lib/dungeon.ts` | Dungeons: grid of rooms, room = tile grid (pit/floor/wall) + doors + sparse part/entity overlays. `resolveTile` decides what is on a tile (painted part, else the auto pick — a deterministic per-tile hash for floors, the file's first part for walls); `buildRoom`/`buildDungeon` turn that into `Object3D` groups. Tiles are 1 world unit. |
| `src/assets/dungeon/*.txt` | Part libraries: the FILE is a category (`walls`, `grounds`, `props`), each named mesh node is a part. Author on `y = 0`, centred, ~1 tile wide — placed at a uniform tile scale. Another junction into the picoCAD2 app folder. |
| `src/assets/dungeons/*.ts` | GENERATED by the Dungeon editor: the map data plus `buildDungeon()` / `buildRoom(rc, rr)` wired to that dungeon's own asset imports. |
| `src/lib/editorViewport.ts` | Shared editor viewport: renderer + scene + orbit camera + free-run loop + `project()` for DOM overlays; used by the entity editor and `animPreview`. |
| `src/lib/editorIcons.ts` | `renderIcons([[key, object]])` → PNG data URLs: small 3/4-view renders through the REAL renderer (same meshes/palette/shading), each framed from its own bounds. One-shot — the GL context is dropped after baking. |
| `src/lib/animPreview.ts` | The Animation editor's single-model preview over `editorViewport`. |
| `src/lib/math.ts` | Column-major mat4 helpers: `identity`, `multiply`, `compose` (T·R·S), `perspective`, `lookAt`. |
| `src/assets/models/animations.ts` | `loadAnimationClips(mesh)` — looks up the generated `<mesh>_animations.ts` registry. |

## The coding style

`src/main.ts` is the template:

```ts
// Canvas size/aspect/colours live in index.html's PAGE config, not here.
const box = cube({ uv: { tile: { u: 2, v: 2 } } });
box.position.set(-4.5, 1.5, 0);
scene.add(box);

const pig = new PicoCad2Loader().parse(pigText).instantiate();
scene.add(pig);

function update(dt: number, t: number): void {
    box.rotation.y += dt;
}

run({ init, update });
```

Objects are `Object3D`s. An instantiated model keeps its picoCAD node graph
live, so sub-nodes can be grabbed with `getObjectByName` and animation clips can
move them.

Input follows the same shape — read state, never bind keys:

```ts
import { move, pressed } from './controls';

const m = move();                       // {x, z} -1..1, WASD/arrows/stick
pig.position.x += m.x * SPEED * dt;
if (pressed('shoot')) fire();           // named action, one step per press
```

Actions are curated in `/editor_controls.html` (dev-only): rename, click a key
cap and press a key to rebind, assign a gamepad button, Save. Movement keys are
fixed by design.

## Animations (base model + tiny tracks file)

picoCAD2 animation exports are near-full copies of the model — shipping five of
them would duplicate the mesh five times (`thinktank-anim-shoot.txt` is ~290 KB;
its extracted `thinktank_animations.ts` is ~1.5 KB). Instead:

- **Sources**: `<mesh>-anim-<clip>.txt` (also `<mesh>_anim_<clip>.txt`) sit
  beside the base `<mesh>.txt` in `assets/models/` (or `assets/primitives/`).
  They are editor input only and never reach a production build.
- **Editor**: `/editor_animation.html` (dev-only). Pick a mesh, curate which
  clips/nodes to keep, preview on the real animator, Save. Saving regenerates
  `src/assets/models/<mesh>_animations.ts` — just the motion tracks, verbatim —
  via the `editor-save` middleware in `vite.config.ts`. Include/exclude state
  round-trips out of the generated file itself.
- **Runtime**: `loadAnimationClips('thinktank')` + `playClip(model, clips.shoot)`.
  Clips bind by node name; the run loop advances all playing animators. `tex`
  segments (UV scrolls — e.g. thinktank's `shoot` squeezes the driver's eyes
  shut by scrolling two face UVs) rewrite the shared vertex buffer —
  fine for previews and one-off instances.

## Model space

Animation deltas: `pos` adds, `rot` adds in turns (×2π), **`scale` is relative
— `rest × (1 + delta)`**, so a node resting at 0.25 with delta 3 lands at 1.0
(identical to adding whenever the rest scale is 1). `visible` segments mean
"hidden during this window" and the clip owns visibility while it plays, so a
node authored hidden (e.g. a muzzle flash) is revealed by its clip and
restored to hidden on `stop()`. A clip carries motion only — rest transforms
always come from the base model, so a node's rest scale there must match what
the animation was authored against.

picoCAD2 models are X-mirrored vs. a right-handed WebGL world. `flattenScene`
applies that as one mirror at each model root; face normals are negated to match
the winding flip, and the shader flips normals on back faces for lighting. Node
`transform.rot` in model files is radians; animation `rot` deltas are turns
(×2π at playback).

## The format-conversion question

You do **not** need a separate on-disk format (glTF, custom binary with normals,
etc.). The picoCAD2 `.txt` is already parseable JSON; `buildModelGraph` converts
it at load into exactly the GPU-friendly layout WebGL wants — triangulated,
interleaved, with computed normals. On-disk files stay raw/file-faithful; build
size is handled separately by the `picocad-compact` vite plugin, which re-encodes
bundled models with `picocad2_compact.ts` (`pc2!` prefix, decoded transparently
by `parsePicoCad2`) at build time only.

## Dungeons (map data + part libraries)

- **Parts**: `src/assets/dungeon/<category>.txt` — the file is the category
  (`walls` / `grounds` / `props`), each named mesh node is a part. Author on
  the ground plane (`y = 0`), centred on x/z, ~1 tile wide; parts are placed at
  a uniform tile scale, so what you model is what you get.
- **Editor**: `/editor_dungeon.html` (dev-only). Paint tiles, choose the part
  per tile, drop entities, toggle doors, Save → `src/assets/dungeons/<name>.ts`
  via the `save-dungeon` middleware. State round-trips out of those files.
  Drag to paint, ctrl-click picks the tile under the cursor as the brush;
  clicking a swatch opens its part list, each part shown as a 3/4-view render
  of the real model. Brushes are additive — Pit wipes a tile, and Prop/Entity
  lists start with a "None" entry that clears that overlay.
- **Preview**: "Preview in game" saves, then opens `/dungeon_play.html`
  (`src/dungeon_play.ts`, dev-only) — the real `run()` harness with the
  `player`-tagged entity, tile collision and a camera that slides room to room.
  Only the current room draws.
- **Runtime**: `import { buildDungeon } from './assets/dungeons/<name>'` then
  `scene.add(buildDungeon())`.

The 2D map and the 3D preview both go through `resolveTile`, and map colours
are sampled from each part's real texture, so the map always agrees with what
the game builds. Entity placements store a plain name — a blueprint deleted
since the last Save spawns nothing rather than throwing.

## Asset location gotcha

`src/assets/primitives` and `src/assets/dungeon` are directory **junctions**
into the picoCAD2 app's own folders (`%AppData%/Roaming/picocad2/…`) so fresh
exports appear here live. Vite resolves those imports to the real path — never
filter module ids by a `src/assets` path prefix (the compact plugin learned
this the hard way).
