// picoCAD2 model file format: JSON with an indexed-palette `texture` and a
// `graph` node tree. Each node may hold a mesh (vertices + n-gon faces) and a
// local transform, plus child nodes.

export type PicoCad2Color = [number, number, number];

export type PicoCad2Texture = {
    pixels: string; // one hex digit per pixel, width*height long
    colors: PicoCad2Color[]; // palette, channels either 0..1 or 0..255
    transparent_color?: number;
    shade_pal_1?: number[];
    shade_pal_2?: number[];
    width?: number;
    height?: number;
};

export type PicoCad2Face = {
    vertex_ids?: number[]; // 1-based indices into the node's vertex list
    uvs?: number[]; // 2 per vertex, in pixels
    color?: number;
    texture?: boolean;
    notex?: boolean;
    no_shade?: boolean;
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
    children?: PicoCad2Node[];
};

export type PicoCad2Data = {
    metadata?: { name?: string };
    texture?: PicoCad2Texture;
    graph?: PicoCad2Node;
};

export function parsePicoCad2(text: string): PicoCad2Data {
    return JSON.parse(text) as PicoCad2Data;
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

    const width = tex.width ?? 128;
    const height = tex.height ?? 128;
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
