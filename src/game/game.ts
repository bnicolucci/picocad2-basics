import type { Instance } from '../lib/renderer';
import { resolveCollisions } from './collide';
import { resolveCombat } from './combat';
import { enemyInstance, spawnRoomEnemies, updateEnemy } from './enemy';
import { doorCrossed, enterRoom, mapInstances } from './map';
import { playerInstance, slashInstance, updatePlayer } from './player';
import type { Input, World } from './world';

// The PICO-8 contract: init once, then update + draw every frame.

export function init(w: World): void {
    w.roomId = 'A';
    w.player.x = 0;
    w.player.z = 0;
    spawnRoomEnemies(w);
}

export function update(w: World, dt: number, input: Input): void {
    w.time += dt;

    updatePlayer(w.player, w, dt, input);

    const door = doorCrossed(w);
    if (door) {
        enterRoom(w, door);
        spawnRoomEnemies(w);
    }

    for (const e of w.enemies) updateEnemy(e, w, dt);

    resolveCollisions(w);
    resolveCombat(w);
}

export function draw(w: World): Instance[] {
    const out: Instance[] = [...mapInstances(w), ...w.enemies.map((e) => enemyInstance(w, e))];

    const p = w.player;
    const slash = slashInstance(w, p);
    if (slash) out.push(slash);

    // Blink the player while briefly invulnerable after a hit.
    const blinkedOut = p.invuln > 0 && Math.floor(w.time * 12) % 2 === 0;
    if (!blinkedOut) out.push(playerInstance(w, p));

    return out;
}
