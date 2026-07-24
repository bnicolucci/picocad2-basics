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

## Files (all of it)

| File | Role |
|---|---|
| `src/main.ts` | Entry point. Loads the model, sets up camera + renderer, runs the render loop. The `model` object (position/rotation/scale) is what you mutate to control the model. |
| `src/model.txt` | The picoCAD2 model being displayed (plain JSON). Swap this file to load a different model. |
| `src/picocad2.ts` | The picoCAD2 file format: types, `parsePicoCad2`, and `buildTexture` (indexed palette → GPU index + palette textures). |
| `src/mesh.ts` | `buildModelMeshes` walks the model graph and produces flat interleaved GPU vertex buffers (position, uv, normal, colorIndex, faceFlags) with baked node matrices. This is the "WebGL-friendly" conversion. |
| `src/renderer.ts` | Minimal WebGL2 renderer: one palette-shaded program, uploads meshes/textures, draws. |
| `src/camera.ts` | Perspective orbit camera + mouse-drag / wheel controls. |
| `src/math.ts` | Column-major mat4 + quaternion helpers. |

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
