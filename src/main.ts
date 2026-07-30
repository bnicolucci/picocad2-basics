import { spawnEntity } from './assets/entities';
import { loadAnimationClips } from './assets/models/animations';
import { move, pressed } from './controls';
import { type PicoCadAnimator, playClip } from './lib/animator';
import { audioReady } from './lib/audio';
import { faceToward } from './lib/entity';
import type { Object3D } from './lib/object3d';
import type { PicoCadAnimationClip } from './lib/picocad2';
import { cube, plane, sphere } from './primitives';
import { camera, run, scene } from './run';
import { play, playAt, playMusic, preloadSounds } from './sounds';

// Canvas size, aspect, colours, retroScale: the PAGE config in index.html.

let pig: Object3D;
let box: Object3D;
let ball: Object3D;
let tank: Object3D;
let primitivething: Object3D;

let pigClips: Record<string, PicoCadAnimationClip> = {};
let tankClips: Record<string, PicoCadAnimationClip> = {};
let pigAnim: PicoCadAnimator | null = null;
let tankAnim: PicoCadAnimator | null = null;

function init(): void {
    camera.position.set(0, 6, 11);
    camera.lookAt(0, 1.5, 0);

    preloadSounds();

    const floor = plane({ uv: { repeatU: 10, repeatV: 10 } });
    floor.scale.set(14, 1, 14);
    scene.add(floor);

    pig = spawnEntity('pig');
    scene.add(pig);
    primitivething = spawnEntity('PrimitiveThing');
    scene.add(primitivething);

    // An entity + its clip registry: thinktank.txt carries the mesh once;
    // thinktank_animations.ts carries just the motion tracks.
    tank = spawnEntity('thinktank');
    tank.position.set(0, 0, -4.5);
    scene.add(tank);

    box = cube({ uv: { tile: { u: 2, v: 2 } } });
    box.position.set(-4.5, 1.5, 0);
    scene.add(box);

    ball = sphere({ color: 4 });
    ball.position.set(4.5, 0.5, 0);
    scene.add(ball);

    void loadAnimationClips('pig').then((clips) => {
        pigClips = clips;
    });
    void loadAnimationClips('thinktank').then((clips) => {
        tankClips = clips;
    });
}

const PIG_SPEED = 6;
const FLOOR_EDGE = 6.5;

let ballWasUp = false;
let musicStarted = false;

function update(dt: number, t: number): void {
    const m = move();
    pig.position.x = Math.min(FLOOR_EDGE, Math.max(-FLOOR_EDGE, pig.position.x + m.x * PIG_SPEED * dt));
    pig.position.z = Math.min(FLOOR_EDGE, Math.max(-FLOOR_EDGE, pig.position.z + m.z * PIG_SPEED * dt));
    faceToward(pig, m.x, m.z);

    if (pressed('shoot') && tankClips.shoot) {
        tankAnim?.stop();
        tankAnim = playClip(tank, tankClips.shoot, { loop: false, start: t });
        playAt('shoot', tank.position.x, tank.position.y, tank.position.z);
    }
    if (pressed('bounce') && pigClips.bounce) {
        pigAnim?.stop();
        pigAnim = playClip(pig, pigClips.bounce, { loop: false, start: t });
        play('pickup');
    }

    box.rotation.x += dt;
    box.rotation.y += dt * 2;

    // The ball orbits while it bounces, so each landing is heard from wherever
    // it happens to be — the pan and falloff in playAt are the point.
    const bounce = Math.abs(Math.sin(t * 3));
    ball.position.set(Math.cos(t * 0.7) * 5, 0.5 + bounce * 1.5, Math.sin(t * 0.7) * 5);
    const up = bounce > 0.05;
    if (ballWasUp && !up) playAt('bounce', ball.position.x, ball.position.y, ball.position.z, 0.7);
    ballWasUp = up;

    if (!musicStarted && audioReady()) {
        musicStarted = true;
        playMusic(0.35);
    }
}

run({ init, update });
