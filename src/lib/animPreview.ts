import { advanceAnimators, type PicoCadAnimator, playClip } from './animator';
import { PerspectiveCamera } from './camera';
import { PicoCad2Loader } from './loader';
import { flattenScene, type Object3D, Scene } from './object3d';
import { computeGraphBounds, type PicoCadAnimationClip } from './picocad2';
import { Renderer } from './renderer';

// Single-model preview for the Animation editor: one renderer for the page's
// lifetime, the model inside it swapped per selection. Drag to orbit, scroll
// to zoom. Playback runs through the real loader + animator, so what plays
// here is what plays in-game.

export type AnimPreview = {
    /** Swap in a model; false if the text failed to parse. */
    setModel(text: string): boolean;
    /** Remove the current model (and stop playback). */
    clear(): void;
    /** Play a clip on the current model; null when no model is loaded. */
    play(clip: PicoCadAnimationClip): PicoCadAnimator | null;
    stop(): void;
};

const FOV = 60;

export function createAnimPreview(canvas: HTMLCanvasElement): AnimPreview {
    const renderer = new Renderer(canvas);
    renderer.background = [0.10, 0.12, 0.14];
    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 0.05, 500);
    const loader = new PicoCad2Loader();

    let model: Object3D | null = null;
    let animator: PicoCadAnimator | null = null;

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
    const frame = (now: number): void => {
        clock += Math.min((now - last) / 1000, 0.1);
        last = now;
        advanceAnimators(clock);
        applyOrbit();
        renderer.render(camera.viewProjection(renderer.aspect), camera.lightDir(), flattenScene(scene, renderer));
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    function stop(): void {
        animator?.stop();
        animator = null;
    }

    function clear(): void {
        stop();
        if (model) scene.remove(model);
        model = null;
    }

    return {
        setModel(text: string): boolean {
            clear();
            try {
                const parsed = loader.parse(text);
                model = parsed.instantiate();
                scene.add(model);
                // Frame the orbit to the model's bounds. The mirror negates the
                // visible X of the raw graph center; Y/Z are unchanged.
                const b = parsed.data.graph ? computeGraphBounds(parsed.data.graph) : null;
                if (b) {
                    const radius = Math.max(0.5, 0.5 * Math.hypot(b.sizeX, b.sizeY, b.sizeZ));
                    orbit.target = { x: -b.centerX, y: b.centerY, z: b.centerZ };
                    orbit.distance = (radius / Math.sin((FOV * Math.PI) / 360)) * 1.15;
                    orbit.minDistance = Math.max(0.05, radius * 0.15);
                    orbit.maxDistance = Math.max(orbit.distance * 4, radius * 20);
                }
                return true;
            } catch {
                model = null;
                return false;
            }
        },
        clear,
        play(clip: PicoCadAnimationClip): PicoCadAnimator | null {
            if (!model) return null;
            stop();
            animator = playClip(model, clip, { start: clock });
            return animator;
        },
        stop,
    };
}
