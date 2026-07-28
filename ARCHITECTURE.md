# Architecture & Extension Guide

How the framework is structured and how to extend it. It reflects the code as it
stands — if you change the code, change this too.

> The old Zelda-style room-crawler game (and its guide, including the ECS
> evolution path) was removed from the working tree; it lives in git history
> (commit `60a3d51` and earlier).

---

## 1. Big picture

A zero-dependency WebGL2 framework for picoCAD2 models with a deliberately
simple user-facing style — an app is one file shaped like `src/main.ts`:

```
index.html      PAGE config: canvas size/colours/retroScale — turned into CSS
                during HTML parse, so the first paint is already right (a
                module-loaded config would flash)
init()          runs once: place the camera, scene.add your objects
update(dt, t)   runs at a locked 60 fps: move objects
run({ init, update })
```

User code never touches WebGL, matrices, or the renderer. It works with
`Object3D`s (position / rotation / scale), the shared `scene` and `camera`
from `run.ts`, and factories/loaders that hand out objects.

## 2. Data flow, one frame

```
scene (Object3D tree)
  └─ flattenScene()        object3d.ts: compose world matrices down the tree,
                           X-mirror at model roots → Instance[] (per model:
                           per-mesh matrices, uv/color look, vertex updates)
      └─ renderer.render() renderer.ts: upload-on-first-sight + sort by model,
                           palette-shaded draw at retroScale resolution,
                           CSS-upscaled with image-rendering: pixelated
```

Before rendering, the run loop calls `advanceAnimators(t)` — every playing
`PicoCadAnimator` writes new local transforms (and UV-scrolled vertices) into
its model's nodes, which `flattenScene` then picks up like any other change.

## 3. File guide

```
src/
  main.ts        the app — also the style reference for new code
  run.ts         shared scene/camera + run(): canvas sizing, fixed 60 fps loop
  primitives.ts  cube()/sphere()/cylinder()/plane()/capsule()
  controls.ts    GENERATED action buttons + typed move/held/pressed wrappers
  editor_animation.ts  dev-only Animation editor (editor_animation.html)
  editor_controls.ts   dev-only Controls editor (editor_controls.html)
  editor_entity.ts     dev-only Entity editor (editor_entity.html)
  editor_dungeon.ts    dev-only Dungeon editor (editor_dungeon.html)
  dungeon_play.ts      dev-only dungeon preview (dungeon_play.html)
  lib/
    math.ts      mat4: identity, multiply, compose (T·R·S), perspective, lookAt
    input.ts     keyboard+gamepad: move()/held()/pressed() + run-loop hooks
    picocad2.ts  file-format types (+ motion tracks), parse, buildTexture, bounds
    mesh.ts      buildModelGraph: model → live node tree + per-node GPU meshes
    object3d.ts  Object3D/Scene/Vector3 + flattenScene
    loader.ts    PicoCad2Loader.parse(text).instantiate(look?) → Object3D
    entity.ts    EntityBlueprint / instantiateEntity / faceToward
    dungeon.ts   Dungeon data model + resolveTile / buildRoom / buildDungeon
    animator.ts  playClip / PicoCadAnimator / clipDuration / advanceAnimators
    animPreview.ts  the editor's orbit-camera single-model preview
    editorPage.ts / editorViewport.ts  shared dev-editor chrome + viewport
    picocad2_animation_extract.ts  pure clip extractor + registry generator
    picocad2_compact.ts  pc2! wire encoding (build plugin encodes, parse decodes)
    renderer.ts  WebGL2: render(Instance[]) with upload-once cache, retroScale
    camera.ts    PerspectiveCamera + view-space headlight
  assets/
    primitives/  mesh_*.txt unit shapes
    models/      <mesh>.txt base models
                 <mesh>-anim-<clip>.txt animation sources (dev-only editor input)
                 <mesh>_animations.ts generated clip registries
                 animations.ts  loadAnimationClips(mesh) registry lookup
    dungeon/     <category>.txt part libraries (walls / grounds / props)
    dungeons/    <name>.ts generated dungeons
    entities.ts  generated entity registry
```

Dependency direction is strictly **app → lib**; `lib/` knows nothing about any
particular scene.

## 4. Models & instancing

`PicoCad2Loader.parse` builds shared geometry once (`buildModelGraph`: one GPU
mesh per picoCAD node, transforms NOT baked). `.instantiate(look?)` returns a
fresh `Object3D` tree mirroring the node graph — cheap, geometry is shared and
uploaded to the GPU on first draw (the renderer's upload-once cache).

Per-instance look:
- `{ color: 4 }` — every face flat palette colour 4 (still shaded)
- `{ uv: { tile: { u, v } } }` — re-point the model's UVs at another 16px atlas tile
- `{ uv: { repeatU, repeatV } }` — tile the texture across the surface
- `{ part: 'pillar' }` — instantiate only that named node. A part library puts
  several independent things in one file (`walls.txt` = wall / pillar /
  castley); every part still shares the file's single GPU upload, so a room of
  240 tiles costs three texture binds. `model.parts` lists the names.

## 5. Animation pipeline

1. Export clips from picoCAD2 as `<mesh>-anim-<clip>.txt` beside the base model.
2. Open `/editor_animation.html` in dev; curate clips/nodes; preview; **Save**.
3. Save POSTs generated module text to the `editor-save` middleware
   (vite.config.ts), which writes `src/assets/models/<mesh>_animations.ts` —
   motion tracks only, copied verbatim (~KBs instead of a full model copy per clip).
4. At runtime: `loadAnimationClips('<mesh>')` then `playClip(model, clip)`.

Clips bind by node **name**. The animator applies deltas on top of each node's
rest transform: pos/scale add, rot adds in turns (×2π), `visible` segments hide
a node inside their window, `tex` segments scroll a face's UVs (rewrites the
shared vertex buffer — per-model, not per-instance).

Anim sources and the editor page are dev-only: the editor page is not a build
input, and nothing else globs `-anim-` files, so production builds ship only the
base model + the small registries.

## 6. Input

The PICO-8 split: **movement is fixed** (WASD/arrows + gamepad left stick and
d-pad, read via `move()` → `{x, z}` with diagonals normalized), and **actions
are a small named set** (4 max) defined in the generated `src/controls.ts` and
curated in `/editor_controls.html` — rename an action, click its key cap and
press a key to rebind, pick a gamepad button, Save.

`held(name)` is true while down; `pressed(name)` is true for exactly one update
step per press — the run loop consumes press edges after each step
(`stepInput`) and polls the gamepad once per frame (`pollGamepad`), so a press
is never missed or double-counted regardless of frame rate. Action names are a
literal type: renaming one in the editor turns stale `pressed('...')` calls
into compile errors.

## 7. Dungeons

A dungeon is a grid of **rooms**; a room is a tile grid (`0` pit / `1` floor /
`2` wall) plus door edges and sparse overlays — which authored part fills a
tile, which prop stands on it, which entity spawns there. Tiles are one world
unit; room `(rc, rr)` starts at world `X = rc*tileCols, Z = rr*tileRows`.

Parts come from `src/assets/dungeon/<category>.txt`: the FILE is the category
(`walls`, `grounds`, `props`) and each named mesh node in it is a part. Author
them standing on `y = 0`, centred on x/z, about a tile wide — they are placed at
a uniform tile scale, so what you model is what you get.

```
/editor_dungeon.html   paint rooms, place entities, Save
  └─ src/assets/dungeons/<name>.ts     GENERATED: the data +
       buildDungeon() / buildRoom(rc, rr) wired to its own asset imports
          └─ lib/dungeon.ts  resolveTile → buildRoom → Object3D group
  └─ "Preview in game" → /dungeon_play.html?dungeon=<name>
       saves first (the play page loads the generated file), then walks it
       in the real run() harness
```

Painting: drag to paint, ctrl-click is an eyedropper that makes the brush
whatever the clicked tile shows. Clicking a swatch opens a floating list of
that category's parts, each with a 3/4-view render of the real model
(`lib/editorIcons.ts` — the actual renderer on an off-screen canvas, so an
icon can't drift from what you get in play). Every brush is additive; removing
things is a menu choice, not a modifier — Pit wipes a tile, and the Prop and
Entity lists start with a "None" entry that clears that overlay.

`resolveTile` is the single source of truth for what is on a tile: the painted
part when there is one, otherwise the auto pick (a deterministic per-tile hash
for floors, the file's first part for walls). The editor's 2D map colours tiles
through it too — sampling each part's real texture colour — so the map and the
3D preview can never disagree with the game.

Entity placements store a plain name, so a blueprint deleted from the entity
registry since the last Save spawns nothing instead of throwing. `buildRoom`
names each one `entity:<name>`, so a game can find its placements.

`src/dungeon_play.ts` is the dev-only preview that button opens: the same
`run()` loop as the app, the entity tagged `player` (its painted placement if
there is one, re-parented out of its room group so room culling can't hide it),
circle-vs-tile collision through `isSolidAt`, and a fixed three-quarter camera
that slides to the neighbouring room when you walk through a door. Only the
room you are in draws — plus the one you just left, while the camera is still
sliding.

## 8. Adding things

- **A new primitive**: drop `mesh_<name>.txt` in `assets/primitives/`, add
  `export const <name> = make('<name>')` in `primitives.ts`.
- **A new model**: drop `<mesh>.txt` in `assets/models/`, import it with
  `?raw`, `new PicoCad2Loader().parse(text).instantiate()`.
- **A new clip**: export `<mesh>-anim-<clip>.txt`, open the editor, Save.
- **Engine features** (e.g. per-instance palette swap): extend `ModelLook` →
  thread through `InstantiatedModel`/`flattenScene` → a uniform in
  `renderer.ts`. Follow how `color` is wired.

## 9. Rendering notes

- **Retro look**: render at `renderer.retroScale` × canvas resolution, CSS-upscaled
  pixelated. No antialiasing (AA blends convex edges into dark hairlines).
- **Instancing**: per-instance data (model matrix, colour override, UV
  transform) lives in vertex attributes with divisor 1, not uniforms, so every
  copy of a mesh goes out in ONE `drawElementsInstanced` call. Draw calls =
  the number of distinct *meshes* on screen, not the number of objects: 400
  cubes with 400 different looks cost one call, and a 240-tile dungeon room
  costs 26 instead of 261. `renderer.drawCalls` reports the last frame's count.
  Each mesh keeps its own instance buffer, refilled per frame; `flattenScene`
  is unchanged, so nothing in user code or the scene graph had to move.
- **Palette shading**: fragment shader samples an index texture, then a 16×3
  palette (lit / mid / dark rows) picked by a stepped headlight term with a
  checker dither between bands — the picoCAD look.
- **Mirror**: picoCAD2 model space is X-mirrored vs. our world;
  `flattenScene` inserts one mirror matrix at each model root, and mesh
  normals are pre-negated to match the winding flip.
- **Fixed timestep**: `run()` steps `update` at exactly 60 Hz regardless of
  display refresh; up to 6 catch-up steps after a slow frame.

## 10. Build size

Only what the app imports ships: primitives are explicit pure-annotated
factories (unused ones tree-shake out with their model text), anim sources and
the editor page are dev-only, and clip registries load as tiny lazy chunks. At
build time the `picocad-compact` vite plugin re-encodes every bundled
`.txt?raw` model via `picocad2_compact.ts` — tuple JSON, no whitespace,
bit-packed face flags, texture pixels base64-packed two per byte, floats
quantized to visually-lossless precision (1e-5 units; UVs 1e-3 px), `pc2!`
prefix — and `parsePicoCad2` decodes it transparently (a thinktank-sized model
drops to ~29% of its raw bytes). Dev always serves the raw files. Note `src/assets/primitives`
is a junction into the picoCAD2 app's export folder, so the plugin matches any
`.txt?raw` id rather than filtering by path.
