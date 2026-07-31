import { describe, expect, test } from 'bun:test';
import { type BuiltTexture, repaletteTexture } from './picocad2';

const texture = (): BuiltTexture => ({
    width: 2,
    height: 1,
    indexPixels: new Uint8Array([3, 7]),
    palettePixels: new Uint8Array(16 * 3 * 4),
    transparentIndex: 5,
});

// colour c is (c, c*2, c*3); shade rows point everything at colour 0 / colour 1.
const palette = {
    colors: Array.from({ length: 16 }, (_, c) => [c, c * 2, c * 3] as const),
    shadePal1: Array.from({ length: 16 }, () => 0),
    shadePal2: Array.from({ length: 16 }, () => 1),
};

const at = (px: Uint8Array, row: number, c: number): number[] => [...px.subarray((row * 16 + c) * 4, (row * 16 + c) * 4 + 4)];

describe('repaletteTexture', () => {
    test('row 0 is the palette colour itself', () => {
        expect(at(repaletteTexture(texture(), palette).palettePixels, 0, 4)).toEqual([4, 8, 12, 255]);
    });

    // The shade rows are what the stepped headlight samples, so they must go
    // through the shade tables rather than repeating the base colour.
    test('rows 1 and 2 come from the shade tables', () => {
        const px = repaletteTexture(texture(), palette).palettePixels;
        expect(at(px, 1, 9)).toEqual([0, 0, 0, 255]); // shadePal1 -> colour 0
        expect(at(px, 2, 9)).toEqual([1, 2, 3, 255]); // shadePal2 -> colour 1
    });

    // The pixels are indices into the palette; recolouring must not touch them.
    test('leaves the authored pixels and transparency alone', () => {
        const out = repaletteTexture(texture(), palette);
        expect([...out.indexPixels]).toEqual([3, 7]);
        expect(out.transparentIndex).toBe(5);
        expect(out.width).toBe(2);
    });

    test('does not mutate the texture it was given', () => {
        const original = texture();
        repaletteTexture(original, palette);
        expect([...original.palettePixels]).toEqual([...new Uint8Array(16 * 3 * 4)]);
    });
});
