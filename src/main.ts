import { loadAnimationClips } from './assets/models/animations';
import pigText from './assets/models/pig.txt?raw';
import thinktankText from './assets/models/thinktank.txt?raw';
import { move, pressed } from './controls';
import { type PicoCadAnimator, playClip } from './lib/animator';
import { PicoCad2Loader } from './lib/loader';
import type { Object3D } from './lib/object3d';
import type { PicoCadAnimationClip } from './lib/picocad2';
import { cube, plane, sphere } from './primitives';
import { camera, run, scene } from './run';

// Canvas size, aspect, colours, retroScale: the PAGE config in index.html.

let pig: Object3D;
let box: Object3D;
let ball: Object3D;
let tank: Object3D;

let pigClips: Record<string, PicoCadAnimationClip> = {};
let tankClips: Record<string, PicoCadAnimationClip> = {};
let pigAnim: PicoCadAnimator | null = null;
let tankAnim: PicoCadAnimator | null = null;

function init(): void {
    camera.position.set(0, 6, 11);
    camera.lookAt(0, 1.5, 0);

    const floor = plane({ uv: { repeatU: 10, repeatV: 10 } });
    floor.scale.set(14, 1, 14);
    scene.add(floor);

    pig = new PicoCad2Loader().parse(pigText).instantiate();
    pig.scale.set(0.25, 0.25, 0.25);
    scene.add(pig);

    box = cube({ uv: { tile: { u: 2, v: 2 } } });
    box.position.set(-4.5, 1.5, 0);
    scene.add(box);

    ball = sphere({ color: 4 });
    ball.position.set(4.5, 0.5, 0);
    scene.add(ball);

    // A base model + its extracted clip registry: thinktank.txt carries the
    // mesh once; thinktank_animations.ts carries just the motion tracks.
    tank = new PicoCad2Loader().parse(thinktankText).instantiate();
    tank.position.set(0, 0, -4.5);
    scene.add(tank);

    void loadAnimationClips('pig').then((clips) => {
        pigClips = clips;
    });
    void loadAnimationClips('thinktank').then((clips) => {
        tankClips = clips;
    });
}

const PIG_SPEED = 6;
const FLOOR_EDGE = 6.5;

function update(dt: number, t: number): void {
    const m = move();
    pig.position.x = Math.min(FLOOR_EDGE, Math.max(-FLOOR_EDGE, pig.position.x + m.x * PIG_SPEED * dt));
    pig.position.z = Math.min(FLOOR_EDGE, Math.max(-FLOOR_EDGE, pig.position.z + m.z * PIG_SPEED * dt));
    if (m.x !== 0 || m.z !== 0) pig.rotation.y = Math.atan2(m.x, m.z);

    if (pressed('shoot') && tankClips.shoot) {
        tankAnim?.stop();
        tankAnim = playClip(tank, tankClips.shoot, { loop: false, start: t });
    }
    if (pressed('bounce') && pigClips.bounce) {
        pigAnim?.stop();
        pigAnim = playClip(pig, pigClips.bounce, { loop: false, start: t });
    }

    box.rotation.x += dt;
    box.rotation.y += dt * 2;
    ball.position.y = 0.5 + Math.abs(Math.sin(t * 3)) * 1.5;
}

run({ init, update });
