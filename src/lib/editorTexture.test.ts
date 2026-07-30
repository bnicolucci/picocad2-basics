import { describe, expect, test } from 'bun:test';
import { textureRgba, tileAtPixel, tileGrid } from './editorTexture';
import type { BuiltTexture } from './picocad2';

// 2x1 texture: pixel 0 uses palette index 1, pixel 1 uses index 2.
function texture(overrides: Partial<BuiltTexture> = {}): BuiltTexture {
    const palettePixels = new Uint8Array(16 * 3 * 4);
    palettePixels.set([10, 20, 30, 255], 1 * 4); // index 1, row 0
    palettePixels.set([40, 50, 60, 255], 2 * 4); // index 2, row 0
    return { width: 2, height: 1, indexPixels: new Uint8Array([1, 2]), palettePixels, transparentIndex: -1, ...overrides };
}

describe('textureRgba', () => {
    test('expands each index through palette row 0', () => {
        expect([...textureRgba(texture())]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    });

    test('the transparent index comes back with zero alpha', () => {
        const rgba = textureRgba(texture({ transparentIndex: 1 }));
        expect(rgba[3]).toBe(0);
        expect(rgba[7]).toBe(255);
    });

    test('output is 4 bytes per pixel', () => {
        expect(textureRgba(texture({ width: 8, height: 4, indexPixels: new Uint8Array(32) })).length).toBe(8 * 4 * 4);
    });
});

describe('tileGrid', () => {
    test('counts whole tiles', () => {
        expect(tileGrid({ width: 128, height: 64 }, 16)).toEqual({ cols: 8, rows: 4 });
    });

    // A texture smaller than one tile still has to offer a tile to point at.
    test('never reports zero tiles', () => {
        expect(tileGrid({ width: 8, height: 8 }, 16)).toEqual({ cols: 1, rows: 1 });
    });
});

describe('tileAtPixel', () => {
    const tex = { width: 128, height: 128 };

    // UvTransform.tile is 1-based, so the top-left tile is (1, 1).
    test('is 1-based', () => {
        expect(tileAtPixel(0, 0, 16, tex)).toEqual({ u: 1, v: 1 });
        expect(tileAtPixel(15, 15, 16, tex)).toEqual({ u: 1, v: 1 });
        expect(tileAtPixel(16, 0, 16, tex)).toEqual({ u: 2, v: 1 });
    });

    test('maps a pixel to the tile containing it', () => {
        expect(tileAtPixel(100, 40, 16, tex)).toEqual({ u: 7, v: 3 });
    });

    // Clicking the very edge of the canvas must not produce a tile off the grid.
    test('clamps to the grid', () => {
        expect(tileAtPixel(128, 128, 16, tex)).toEqual({ u: 8, v: 8 });
        expect(tileAtPixel(-5, -5, 16, tex)).toEqual({ u: 1, v: 1 });
    });

    test('follows the tile size', () => {
        expect(tileAtPixel(40, 0, 32, tex)).toEqual({ u: 2, v: 1 });
        expect(tileAtPixel(40, 0, 8, tex)).toEqual({ u: 6, v: 1 });
    });
});
