import { describe, expect, test } from 'bun:test';
import { buildTexture, parsePicoCad2 } from './picocad2';
import { decodePicoCad2Compact, PICO_CAD2_COMPACT_PREFIX, tryEncodePicoCad2Compact } from './picocad2_compact';
import { tinyModelText } from './testModels';

// The build plugin encodes every bundled model with this and parsePicoCad2
// decodes it at runtime. A round-trip bug here ships broken geometry in
// production while dev (which serves raw files) looks perfect — so these are
// the tests that stand between a green dev server and a broken build.

const raw = tinyModelText(['wall', 'pillar']);

describe('tryEncodePicoCad2Compact', () => {
    test('produces a pc2!-prefixed string that is smaller than the raw file', () => {
        const compact = tryEncodePicoCad2Compact(raw)!;
        expect(compact.startsWith(PICO_CAD2_COMPACT_PREFIX)).toBe(true);
        expect(compact.length).toBeLessThan(raw.length);
    });

    test('declines anything that is not a picoCAD2 model, so the plugin leaves it alone', () => {
        expect(tryEncodePicoCad2Compact('hello, not a model')).toBeNull();
        expect(tryEncodePicoCad2Compact('{"just":"json"}')).toBeNull();
    });
});

describe('round trip', () => {
    const decoded = decodePicoCad2Compact(tryEncodePicoCad2Compact(raw)!);
    const original = JSON.parse(raw);

    test('keeps the node graph: names, nesting and mesh presence', () => {
        expect(decoded.graph?.children?.map((n) => n.name)).toEqual(['wall', 'pillar']);
        expect(decoded.graph?.children?.[0].mesh?.faces).toHaveLength(1);
    });

    test('keeps vertex positions within the quantization tolerance', () => {
        const before: number[] = original.graph.children[0].mesh.vertices;
        const after = decoded.graph!.children![0].mesh!.vertices!;
        expect(after).toHaveLength(before.length);
        for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i], 4);
    });

    test('keeps face vertex ids and colours exactly', () => {
        const before = original.graph.children[1].mesh.faces[0];
        const after = decoded.graph!.children![1].mesh!.faces![0];
        expect(after.vertex_ids).toEqual(before.vertex_ids);
        expect(after.color).toBe(before.color);
    });

    test('keeps the texture pixel-for-pixel', () => {
        expect(buildTexture(decoded).indexPixels).toEqual(buildTexture(original).indexPixels);
        expect(decoded.texture?.transparent_color).toBe(original.texture.transparent_color);
    });
});

test('parsePicoCad2 decodes the compact form transparently', () => {
    const viaCompact = parsePicoCad2(tryEncodePicoCad2Compact(raw)!);
    const viaRaw = parsePicoCad2(raw);
    expect(viaCompact.graph?.children?.map((n) => n.name)).toEqual(viaRaw.graph?.children?.map((n) => n.name));
});
