import { lookAt, type Mat4, multiply, normalize, perspective, type V3 } from './math';
import { Vector3 } from './object3d';

// The light is a headlight fixed in view space (slightly above the camera),
// rotated into world space each frame. This is what gives picoCAD its checker
// dither: as you orbit, surfaces sweep through the lit/dither/dark bands.
const LIGHT_VIEW = normalize([0, -0.3, -1]);

function headlightFromView(v: Mat4): V3 {
    const [lx, ly, lz] = LIGHT_VIEW;
    // world = R^T * lightView (view rotation is orthonormal, so transpose = inverse).
    return normalize([
        v[0] * lx + v[1] * ly + v[2] * lz,
        v[4] * lx + v[5] * ly + v[6] * lz,
        v[8] * lx + v[9] * ly + v[10] * lz,
    ]);
}

// The simple-API camera: place it with `camera.position.set(...)`, aim it with
// `camera.lookAt(...)`. Aspect comes from the canvas each frame, so it is not
// a constructor argument.
export class PerspectiveCamera {
    readonly position = new Vector3(0, 5, 10);
    readonly target = new Vector3(0, 0, 0);
    fov: number; // degrees
    near: number;
    far: number;

    constructor(fov = 60, near = 0.1, far = 100) {
        this.fov = fov;
        this.near = near;
        this.far = far;
    }

    lookAt(x: number, y: number, z: number): void {
        this.target.set(x, y, z);
    }

    private view(): Mat4 {
        const p = this.position;
        const t = this.target;
        return lookAt([p.x, p.y, p.z], [t.x, t.y, t.z], [0, 1, 0]);
    }

    viewProjection(aspect: number): Mat4 {
        return multiply(perspective((this.fov * Math.PI) / 180, aspect, this.near, this.far), this.view());
    }

    lightDir(): [number, number, number] {
        return headlightFromView(this.view());
    }
}
