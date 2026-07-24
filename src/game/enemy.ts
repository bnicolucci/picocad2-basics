import { compose } from '../lib/math';
import type { Instance } from '../lib/renderer';
import { clampToRoom, roomEnemySpawns } from './map';
import type { World } from './world';

export type EnemyKind = 'chaser' | 'wander';

export type Enemy = {
    x: number;
    z: number;
    facing: number;
    kind: EnemyKind;
    model: string;
    speed: number;
    radius: number;
    hp: number;
    hitSwing: number; // id of the last swing that damaged this enemy (once per swing)
    timer: number; // wander: seconds until next heading change
};

export function createEnemy(kind: EnemyKind, x: number, z: number): Enemy {
    const chaser = kind === 'chaser';
    return {
        x,
        z,
        facing: 0,
        kind,
        model: chaser ? 'mesh_sphere' : 'mesh_cylinder',
        speed: chaser ? 4 : 2.5,
        radius: 0.5,
        hp: chaser ? 2 : 1,
        hitSwing: -1,
        timer: 0,
    };
}

// Replace the enemy list with the current room's spawns. Shared by init, door
// transitions, and respawn-on-death.
export function spawnRoomEnemies(w: World): void {
    w.enemies = roomEnemySpawns(w).map((s) => createEnemy(s.kind, s.x, s.z));
}

export function updateEnemy(e: Enemy, w: World, dt: number): void {
    if (e.kind === 'chaser') {
        const dx = w.player.x - e.x;
        const dz = w.player.z - e.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.001) {
            e.x += (dx / len) * e.speed * dt;
            e.z += (dz / len) * e.speed * dt;
            e.facing = Math.atan2(dx, dz);
        }
    } else {
        e.timer -= dt;
        if (e.timer <= 0) {
            e.facing = Math.random() * Math.PI * 2;
            e.timer = 1 + Math.random() * 2;
        }
        e.x += Math.sin(e.facing) * e.speed * dt;
        e.z += Math.cos(e.facing) * e.speed * dt;
    }
    clampToRoom(w, e);
}

export function enemyInstance(w: World, e: Enemy): Instance {
    // sphere/cylinder are unit-centered, so y 0.5 sets their base on the floor.
    return {
        model: w.handles[e.model],
        matrix: compose({ x: e.x, y: 0.5, z: e.z }, { x: 0, y: e.facing, z: 0 }, { x: 1, y: 1, z: 1 }),
    };
}
