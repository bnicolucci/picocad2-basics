import { describe, expect, test } from 'bun:test';
import { type Instrument, renderSong, renderSound, SAMPLE_RATE } from './audio';

// Synthesis is pure math over Float32Arrays — no AudioContext — so it runs here.

// A plain sine blip: one oscillator, no noise, no delay, no filter.
const BLIP: Instrument = [8,0,0,0,192,0, 8,0,0,0,0,0, 0, 100,2000,4000, 200, 0,0,0, 0,0, 0,0, 0,0,0,0,0];

const peak = (v: Float32Array): number => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

describe('renderSound', () => {
    test('length is the envelope, when there is no delay tail', () => {
        const { left, right } = renderSound(135, BLIP);
        expect(left.length).toBe(100 + 2000 + 4000);
        expect(right.length).toBe(left.length);
    });

    test('produces audible, in-range samples', () => {
        const { left } = renderSound(135, BLIP);
        expect(peak(left)).toBeGreaterThan(0.01);
        expect(peak(left)).toBeLessThanOrEqual(1);
    });

    test('is deterministic for instruments without the noise oscillator', () => {
        expect(renderSound(135, BLIP).left).toEqual(renderSound(135, BLIP).left);
    });

    test('a higher note oscillates faster', () => {
        const crossings = (v: Float32Array): number => {
            let n = 0;
            for (let i = 1; i < v.length; i++) if (v[i - 1] < 0 !== v[i] < 0) n++;
            return n;
        };
        expect(crossings(renderSound(147, BLIP).left)).toBeGreaterThan(crossings(renderSound(123, BLIP).left));
    });

    // fxDelayTime/fxDelayAmt (20, 21) buy extra samples for the echo to ring out.
    test('delay lengthens the buffer and rings on past the envelope', () => {
        const echoed: Instrument = [8,0,0,0,192,0, 8,0,0,0,0,0, 0, 100,2000,4000, 200, 0,0,0, 2,80, 0,0, 0,0,0,0,0];
        const dry = renderSound(135, BLIP);
        const wet = renderSound(135, echoed);
        expect(wet.left.length).toBeGreaterThan(dry.left.length);
        expect(peak(wet.left.subarray(dry.left.length))).toBeGreaterThan(0);
    });

    // A delay TIME of 0 with a non-zero amount is not "no delay" — the channels
    // cross-feed in place, which audibly widens the sound. Skipping that as an
    // optimisation silently changed instruments that rely on it.
    test('a zero delay time still cross-feeds when the amount is non-zero', () => {
        const zeroTime: Instrument = [8,0,0,0,192,0, 8,0,0,0,0,0, 0, 100,2000,4000, 200, 0,0,0, 0,60, 0,0, 0,0,0,0,0];
        const dry = renderSound(135, BLIP);
        const wet = renderSound(135, zeroTime);
        expect(wet.left.length).toBe(dry.left.length); // no tail is added
        expect(peak(wet.left)).not.toBe(peak(dry.left)); // but the signal changed
    });

    // Every voice is written into both channels, so a sound is never one-sided
    // unless the instrument's own auto-pan says so.
    test('writes both channels', () => {
        const { left, right } = renderSound(135, BLIP);
        expect(peak(left)).toBeGreaterThan(0);
        expect(peak(right)).toBeGreaterThan(0);
    });
});

describe('renderSong', () => {
    const beat: Instrument = [8,0,0,0,192,0, 8,0,0,0,0,0, 0, 10,500,1500, 200, 0,0,0, 0,0, 0,0, 0,0,0,0,0];
    const song = {
        rowLen: 5000,
        seconds: 2,
        tracks: [{ instrument: beat, sequence: [1], patterns: [[135, 0, 0, 0, 0, 0, 0, 0, 135, 0, 0, 0, 0, 0, 0, 0]] }],
    };

    test('buffer length is exactly the requested duration', () => {
        expect(renderSong(song).left.length).toBe(SAMPLE_RATE * 2);
    });

    test('notes land on their row, and rest rows stay silent', () => {
        const { left } = renderSong(song);
        expect(peak(left.subarray(0, 2000))).toBeGreaterThan(0); // row 0 fires
        expect(peak(left.subarray(30000, 35000))).toBe(0); // rows 6-7 rest
        expect(peak(left.subarray(40000, 42000))).toBeGreaterThan(0); // row 8 fires
    });

    // Sequence entries are 1-based so that 0 can mean "silent bar".
    test('a 0 in the sequence renders a silent bar', () => {
        const silent = renderSong({ ...song, tracks: [{ ...song.tracks[0], sequence: [0] }] });
        expect(peak(silent.left)).toBe(0);
    });

    test('tracks mix together rather than overwrite', () => {
        const one = renderSong(song);
        const two = renderSong({ ...song, tracks: [song.tracks[0], song.tracks[0]] });
        expect(peak(two.left)).toBeGreaterThan(peak(one.left));
    });
});
