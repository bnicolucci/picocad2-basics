import type { MeshBounds, PicoCad2Node } from '../picocad2';

export type AABB = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

export type RotateRingGeometry = { centerX: number; centerZ: number; radius: number };

export function formatNumber(n: number): string {
    if (Math.abs(n) < 1e-9) return '0';
    return Number(n.toFixed(4)).toString();
}

export function formatInspectorNumber(value: number): string {
    return Number(value.toFixed(4)).toString();
}

export function parseInspectorNumber(input: HTMLInputElement | null, fallback: number): number {
    const value = Number(input?.value);
    return Number.isFinite(value) ? value : fallback;
}

export function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

export function meshIdToPath(meshId: string, modelId: string): number[] {
    const suffix = meshId.slice(`mesh:${modelId}:`.length);
    if (suffix === 'root') return [];
    return suffix.split('/').map(Number);
}

export function findNodeByMeshId(root: PicoCad2Node, modelId: string, meshId: string): PicoCad2Node | null {
    let node: PicoCad2Node | undefined = root;
    for (const index of meshIdToPath(meshId, modelId)) {
        node = node.children?.[index];
        if (!node) return null;
    }
    return node ?? null;
}

export function outlinerNodeName(node: PicoCad2Node, fallback: string): string {
    return node.name?.trim() || fallback;
}

export function rotateRingGeometry(pos: [number, number, number], footprint: [number, number, number, number]): RotateRingGeometry {
    const [rx0, rx1, rz0, rz1] = footprint;
    const centerX = pos[0] + (rx0 + rx1) * 0.5;
    const centerZ = pos[2] + (rz0 + rz1) * 0.5;
    const halfW = Math.abs(rx1 - rx0) * 0.5;
    const halfD = Math.abs(rz1 - rz0) * 0.5;
    return { centerX, centerZ, radius: Math.max(0.75, Math.hypot(halfW, halfD) + 0.45) };
}

const MAT4_IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function boundsToFootprint(b: MeshBounds | null): [number, number, number, number] {
    if (!b) return [-0.5, 0.5, -0.5, 0.5];
    return [b.minX, b.maxX, b.minZ, b.maxZ];
}

function transformPoint(m: Float32Array, vx: number, vy: number, vz: number): [number, number, number] {
    return [
        m[0] * vx + m[4] * vy + m[8] * vz + m[12],
        m[1] * vx + m[5] * vy + m[9] * vz + m[13],
        m[2] * vx + m[6] * vy + m[10] * vz + m[14],
    ];
}

export function computeWorldAABB(b: MeshBounds, m: Float32Array): AABB {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const vx of [b.minX, b.maxX]) {
        for (const vy of [b.minY, b.maxY]) {
            for (const vz of [b.minZ, b.maxZ]) {
                const [wx, wy, wz] = transformPoint(m, vx, vy, vz);
                if (wx < minX) minX = wx;
                if (wx > maxX) maxX = wx;
                if (wy < minY) minY = wy;
                if (wy > maxY) maxY = wy;
                if (wz < minZ) minZ = wz;
                if (wz > maxZ) maxZ = wz;
            }
        }
    }

    return { minX, maxX, minY, maxY, minZ, maxZ };
}

export function rayHitsAABB(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, box: AABB): number | null {
    let tmin = -Infinity;
    let tmax = Infinity;

    for (const [o, d, lo, hi] of [
        [ox, dx, box.minX, box.maxX],
        [oy, dy, box.minY, box.maxY],
        [oz, dz, box.minZ, box.maxZ],
    ] as [number, number, number, number][]) {
        if (Math.abs(d) < 1e-10) {
            if (o < lo || o > hi) return null;
        } else {
            const inv = 1 / d;
            const t1 = (lo - o) * inv;
            const t2 = (hi - o) * inv;
            tmin = Math.max(tmin, Math.min(t1, t2));
            tmax = Math.min(tmax, Math.max(t1, t2));
        }
    }

    return tmax >= tmin && tmax > 0 ? Math.max(0, tmin) : null;
}

export function buildModelMatrix(
    pos: [number, number, number],
    rotDeg: [number, number, number],
    scale: [number, number, number],
): Float32Array {
    const r = Math.PI / 180;
    const cx = Math.cos(rotDeg[0] * r);
    const sx = Math.sin(rotDeg[0] * r);
    const cy = Math.cos(rotDeg[1] * r);
    const sy = Math.sin(rotDeg[1] * r);
    const cz = Math.cos(rotDeg[2] * r);
    const sz = Math.sin(rotDeg[2] * r);

    const r00 = cy * cz + sy * sx * sz;
    const r01 = -cy * sz + sy * sx * cz;
    const r02 = sy * cx;
    const r10 = cx * sz;
    const r11 = cx * cz;
    const r12 = -sx;
    const r20 = -sy * cz + cy * sx * sz;
    const r21 = sy * sz + cy * sx * cz;
    const r22 = cy * cx;

    const [scx, scy, scz] = scale;
    return new Float32Array([
        r00 * scx,
        r10 * scx,
        r20 * scx,
        0,
        r01 * scy,
        r11 * scy,
        r21 * scy,
        0,
        r02 * scz,
        r12 * scz,
        r22 * scz,
        0,
        pos[0],
        pos[1],
        pos[2],
        1,
    ]);
}

export function rotateScaledLocalOffset(
    rotDeg: [number, number, number],
    scale: [number, number, number],
    offset: [number, number, number],
): [number, number, number] {
    const m = buildModelMatrix([0, 0, 0], rotDeg, scale);
    return [
        m[0] * offset[0] + m[4] * offset[1] + m[8] * offset[2],
        m[1] * offset[0] + m[5] * offset[1] + m[9] * offset[2],
        m[2] * offset[0] + m[6] * offset[1] + m[10] * offset[2],
    ];
}

export function identityMatrix(): Float32Array {
    return new Float32Array(MAT4_IDENTITY);
}

export function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

export function snapDegrees(deg: number, step: number): number {
    return Math.round(deg / step) * step;
}

export function angleDeltaDeg(from: number, to: number): number {
    let delta = to - from;
    while (delta <= -180) delta += 360;
    while (delta > 180) delta -= 360;
    return delta;
}

export function screenDistanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    if (len2 <= 1e-6) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
