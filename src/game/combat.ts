import { spawnRoomEnemies } from './enemy';
import { clampToRoom } from './map';
import type { World } from './world';

const ATTACK_RANGE = 2;
const ATTACK_ARC = 0.3; // min dot(facing, dirToEnemy) to be "in front"
const KNOCKBACK = 1.5;
const INVULN = 1.2;

// Player <-> enemy interaction, run after movement + collision each frame.
export function resolveCombat(w: World): void {
    const p = w.player;

    // Attack: damage enemies in a forward arc; drop any that die.
    if (p.attackFired) {
        const fx = Math.sin(p.facing);
        const fz = Math.cos(p.facing);
        for (const e of w.enemies) {
            const dx = e.x - p.x;
            const dz = e.z - p.z;
            const dist = Math.hypot(dx, dz);
            if (dist > 1e-4 && dist <= ATTACK_RANGE && (dx / dist) * fx + (dz / dist) * fz >= ATTACK_ARC) {
                e.hp -= 1;
            }
        }
        w.enemies = w.enemies.filter((e) => e.hp > 0);
    }

    // Enemy contact damages the player, with i-frames + knockback.
    if (p.invuln <= 0) {
        for (const e of w.enemies) {
            const dx = p.x - e.x;
            const dz = p.z - e.z;
            const dist = Math.hypot(dx, dz);
            if (dist <= p.radius + e.radius + 0.1) {
                p.hp -= 1;
                p.invuln = INVULN;
                const nx = dist > 1e-4 ? dx / dist : 1;
                const nz = dist > 1e-4 ? dz / dist : 0;
                p.x += nx * KNOCKBACK;
                p.z += nz * KNOCKBACK;
                clampToRoom(w, p);
                break; // at most one hit per frame
            }
        }
    }

    // Death: respawn at room A with full health.
    if (p.hp <= 0) {
        p.hp = p.maxHp;
        p.invuln = INVULN;
        p.x = 0;
        p.z = 0;
        w.roomId = 'A';
        spawnRoomEnemies(w);
    }
}
