// picoCAD2 model file format: JSON with an indexed-palette `texture` and a
// `graph` node tree. Each node may hold a mesh (vertices + n-gon faces) and a
// local transform, plus child nodes.

import { decodePicoCad2Compact, PICO_CAD2_COMPACT_PREFIX } from './picocad2_compact';

// Texture size when a model file omits width/height.
export const TEXTURE_SIZE_DEFAULT = 128;

export type PicoCad2Color = [number, number, number];

export type PicoCad2Texture = {
    pixels: string; // one hex digit per pixel, width*height long
    colors: PicoCad2Color[]; // palette, channels either 0..1 or 0..255
    transparent_color?: number;
    shade_pal_1?: number[];
    shade_pal_2?: number[];
    background_color?: number;
    width?: number;
    height?: number;
};

// One motion segment from a node's `motions.tracks`. Times/positions are in
// seconds on the clip timeline; `delta` units match `prop` (world units for
// pos, turns for rot, scale factor for scale). `tex` segments scroll a face's
// UVs by `step` pixels per frame. Kept verbatim-shaped so extracted clips are
// byte-faithful to the picoCAD2 export.
export type PicoCad2MotionSegment = {
    axises?: readonly string[];
    prop?: string; // 'pos' | 'rot' | 'scale' | 'visible' | 'tex'
    curve?: string;
    start?: number;
    stop?: number;
    delta?: number;
    pingpong?: boolean;
    times?: number;
    frames?: number;
    step?: number;
    face_id?: number;
    return_uv?: boolean;
    icon?: number;
};

// A named animation clip extracted from a "<mesh>-anim-<name>.txt" export:
// just the animated nodes' tracks, so one base model + N tiny clips replaces
// N full model copies.
// Readonly so `as const` generated registries satisfy it directly.
export type MotionTracks = readonly (readonly PicoCad2MotionSegment[])[];

export type PicoCadAnimationClip = {
    /** node name -> that node's 4-slot motions.tracks, verbatim from the source export. */
    tracks: Record<string, MotionTracks>;
    /** Source model's texture size — converts `tex` pixel offsets to UV deltas. */
    textureWidth: number;
    textureHeight: number;
    /** Full timeline length in seconds (picoCAD2's motion_duration). */
    motionDuration: number;
};

export type PicoCad2Face = {
    vertex_ids?: number[]; // 1-based indices into the node's vertex list
    uvs?: number[]; // 2 per vertex, in pixels
    color?: number;
    texture?: boolean;
    notex?: boolean;
    /** Flat/unlit face. picoCAD2 writes `noshade`; `no_shade` is accepted too. */
    noshade?: boolean;
    no_shade?: boolean;
    double_sided?: boolean;
    dbl?: boolean;
    render_first?: boolean;
};

export type PicoCad2Node = {
    name?: string;
    visible?: boolean;
    transform?: {
        pos?: { x?: number; y?: number; z?: number };
        rot?: { x?: number; y?: number; z?: number };
        scale?: { x?: number; y?: number; z?: number };
    };
    mesh?: { vertices?: number[]; faces?: PicoCad2Face[] };
    motions?: { tracks?: PicoCad2MotionSegment[][] };
    children?: PicoCad2Node[];
};

export type PicoCad2Data = {
    metadata?: { name?: string; motion_duration?: number; export_settings?: { speed?: number } };
    texture?: PicoCad2Texture;
    graph?: PicoCad2Node;
};

export function parsePicoCad2(text: string): PicoCad2Data {
    return text.startsWith(PICO_CAD2_COMPACT_PREFIX) ? decodePicoCad2Compact(text) : (JSON.parse(text) as PicoCad2Data);
}

function channelToByte(value: number): number {
    return Math.round(value <= 1 ? value * 255 : value);
}

export type BuiltTexture = {
    width: number;
    height: number;
    // One palette index per pixel (0..15), what the shader samples.
    indexPixels: Uint8Array;
    // 16 columns x 3 rows RGBA: row 0 base, row 1 shade_pal_1, row 2 shade_pal_2.
    palettePixels: Uint8Array;
    transparentIndex: number;
};

// Turns the indexed texture + palette into two GPU textures: a single-channel
// index map and a 16x3 palette lookup (base + two shade rows for lighting).
export function buildTexture(data: PicoCad2Data): BuiltTexture {
    const tex = data.texture;
    if (!tex) throw new Error('Model has no texture');

    const width = tex.width ?? TEXTURE_SIZE_DEFAULT;
    const height = tex.height ?? TEXTURE_SIZE_DEFAULT;
    const colors = tex.colors;
    const transparentIndex = tex.transparent_color ?? -1;

    if (tex.pixels.length !== width * height) {
        throw new Error(`Texture size mismatch: ${tex.pixels.length} pixels, expected ${width * height}`);
    }

    const indexPixels = new Uint8Array(width * height);
    for (let i = 0; i < tex.pixels.length; i++) {
        indexPixels[i] = parseInt(tex.pixels[i], 16);
    }

    const shade1 = tex.shade_pal_1 ?? [];
    const shade2 = tex.shade_pal_2 ?? [];
    const palettePixels = new Uint8Array(16 * 3 * 4);
    for (let c = 0; c < 16; c++) {
        const base = colors[c] ?? [0, 0, 0];
        const s1 = colors[shade1[c] ?? c] ?? base;
        const s2 = colors[shade2[c] ?? shade1[c] ?? c] ?? s1;
        const rows: PicoCad2Color[] = [base, s1, s2];
        for (let row = 0; row < 3; row++) {
            const o = (row * 16 + c) * 4;
            palettePixels[o + 0] = channelToByte(rows[row][0]);
            palettePixels[o + 1] = channelToByte(rows[row][1]);
            palettePixels[o + 2] = channelToByte(rows[row][2]);
            palettePixels[o + 3] = 255;
        }
    }

    return { width, height, indexPixels, palettePixels, transparentIndex };
}

/** What recolouring needs from a palette: 16 RGB triples plus the two shade
    tables, which index back into those same colours. */
export type PaletteColors = {
    colors: readonly (readonly [number, number, number])[];
    shadePal1: readonly number[];
    shadePal2: readonly number[];
};

/**
 * The same texture under a different palette. A picoCAD texture is INDEXED —
 * the pixels are palette indices — so recolouring rebuilds only the 16x3 colour
 * map and leaves the authored pixels alone. `transparentIndex` stays too: it
 * says which texels were authored to vanish, which is a property of the
 * texture, not of the colours.
 */
export function repaletteTexture(texture: BuiltTexture, palette: PaletteColors): BuiltTexture {
    const palettePixels = new Uint8Array(16 * 3 * 4);
    for (let c = 0; c < 16; c++) {
        const base = palette.colors[c] ?? [0, 0, 0];
        const rows = [base, palette.colors[palette.shadePal1[c] ?? c] ?? base, palette.colors[palette.shadePal2[c] ?? c] ?? base];
        for (let row = 0; row < 3; row++) {
            const o = (row * 16 + c) * 4;
            palettePixels[o + 0] = rows[row][0];
            palettePixels[o + 1] = rows[row][1];
            palettePixels[o + 2] = rows[row][2];
            palettePixels[o + 3] = 255;
        }
    }
    return { ...texture, palettePixels };
}

export type GraphBounds = {
    centerX: number;
    centerY: number;
    centerZ: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
};

// Bounding box of every mesh vertex in the graph, applying node pos + scale
// (rotation ignored — fine for framing a camera on the model).
export function computeGraphBounds(graph: PicoCad2Node): GraphBounds | null {
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const walk = (node: PicoCad2Node, ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): void => {
        const t = node.transform;
        const nx = ox + (t?.pos?.x ?? 0) * sx;
        const ny = oy + (t?.pos?.y ?? 0) * sy;
        const nz = oz + (t?.pos?.z ?? 0) * sz;
        const nsx = sx * (t?.scale?.x ?? 1);
        const nsy = sy * (t?.scale?.y ?? 1);
        const nsz = sz * (t?.scale?.z ?? 1);
        const verts = node.mesh?.vertices;
        if (verts) {
            for (let i = 0; i < verts.length; i += 3) {
                const wx = nx + (verts[i] ?? 0) * nsx;
                const wy = ny + (verts[i + 1] ?? 0) * nsy;
                const wz = nz + (verts[i + 2] ?? 0) * nsz;
                if (wx < b.minX) b.minX = wx;
                if (wx > b.maxX) b.maxX = wx;
                if (wy < b.minY) b.minY = wy;
                if (wy > b.maxY) b.maxY = wy;
                if (wz < b.minZ) b.minZ = wz;
                if (wz > b.maxZ) b.maxZ = wz;
            }
        }
        for (const child of node.children ?? []) walk(child, nx, ny, nz, nsx, nsy, nsz);
    };
    walk(graph, 0, 0, 0, 1, 1, 1);
    if (!Number.isFinite(b.minX)) return null;
    return {
        centerX: (b.minX + b.maxX) * 0.5,
        centerY: (b.minY + b.maxY) * 0.5,
        centerZ: (b.minZ + b.maxZ) * 0.5,
        sizeX: b.maxX - b.minX,
        sizeY: b.maxY - b.minY,
        sizeZ: b.maxZ - b.minZ,
    };
}
