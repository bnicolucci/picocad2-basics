// The format-neutral intermediate representation that sits between a reader
// (picoCAD2 .txt, a Blender export, …) and the RM1 writer. Readers own all
// source-format quirks; the writer only knows RM1.
//
// IR invariants — a reader MUST satisfy these:
//   * right-handed, Y-up, faces wound CCW seen from outside
//   * vertices are node-local; `ids` are node-local and 0-based
//   * `uvs` are normalized 0..1 with a TOP-LEFT origin (V down), 2 per corner
//   * every face has >= 3 corners (drop degenerates at read time)
//   * palette channels are 0..255

export type RmFace = {
    /** Node-local, 0-based, >= 3 entries. */
    ids: number[];
    /** 2 per corner, same order as `ids`. Normalized, top-left origin. */
    uvs: number[];
    /** Palette index 0..15, used when the face is untextured. */
    color: number;
    notex: boolean;
    noshade: boolean;
    dbl: boolean;
};

export type RmNode = {
    name: string;
    /** Index into the node list, or ROOT_PARENT for a root. */
    parent: number;
    visible: boolean;
    pos: [number, number, number];
    /** Radians, XYZ euler; matrix = T * R * S. */
    rot: [number, number, number];
    scale: [number, number, number];
    /** Flat xyz triples, node-local. May be empty (a pure transform node). */
    verts: number[];
    faces: RmFace[];
};

export type RmModel = {
    /** Depth-first: a child always follows its parent. */
    nodes: RmNode[];
    /** Exactly 16 RGB triples, channels 0..255. */
    palette: [number, number, number][];
    /** 16 palette-index remaps for the mid and dark shade rows. */
    shade1: number[];
    shade2: number[];
    /** texWidth * texHeight palette indices, row-major, TOP row first. */
    texture: Uint8Array;
    texWidth: number;
    texHeight: number;
    /** Palette index discarded when rasterising, or NO_INDEX. */
    transparentIndex: number;
    backgroundIndex: number;
};

export const MAGIC = 'RM1\0';
export const VERSION = 1;
export const HEADER_BYTES = 64;
export const PALETTE_BYTES = 80;
export const NODE_BYTES = 48;
/** Sentinel for "this node is a root" and for an absent palette index. */
export const ROOT_PARENT = 255;
export const NO_INDEX = 255;
/** UVs are stored as int16 in units of 1/512 — a quarter texel at 128px. */
export const UV_SCALE = 512;

export const FLAG_HAS_TEXTURE = 1;
export const FLAG_POS16 = 4;
export const FLAG_IDX16 = 8;

export const FACE_NOTEX = 16;
export const FACE_NOSHADE = 32;
export const FACE_DBL = 64;

/** Sections are 4-byte aligned so a loader can cast straight to typed arrays. */
export function align4(n: number): number {
    return (n + 3) & ~3;
}
