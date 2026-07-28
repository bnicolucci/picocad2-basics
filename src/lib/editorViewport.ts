import { advanceAnimators } from './animator';
import { PerspectiveCamera } from './camera';
import { flattenScene, Scene } from './object3d';
import { Renderer } from './renderer';

// Shared viewport for the dev-only editor pages: one renderer + scene + orbit
// camera on a canvas, free-running through the real engine. Drag to orbit,
// scroll to zoom. Editors fill `scene` and frame the orbit; playback advanced
// here is the same animator the game uses.

export type EditorViewport = {
    renderer: Renderer;
    scene: Scene;
    camera: PerspectiveCamera;
    /** Aim the orbit at a centre and fit the distance to a bounding radius,
        optionally snapping to a viewing angle (radians). */
    frame(center: { x: number; y: number; z: number }, radius: number, pose?: { yaw?: number; pitch?: number }): void;
    /** The viewport's animation clock (seconds) — pass as playClip `start`. */
    clock(): number;
    /** World point -> canvas CSS px, or null when behind the camera. */
    project(x: number, y: number, z: number): { x: number; y: number } | null;
};

export function createEditorViewport(canvas: HTMLCanvasElement, opts: { fov?: number; background?: string } = {}): EditorViewport {
    const fov = opts.fov ?? 60;
    const renderer = new Renderer(canvas);
    // Editors preview in small panels; render sharp, not game-pixelated.
    renderer.retroScale = 1;
    const scene = new Scene();
    if (opts.background) scene.background = opts.background;
    const camera = new PerspectiveCamera(fov, 0.05, 500);

    const orbit = { yaw: 0.7, pitch: 0.35, distance: 8, minDistance: 1, maxDistance: 40, target: { x: 0, y: 1, z: 0 } };

    function applyOrbit(): void {
        const cp = Math.cos(orbit.pitch);
        camera.position.set(
            orbit.target.x + orbit.distance * cp * Math.sin(orbit.yaw),
            orbit.target.y + orbit.distance * Math.sin(orbit.pitch),
            orbit.target.z + orbit.distance * cp * Math.cos(orbit.yaw),
        );
        camera.lookAt(orbit.target.x, orbit.target.y, orbit.target.z);
    }

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        orbit.yaw -= (e.clientX - lastX) * 0.01;
        orbit.pitch = Math.min(1.5, Math.max(-1.5, orbit.pitch + (e.clientY - lastY) * 0.01));
        lastX = e.clientX;
        lastY = e.clientY;
    });
    canvas.addEventListener('pointerup', () => {
        dragging = false;
    });
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.001);
        orbit.distance = Math.min(orbit.maxDistance, Math.max(orbit.minDistance, orbit.distance * factor));
    }, { passive: false });

    let clock = 0;
    let last = performance.now();
    const frameLoop = (now: number): void => {
        clock += Math.min((now - last) / 1000, 0.1);
        last = now;
        advanceAnimators(clock);
        applyOrbit();
        renderer.setBackground(scene.background);
        renderer.render(camera.viewProjection(renderer.aspect), camera.lightDir(), flattenScene(scene));
        requestAnimationFrame(frameLoop);
    };
    requestAnimationFrame(frameLoop);

    return {
        renderer,
        scene,
        camera,
        frame(center, radius, pose) {
            const r = Math.max(0.5, radius);
            orbit.target = { ...center };
            orbit.distance = (r / Math.sin((fov * Math.PI) / 360)) * 1.15;
            orbit.minDistance = Math.max(0.05, r * 0.15);
            orbit.maxDistance = Math.max(orbit.distance * 4, r * 20);
            if (pose?.yaw !== undefined) orbit.yaw = pose.yaw;
            if (pose?.pitch !== undefined) orbit.pitch = pose.pitch;
        },
        clock: () => clock,
        project(x, y, z) {
            const m = camera.viewProjection(renderer.aspect);
            const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (cw <= 0) return null;
            const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
            const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
            return {
                x: (cx * 0.5 + 0.5) * canvas.clientWidth,
                y: (1 - (cy * 0.5 + 0.5)) * canvas.clientHeight,
            };
        },
    };
}
