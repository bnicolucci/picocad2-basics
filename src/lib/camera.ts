import { lookAt, type Mat4, multiply, perspective } from './math';

export type Camera = {
    target: [number, number, number];
    yaw: number; // radians around Y
    pitch: number; // radians up/down
    distance: number;
    fovYRadians: number;
    near: number;
    far: number;
    up: [number, number, number];
};

export function createCamera(partial: Partial<Camera> = {}): Camera {
    return {
        target: partial.target ?? [0, 2, 0],
        yaw: partial.yaw ?? 0.7,
        pitch: partial.pitch ?? 0.35,
        distance: partial.distance ?? 11,
        fovYRadians: partial.fovYRadians ?? (60 * Math.PI) / 180,
        near: partial.near ?? 0.1,
        far: partial.far ?? 300,
        up: partial.up ?? [0, 1, 0],
    };
}

export function cameraEye(cam: Camera): [number, number, number] {
    const cp = Math.cos(cam.pitch);
    return [
        cam.target[0] + cam.distance * cp * Math.sin(cam.yaw),
        cam.target[1] + cam.distance * Math.sin(cam.pitch),
        cam.target[2] + cam.distance * cp * Math.cos(cam.yaw),
    ];
}

export function viewProjection(cam: Camera, aspect: number): Mat4 {
    const proj = perspective(cam.fovYRadians, aspect, cam.near, cam.far);
    const view = lookAt(cameraEye(cam), cam.target, cam.up);
    return multiply(proj, view);
}

// The light is a headlight fixed in view space (slightly above the camera),
// rotated into world space each frame. This is what gives picoCAD its checker
// dither: as you orbit, surfaces sweep through the lit/dither/dark bands.
const LIGHT_VIEW: [number, number, number] = (() => {
    const l = Math.hypot(0, -0.3, -1);
    return [0, -0.3 / l, -1 / l];
})();

export function cameraLightDir(cam: Camera): [number, number, number] {
    const v = lookAt(cameraEye(cam), cam.target, cam.up);
    const [lx, ly, lz] = LIGHT_VIEW;
    // world = R^T * lightView (view rotation is orthonormal, so transpose = inverse).
    const x = v[0] * lx + v[1] * ly + v[2] * lz;
    const y = v[4] * lx + v[5] * ly + v[6] * lz;
    const z = v[8] * lx + v[9] * ly + v[10] * lz;
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

const PITCH_LIMIT = 1.45;

// Left-drag orbits, wheel zooms. That's the whole camera interaction.
export function installOrbitControls(canvas: HTMLCanvasElement, cam: Camera): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('mousedown', (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => {
        dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        cam.yaw -= (e.clientX - lastX) * 0.01;
        cam.pitch += (e.clientY - lastY) * 0.01;
        cam.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cam.pitch));
        lastX = e.clientX;
        lastY = e.clientY;
    });
    canvas.addEventListener(
        'wheel',
        (e) => {
            e.preventDefault();
            cam.distance = Math.max(1, cam.distance * (1 + e.deltaY * 0.001));
        },
        { passive: false },
    );
}
