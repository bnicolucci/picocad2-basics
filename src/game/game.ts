import type { Instance } from '../lib/renderer';
import { resolveCollisions } from './collide';
import { createEnemy, enemyInstance, updateEnemy } from './enemy';
import { doorCrossed, enterRoom, mapInstances, roomEnemySpawns } from './map';
import { playerInstance, updatePlayer } from './player';
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
}

export function draw(w: World): Instance[] {
    return [...mapInstances(w), ...w.enemies.map((e) => enemyInstance(w, e)), playerInstance(w, w.player)];
}

function spawnRoomEnemies(w: World): void {
    w.enemies = roomEnemySpawns(w).map((s) => createEnemy(s.kind, s.x, s.z));
}
