import type { PicoCad2Data, PicoCad2Node } from './picocad2';

// Tiny hand-built picoCAD2 models for the tests. Hermetic on purpose: the real
// assets under src/assets/primitives and src/assets/dungeon are directory
// junctions into the picoCAD2 app's folders, so tests that read them would fail
// on a machine that has not installed picoCAD2.

/** One flat quad at height `y`, so the node has a real mesh to build. */
function quad(y: number, color: number): PicoCad2Node['mesh'] {
    return {
        vertices: [-0.5, y, -0.5, 0.5, y, -0.5, 0.5, y, 0.5, -0.5, y, 0.5],
        faces: [{ vertex_ids: [1, 2, 3, 4], uvs: [0, 0, 1, 0, 1, 1, 0, 1], color }],
    };
}

/**
 * A model whose graph root has one named mesh node per entry in `parts` —
 * the shape of a dungeon part library (walls.txt = wall / pillar / castley).
 * Part i sits at y = i and carries a distinct face colour, so tests can tell
 * the parts apart.
 */
export function tinyModel(parts: string[]): PicoCad2Data {
    return {
        metadata: { name: 'tiny' },
        texture: {
            pixels: '0123456789abcdef',
            width: 4,
            height: 4,
            colors: Array.from({ length: 16 }, (_, i): [number, number, number] => [i * 16, 255 - i * 16, i * 8]),
            transparent_color: 0,
        },
        graph: {
            name: 'root',
            children: parts.map((name, i) => ({ name, mesh: quad(i, i % 16) })),
        },
    };
}

export function tinyModelText(parts: string[]): string {
    return JSON.stringify(tinyModel(parts));
}
