import { dirTo2 } from '../lib/math';
import { clampToRoom, roomColliders } from './map';
import type { World } from './world';

type Circle = { x: number; z: number; radius: number };

// Circle-circle collision on the XZ plane, run after movement. Props are
// static (push the mover fully out); player and enemies split the push.
export function resolveCollisions(w: World): void {
    const dynamics: Circle[] = [w.player, ...w.enemies];
    const statics = roomColliders(w);

    for (const d of dynamics) {
        for (const s of statics) separate(d, s, 1, 0);
    }
    for (let i = 0; i < dynamics.length; i++) {
        for (let j = i + 1; j < dynamics.length; j++) separate(dynamics[i], dynamics[j], 0.5, 0.5);
    }

    // A push could shove someone into a wall; keep everyone in the room.
    for (const d of dynamics) clampToRoom(w, d);
}

// Pushes a and b apart along their center line by their overlap, weighted.
function separate(a: Circle, b: Circle, aWeight: number, bWeight: number): void {
    const minDist = a.radius + b.radius;
    const d = dirTo2(b.x, b.z, a.x, a.z);
    if (d.dist >= minDist) return;
    const coincident = d.dist < 1e-6;
    const nx = coincident ? 1 : d.x;
    const nz = coincident ? 0 : d.z;
    const overlap = minDist - (coincident ? 1 : d.dist);
    a.x += nx * overlap * aWeight;
    a.z += nz * overlap * aWeight;
    b.x -= nx * overlap * bWeight;
    b.z -= nz * overlap * bWeight;
}
