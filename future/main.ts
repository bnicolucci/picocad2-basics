import { Color, type Object3D } from 'three/webgpu';
import pigText from './assets/models/pig.txt?raw';
import { cube, plane, sphere } from './primitives';
import { camera, run, scene } from './run';
import { PicoCad2Loader } from './three';

let pig: Object3D;
let box: Object3D;
let ball: Object3D;

function init(): void {
    scene.background = new Color('#1d2b53');
    camera.position.set(0, 6, 11);
    camera.lookAt(0, 1.5, 0);

    const floor = plane({ uv: { repeatU: 10, repeatV: 10 } });
    floor.scale.set(14, 1, 14);
    scene.add(floor);

    pig = new PicoCad2Loader().parse(pigText).instantiate();
    scene.add(pig);

    box = cube({ uv: { tile: { u: 2, v: 2 } } });
    box.position.set(-4.5, 1.5, 0);
    scene.add(box);

    ball = sphere({ color: 4 });
    ball.position.set(4.5, 0.5, 0);
    scene.add(ball);
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
