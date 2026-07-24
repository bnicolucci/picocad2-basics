# picoCAD2 minimal — load a model, control it with code

A bare-bones WebGL2 viewer for picoCAD2 `.txt` models. It parses one model
file, builds GPU meshes, and renders it with a perspective camera. There is no
engine, ECS, editor, scene system, or physics — just enough to load a model
and manipulate it from plain TypeScript.

## Package manager
Use **bun** / **bunx**. Never npm/npx.
- Install: `bun install`
- Dev server: `bun run dev`
- Type-check: `bunx tsc --noEmit`

## Code style
- No comments unless the WHY is non-obvious
- Prefer targeted edits over rewrites
- No premature abstractions

## Layout

```
src/
  main.ts        app entry: loads assets, wires input + the game loop
  game.ts        game logic: rooms, player, camera, transitions
  lib/           reusable engine core (no game logic)
  assets/        picoCAD2 model + primitive .txt files
```

Engine core lives in `src/lib/`; `main.ts` and game-specific code (`game.ts`)
stay above it, so the library stays clean as the game grows.

| File | Role |
|---|---|
| `src/main.ts` | Entry point. Uploads every primitive once, tracks held keys, runs the loop (`game.update` → `renderer.render`). |
| `src/game.ts` | The game: room definitions, WASD player, angled top-down camera, doorway transitions. Emits an `Instance[]` for the renderer each frame. |
| `src/lib/picocad2.ts` | The picoCAD2 file format: types, `parsePicoCad2`, and `buildTexture` (indexed palette → GPU index + palette textures). |
| `src/lib/mesh.ts` | `buildModelMeshes` walks the model graph into flat interleaved GPU vertex buffers (position, uv, normal, colorIndex, faceFlags) with baked node matrices. This is the "WebGL-friendly" conversion. |
| `src/lib/model.ts` | `buildModel(text)` → CPU-side `{ meshes, texture, bounds }` ready for `Renderer.upload()`. |
| `src/lib/renderer.ts` | Minimal WebGL2 renderer. `upload(meshes, texture)` returns a `ModelHandle`; `render(viewProj, lightDir, instances)` draws an `Instance[]` (`{ model: handle, matrix }`). One palette-shaded program, no AA, half-res retro upscale. |
| `src/lib/camera.ts` | Perspective camera, view-space headlight, orbit controls (unused by the game, which drives the camera directly). |
| `src/lib/math.ts` | Column-major mat4 + quaternion helpers. |
| `src/assets/**/*.txt` | picoCAD2 models (`model.txt`) and primitives (`primitives/mesh_*.txt`). |

## Game (`src/game.ts`)

A top-down-ish (angled) Zelda-style room crawler, built entirely from primitives.

- **Rooms** (`ROOMS`) are data: which walls have `doors` (and where they lead)
  plus one distinguishing `prop`. Rooms are centered at the origin; the camera
  is fixed and framed on the room, so entering a new room swaps its contents in
  place.
- **Walls** are unit `mesh_cube`s scaled into segments (`wallSegments`), leaving
  a centered gap on any wall with a door. **Floor** is a scaled `mesh_plane`.
- **Player** is `mesh_capsule` (offset `y -1.2` so its feet sit on the floor),
  moved in world XZ by WASD/arrows, clamped to the room except through aligned
  doorways. Crossing a door threshold calls `enter()`, which swaps the room and
  repositions the player at the opposite doorway.
- **Multi-object rendering**: `Game.instances()` returns floor + walls + prop +
  player as `{ model: handle, matrix }`. The renderer draws them; there is no
  scene graph — just the flat list ("minimal object list").

## Model space

picoCAD2 models are X-mirrored vs. a right-handed WebGL world. `mesh.ts` applies
that as one innermost mirror matrix per model; face normals are negated to match
the winding flip, and the shader flips normals on back faces for lighting.

## Controlling the model

`src/main.ts` exposes a `model` with `position`, `rotation` (radians, XYZ Euler),
and `scale`. Mutate them from the `update()` function (or the devtools console —
`model` and `camera` are on `window`). Each frame `main.ts` composes
`T * R * S` and passes it to the renderer.

## The format-conversion question

You do **not** need a separate on-disk format (glTF, custom binary with normals,
etc.). The picoCAD2 `.txt` is already parseable JSON; `buildModelMeshes` converts
it at load into exactly the GPU-friendly layout WebGL wants — triangulated,
interleaved, with computed normals. That conversion is cheap and happens once at
load, so a precomputed file would only save a few ms while adding a build step to
keep in sync. Keep the `.txt` + the load-time build.
