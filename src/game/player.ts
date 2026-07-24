import { compose } from '../lib/math';
import type { Instance } from '../lib/renderer';
import { clampToRoom } from './map';
import type { Input, World } from './world';

export type Player = {
    x: number;
    z: number;
    facing: number;
    speed: number;
    radius: number;
    model: string;
};

export function createPlayer(): Player {
    return { x: 0, z: 0, facing: 0, speed: 7, radius: 0.5, model: 'mesh_capsule' };
}

export function updatePlayer(p: Player, w: World, dt: number, input: Input): void {
    let dx = 0;
    let dz = 0;
    if (input.has('w') || input.has('arrowup')) dz -= 1;
    if (input.has('s') || input.has('arrowdown')) dz += 1;
    if (input.has('a') || input.has('arrowleft')) dx -= 1;
    if (input.has('d') || input.has('arrowright')) dx += 1;

    if (dx !== 0 || dz !== 0) {
        const len = Math.hypot(dx, dz);
        p.x += (dx / len) * p.speed * dt;
        p.z += (dz / len) * p.speed * dt;
        p.facing = Math.atan2(dx, dz);
    }
    clampToRoom(w, p);
}

export function playerInstance(w: World, p: Player): Instance {
    // Capsule sits at local y 1.2..2.8, so offset it down onto the floor.
    return {
        model: w.handles[p.model],
        matrix: compose({ x: p.x, y: -1.2, z: p.z }, { x: 0, y: p.facing, z: 0 }, { x: 1, y: 1, z: 1 }),
    };
}
