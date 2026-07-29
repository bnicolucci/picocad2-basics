// Encode every real model, decode it back, and compare against the IR the
// reader produced. Positions and UVs are lossy by design, so those are checked
// against the format's stated error budget; everything else must be exact.
//
// This harness is the reason two silent bugs were caught during development (a
// byte-overflowing index encoding, and transforms that read back as identity) —
// both produced valid-looking files of exactly the right size.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parsePicoCad2, type PicoCad2Node } from '../../src/lib/picocad2';
import { UV_SCALE, type RmModel } from './ir';
import { readPicoCad2 } from './read_picocad2';
import { readRm1 } from './read_rm1';
import { writeRm1 } from './write_rm1';

const MODEL_DIR = join(import.meta.dir, '..', '..', 'src', 'assets', 'models');
const NAMES = ['cube', 'pig', 'truck', 'helicopter', 'thinktank'];
const MODELS: [string, string][] = NAMES.map((n) => [n, readFileSync(join(MODEL_DIR, `${n}.txt`), 'utf8')]);

/** Half a UV step, plus float32 slack. */
const UV_TOLERANCE = 1 / UV_SCALE / 2 + 1e-6;

function modelSpan(model: RmModel): number {
    let span = 0;
    for (let c = 0; c < 3; c++) {
        let min = Infinity;
        let max = -Infinity;
        for (const node of model.nodes) {
            for (let i = c; i < node.verts.length; i += 3) {
                if (node.verts[i] < min) min = node.verts[i];
                if (node.verts[i] > max) max = node.verts[i];
            }
        }
        if (Number.isFinite(min)) span = Math.max(span, max - min);
    }
    return span;
}

/** The source graph in the same depth-first order the reader emits. */
function sourceNodes(text: string): PicoCad2Node[] {
    const out: PicoCad2Node[] = [];
    const walk = (node: PicoCad2Node): void => {
        out.push(node);
        for (const child of node.children ?? []) walk(child);
    };
    walk(parsePicoCad2(text).graph ?? {});
    return out;
}

describe.each(MODELS)('RM1 round-trip: %s', (_name, text) => {
    const source = readPicoCad2(text);
    const written = writeRm1(source);
    const decoded = readRm1(written.bytes);
    const span = modelSpan(source);

    test('structure survives exactly', () => {
        expect(decoded.nodes.length).toBe(source.nodes.length);
        expect(decoded.nodes.map((n) => n.name)).toEqual(source.nodes.map((n) => n.name));
        expect(decoded.nodes.map((n) => n.parent)).toEqual(source.nodes.map((n) => n.parent));
        expect(decoded.nodes.map((n) => n.visible)).toEqual(source.nodes.map((n) => n.visible));
        expect(decoded.nodes.map((n) => n.verts.length)).toEqual(source.nodes.map((n) => n.verts.length));
        expect(decoded.nodes.map((n) => n.faces.length)).toEqual(source.nodes.map((n) => n.faces.length));
    });

    test('node transforms survive to float32', () => {
        source.nodes.forEach((node, i) => {
            for (let c = 0; c < 3; c++) {
                expect(decoded.nodes[i].pos[c]).toBeCloseTo(node.pos[c], 5);
                expect(decoded.nodes[i].rot[c]).toBeCloseTo(node.rot[c], 5);
                expect(decoded.nodes[i].scale[c]).toBeCloseTo(node.scale[c], 5);
            }
        });
    });

    test('face topology and flags survive exactly', () => {
        source.nodes.forEach((node, i) => {
            node.faces.forEach((face, f) => {
                const got = decoded.nodes[i].faces[f];
                expect(got.ids).toEqual(face.ids);
                expect(got.color).toBe(face.color);
                expect(got.notex).toBe(face.notex);
                expect(got.noshade).toBe(face.noshade);
                expect(got.dbl).toBe(face.dbl);
            });
        });
    });

    test('every face has at least 3 corners', () => {
        for (const node of decoded.nodes) {
            for (const face of node.faces) expect(face.ids.length).toBeGreaterThanOrEqual(3);
        }
    });

    test('indices stay inside their own node', () => {
        for (const node of decoded.nodes) {
            const count = node.verts.length / 3;
            for (const face of node.faces) {
                for (const id of face.ids) {
                    expect(id).toBeGreaterThanOrEqual(0);
                    expect(id).toBeLessThan(count);
                }
            }
        }
    });

    test('positions stay within the 8-bit error budget', () => {
        const budget = written.positionError * span + 1e-4;
        let worst = 0;
        source.nodes.forEach((node, i) => {
            node.verts.forEach((v, k) => {
                worst = Math.max(worst, Math.abs(v - decoded.nodes[i].verts[k]));
            });
        });
        expect(worst).toBeLessThanOrEqual(budget);
        // Sub-texel when the model fills a 128px viewport — the whole point.
        expect((worst / span) * 128).toBeLessThan(0.5);
    });

    test('uvs stay within a quarter texel', () => {
        let worst = 0;
        source.nodes.forEach((node, i) => {
            node.faces.forEach((face, f) => {
                face.uvs.forEach((v, k) => {
                    worst = Math.max(worst, Math.abs(v - decoded.nodes[i].faces[f].uvs[k]));
                });
            });
        });
        expect(worst).toBeLessThanOrEqual(UV_TOLERANCE);
    });

    test('texture and palette survive exactly', () => {
        expect(decoded.texWidth).toBe(source.texWidth);
        expect(decoded.texHeight).toBe(source.texHeight);
        expect(Array.from(decoded.texture)).toEqual(Array.from(source.texture));
        expect(decoded.palette).toEqual(source.palette);
        expect(decoded.shade1).toEqual(source.shade1);
        expect(decoded.shade2).toEqual(source.shade2);
        expect(decoded.transparentIndex).toBe(source.transparentIndex);
        expect(decoded.backgroundIndex).toBe(source.backgroundIndex);
    });

    test('all texture indices are a valid palette entry', () => {
        for (const index of decoded.texture) expect(index).toBeLessThan(16);
    });

    test('sections are 4-byte aligned and the file is smaller than the source', () => {
        expect(written.bytes.byteLength % 4).toBe(0);
        expect(written.bytes.byteLength).toBeLessThan(text.length);
    });

    // The load-bearing conversion: picoCAD2 model space is X-mirrored vs. a
    // right-handed world, and the reader bakes that out so the runtime loader
    // never mirrors. Checked directly against the source file rather than by a
    // signed-volume heuristic, which would assume closed manifolds these
    // models don't have (rotor planes, double-sided faces).
    test('the X-mirror is baked out against the source file', () => {
        const raw = sourceNodes(text);
        expect(raw.length).toBe(decoded.nodes.length);
        raw.forEach((src, i) => {
            const got = decoded.nodes[i];
            expect(got.name).toBe(src.name ?? '');

            const srcVerts = src.mesh?.vertices ?? [];
            for (let v = 0; v < srcVerts.length / 3; v++) {
                expect(got.verts[v * 3]).toBeCloseTo(-srcVerts[v * 3], 1);
                expect(got.verts[v * 3 + 1]).toBeCloseTo(srcVerts[v * 3 + 1], 1);
                expect(got.verts[v * 3 + 2]).toBeCloseTo(srcVerts[v * 3 + 2], 1);
            }

            expect(got.pos[0]).toBeCloseTo(-(src.transform?.pos?.x ?? 0), 5);
            expect(got.rot[1]).toBeCloseTo(-(src.transform?.rot?.y ?? 0), 5);
            expect(got.rot[2]).toBeCloseTo(-(src.transform?.rot?.z ?? 0), 5);

            // Winding is reversed to compensate for the mirror's flip.
            const srcFaces = (src.mesh?.faces ?? []).filter((f) => (f.vertex_ids ?? []).length >= 3);
            srcFaces.forEach((face, f) => {
                const expected = (face.vertex_ids ?? []).map((x) => x - 1).reverse();
                expect(got.faces[f].ids).toEqual(expected);
            });
        });
    });
});
