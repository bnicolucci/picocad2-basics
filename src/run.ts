import { advanceAnimators } from './lib/animator';
import { PerspectiveCamera } from './lib/camera';
import { pollGamepad, stepInput } from './lib/input';
import { flattenScene, Scene } from './lib/object3d';
import { Renderer, retro } from './lib/renderer';

// The scene and camera every page of a project shares — import them, fill them
// in init(), move things in update().
export const scene = new Scene();
export const camera = new PerspectiveCamera(60, 0.1, 100);

export type RunConfig = {
    /** Canvas size in CSS pixels. Omit both to fill the window. */
    width?: number;
    height?: number;
    /** Pixelation: 0.25 matches picoCAD2's own viewport, 0.5 is cleaner. */
    retroScale?: number;
    /** Runs once: set the background, place the camera, scene.add your models. */
    init: () => void;
    /** Runs at a locked 60 fps: dt is always 1/60, t is seconds since start. */
    update: (dt: number, t: number) => void;
};

const STEP = 1 / 60;

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The whole harness: sizes the canvas, makes the renderer, runs init() once,
 * then update() at a fixed 60 steps/second regardless of display refresh rate
 * (a 120 Hz screen renders every frame but steps every other one; after a slow
 * frame, up to 6 steps catch up so movement never changes speed).
 */
export function run(config: RunConfig): void {
    const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
    if (config.width) canvas.style.width = `${config.width}px`;
    if (config.height) canvas.style.height = `${config.height}px`;
    if (config.retroScale) retro.scale = config.retroScale;

    const renderer = new Renderer(canvas);
    config.init();

    let t = 0;
    let pending = 0;
    let last = performance.now();
    const frame = (now: number): void => {
        pending = Math.min(pending + (now - last) / 1000, 6 * STEP);
        last = now;

        pollGamepad();
        while (pending >= STEP) {
            pending -= STEP;
            t += STEP;
            config.update(STEP, t);
            stepInput();
        }
        advanceAnimators(t);

        renderer.background = hexToRgb(scene.background);
        renderer.render(camera.viewProjection(renderer.aspect), camera.lightDir(), flattenScene(scene, renderer));
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // `retro.scale = 0.25` in the console to dial in the pixelation live.
    Object.assign(window as unknown as Record<string, unknown>, { scene, camera, retro });
}
