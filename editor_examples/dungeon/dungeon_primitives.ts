// Loads picoCAD2 primitive .txt files into renderable meshes and builds clean
// flat-colour materials, so the dungeon reads as distinct floor / wall / player
// surfaces instead of the primitives' rainbow debug atlas. Shared by the editor
// preview (EditorRenderer) and the runtime (core Renderer) — both consume the
// same { meshId, builtMesh } and material shape.

import { type BuiltMesh, buildLocalMeshFromMeshAsset, buildMeshAssetFromPicoNode } from '../mesh';
import { parsePicoCad2, type PicoCad2Node } from '../picocad2';

export type FlatMaterial = {
    width: number;
    height: number;
    pixels: Uint8Array;
    palettePixels: Uint8Array;
    transparentIndex: number;
};

export type LoadedMesh = {
    meshId: string;
    builtMesh: BuiltMesh;
};

function firstMeshNode(node: PicoCad2Node, path: number[]): { node: PicoCad2Node; path: number[] } | null {
    if (node.mesh?.vertices?.length && node.mesh.faces?.length) return { node, path };
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
        const hit = firstMeshNode(children[i]!, [...path, i]);
        if (hit) return hit;
    }
    return null;
}

// Parses a primitive and returns its first mesh in canonical local space
// (primitives are authored unit-sized at the origin with identity transforms,
// so no parent-matrix accumulation is needed). Placement scale/position is
// applied per-instance by the caller.
export function loadPrimitiveMesh(name: string, text: string): LoadedMesh {
    const data = parsePicoCad2(text);
    if (!data.graph) throw new Error(`Primitive "${name}" has no graph`);
    const found = firstMeshNode(data.graph, []);
    if (!found) throw new Error(`Primitive "${name}" has no mesh`);
    const modelId = `dungeon:${name}`;
    const asset = buildMeshAssetFromPicoNode(found.node, modelId, found.path);
    if (!asset) throw new Error(`Primitive "${name}" mesh could not be built`);
    return { meshId: `mesh:${modelId}`, builtMesh: buildLocalMeshFromMeshAsset(asset) };
}

type RGB = [number, number, number];

function scaleRgb(c: RGB, f: number): RGB {
    return [c[0] * f, c[1] * f, c[2] * f];
}

// A solid-colour material. Every texel is one palette index, so textured
// primitive faces (which sample the index texture at their UVs) resolve to this
// one colour regardless of their authored UVs. The three palette rows are the
// lit / mid / dark shading levels the shader picks by face angle, so surfaces
// still get depth cues.
export function makeFlatMaterial(base: RGB, index = 1): FlatMaterial {
    const size = 4;
    const pixels = new Uint8Array(size * size).fill(index);
    const palettePixels = new Uint8Array(16 * 3 * 4);
    const rows: RGB[] = [base, scaleRgb(base, 0.72), scaleRgb(base, 0.5)];
    for (let row = 0; row < 3; row++) {
        const c = rows[row]!;
        const o = (row * 16 + index) * 4;
        palettePixels[o + 0] = Math.round(Math.min(1, c[0]) * 255);
        palettePixels[o + 1] = Math.round(Math.min(1, c[1]) * 255);
        palettePixels[o + 2] = Math.round(Math.min(1, c[2]) * 255);
        palettePixels[o + 3] = 255;
    }
    // No index equals the fill index, so nothing is ever discarded as transparent.
    return { width: size, height: size, pixels, palettePixels, transparentIndex: index === 0 ? 1 : 0 };
}

// Dungeon palette (base colours; the material darkens rows 1/2 for shading).
export const DUNGEON_COLORS = {
    floor: [0.42, 0.40, 0.36] as RGB,
    wall: [0.34, 0.38, 0.5] as RGB,
    player: [0.95, 0.82, 0.25] as RGB,
} as const;

// Column-major TRS matrix (translate * scale) with an X reflection folded in.
// Every model in this renderer is expected mirrored on X (the shader's
// gl_FrontFacing lighting compensation assumes it — see scene.ts /
// renderer.ts); negating scale.x reverses winding to match, with no visible
// effect on the symmetric box/capsule primitives.
export function dungeonInstanceMatrix(pos: [number, number, number], scale: [number, number, number]): Float32Array {
    const [x, y, z] = pos;
    const [sx, sy, sz] = scale;
    return new Float32Array([-sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
}

// Same as dungeonInstanceMatrix but with a Y-axis rotation folded in (for
// spinning props). Columns are the rotated+scaled basis vectors; the X mirror
// rides on the X scale exactly as above, so winding still matches the shader's
// gl_FrontFacing assumption.
export function dungeonPropMatrix(pos: [number, number, number], scale: [number, number, number], rotY: number): Float32Array {
    const [x, y, z] = pos;
    const [sx, sy, sz] = scale;
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    return new Float32Array([
        -sx * c, 0, sx * s, 0,
        0, sy, 0, 0,
        sz * s, 0, sz * c, 0,
        x, y, z, 1,
    ]);
}
