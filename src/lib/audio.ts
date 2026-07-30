// Sounds and music synthesised from numbers — nothing is fetched, no audio data
// ships. A one-shot sound is 29 numbers; a song is those plus note patterns.
//
// This is a TypeScript port of the Sonant-X fork Dominic Szablewski (phoboslab)
// wrote for js13k: oscillators come out of one shared lookup table, buffers are
// Float32 all the way to `AudioContext.createBuffer`, and rendering is plain
// synchronous math with no scheduling.
//
// Sonant-X (c) 2014 Nicolas Vanhoren — itself a fork of js-sonant by Marcus
// Geelnard (c) 2011 and Jake Taylor (c) 2008-2009. Published under the zlib
// licence: provided 'as-is' with no warranty; you must not misrepresent its
// origin; altered source versions must be marked as such; this notice may not
// be removed. https://github.com/nicolas-van/sonant-x

export const SAMPLE_RATE = 44100;

/** The 29 knobs of one instrument — SoundBox's parameter order exactly, so a
    song exported from https://sb.bitsnbites.eu pastes straight in. Waveform
    values index WAVEFORM; fxFilter indexes 0 none / 1 high / 2 low / 3 band /
    4 notch. */
export type Instrument = readonly [
    osc1Oct: number,
    osc1Det: number,
    osc1Detune: number,
    osc1Xenv: number,
    osc1Vol: number,
    osc1Waveform: number,
    osc2Oct: number,
    osc2Det: number,
    osc2Detune: number,
    osc2Xenv: number,
    osc2Vol: number,
    osc2Waveform: number,
    noiseFader: number,
    attack: number,
    sustain: number,
    release: number,
    master: number,
    fxFilter: number,
    fxFreq: number,
    fxResonance: number,
    fxDelayTime: number,
    fxDelayAmt: number,
    fxPanFreq: number,
    fxPanAmt: number,
    lfoOsc1Freq: number,
    lfoFxFreq: number,
    lfoFreq: number,
    lfoAmt: number,
    lfoWaveform: number,
];

export const WAVEFORM = { sine: 0, square: 1, saw: 2, triangle: 3 } as const;

/** Rendered audio, before it ever touches WebAudio — so it is testable. */
export type Stereo = { left: Float32Array; right: Float32Array };

export type Track = {
    instrument: Instrument;
    /** One entry per bar: which pattern plays. 0 is a silent bar, 1 is patterns[0]. */
    sequence: readonly number[];
    /** 32 rows each. 0 is a rest, anything else is a semitone number (~120-150). */
    patterns: readonly (readonly number[])[];
};

export type Song = {
    /** Samples per row — the tempo. Smaller is faster. */
    rowLen: number;
    /** Length of the rendered buffer; also the loop length. */
    seconds: number;
    tracks: readonly Track[];
};

const TAB_SIZE = 4096;
const TAB_MASK = TAB_SIZE - 1;
const ROWS_PER_PATTERN = 32;

// One table for all four oscillators, so the inner loop is a lookup rather than
// a Math.sin call — the change that made this fork ~10x faster than upstream.
let table: Float32Array | null = null;

function waveTable(): Float32Array {
    if (table) return table;
    const t = new Float32Array(TAB_SIZE * 4);
    for (let i = 0; i < TAB_SIZE; i++) {
        t[i] = Math.sin((i * 6.283184) / TAB_SIZE);
        t[i + TAB_SIZE] = t[i] < 0 ? -1 : 1;
        t[i + TAB_SIZE * 2] = i / TAB_SIZE - 0.5;
        t[i + TAB_SIZE * 3] = i < TAB_SIZE / 2 ? i / (TAB_SIZE / 4) - 1 : 3 - i / (TAB_SIZE / 4);
    }
    return (table = t);
}

/** Synthesise one note into `dst`, added on top of whatever is already there.
    Writes past the end of the buffer are dropped, as with any typed array. */
function renderNote(dst: Stereo, writePos: number, rowLen: number, note: number, inst: Instrument): void {
    const tab = waveTable();
    const [
        osc1Oct, osc1Det, osc1Detune, osc1Xenv, osc1Vol, osc1Waveform,
        osc2Oct, osc2Det, osc2Detune, osc2Xenv, osc2Vol, osc2Waveform,
        noiseFader,
        attack, sustain, release, master,
        fxFilter, fxFreq, fxResonance,
        /* fxDelayTime and fxDelayAmt are applied afterwards, by applyDelay */ , ,
        fxPanFreq, fxPanAmt,
        lfoOsc1Freq, lfoFxFreq, lfoFreq, lfoAmt, lfoWaveform,
    ] = inst;

    const lfoOffset = lfoWaveform * TAB_SIZE;
    const osc1Offset = osc1Waveform * TAB_SIZE;
    const osc2Offset = osc2Waveform * TAB_SIZE;
    const panRate = 2 ** (fxPanFreq - 8) / rowLen;
    const lfoRate = 2 ** (lfoFreq - 8) / rowLen;
    const q = fxResonance / 255;
    const numSamples = attack + sustain + release - 1;

    const semitone = (n: number): number => 1.059463094 ** (n - 128) * 0.00390625;
    const osc1Step = semitone(note + (osc1Oct - 8) * 12 + osc1Det) * (1 + 0.0008 * osc1Detune);
    const osc2Step = semitone(note + (osc2Oct - 8) * 12 + osc2Det) * (1 + 0.0008 * osc2Detune);

    let c1 = 0;
    let c2 = 0;
    let low = 0;
    let band = 0;

    for (let j = numSamples; j >= 0; --j) {
        const k = j + writePos;
        const lfo = (tab[lfoOffset + ((k * lfoRate * TAB_SIZE) & TAB_MASK)] * lfoAmt) / 512 + 0.5;

        let envelope = 1;
        if (j < attack) envelope = j / attack;
        else if (j >= attack + sustain) envelope -= (j - attack - sustain) / release;

        let step = osc1Step;
        if (lfoOsc1Freq) step *= lfo;
        if (osc1Xenv) step *= envelope * envelope;
        c1 += step;
        let sample = tab[osc1Offset + ((c1 * TAB_SIZE) & TAB_MASK)] * osc1Vol;

        step = osc2Step;
        if (osc2Xenv) step *= envelope * envelope;
        c2 += step;
        sample += tab[osc2Offset + ((c2 * TAB_SIZE) & TAB_MASK)] * osc2Vol;

        if (noiseFader) sample += (2 * Math.random() - 1) * noiseFader * envelope;
        sample *= envelope / 255;

        // State variable filter; its coefficient comes out of the sine table too.
        let cutoff = fxFreq;
        if (lfoFxFreq) cutoff *= lfo;
        cutoff = 1.5 * tab[(((cutoff * 0.5) / SAMPLE_RATE) * TAB_SIZE) & TAB_MASK];
        low += cutoff * band;
        const high = q * (sample - band) - low;
        band += cutoff * high;
        if (fxFilter === 1) sample = high;
        else if (fxFilter === 2) sample = low;
        else if (fxFilter === 3) sample = band;
        else if (fxFilter === 4) sample = low + high;

        const pan = (tab[(k * panRate * TAB_SIZE) & TAB_MASK] * fxPanAmt) / 512 + 0.5;
        sample *= 0.00476 * master; // 39 / 8192

        dst.left[k] += sample * (1 - pan);
        dst.right[k] += sample * pan;
    }
}

/** Ping-pong delay: each channel feeds the other, `shift` samples later. */
function applyDelay(dst: Stereo, shift: number, amount: number): void {
    if (!shift || !amount) return;
    for (let i = 0; i < dst.left.length - shift; i++) {
        dst.left[i + shift] += dst.right[i] * amount;
        dst.right[i + shift] += dst.left[i] * amount;
    }
}

function silence(numSamples: number): Stereo {
    return { left: new Float32Array(numSamples), right: new Float32Array(numSamples) };
}

/**
 * Render one note of one instrument — a sound effect. `note` is a semitone
 * number; the same instrument at a different note is a different-pitched
 * version of the same sound.
 */
export function renderSound(note: number, instrument: Instrument, rowLen = 5605): Stereo {
    const delayShift = (instrument[20] * rowLen) >> 1;
    const delayAmount = instrument[21] / 255;
    const tail = delayShift * 32 * delayAmount;
    const out = silence(Math.floor(instrument[13] + instrument[14] + instrument[15] + tail));
    renderNote(out, 0, rowLen, note, instrument);
    applyDelay(out, delayShift, delayAmount);
    return out;
}

/**
 * Render a whole song to one buffer. Cost is roughly
 * `tracks x seconds x 44100` samples of work on whichever thread calls this,
 * plus two full-length Float32Arrays per track — a minute-long song is a
 * visible hitch, so render it behind a loading state or in a Worker.
 */
export function renderSong(song: Song): Stereo {
    const numSamples = Math.floor(SAMPLE_RATE * song.seconds);
    const mix = silence(numSamples);

    for (const track of song.tracks) {
        const buf = silence(numSamples);
        let writePos = 0;
        for (const bar of track.sequence) {
            const pattern = track.patterns[bar - 1];
            for (let row = 0; row < ROWS_PER_PATTERN; row++) {
                const note = pattern?.[row];
                if (note) renderNote(buf, writePos, song.rowLen, note, track.instrument);
                writePos += song.rowLen;
            }
        }
        applyDelay(buf, (track.instrument[20] * song.rowLen) >> 1, track.instrument[21] / 255);
        for (let i = 0; i < numSamples; i++) {
            mix.left[i] += buf.left[i];
            mix.right[i] += buf.right[i];
        }
    }
    return mix;
}

// --- Playback ---------------------------------------------------------------

// Browsers refuse to start an AudioContext until the user has interacted with
// the page, so we create it on the first click or key and let every play()
// before that be a silent no-op. Nothing in the app has to know about this.
let ctx: AudioContext | null = null;
const buffers = new WeakMap<Stereo, AudioBuffer>();

// Master volume for everything played through play(). The synth has no limiter
// and its only headroom control is the instrument's own `master` knob, so loud
// instruments render past 1.0 on their own (q1k3's shotgun peaks at 1.11, its
// song at 1.59) and anything layered on top clips. Hence the default < 1.
let masterVolume = 0.8;

export function setVolume(value: number): void {
    masterVolume = value;
}

function unlock(): void {
    ctx ??= new AudioContext();
    void ctx.resume();
}

if (typeof document !== 'undefined') {
    for (const event of ['pointerdown', 'keydown'] as const) {
        document.addEventListener(event, unlock, { passive: true });
    }
}

/** True once the user has interacted and sound can actually be heard. */
export function audioReady(): boolean {
    return ctx !== null;
}

export type PlayOptions = {
    /** 0..1, multiplied by the master volume. */
    volume?: number;
    /** -1 hard left, 0 centre, 1 hard right. */
    pan?: number;
    loop?: boolean;
};

/** Play rendered samples. The AudioBuffer is built once per Stereo and cached. */
export function play(samples: Stereo, options: PlayOptions = {}): void {
    if (!ctx) return;

    let buffer = buffers.get(samples);
    if (!buffer) {
        buffer = ctx.createBuffer(2, samples.left.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(samples.left);
        buffer.getChannelData(1).set(samples.right);
        buffers.set(samples, buffer);
    }

    const gain = ctx.createGain();
    gain.gain.value = (options.volume ?? 1) * masterVolume;
    gain.connect(ctx.destination);

    const panner = ctx.createStereoPanner();
    panner.pan.value = options.pan ?? 0;
    panner.connect(gain);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    source.connect(panner);
    source.start();
}
