import { loadAnimationClips } from './assets/models/animations';
import pigText from './assets/models/pig.txt?raw';
import thinktankText from './assets/models/thinktank.txt?raw';
import { playClip } from './lib/animator';
import { PicoCad2Loader } from './lib/loader';
import type { Object3D } from './lib/object3d';
import { cube, plane, sphere } from './primitives';
import { camera, run, scene } from './run';

let pig: Object3D;
let box: Object3D;
let ball: Object3D;

function init(): void {
    scene.background = '#1d2b53';
    camera.position.set(0, 6, 11);
    camera.lookAt(0, 1.5, 0);

    const floor = plane({ uv: { repeatU: 10, repeatV: 10 } });
    floor.scale.set(14, 1, 14);
    scene.add(floor);

    pig = new PicoCad2Loader().parse(pigText).instantiate();
    pig.position.set(0, 0, 0);
    pig.scale.set(0.25, 0.25, 0.25);
    scene.add(pig);
    void loadAnimationClips('pig').then((clips) => {
        if (clips.bounce) playClip(pig, clips.bounce);
    });

    box = cube({ uv: { tile: { u: 2, v: 2 } } });
    box.position.set(-4.5, 1.5, 0);
    scene.add(box);

    ball = sphere({ color: 4 });
    ball.position.set(4.5, 0.5, 0);
    scene.add(ball);

    // A base model + its extracted clip registry: thinktank.txt carries the
    // mesh once; thinktank_animations.ts carries just the motion tracks.
    const tank = new PicoCad2Loader().parse(thinktankText).instantiate();
    tank.position.set(0, 0, -4.5);
    scene.add(tank);
    void loadAnimationClips('thinktank').then((clips) => {
        if (clips.shoot) playClip(tank, clips.shoot);
    });
}

function update(dt: number, t: number): void {
    pig.rotation.y = t * 0.6;
    box.rotation.x += dt;
    box.rotation.y += dt * 2;
    ball.position.y = 0.5 + Math.abs(Math.sin(t * 3)) * 1.5;
}

run({
    width: 800,
    height: 600,
    retroScale: 0.5,
    init,
    update,
});
