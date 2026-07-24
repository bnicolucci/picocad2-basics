import { type Camera, createCamera } from '../lib/camera';
import type { ModelHandle } from '../lib/renderer';
import type { Enemy } from './enemy';
import { SPAWN_ROOM } from './map';
import { createPlayer, type Player } from './player';

// Currently-held keys, lowercased (e.g. 'w', 'arrowleft').
export type Input = Set<string>;

// The whole game state, passed into init/update/draw.
export type World = {
    handles: Record<string, ModelHandle>; // primitive name -> uploaded GPU handle
    camera: Camera;
    player: Player;
    enemies: Enemy[];
    roomId: string;
    time: number;
};

export function createWorld(handles: Record<string, ModelHandle>): World {
    return {
        handles,
        // Fixed angled top-down camera framed on the room (rooms sit at the origin).
        camera: createCamera({ target: [0, 0.5, 0], yaw: 0, pitch: 0.85, distance: 19 }),
        player: createPlayer(),
        enemies: [],
        roomId: SPAWN_ROOM,
        time: 0,
    };
}
