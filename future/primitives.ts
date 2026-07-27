import type { Object3D } from 'three/webgpu';
import { type ModelLook, PicoCad2Loader, type PicoCadModel } from './three';

// Every shape in assets/primitives, usable like a three.js geometry:
//
//   const box = cube();                                // textured, atlas tile as authored
//   const ball = sphere({ color: 4 });                 // one flat (still shaded) palette colour
//   const wall = cube({ uv: { tile: { u: 2, v: 2 } } }); // re-point to another atlas tile
//
// Each call returns a fresh Object3D ready for `scene.add`; geometry is always
// shared, and each distinct look gets one cached material variant.

const texts = import.meta.glob(['./assets/primitives/mesh_*.txt', '!./assets/primitives/*-anim-*.txt'], {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const loader = new PicoCad2Loader();
const models = new Map<string, PicoCadModel>();

/** The shared model behind a primitive (`cube` -> `mesh_cube.txt`), parsed on first use. */
export function primitive(name: string): PicoCadModel {
    let model = models.get(name);
    if (!model) {
        const text = texts[`./assets/primitives/mesh_${name}.txt`];
        if (!text) throw new Error(`no primitive "${name}" — add src/assets/primitives/mesh_${name}.txt`);
        model = loader.parse(text);
        models.set(name, model);
    }
    return model;
}

const make =
    (name: string) =>
    (look?: ModelLook): Object3D =>
        primitive(name).instantiate(look);

// Unit-sized and centered on the origin, so `position.y = 0.5` stands a cube on
// the floor. `plane` is flat at y 0.
export const cube = make('cube');
export const sphere = make('sphere');
export const cylinder = make('cylinder');
export const plane = make('plane');
export const hexprism = make('hexprism');
