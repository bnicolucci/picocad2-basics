import { spawnRoomEnemies } from './enemy';
import { clampToRoom } from './map';
import type { World } from './world';

const ATTACK_RANGE = 1.9;
const ATTACK_ARC = -0.2; // min dot(facing, dirToEnemy); wide (~110° each side of front)
const KNOCKBACK = 1.5;
const INVULN = 1.2;

// Player <-> enemy interaction, run after movement + collision each frame.
export function resolveCombat(w: World): void {
    const p = w.player;

    // Attack: while a swing is active, damage each in-reach enemy once per swing.
    if (p.attackTimer > 0) {
        const fx = Math.sin(p.facing);
        const fz = Math.cos(p.facing);
        for (const e of w.enemies) {
            if (e.hitSwing === p.swingId) continue;
            const dx = e.x - p.x;
            const dz = e.z - p.z;
            const dist = Math.hypot(dx, dz);
            if (dist <= ATTACK_RANGE && (dist < 1e-4 || (dx / dist) * fx + (dz / dist) * fz >= ATTACK_ARC)) {
                e.hp -= 1;
                e.hitSwing = p.swingId;
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
