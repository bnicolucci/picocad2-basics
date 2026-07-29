// picoCAD2 .txt -> RM1 IR. Everything picoCAD2-specific is resolved here so the
// writer (and the runtime loader) never has to know about it:
//
//   * the X-mirror is BAKED OUT, so the IR is plain right-handed
//   * palette channels are normalized to 0..255 (the file may use either)
//   * the two spellings of every face flag collapse to one boolean
//   * hex pixel digits become bytes; degenerate faces are dropped

import { parsePicoCad2, TEXTURE_SIZE_DEFAULT, type PicoCad2Data, type PicoCad2Face, type PicoCad2Node } from '../../src/lib/picocad2';
import { NO_INDEX, ROOT_PARENT, type RmFace, type RmModel, type RmNode } from './ir';

function channelToByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value <= 1 ? value * 255 : value)));
}

function readTexture(data: PicoCad2Data): Pick<RmModel, 'texture' | 'texWidth' | 'texHeight'> {
    const tex = data.texture;
    if (!tex) throw new Error('model has no texture');
    const width = tex.width ?? TEXTURE_SIZE_DEFAULT;
    const height = tex.height ?? TEXTURE_SIZE_DEFAULT;
    if (tex.pixels.length !== width * height) {
        throw new Error(`texture is ${tex.pixels.length} pixels, expected ${width * height}`);
    }
    const texture = new Uint8Array(width * height);
    for (let i = 0; i < texture.length; i++) {
        const v = parseInt(tex.pixels[i], 16);
        if (Number.isNaN(v)) throw new Error(`texture pixel ${i} is not a hex digit: "${tex.pixels[i]}"`);
        texture[i] = v;
    }
    return { texture, texWidth: width, texHeight: height };
}

// picoCAD2 stores faces whose FILE-order cross product points outward. Baking
// the mirror negates x, which flips winding — so the corner order (and the UV
// pairs alongside it) is reversed to put the outward normal back.
function readFace(raw: PicoCad2Face, vertexCount: number): RmFace | null {
    const ids = (raw.vertex_ids ?? []).map((v) => v - 1);
    if (ids.length < 3) return null;
    for (const id of ids) {
        if (id < 0 || id >= vertexCount) throw new Error(`face references vertex ${id + 1} of ${vertexCount}`);
    }
    const srcUvs = raw.uvs ?? [];
    const mirroredIds: number[] = [];
    const mirroredUvs: number[] = [];
    for (let k = ids.length - 1; k >= 0; k--) {
        mirroredIds.push(ids[k]);
        mirroredUvs.push(srcUvs[k * 2] ?? 0, srcUvs[k * 2 + 1] ?? 0);
    }
    return {
        ids: mirroredIds,
        uvs: mirroredUvs,
        color: (raw.color ?? 0) & 15,
        notex: raw.notex === true || raw.texture === false,
        noshade: raw.noshade === true || raw.no_shade === true,
        dbl: raw.dbl === true || raw.double_sided === true,
    };
}

export function readPicoCad2(text: string): RmModel {
    const data = parsePicoCad2(text);
    const nodes: RmNode[] = [];

    const walk = (src: PicoCad2Node, parent: number): void => {
        const index = nodes.length;
        const rawVerts = src.mesh?.vertices ?? [];
        const verts = rawVerts.slice();
        for (let i = 0; i < verts.length; i += 3) verts[i] = -verts[i];

        const vertexCount = verts.length / 3;
        const faces: RmFace[] = [];
        for (const rawFace of src.mesh?.faces ?? []) {
            const face = readFace(rawFace, vertexCount);
            if (face) faces.push(face);
        }

        const t = src.transform;
        nodes.push({
            name: src.name ?? '',
            parent,
            visible: src.visible !== false,
            // A mirror conjugates an XYZ-euler triple axis-by-axis: the mirrored
            // axis keeps its angle, the other two negate.
            pos: [-(t?.pos?.x ?? 0), t?.pos?.y ?? 0, t?.pos?.z ?? 0],
            rot: [t?.rot?.x ?? 0, -(t?.rot?.y ?? 0), -(t?.rot?.z ?? 0)],
            scale: [t?.scale?.x ?? 1, t?.scale?.y ?? 1, t?.scale?.z ?? 1],
            verts,
            faces,
        });
        for (const child of src.children ?? []) walk(child, index);
    };

    if (!data.graph) throw new Error('model has no graph');
    walk(data.graph, ROOT_PARENT);

    const colors = data.texture?.colors ?? [];
    const palette: [number, number, number][] = [];
    for (let c = 0; c < 16; c++) {
        const src = colors[c] ?? [0, 0, 0];
        palette.push([channelToByte(src[0]), channelToByte(src[1]), channelToByte(src[2])]);
    }
    const shade1 = Array.from({ length: 16 }, (_, c) => data.texture?.shade_pal_1?.[c] ?? c);
    const shade2 = Array.from({ length: 16 }, (_, c) => data.texture?.shade_pal_2?.[c] ?? shade1[c]);

    return {
        nodes,
        palette,
        shade1,
        shade2,
        ...readTexture(data),
        transparentIndex: data.texture?.transparent_color ?? NO_INDEX,
        backgroundIndex: data.texture?.background_color ?? NO_INDEX,
    };
}
