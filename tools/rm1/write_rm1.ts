// RM1 IR -> bytes. Knows nothing about picoCAD2.
//
// Layout (little-endian, every section 4-byte aligned):
//   header 64 | palette 80 | texture w*h | nodes 48*n | positions | uvs
//   | corner counts | indices | face attrs | name blob
//
// Positions are quantized against ONE per-axis bounding box for the whole
// model and stored grouped by axis (all X, then all Y, then all Z). Both
// choices were measured: per-node boxes and byte-plane/delta tricks each made
// the compressed file BIGGER at this scale.

import {
    FACE_DBL, FACE_NOSHADE, FACE_NOTEX, FLAG_HAS_TEXTURE, FLAG_IDX16, FLAG_POS16,
    HEADER_BYTES, MAGIC, NODE_BYTES, PALETTE_BYTES, UV_SCALE, VERSION, align4, type RmModel,
} from './ir';

export type WriteOptions = {
    /** 16-bit positions instead of 8-bit. Rarely needed — see the error budget. */
    pos16?: boolean;
};

export type WriteResult = {
    bytes: Uint8Array;
    /** Worst-case position error, as a fraction of the model's largest dimension. */
    positionError: number;
    vertexCount: number;
    faceCount: number;
    cornerCount: number;
};

function log2Exact(n: number, what: string): number {
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error(`${what} must be a power of two, got ${n}`);
    return bits;
}

export function writeRm1(model: RmModel, opts: WriteOptions = {}): WriteResult {
    const { nodes } = model;
    if (nodes.length === 0) throw new Error('model has no nodes');
    if (nodes.length > 255) throw new Error(`${nodes.length} nodes; the parent index is a u8 (max 255)`);

    // --- pool geometry, recording each node's ranges ---
    const positions: number[] = [];
    const uvs: number[] = [];
    const counts: number[] = [];
    const indices: number[] = [];
    const attrs: number[] = [];
    const ranges: { vStart: number; vCount: number; fStart: number; fCount: number }[] = [];

    for (const node of nodes) {
        const vStart = positions.length / 3;
        const fStart = counts.length;
        positions.push(...node.verts);
        for (const face of node.faces) {
            counts.push(face.ids.length);
            indices.push(...face.ids);
            for (let k = 0; k < face.ids.length; k++) {
                uvs.push(face.uvs[k * 2] ?? 0, face.uvs[k * 2 + 1] ?? 0);
            }
            attrs.push(
                (face.color & 15)
                | (face.notex ? FACE_NOTEX : 0)
                | (face.noshade ? FACE_NOSHADE : 0)
                | (face.dbl ? FACE_DBL : 0),
            );
        }
        ranges.push({ vStart, vCount: node.verts.length / 3, fStart, fCount: node.faces.length });
    }

    const vertexCount = positions.length / 3;
    const faceCount = counts.length;
    const cornerCount = indices.length;
    if (vertexCount === 0) throw new Error('model has no vertices');
    for (const [label, value] of [['vertices', vertexCount], ['faces', faceCount], ['corners', cornerCount]] as const) {
        if (value > 65535) throw new Error(`${value} ${label}; the header counter is a u16 (max 65535)`);
    }

    // --- quantize positions against one per-axis box ---
    const pos16 = opts.pos16 ?? false;
    const levels = pos16 ? 65535 : 255;
    const min: number[] = [Infinity, Infinity, Infinity];
    const max: number[] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
        for (let c = 0; c < 3; c++) {
            const v = positions[i * 3 + c];
            if (v < min[c]) min[c] = v;
            if (v > max[c]) max[c] = v;
        }
    }
    // A flat axis has zero span; any non-zero scale reproduces it exactly.
    const scale = [0, 1, 2].map((c) => (max[c] - min[c]) / levels || 1);
    const span = Math.max(...[0, 1, 2].map((c) => max[c] - min[c]));
    const positionError = span > 0 ? Math.max(...scale) / 2 / span : 0;

    const idx16 = ranges.some((r) => r.vCount > 256);
    const texBytes = model.texture.length;
    if (texBytes !== model.texWidth * model.texHeight) {
        throw new Error(`texture is ${texBytes} bytes, expected ${model.texWidth * model.texHeight}`);
    }

    const nameBlob = new TextEncoder().encode(nodes.map((n) => n.name).join('\0') + '\0');
    const nameOffsets: number[] = [];
    {
        let offset = 0;
        for (const node of nodes) {
            nameOffsets.push(offset);
            offset += new TextEncoder().encode(node.name).length + 1;
        }
    }
    if (nameBlob.length > 65535) throw new Error('name blob exceeds 65535 bytes');

    // --- lay sections out ---
    const posBytes = vertexCount * 3 * (pos16 ? 2 : 1);
    const uvBytes = cornerCount * 4;
    const idxBytes = cornerCount * (idx16 ? 2 : 1);

    const palOff = align4(HEADER_BYTES);
    const texOff = align4(palOff + PALETTE_BYTES);
    const nodeOff = align4(texOff + texBytes);
    const posOff = align4(nodeOff + nodes.length * NODE_BYTES);
    const uvOff = align4(posOff + posBytes);
    const cntOff = align4(uvOff + uvBytes);
    const idxOff = align4(cntOff + faceCount);
    const attrOff = align4(idxOff + idxBytes);
    const nameOff = align4(attrOff + faceCount);
    const total = align4(nameOff + nameBlob.length);

    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < 4; i++) bytes[i] = MAGIC.charCodeAt(i);
    view.setUint8(4, VERSION);
    view.setUint8(5, FLAG_HAS_TEXTURE | (pos16 ? FLAG_POS16 : 0) | (idx16 ? FLAG_IDX16 : 0));
    view.setUint8(6, log2Exact(model.texWidth, 'texture width'));
    view.setUint8(7, log2Exact(model.texHeight, 'texture height'));
    view.setUint16(8, nodes.length, true);
    view.setUint16(10, vertexCount, true);
    view.setUint16(12, faceCount, true);
    view.setUint16(14, cornerCount, true);
    for (let c = 0; c < 3; c++) {
        view.setFloat32(16 + c * 4, min[c], true);
        view.setFloat32(28 + c * 4, scale[c], true);
    }
    view.setUint8(40, model.transparentIndex);
    view.setUint8(41, model.backgroundIndex);
    view.setUint16(42, nameBlob.length, true);

    for (let c = 0; c < 16; c++) {
        const rgb = model.palette[c] ?? [0, 0, 0];
        for (let k = 0; k < 3; k++) bytes[palOff + c * 3 + k] = rgb[k];
        bytes[palOff + 48 + c] = model.shade1[c] ?? c;
        bytes[palOff + 64 + c] = model.shade2[c] ?? c;
    }

    bytes.set(model.texture, texOff);

    nodes.forEach((node, i) => {
        const o = nodeOff + i * NODE_BYTES;
        const r = ranges[i];
        view.setUint16(o, nameOffsets[i], true);
        view.setUint8(o + 2, node.parent);
        view.setUint8(o + 3, node.visible ? 1 : 0);
        for (let c = 0; c < 3; c++) {
            view.setFloat32(o + 4 + c * 4, node.pos[c], true);
            view.setFloat32(o + 16 + c * 4, node.rot[c], true);
            view.setFloat32(o + 28 + c * 4, node.scale[c], true);
        }
        view.setUint16(o + 40, r.vStart, true);
        view.setUint16(o + 42, r.vCount, true);
        view.setUint16(o + 44, r.fStart, true);
        view.setUint16(o + 46, r.fCount, true);
    });

    for (let c = 0; c < 3; c++) {
        for (let i = 0; i < vertexCount; i++) {
            const q = Math.max(0, Math.min(levels, Math.round((positions[i * 3 + c] - min[c]) / scale[c])));
            if (pos16) view.setUint16(posOff + (c * vertexCount + i) * 2, q, true);
            else bytes[posOff + c * vertexCount + i] = q;
        }
    }

    for (let i = 0; i < cornerCount * 2; i++) {
        view.setInt16(uvOff + i * 2, Math.round(uvs[i] * UV_SCALE), true);
    }

    for (let i = 0; i < faceCount; i++) {
        bytes[cntOff + i] = counts[i];
        bytes[attrOff + i] = attrs[i];
    }
    for (let i = 0; i < cornerCount; i++) {
        if (idx16) view.setUint16(idxOff + i * 2, indices[i], true);
        else bytes[idxOff + i] = indices[i];
    }
    bytes.set(nameBlob, nameOff);

    return { bytes, positionError, vertexCount, faceCount, cornerCount };
}
