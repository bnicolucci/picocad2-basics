import { install_orbit_camera_controls, OrbitCamera, OrbitCameraController } from '../core/camera';
import { type PicoCadAnimationClip, parsePicoCad2 } from '../picocad2';
import {
    type AnimatedNode,
    collectAnimatedNodes,
    detectSharedNodes,
    extractClip,
    generateAnimationsModule,
    parseAnimSourceFileName,
} from '../picocad2_animation_extract';
import { type AnimPreview, buildAnimPreview } from './anim_preview';

// Animation Editor — turns a model's "<mesh>-anim-<clip>.txt" exports into its
// generated "<mesh>_animations.ts" clip library. The editor only curates (which
// clips, which nodes); the clip data is copied verbatim by the shared pure
// extractor (picocad2_animation_extract.ts), so what you save is exactly what
// picoCAD2 exported. Include/exclude state round-trips out of the existing
// generated file (nodes present there = included) — no sidecar save.
//
// Live preview drives the same PicoCadAnimationController a game would use, so
// what plays here is what plays in-game.

// Animation SOURCES may sit beside models or primitives; the generated
// registries only ever live under models/.
const ANIM_SOURCE_FILES = import.meta.glob(['../assets/models/*-anim-*.txt', '../assets/primitives/*-anim-*.txt'], {
    query: '?raw',
    import: 'default',
}) as Record<string, () => Promise<string>>;

const ANIMATION_LIBRARY_FILES = import.meta.glob('../assets/models/*_animations.ts') as Record<
    string,
    () => Promise<Record<string, unknown>>
>;

// Base model geometry for the preview (excludes the -anim- sources).
const MODEL_FILES = import.meta.glob(
    ['../assets/models/*.txt', '../assets/primitives/*.txt', '!../assets/models/*-anim-*.txt', '!../assets/primitives/*-anim-*.txt'],
    { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

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
const previewWrap = document.getElementById('preview-wrap') as HTMLDivElement;
const previewEmpty = document.getElementById('preview-empty') as HTMLDivElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const nowPlayingEl = document.getElementById('now-playing') as HTMLSpanElement;
document.getElementById('stage-editor-btn')?.addEventListener('click', () => {
    window.location.href = '/editor.html';
});

type SourceClip = {
    clipName: string;
    data: ReturnType<typeof parsePicoCad2>;
    nodes: AnimatedNode[];
};

type ClipUiState = {
    clipName: string;
    included: boolean;
    includedNodes: Set<string>;
    source: SourceClip;
};

let clipStates: ClipUiState[] = [];
let playing: string | null = null;

// Orbit + input installed ONCE on the persistent canvas; only the renderer/
// scene/controller are rebuilt per model (re-installing input would stack it).
const orbit = new OrbitCamera([0, 1.4, 0], 15);
orbit.yaw = 2.35;
orbit.pitch = 0.38;
orbit.minDistance = 0.05;
orbit.maxDistance = 1000;
const orbitController = new OrbitCameraController(orbit, { rotateSpeed: 0.008, wheelZoomSpeed: 0.001, panSpeed: 1.0 });
install_orbit_camera_controls(previewCanvas, orbitController);

let preview: AnimPreview | null = null;
let previewToken = 0;

function setStatus(message: string, isError = false): void {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

function fitPreviewCanvas(): void {
    if (!preview) return;
    const rect = previewWrap.getBoundingClientRect();
    preview.resize(rect.width, rect.height);
}
new ResizeObserver(() => fitPreviewCanvas()).observe(previewWrap);

function teardownPreview(): void {
    preview?.dispose();
    preview = null;
    setPlaying(null);
    previewEmpty.style.display = '';
}

function setPlaying(clipName: string | null): void {
    playing = clipName;
    stopBtn.disabled = clipName === null;
    nowPlayingEl.textContent = clipName ? `playing: ${clipName}` : '';
    for (const el of clipsEl.querySelectorAll('.clip')) {
        el.classList.toggle('playing', (el as HTMLElement).dataset.clip === clipName);
    }
}

async function buildPreview(mesh: string): Promise<void> {
    teardownPreview();
    const token = ++previewToken;

    const loader = modelLoaderByName.get(mesh);
    if (!loader) {
        previewEmpty.textContent = `No base ${mesh}.txt model to preview`;
        previewEmpty.style.display = '';
        return;
    }

    let modelText: string;
    try {
        modelText = await loader();
    } catch {
        previewEmpty.textContent = `Failed to load ${mesh}.txt`;
        return;
    }
    if (token !== previewToken) return;

    const built = await buildAnimPreview({ canvas: previewCanvas, modelText, modelId: `anim-preview:${mesh}`, orbit, orbitController });
    if (token !== previewToken) {
        built.dispose();
        return;
    }
    preview = built;
    preview.frameToModel();
    previewEmpty.style.display = 'none';
    fitPreviewCanvas();
}

function playClip(state: ClipUiState): void {
    if (!preview) return;
    if (state.includedNodes.size === 0) {
        setStatus(`"${state.clipName}" has no included nodes to play.`, true);
        return;
    }
    const clip = extractClip(state.source.data, state.includedNodes);
    preview.controller.stop();
    preview.controller.play(clip, preview.clock(), { loop: true });
    setPlaying(state.clipName);
}

stopBtn.addEventListener('click', () => {
    preview?.controller.stop();
    setPlaying(null);
});

function clipDuration(clip: PicoCadAnimationClip): number {
    let max = 0;
    for (const slots of Object.values(clip.tracks)) {
        for (const slot of slots) {
            for (const seg of slot) {
                if (typeof seg.stop === 'number' && seg.stop > max) max = seg.stop;
            }
        }
    }
    return max;
}

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
// included nodes.
async function loadSavedSelection(mesh: string): Promise<Map<string, Set<string>> | null> {
    const loader = ANIMATION_LIBRARY_FILES[`../assets/models/${mesh}_animations.ts`];
    if (!loader) return null;
    try {
        const registry = Object.values(await loader())[0] as Record<string, PicoCadAnimationClip> | undefined;
        if (!registry) return null;
        const selection = new Map<string, Set<string>>();
        for (const [clipName, clip] of Object.entries(registry)) {
            selection.set(clipName, new Set(Object.keys(clip.tracks)));
        }
        return selection;
    } catch {
        return null;
    }
}

async function selectMesh(mesh: string): Promise<void> {
    clipStates = [];
    clipsEl.replaceChildren();
    saveBtn.disabled = true;
    setStatus(`Loading ${mesh}…`);
    void buildPreview(mesh).catch((error) => {
        previewEmpty.textContent = `Preview error: ${error instanceof Error ? error.message : error}`;
        previewEmpty.style.display = '';
    });

    const sources = sourcesByMesh.get(mesh);
    if (!sources) return;

    const parsed: SourceClip[] = [];
    const skipped: string[] = [];
    for (const [clipName, loader] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        try {
            const data = parsePicoCad2(await loader());
            parsed.push({ clipName, data, nodes: collectAnimatedNodes(data) });
        } catch (error) {
            console.warn(`Skipping ${mesh}-anim-${clipName}.txt:`, error);
            skipped.push(clipName);
        }
    }

    const saved = await loadSavedSelection(mesh);
    const sharedNodes = detectSharedNodes(Object.fromEntries(parsed.map((p) => [p.clipName, extractClip(p.data)])));

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
        const fullClip = extractClip(state.source.data);
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
        meta.textContent = `${state.source.nodes.length} nodes · ${clipDuration(fullClip).toFixed(2)}s`;

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
        setStatus(`Saved ${mesh}_animations.ts (${Object.keys(clipsByName).length} clips).`);
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
    void selectMesh(initial);
}

init();
