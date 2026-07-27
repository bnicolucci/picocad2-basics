import capsuleText from './assets/primitives/mesh_capsule.txt?raw';
import cubeText from './assets/primitives/mesh_cube.txt?raw';
import cylinderText from './assets/primitives/mesh_cylinder.txt?raw';
import planeText from './assets/primitives/mesh_plane.txt?raw';
import sphereText from './assets/primitives/mesh_sphere.txt?raw';
import { type ModelLook, PicoCad2Loader, type PicoCadModel } from './lib/loader';
import type { Object3D } from './lib/object3d';

// Every shape in assets/primitives, usable like a ready-made geometry:
//
//   const box = cube();                                  // textured, atlas tile as authored
//   const ball = sphere({ color: 4 });                   // one flat (still shaded) palette colour
//   const wall = cube({ uv: { tile: { u: 2, v: 2 } } }); // re-point to another atlas tile
//
// Each call returns a fresh Object3D ready for `scene.add`; geometry is shared,
// parsed on first use, and uploaded to the GPU once. The imports are explicit
// (no glob) and the factories are marked pure, so primitives you never call
// tree-shake out of the build along with their model text.

const loader = new PicoCad2Loader();

const make = (text: string) => {
    let model: PicoCadModel | undefined;
    return (look?: ModelLook): Object3D => (model ??= loader.parse(text)).instantiate(look);
};

// Unit-sized and centered on the origin, so `position.y = 0.5` stands a cube on
// the floor. `plane` is flat at y 0.
export const cube = /*#__PURE__*/ make(cubeText);
export const sphere = /*#__PURE__*/ make(sphereText);
export const cylinder = /*#__PURE__*/ make(cylinderText);
export const plane = /*#__PURE__*/ make(planeText);
export const capsule = /*#__PURE__*/ make(capsuleText);
