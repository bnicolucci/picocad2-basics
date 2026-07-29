// RM1 bytes -> IR. This is the reference decoder: it is what the round-trip
// test checks against, and the shape an Odin loader should mirror. Note that
// every section offset is DERIVED from the header counts — there is no offset
// table in the file to keep in sync.

import {
    FACE_DBL, FACE_NOSHADE, FACE_NOTEX, FLAG_IDX16, FLAG_POS16, HEADER_BYTES, MAGIC,
    NODE_BYTES, PALETTE_BYTES, UV_SCALE, VERSION, align4, type RmFace, type RmModel, type RmNode,
} from './ir';

export function readRm1(bytes: Uint8Array): RmModel {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < 4; i++) {
        if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('not an RM1 file');
    }
    const version = view.getUint8(4);
    if (version !== VERSION) throw new Error(`unsupported RM1 version ${version}`);

    const flags = view.getUint8(5);
    const pos16 = (flags & FLAG_POS16) !== 0;
    const idx16 = (flags & FLAG_IDX16) !== 0;
    const texWidth = 1 << view.getUint8(6);
    const texHeight = 1 << view.getUint8(7);
    const nodeCount = view.getUint16(8, true);
    const vertexCount = view.getUint16(10, true);
    const faceCount = view.getUint16(12, true);
    const cornerCount = view.getUint16(14, true);
    const min = [0, 1, 2].map((c) => view.getFloat32(16 + c * 4, true));
    const scale = [0, 1, 2].map((c) => view.getFloat32(28 + c * 4, true));
    const transparentIndex = view.getUint8(40);
    const backgroundIndex = view.getUint8(41);
    const nameLength = view.getUint16(42, true);

    const palOff = align4(HEADER_BYTES);
    const texOff = align4(palOff + PALETTE_BYTES);
    const nodeOff = align4(texOff + texWidth * texHeight);
    const posOff = align4(nodeOff + nodeCount * NODE_BYTES);
    const uvOff = align4(posOff + vertexCount * 3 * (pos16 ? 2 : 1));
    const cntOff = align4(uvOff + cornerCount * 4);
    const idxOff = align4(cntOff + faceCount);
    const attrOff = align4(idxOff + cornerCount * (idx16 ? 2 : 1));
    const nameOff = align4(attrOff + faceCount);
    if (align4(nameOff + nameLength) !== bytes.byteLength) {
        throw new Error(`truncated RM1: header implies ${align4(nameOff + nameLength)} bytes, got ${bytes.byteLength}`);
    }

    const palette: [number, number, number][] = [];
    const shade1: number[] = [];
    const shade2: number[] = [];
    for (let c = 0; c < 16; c++) {
        palette.push([bytes[palOff + c * 3], bytes[palOff + c * 3 + 1], bytes[palOff + c * 3 + 2]]);
        shade1.push(bytes[palOff + 48 + c]);
        shade2.push(bytes[palOff + 64 + c]);
    }

    const texture = bytes.slice(texOff, texOff + texWidth * texHeight);

    const positions = new Float32Array(vertexCount * 3);
    for (let c = 0; c < 3; c++) {
        for (let i = 0; i < vertexCount; i++) {
            const q = pos16
                ? view.getUint16(posOff + (c * vertexCount + i) * 2, true)
                : bytes[posOff + c * vertexCount + i];
            positions[i * 3 + c] = min[c] + q * scale[c];
        }
    }

    const nameAt = (offset: number): string => {
        const end = bytes.indexOf(0, nameOff + offset);
        return new TextDecoder().decode(bytes.subarray(nameOff + offset, end));
    };

    // Corner streams are shared across the whole model; this maps a face index
    // to where its corners begin.
    const cornerStart = new Uint32Array(faceCount + 1);
    for (let f = 0; f < faceCount; f++) cornerStart[f + 1] = cornerStart[f] + bytes[cntOff + f];

    const nodes: RmNode[] = [];
    for (let i = 0; i < nodeCount; i++) {
        const o = nodeOff + i * NODE_BYTES;
        const vStart = view.getUint16(o + 40, true);
        const vCount = view.getUint16(o + 42, true);
        const fStart = view.getUint16(o + 44, true);
        const fCount = view.getUint16(o + 46, true);

        const faces: RmFace[] = [];
        for (let f = 0; f < fCount; f++) {
            const n = bytes[cntOff + fStart + f];
            const attr = bytes[attrOff + fStart + f];
            const base = cornerStart[fStart + f];
            const ids: number[] = [];
            const uvs: number[] = [];
            for (let k = 0; k < n; k++) {
                const corner = base + k;
                ids.push(idx16 ? view.getUint16(idxOff + corner * 2, true) : bytes[idxOff + corner]);
                uvs.push(
                    view.getInt16(uvOff + corner * 4, true) / UV_SCALE,
                    view.getInt16(uvOff + corner * 4 + 2, true) / UV_SCALE,
                );
            }
            faces.push({
                ids,
                uvs,
                color: attr & 15,
                notex: (attr & FACE_NOTEX) !== 0,
                noshade: (attr & FACE_NOSHADE) !== 0,
                dbl: (attr & FACE_DBL) !== 0,
            });
        }

        nodes.push({
            name: nameAt(view.getUint16(o, true)),
            parent: view.getUint8(o + 2),
            visible: view.getUint8(o + 3) !== 0,
            pos: [0, 1, 2].map((c) => view.getFloat32(o + 4 + c * 4, true)) as [number, number, number],
            rot: [0, 1, 2].map((c) => view.getFloat32(o + 16 + c * 4, true)) as [number, number, number],
            scale: [0, 1, 2].map((c) => view.getFloat32(o + 28 + c * 4, true)) as [number, number, number],
            verts: Array.from(positions.subarray(vStart * 3, (vStart + vCount) * 3)),
            faces,
        });
    }

    return { nodes, palette, shade1, shade2, texture, texWidth, texHeight, transparentIndex, backgroundIndex };
}
