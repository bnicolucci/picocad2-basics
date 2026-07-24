// Minimal column-major 4x4 matrix + quaternion math.
// Column-major Float32Array(16), the layout WebGL uniforms expect.

export type Mat4 = Float32Array;
export type Vec3 = { x: number; y: number; z: number };

export function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

export function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
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

// Euler XYZ (radians) -> quaternion [x, y, z, w].
function quatFromEuler(x: number, y: number, z: number): [number, number, number, number] {
    const c1 = Math.cos(x / 2);
    const c2 = Math.cos(y / 2);
    const c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2);
    const s2 = Math.sin(y / 2);
    const s3 = Math.sin(z / 2);
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ];
}

// M = T * R * S from position, XYZ-Euler rotation (radians), and scale.
export function compose(pos: Vec3, rot: Vec3, scale: Vec3): Mat4 {
    const [x, y, z, w] = quatFromEuler(rot.x, rot.y, rot.z);
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;

    const out = new Float32Array(16);
    out[0] = (1 - (yy + zz)) * scale.x;
    out[1] = (xy + wz) * scale.x;
    out[2] = (xz - wy) * scale.x;
    out[4] = (xy - wz) * scale.y;
    out[5] = (1 - (xx + zz)) * scale.y;
    out[6] = (yz + wx) * scale.y;
    out[8] = (xz + wy) * scale.z;
    out[9] = (yz - wx) * scale.z;
    out[10] = (1 - (xx + yy)) * scale.z;
    out[12] = pos.x;
    out[13] = pos.y;
    out[14] = pos.z;
    out[15] = 1;
    return out;
}

export function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovYRadians / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: V3, b: V3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(v: V3): V3 {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
}

export function lookAt(eye: V3, target: V3, up: V3): Mat4 {
    const z = normalize(sub(eye, target));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
}
