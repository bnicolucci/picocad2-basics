// Animation Editor — turns a model's "<mesh>-anim-<clip>.txt" exports into its
// generated "<mesh>_animations.ts" clip library. The editor only curates (which
// clips, which nodes); the clip data is copied verbatim by the shared pure
// extractor (lib/picocad2_animation_extract.ts), so what you save is exactly
// what picoCAD2 exported. Include/exclude state round-trips out of the existing
// generated file (nodes present there = included) — no sidecar save.
//
// This page is dev-only: it is the sole place that globs the anim sources, and
// it is deliberately absent from build.rollupOptions.input, so those
// near-duplicate exports cannot reach a production bundle. Saving POSTs to the
// `editor-save` dev middleware in vite.config.ts.
//
// The preview drives the real animator over the real loader/renderer, so what
// plays here is what plays in-game.

import { loadAnimationClips } from './assets/models/animations';
import { createAnimPreview } from './lib/animPreview';
import { clipDuration } from './lib/animator';
import { type PicoCadAnimationClip, parsePicoCad2 } from './lib/picocad2';
import {
    type AnimatedNode,
    collectAnimatedNodes,
    detectSharedNodes,
    extractClip,
    generateAnimationsModule,
    parseAnimSourceFileName,
} from './lib/picocad2_animation_extract';
import { retro } from './lib/renderer';

// Animation SOURCES may sit beside models or primitives; the generated
// registries only ever live under models/.
const ANIM_SOURCE_FILES = import.meta.glob(
    [
        './assets/models/*-anim-*.txt',
        './assets/models/*_anim_*.txt',
        './assets/primitives/*-anim-*.txt',
        './assets/primitives/*_anim_*.txt',
    ],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

// Base model geometry for the preview (excludes the anim sources).
const MODEL_FILES = import.meta.glob(
    [
        './assets/models/*.txt',
        './assets/primitives/*.txt',
        '!./assets/models/*-anim-*.txt',
        '!./assets/models/*_anim_*.txt',
        '!./assets/primitives/*-anim-*.txt',
        '!./assets/primitives/*_anim_*.txt',
    ],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

// The game renders at 0.5; in a 320px panel that is still too coarse to judge
// a motion by, so the preview renders sharper. Page-local — the game's scale
// is untouched.
retro.scale = 1;

function baseName(path: string): string {
    return path.split('/').pop()?.replace(/\.txt$/i, '') ?? path;
}

// mesh name -> base model loader, across both asset folders.
const modelLoaderByName = new Map<string, () => Promise<string>>();
for (const [path, loader] of Object.entries(MODEL_FILES)) {
    modelLoaderByName.set(baseName(path), loader);
}

// mesh -> its animation source loaders, keyed by clip name.
const sourcesByMesh = new Map<string, Map<string, () => Promise<string>>>();
for (const [path, loader] of Object.entries(ANIM_SOURCE_FILES)) {
    const info = parseAnimSourceFileName(path);
    if (!info) continue;
    if (!sourcesByMesh.has(info.mesh)) sourcesByMesh.set(info.mesh, new Map());
    sourcesByMesh.get(info.mesh)!.set(info.clipName, loader);
}

const meshSelect = document.getElementById('mesh-select') as HTMLSelectElement;
const clipsEl = document.getElementById('clips') as HTMLDivElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const previewEmpty = document.getElementById('preview-empty') as HTMLDivElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const nowPlayingEl = document.getElementById('now-playing') as HTMLSpanElement;

type SourceClip = {
    clipName: string;
    data: ReturnType<typeof parsePicoCad2>;
    nodes: AnimatedNode[];
    /** Every animated node, extracted once: the duration and the shared-idle scan. */
    clip: PicoCadAnimationClip;
};

type ClipUiState = {
    clipName: string;
    included: boolean;
    includedNodes: Set<string>;
    source: SourceClip;
};

const SAVED_MESSAGE_KEY = 'anim-editor:saved';

let clipStates: ClipUiState[] = [];
let playing: string | null = null;

// One renderer for the page's lifetime; the model inside it is swapped.
const preview = createAnimPreview(previewCanvas);
let previewToken = 0;

function setStatus(message: string, isError = false): void {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

function setPlaying(clipName: string | null): void {
    playing = clipName;
    stopBtn.disabled = clipName === null;
    nowPlayingEl.textContent = clipName ? `playing: ${clipName}` : '';
    for (const el of clipsEl.querySelectorAll('.clip')) {
        el.classList.toggle('playing', (el as HTMLElement).dataset.clip === clipName);
    }
}

// Puts `mesh`'s base model in the preview. Returns the reason it couldn't, for
// the overlay — `#preview-empty` sits on top of the canvas, so it has to be
// shown for every failure and hidden on success.
async function loadPreviewModel(mesh: string): Promise<string | null> {
    const token = ++previewToken;
    preview.clear();
    setPlaying(null);

    const loader = modelLoaderByName.get(mesh);
    if (!loader) return `No base ${mesh}.txt model to preview`;

    let modelText: string;
    try {
        modelText = await loader();
    } catch {
        return `Failed to load ${mesh}.txt`;
    }
    if (token !== previewToken) return null;

    return preview.setModel(modelText) ? null : `${mesh}.txt failed to parse`;
}

function showModel(mesh: string): void {
    void loadPreviewModel(mesh)
        .catch((error) => `Preview error: ${error instanceof Error ? error.message : error}`)
        .then((failure) => {
            previewEmpty.textContent = failure ?? '';
            previewEmpty.style.display = failure ? '' : 'none';
        });
}

function playClip(state: ClipUiState): void {
    if (state.includedNodes.size === 0) {
        setStatus(`"${state.clipName}" has no included nodes to play.`, true);
        return;
    }
    const clip = extractClip(state.source.data, state.includedNodes);
    const animator = preview.play(clip);
    if (!animator) return;
    setPlaying(state.clipName);
    // Clips bind by node name; a name the base model doesn't have is the one
    // failure mode that looks like "nothing happened", so say it out loud.
    const bound = state.includedNodes.size - animator.unmatched.length;
    setStatus(
        animator.unmatched.length > 0
            ? `${state.clipName}: ${bound} nodes bound, unmatched in ${meshSelect.value}.txt: ${animator.unmatched.join(', ')}`
            : `${state.clipName}: ${bound} nodes bound · ${animator.duration.toFixed(2)}s loop`,
        animator.unmatched.length > 0,
    );
}

stopBtn.addEventListener('click', () => {
    preview.stop();
    setPlaying(null);
});

function nodeProps(node: AnimatedNode): string {
    const props = new Set<string>();
    for (const slot of node.tracks) {
        for (const seg of slot) {
            if (seg.prop) props.add(seg.prop);
        }
    }
    return [...props].join(', ') || '—';
}

// The include/exclude selection saved previously, read straight back out of the
// generated registry: a clip present = included, each clip's track keys = its
// included nodes. Null when the mesh has no registry yet (defaults apply).
async function loadSavedSelection(mesh: string): Promise<Map<string, Set<string>> | null> {
    const clips = Object.entries(await loadAnimationClips(mesh));
    if (clips.length === 0) return null;
    return new Map(clips.map(([clipName, clip]) => [clipName, new Set(Object.keys(clip.tracks))]));
}

async function selectMesh(mesh: string): Promise<void> {
    clipStates = [];
    clipsEl.replaceChildren();
    saveBtn.disabled = true;
    setStatus(`Loading ${mesh}…`);
    showModel(mesh);

    const sources = sourcesByMesh.get(mesh);
    if (!sources) return;

    // The sources and the saved selection are independent fetches — one round
    // trip each in dev, and a mesh can have any number of clips.
    const entries = [...sources.entries()].sort(([a], [b]) => a.localeCompare(b));
    const [texts, saved] = await Promise.all([
        Promise.all(entries.map(([, loader]) => loader().catch(() => null))),
        loadSavedSelection(mesh),
    ]);

    const parsed: SourceClip[] = [];
    const skipped: string[] = [];
    for (const [index, [clipName]] of entries.entries()) {
        try {
            const text = texts[index];
            if (text === null) throw new Error('failed to load');
            const data = parsePicoCad2(text);
            parsed.push({ clipName, data, nodes: collectAnimatedNodes(data), clip: extractClip(data) });
        } catch (error) {
            console.warn(`Skipping ${mesh}-anim-${clipName}.txt:`, error);
            skipped.push(clipName);
        }
    }

    const sharedNodes = detectSharedNodes(Object.fromEntries(parsed.map((p) => [p.clipName, p.clip])));

    clipStates = parsed.map((source) => {
        const savedNodes = saved?.get(source.clipName);
        const included = saved ? saved.has(source.clipName) : true;
        const includedNodes = new Set(
            source.nodes
                .map((n) => n.nodeName)
                .filter((name) => (savedNodes ? savedNodes.has(name) : !sharedNodes.has(name))),
        );
        return { clipName: source.clipName, included, includedNodes, source };
    });

    renderClips(sharedNodes);
    saveBtn.disabled = false;
    const skippedNote = skipped.length ? ` — skipped ${skipped.length} unparseable (${skipped.join(', ')})` : '';
    setStatus((saved ? `Loaded ${mesh} (restored saved selection).` : `Loaded ${mesh} (defaults applied).`) + skippedNote, skipped.length > 0);
}

function renderClips(sharedNodes: Set<string>): void {
    clipsEl.replaceChildren();
    if (clipStates.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No animation sources found for this model.';
        clipsEl.appendChild(empty);
        return;
    }

    for (const state of clipStates) {
        const clipEl = document.createElement('div');
        clipEl.className = `clip${state.included ? '' : ' excluded'}`;
        clipEl.dataset.clip = state.clipName;

        const head = document.createElement('div');
        head.className = 'clip-head';

        const toggle = document.createElement('label');
        toggle.className = 'clip-toggle';
        const clipChk = document.createElement('input');
        clipChk.type = 'checkbox';
        clipChk.checked = state.included;
        clipChk.addEventListener('change', () => {
            state.included = clipChk.checked;
            clipEl.classList.toggle('excluded', !state.included);
        });
        const name = document.createElement('span');
        name.className = 'clip-name';
        name.textContent = state.clipName;
        toggle.append(clipChk, name);

        const meta = document.createElement('span');
        meta.className = 'clip-meta';
        meta.textContent = `${state.source.nodes.length} nodes · ${clipDuration(state.source.clip).toFixed(2)}s`;

        const playBtn = document.createElement('button');
        playBtn.className = 'mini-btn';
        playBtn.type = 'button';
        playBtn.textContent = '▶';
        playBtn.title = 'Preview this clip';
        playBtn.addEventListener('click', () => playClip(state));

        head.append(toggle, meta, playBtn);

        const nodeList = document.createElement('div');
        nodeList.className = 'node-list';
        for (const node of state.source.nodes) {
            const row = document.createElement('label');
            row.className = `node-row chk${sharedNodes.has(node.nodeName) ? ' shared' : ''}`;
            const nodeChk = document.createElement('input');
            nodeChk.type = 'checkbox';
            nodeChk.checked = state.includedNodes.has(node.nodeName);
            nodeChk.addEventListener('change', () => {
                if (nodeChk.checked) state.includedNodes.add(node.nodeName);
                else state.includedNodes.delete(node.nodeName);
                if (playing === state.clipName) playClip(state);
            });
            const nodeName = document.createElement('span');
            nodeName.className = 'node-name';
            nodeName.textContent = node.nodeName;
            const nodeMeta = document.createElement('span');
            nodeMeta.className = 'node-meta';
            nodeMeta.textContent = nodeProps(node);
            row.append(nodeChk, nodeName, nodeMeta);
            nodeList.appendChild(row);
        }

        clipEl.append(head, nodeList);
        clipsEl.appendChild(clipEl);
    }
}

async function save(): Promise<void> {
    const mesh = meshSelect.value;
    if (!mesh) return;

    const clipsByName: Record<string, PicoCadAnimationClip> = {};
    for (const state of clipStates) {
        if (!state.included || state.includedNodes.size === 0) continue;
        clipsByName[state.clipName] = extractClip(state.source.data, state.includedNodes);
    }

    if (Object.keys(clipsByName).length === 0) {
        setStatus('Nothing to save — include at least one clip with one node.', true);
        return;
    }

    const source = generateAnimationsModule(mesh, clipsByName);
    setStatus('Saving…');
    try {
        const response = await fetch('/__editor/save-animations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mesh, source }),
        });
        const result = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        // The file we just wrote is one this page imports (the registry glob),
        // so Vite invalidates it and reloads us — which would wipe the message.
        // Hand it across the reload.
        const message = `Saved ${mesh}_animations.ts (${Object.keys(clipsByName).length} clips).`;
        sessionStorage.setItem(SAVED_MESSAGE_KEY, message);
        setStatus(message);
    } catch (error) {
        setStatus(`Save failed: ${error instanceof Error ? error.message : error}`, true);
    }
}

function init(): void {
    const meshes = [...sourcesByMesh.keys()].sort();
    if (meshes.length === 0) {
        setStatus('No "-anim-<clip>.txt" sources found under assets/models or assets/primitives.', true);
        return;
    }
    for (const mesh of meshes) {
        const option = document.createElement('option');
        option.value = mesh;
        option.textContent = mesh;
        meshSelect.appendChild(option);
    }
    meshSelect.addEventListener('change', () => void selectMesh(meshSelect.value));
    saveBtn.addEventListener('click', () => void save());
    const requested = new URLSearchParams(window.location.search).get('mesh');
    const initial = requested && meshes.includes(requested) ? requested : meshes[0];
    meshSelect.value = initial;
    void selectMesh(initial).then(() => {
        const saved = sessionStorage.getItem(SAVED_MESSAGE_KEY);
        if (!saved) return;
        sessionStorage.removeItem(SAVED_MESSAGE_KEY);
        setStatus(saved);
    });
}

init();

Object.assign(window as unknown as Record<string, unknown>, { retro, preview });
