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

// Songs live in src/assets/songs — one module each, converted from a SoundBox
// export. Import the one you want and pass it to playMusic.
export { bigSong } from './assets/songs/bigSong';
export { shortSong } from './assets/songs/shortSong';

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

const renderedSongs = new WeakMap<Song, Stereo>();

/**
 * Render (once) and loop a song. The first call is the whole song's worth of
 * synthesis on this thread — roughly 15ms per track-minute, so a short loop is
 * unnoticeable and a long one is a visible freeze. Call it behind a start
 * gesture or a loading state, not mid-play.
 */
export function playMusic(song: Song, volume = 1): void {
    let samples = renderedSongs.get(song);
    if (!samples) {
        samples = renderSong(song);
        renderedSongs.set(song, samples);
    }
    playSamples(samples, { volume, loop: true });
}
