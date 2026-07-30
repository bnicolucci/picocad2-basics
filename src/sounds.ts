import { type Instrument, play as playSamples, renderSong, renderSound, type Song, type Stereo } from './lib/audio';
import { camera } from './run';

// The game's sounds, as numbers. Each one is a note plus 29 instrument knobs —
// author them in SoundBox (https://sb.bitsnbites.eu), which uses exactly this
// parameter order, and paste the instrument array in here.
//
// Sound names are typed: renaming one turns every stale play('...') into a
// compile error, the same deal as controls.ts.
//
// These four are Dominic Szablewski's, from q1k3 (MIT) — known-good reference
// settings while the synth beds in. Replace them with your own.
export const sounds = {
    shoot: { note: 135, instrument: [7,3,0,1,255,1,6,0,0,1,255,1,112,548,1979,11601,255,2,2902,176,2,77,0,0,1,0,10,255,1] },
    hit: { note: 135, instrument: [8,0,0,1,148,1,0,0,0,0,0,1,255,0,0,2193,128,2,6982,119,2,23,0,0,0,0,0,0,0] },
    bounce: { note: 168, instrument: [7,0,124,0,128,0,8,5,127,0,128,0,125,88,0,2193,125,1,1238,240,1,91,3,47,0,0,0,0,0] },
    pickup: { note: 140, instrument: [7,0,0,1,187,3,8,0,0,1,204,3,0,4298,927,1403,255,0,0,0,3,35,0,0,0,0,0,0,0] },
} as const satisfies Record<string, { note: number; instrument: Instrument }>;

export type SoundName = keyof typeof sounds;

// A placeholder loop, written by hand against the format. Swap it for a
// SoundBox export: `rowLen` is its rowLen, `sequence` its song rows (1-based,
// 0 = a silent bar) and `patterns` its 32-row note columns.
export const music: Song = {
    rowLen: 5513,
    seconds: 16,
    tracks: [
        {
            instrument: [7,0,0,1,255,0,7,0,0,1,255,0,0,100,0,3800,220,2,1400,240,0,0,0,0,0,0,0,0,0],
            sequence: [1, 1, 1, 1],
            patterns: [[126,0,0,0,126,0,0,0,126,0,0,0,126,0,0,0,126,0,0,0,126,0,0,0,126,0,0,0,126,0,0,0]],
        },
        {
            instrument: [6,0,0,0,192,2,6,0,12,0,160,2,0,20,150,3000,180,2,900,200,2,60,0,0,0,0,0,0,0],
            sequence: [1, 1, 2, 1],
            patterns: [
                [123,0,0,0,0,0,123,0,130,0,0,0,0,0,123,0,121,0,0,0,0,0,121,0,128,0,0,0,0,0,121,0],
                [126,0,0,0,0,0,126,0,133,0,0,0,0,0,126,0,123,0,0,0,0,0,123,0,130,0,0,0,0,0,123,0],
            ],
        },
        {
            instrument: [8,0,0,0,110,1,8,0,7,0,90,1,0,5,80,1800,160,2,2600,180,3,90,0,0,0,1,4,80,0],
            sequence: [0, 1, 0, 2],
            patterns: [
                [135,0,138,0,142,0,138,0,135,0,138,0,142,0,145,0,135,0,138,0,142,0,138,0,133,0,130,0,0,0],
                [138,0,142,0,145,0,142,0,138,0,142,0,145,0,147,0,138,0,142,0,145,0,142,0,135,0,133,0,0,0],
            ],
        },
        {
            instrument: [0,0,0,0,0,0,0,0,0,0,0,0,90,2,20,400,120,1,6000,90,0,0,0,0,0,0,0,0,0],
            sequence: [1, 1, 1, 1],
            patterns: [[0,0,135,0,0,0,135,0,0,0,135,0,0,0,135,0,0,0,135,0,0,0,135,0,0,0,135,0,0,0,135,0]],
        },
    ],
};

// Synthesising a sound costs a few ms — enough to drop a frame if it happens
// mid-game — so each one is rendered once and kept. Call preloadSounds() in
// init() to pay for all of them up front instead.
const rendered = new Map<SoundName, Stereo>();

function samplesFor(name: SoundName): Stereo {
    let s = rendered.get(name);
    if (!s) {
        s = renderSound(sounds[name].note, sounds[name].instrument);
        rendered.set(name, s);
    }
    return s;
}

export function preloadSounds(): void {
    for (const name of Object.keys(sounds) as SoundName[]) samplesFor(name);
}

/** Play a sound flat, with no positioning. */
export function play(name: SoundName, volume = 1): void {
    playSamples(samplesFor(name), { volume });
}

const NEAR = 3; // full volume inside this
const FAR = 25; // silent past this

/**
 * Play a sound as if it happened at a point in the world: quieter with
 * distance from the camera, panned to whichever side of the view it is on.
 */
export function playAt(name: SoundName, x: number, y: number, z: number, volume = 1): void {
    const p = camera.position;
    const t = camera.target;

    // Camera right = forward x up, with up = (0,1,0) — only the xz of forward
    // survives the cross product.
    let rx = -(t.z - p.z);
    let rz = t.x - p.x;
    const rlen = Math.hypot(rx, rz) || 1;
    rx /= rlen;
    rz /= rlen;

    const dx = x - p.x;
    const dy = y - p.y;
    const dz = z - p.z;
    const dist = Math.hypot(dx, dy, dz) || 1;

    const falloff = Math.min(1, Math.max(0, (FAR - dist) / (FAR - NEAR)));
    playSamples(samplesFor(name), {
        volume: volume * falloff,
        pan: (dx * rx + dz * rz) / dist,
    });
}

let musicSamples: Stereo | null = null;

/** Render (once) and loop the song. Costs a few tens of ms the first time. */
export function playMusic(volume = 1): void {
    musicSamples ??= renderSong(music);
    playSamples(musicSamples, { volume, loop: true });
}
