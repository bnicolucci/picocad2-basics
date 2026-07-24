import { dirTo2 } from '../lib/math';
import { spawnRoomEnemies } from './enemy';
import { clampToRoom, SPAWN_ROOM } from './map';
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
            const d = dirTo2(p.x, p.z, e.x, e.z);
            if (d.dist <= ATTACK_RANGE && (d.dist < 1e-4 || d.x * fx + d.z * fz >= ATTACK_ARC)) {
                e.hp -= 1;
                e.hitSwing = p.swingId;
            }
        }
        w.enemies = w.enemies.filter((e) => e.hp > 0);
    }

    // Enemy contact damages the player, with i-frames + knockback.
    if (p.invuln <= 0) {
        for (const e of w.enemies) {
            const d = dirTo2(e.x, e.z, p.x, p.z);
            if (d.dist <= p.radius + e.radius + 0.1) {
                p.hp -= 1;
                p.invuln = INVULN;
                const nx = d.dist > 1e-4 ? d.x : 1;
                const nz = d.dist > 1e-4 ? d.z : 0;
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
        w.roomId = SPAWN_ROOM;
        spawnRoomEnemies(w);
    }
}
