import type { BuiltTexture } from './picocad2';

// Showing a model's texture in an editor. The texture is palette-indexed —
// one index per pixel plus a 16x3 palette — so it has to be expanded before a
// 2D canvas can draw it. Kept free of DOM types (no ImageData) so the maths is
// testable; the caller wraps the bytes.

/** Expand an indexed texture to RGBA, using palette row 0 (the lit colour).
    Texels holding the transparent index come back fully transparent. */
export function textureRgba(texture: BuiltTexture): Uint8ClampedArray<ArrayBuffer> {
    const { width, height, indexPixels, palettePixels, transparentIndex } = texture;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const index = indexPixels[i];
        const p = index * 4; // palette row 0
        const o = i * 4;
        out[o] = palettePixels[p];
        out[o + 1] = palettePixels[p + 1];
        out[o + 2] = palettePixels[p + 2];
        out[o + 3] = index === transparentIndex ? 0 : 255;
    }
    return out;
}

/** How many whole tiles of `size` fit across and down a texture. At least 1,
    so a texture smaller than one tile still has a tile to point at. */
export function tileGrid(texture: { width: number; height: number }, size: number): { cols: number; rows: number } {
    const step = Math.max(1, size);
    return {
        cols: Math.max(1, Math.floor(texture.width / step)),
        rows: Math.max(1, Math.floor(texture.height / step)),
    };
}

/** The tile a texture pixel falls in, as the 1-based column/row `UvTransform.tile`
    wants, clamped to the grid so a click on the edge still lands on a tile. */
export function tileAtPixel(
    x: number,
    y: number,
    size: number,
    texture: { width: number; height: number },
): { u: number; v: number } {
    const step = Math.max(1, size);
    const { cols, rows } = tileGrid(texture, step);
    return {
        u: Math.min(cols, Math.max(1, Math.floor(x / step) + 1)),
        v: Math.min(rows, Math.max(1, Math.floor(y / step) + 1)),
    };
}
