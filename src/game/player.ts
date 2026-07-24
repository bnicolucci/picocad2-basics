import { compose, groundTransform, normalize2 } from '../lib/math';
import type { Instance, UvTransform } from '../lib/renderer';
import { clampToRoom } from './map';
import type { Input, World } from './world';

const ATTACK_COOLDOWN = 0.4;
const ATTACK_DURATION = 0.16; // how long a swing stays "active" (forgiving window)

export type Player = {
    x: number;
    z: number;
    facing: number;
    speed: number;
    radius: number;
    model: string;
    hp: number;
    maxHp: number;
    invuln: number; // seconds of damage immunity remaining
    attackTimer: number; // seconds the current swing stays active
    attackCooldown: number; // seconds until able to attack again
    swingId: number; // increments per swing, so each enemy is hit once per swing
    uv?: UvTransform; // optional per-instance texture tile/repeat
};

export function createPlayer(): Player {
    return {
        x: 0,
        z: 0,
        facing: 0,
        speed: 7,
        radius: 0.5,
        model: 'mesh_capsule',
        hp: 3,
        maxHp: 3,
        invuln: 0,
        attackTimer: 0,
        attackCooldown: 0,
        swingId: 0,
        uv:{ tile: { u: 1, v: 3 } },
    };
}

export function updatePlayer(p: Player, w: World, dt: number, input: Input): void {
    p.invuln = Math.max(0, p.invuln - dt);
    p.attackTimer = Math.max(0, p.attackTimer - dt);
    p.attackCooldown = Math.max(0, p.attackCooldown - dt);

    if ((input.has('z') || input.has('x')) && p.attackCooldown <= 0) {
        p.attackTimer = ATTACK_DURATION;
        p.attackCooldown = ATTACK_COOLDOWN;
        p.swingId++;
    }

    let dx = 0;
    let dz = 0;
    if (input.has('w') || input.has('arrowup')) dz -= 1;
    if (input.has('s') || input.has('arrowdown')) dz += 1;
    if (input.has('a') || input.has('arrowleft')) dx -= 1;
    if (input.has('d') || input.has('arrowright')) dx += 1;

    if (dx !== 0 || dz !== 0) {
        const dir = normalize2(dx, dz);
        p.x += dir.x * p.speed * dt;
        p.z += dir.z * p.speed * dt;
        p.facing = Math.atan2(dir.x, dir.z);
    }
    clampToRoom(w, p);
}

export function playerInstance(w: World, p: Player): Instance {
    // Capsule sits at local y 1.2..2.8, so offset it down onto the floor.
    return {
        model: w.handles[p.model],
        matrix: groundTransform(p.x, -1.2, p.z, p.facing),
        uv: p.uv,
    };
}

// A brief slash in front of the player while a swing is active; null otherwise.
export function slashInstance(w: World, p: Player): Instance | null {
    if (p.attackTimer <= 0) return null;
    const fx = Math.sin(p.facing);
    const fz = Math.cos(p.facing);
    return {
        model: w.handles.mesh_cube,
        matrix: compose({ x: p.x + fx * 1.0, y: 0.6, z: p.z + fz * 1.0 }, { x: 0, y: p.facing, z: 0 }, { x: 1.4, y: 0.3, z: 0.6 }),
    };
}
