import { advanceAnimators } from './lib/animator';
import { PerspectiveCamera } from './lib/camera';
import { pollGamepad, stepInput } from './lib/input';
import { flattenScene, Scene } from './lib/object3d';
import { Renderer } from './lib/renderer';

// The scene and camera every page of a project shares — import them, fill them
// in init(), move things in update().
export const scene = new Scene();
export const camera = new PerspectiveCamera(60, 0.1, 100);

// The page config (canvas size, aspect, colours, retroScale) is `PAGE` in
// index.html — the single source of truth. It lives there, not here, because
// an inline script can size and colour the canvas during HTML parse, before
// the first paint; a JS module runs too late and always flashes. run() picks
// up the bits the engine needs at runtime.
type PageConfig = {
    retroScale?: number;
    background?: string;
};

const STEP = 1 / 60;

export type RunConfig = {
    /** Runs once: place the camera, scene.add your models. */
    init: () => void;
    /** Runs at a locked 60 fps: dt is always 1/60, t is seconds since start. */
    update: (dt: number, t: number) => void;
};

/**
 * The whole harness: makes the renderer, runs init() once, then update() at a
 * fixed 60 steps/second regardless of display refresh rate (a 120 Hz screen
 * renders every frame but steps every other one; after a slow frame, up to 6
 * steps catch up so movement never changes speed).
 */
export function run(config: RunConfig): void {
    const page = (window as unknown as { PAGE?: PageConfig }).PAGE ?? {};
    if (page.background) scene.background = page.background;

    const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
    const renderer = new Renderer(canvas);
    if (page.retroScale) renderer.retroScale = page.retroScale;
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

        renderer.setBackground(scene.background);
        renderer.render(camera.viewProjection(renderer.aspect), camera.lightDir(), flattenScene(scene));
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // `renderer.retroScale = 0.25` in the console to dial in the pixelation live.
    Object.assign(window as unknown as Record<string, unknown>, { scene, camera, renderer });
}
