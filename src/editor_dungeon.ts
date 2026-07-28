// Dungeon Editor — paints the room-grid tilemaps in src/assets/dungeons/*.ts.
//
// The 2D map and the 3D preview are driven from the same Dungeon data through
// the runtime's own resolveTile / buildRoom, so what you paint is exactly what
// the game builds: same parts, same auto-picks, same placement. Tiles are
// coloured by the real texture colour of the part on them.
//
// Dev-only page; Save POSTs the regenerated module to the editor-save
// middleware in vite.config.ts and round-trips its state out of the generated
// files themselves.

import { entities, spawnEntity } from './assets/entities';
import {
    buildRoom,
    categoryParts,
    DOOR_EDGES,
    type DoorEdge,
    type Dungeon,
    doorTileSpan,
    GROUNDS,
    hasNeighbour,
    loadDungeonCatalog,
    makeDungeon,
    neighbourRoom,
    PROPS,
    resolveTile,
    type Room,
    roomAt,
    roomCenter,
    sanitizeDungeon,
    TILE_EMPTY,
    TILE_FLOOR,
    TILE_WALL,
    tileIndex,
    WALLS,
} from './lib/dungeon';
import { renderIcons } from './lib/editorIcons';
import { restoreSavedMessage, saveGenerated, statusReporter } from './lib/editorPage';
import { createEditorViewport } from './lib/editorViewport';
import type { PicoCadModel } from './lib/loader';
import type { Object3D } from './lib/object3d';
import type { BuiltTexture, PicoCad2Node } from './lib/picocad2';

const CATEGORY_FILES = import.meta.glob('./assets/dungeon/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const SAVED_DUNGEONS = import.meta.glob('./assets/dungeons/*.ts', { eager: true }) as Record<string, { dungeon?: unknown }>;

const categoryTexts: Record<string, string> = {};
for (const [path, text] of Object.entries(CATEGORY_FILES)) {
    categoryTexts[path.split('/').pop()!.replace(/\.txt$/, '')] = text;
}
const catalog = loadDungeonCatalog(categoryTexts);

// spawnEntity's name is a literal union; the map stores plain strings, so it is
// widened once here and every lookup is guarded against a stale name.
const spawnAny = spawnEntity as (name: string) => Object3D;
const entityNames = Object.keys(entities);
const spawn = (name: string): Object3D | null => (entityNames.includes(name) ? spawnAny(name) : null);

type RGB = [number, number, number];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusEl = $('status');
const baseStatus = statusReporter(statusEl);
const setStatus = (message: string, isError = false): void => {
    baseStatus(message, isError);
    statusEl.classList.remove('warn');
};
const setWarning = (message: string): void => {
    baseStatus(message);
    statusEl.classList.add('warn');
};
const SAVED_MESSAGE_KEY = 'dungeon-editor:saved';

// --- the dungeon under edit -------------------------------------------------

type WorkingDungeon = {
    name: string;
    /** Name of the file it came from, or null when never saved. */
    savedName: string | null;
    data: Dungeon;
};

const list: WorkingDungeon[] = Object.entries(SAVED_DUNGEONS)
    .map(([path, module]) => {
        const name = path.split('/').pop()!.replace(/\.ts$/, '');
        return { name, savedName: name, data: sanitizeDungeon(module.dungeon) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

if (list.length === 0) list.push({ name: 'dungeon1', savedName: null, data: makeDungeon() });

let current: WorkingDungeon = list[0];
let dungeon: Dungeon = current.data;
let selected = { rc: 0, rr: 0 };

function currentRoom(): Room {
    return roomAt(dungeon, selected.rc, selected.rr)!;
}

// --- part colours -----------------------------------------------------------
// A part's colour on the 2D map is its real texture colour, so the map still
// looks like the room it builds.

function sampleNodeColor(node: PicoCad2Node, tex: BuiltTexture): RGB {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (const face of node.mesh?.faces ?? []) {
        // An untextured face IS its palette colour; a textured one is sampled
        // at the centre of its own UVs (parts share one atlas, so the mean UV
        // across a whole part usually lands on an unrelated texel).
        let index: number;
        if (face.notex === true || face.texture === false) {
            index = face.color ?? 0;
        } else {
            const uvs = face.uvs ?? [];
            if (uvs.length < 2) continue;
            let su = 0;
            let sv = 0;
            let count = 0;
            for (let i = 0; i + 1 < uvs.length; i += 2) {
                su += uvs[i];
                sv += uvs[i + 1];
                count++;
            }
            const x = Math.min(tex.width - 1, Math.max(0, Math.floor((su / count) * tex.width)));
            const y = Math.min(tex.height - 1, Math.max(0, Math.floor((sv / count) * tex.height)));
            index = tex.indexPixels[y * tex.width + x];
        }
        if (index === tex.transparentIndex) continue;
        const o = index * 4; // palette row 0 = the lit colour
        sr += tex.palettePixels[o];
        sg += tex.palettePixels[o + 1];
        sb += tex.palettePixels[o + 2];
        n++;
    }
    return n === 0 ? [128, 128, 128] : [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
}

function samplePartColors(model: PicoCadModel): Map<string, RGB> {
    const out = new Map<string, RGB>();
    const walk = (node: PicoCad2Node): void => {
        if (node.name && node.mesh?.faces?.length) out.set(node.name, sampleNodeColor(node, model.texture));
        for (const child of node.children ?? []) walk(child);
    };
    if (model.data.graph) walk(model.data.graph);
    return out;
}

// Parts in one file often paint from the same palette region — `castley` and
// `wall` differ in geometry, not colour — and would come out as one
// indistinguishable swatch. So each keeps its own colour unless it lands too
// close to one already assigned in that category, in which case it is shaded
// (darker first, then lighter) until it separates.
const KEY_SHADE_STEPS = [1, 0.58, 0.36, 1.5, 1.9, 0.22];
const MIN_KEY_DISTANCE = 48;
/** Empty tiles. Seeded as taken so no part is ever shaded into looking like a pit. */
const PIT_COLOR: RGB = [12, 14, 18];
const ENTITY_COLOR = '#ffd23c';

function shade(c: RGB, factor: number): RGB {
    if (factor <= 1) return [Math.round(c[0] * factor), Math.round(c[1] * factor), Math.round(c[2] * factor)];
    const t = Math.min(1, factor - 1);
    return [Math.round(c[0] + (255 - c[0]) * t), Math.round(c[1] + (255 - c[1]) * t), Math.round(c[2] + (255 - c[2]) * t)];
}

function rgbCss(c: RGB): string {
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const keyColors = ((): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [category, model] of catalog) {
        const sampled = samplePartColors(model);
        // Compared within a category only: a wall matching a floor colour is
        // not worth shifting the floor for, and walls already read as raised.
        const assigned: RGB[] = [PIT_COLOR];
        for (const part of model.parts) {
            const base = sampled.get(part) ?? [128, 128, 128];
            let chosen = base;
            for (const step of KEY_SHADE_STEPS) {
                chosen = shade(base, step);
                if (assigned.every((other) => Math.hypot(other[0] - chosen[0], other[1] - chosen[1], other[2] - chosen[2]) >= MIN_KEY_DISTANCE)) break;
            }
            assigned.push(chosen);
            out.set(`${category}:${part}`, rgbCss(chosen));
        }
    }
    return out;
})();

function keyColor(category: string, part: string): string {
    return keyColors.get(`${category}:${part}`) ?? '#888';
}

// --- brush ------------------------------------------------------------------

type Brush =
    | { kind: 'empty' }
    | { kind: 'floor'; part?: string }
    | { kind: 'wall'; part?: string }
    | { kind: 'prop'; part?: string }
    | { kind: 'entity'; name?: string; yaw: number };

let brush: Brush = { kind: 'wall' };

const BRUSH_CATEGORY: Record<Brush['kind'], string | null> = {
    empty: null,
    floor: GROUNDS,
    wall: WALLS,
    prop: PROPS,
    entity: null,
};

const paletteEl = $('palette');
const brushLabelEl = $('brush-label');
const yawField = $('yaw-field');
const yawInput = $<HTMLInputElement>('entity-yaw');

// 3/4-view renders of every part and entity, so the pick menus show the actual
// model in its real palette. Baked once — nothing recolours them yet.
const icons = renderIcons([
    ...[...catalog].flatMap(([category, model]) => model.parts.map((part): [string, Object3D] => [`${category}:${part}`, model.instantiate({ part })])),
    ...entityNames.flatMap((name): [string, Object3D][] => {
        const object = spawn(name);
        return object ? [[`entity:${name}`, object]] : [];
    }),
]);

function brushLabel(): string {
    if (brush.kind === 'empty') return 'Brush: pit (no tile)';
    if (brush.kind === 'entity') return `Brush: entity · ${brush.name ?? 'none'}`;
    return `Brush: ${brush.kind} · ${brush.part ?? (brush.kind === 'prop' ? 'none' : 'auto')}`;
}

// --- the pick menu ----------------------------------------------------------
// Floats over the sidebar rather than sitting inline, so opening it never
// reflows the swatches underneath. It lives on <body> because #side-body
// scrolls and would clip an absolutely positioned child.

let partMenu: HTMLElement | null = null;
/** Which swatch's list is open ('walls', 'grounds', 'props', 'entity'). */
let partMenuFor: string | null = null;

function closePartMenu(): void {
    partMenu?.remove();
    partMenu = null;
    partMenuFor = null;
}

function menuOption(menu: HTMLElement, label: string, iconKey: string | null, active: boolean, onClick: () => void): void {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = active ? 'pick-row active' : 'pick-row';
    const icon = iconKey ? icons.get(iconKey) : undefined;
    const thumb = document.createElement(icon ? 'img' : 'span');
    thumb.className = 'pick-icon';
    if (icon) (thumb as HTMLImageElement).src = icon;
    row.append(thumb, document.createTextNode(label));
    row.addEventListener('click', () => {
        onClick();
        closePartMenu();
        renderBrush();
    });
    menu.append(row);
}

function openPartMenu(anchor: HTMLElement, forKind: string): void {
    closePartMenu();
    const menu = document.createElement('div');
    menu.className = 'pick-menu';

    if (forKind === 'entity') {
        const chosen = brush.kind === 'entity' ? brush.name : undefined;
        menuOption(menu, 'None (clear entity)', null, chosen === undefined, () => {
            brush = { kind: 'entity', name: undefined, yaw: (brush as { yaw?: number }).yaw ?? 0 };
        });
        for (const name of entityNames) {
            menuOption(menu, name, `entity:${name}`, chosen === name, () => {
                brush = { kind: 'entity', name, yaw: (brush as { yaw?: number }).yaw ?? 0 };
            });
        }
    } else {
        const parts = categoryParts(catalog, forKind);
        const chosen = (brush as { part?: string }).part;
        const kind = brush.kind;
        // "Auto" is the deterministic per-tile pick for floors and the file's
        // first part for walls; props have no auto — None clears the overlay.
        const autoLabel = forKind === PROPS ? 'None (clear prop)' : forKind === WALLS ? `Auto (${parts[0]})` : 'Auto (varies per tile)';
        menuOption(menu, autoLabel, forKind === WALLS && parts[0] ? `${forKind}:${parts[0]}` : null, chosen === undefined, () => {
            brush = { kind, part: undefined } as Brush;
        });
        for (const part of parts) {
            menuOption(menu, part, `${forKind}:${part}`, chosen === part, () => {
                brush = { kind, part } as Brush;
            });
        }
    }

    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    const below = rect.bottom + 4;
    menu.style.top = `${below + menu.offsetHeight > window.innerHeight ? Math.max(6, window.innerHeight - menu.offsetHeight - 6) : below}px`;

    partMenu = menu;
    partMenuFor = forKind;
}

// A fixed-position menu can't follow its anchor, so anything that moves it closes it.
document.addEventListener('pointerdown', (event) => {
    if (!partMenu) return;
    const target = event.target as Node;
    if (partMenu.contains(target) || paletteEl.contains(target)) return;
    closePartMenu();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePartMenu();
});
window.addEventListener('resize', closePartMenu);
$('side-body').addEventListener('scroll', closePartMenu);

function swatch(parent: HTMLElement, label: string, color: string, active: boolean, onClick: () => void): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = active ? 'swatch active' : 'swatch';
    button.style.background = color;
    // Swatches are painted in the part's own texture colour, which can land
    // anywhere — flip the label dark on light fills so it stays readable.
    if (luminance(color) > 150) {
        button.style.color = '#111';
        button.style.textShadow = 'none';
    }
    button.textContent = label;
    button.addEventListener('click', onClick);
    parent.append(button);
}

/** Perceived brightness of a '#rrggbb' or 'rgb(r, g, b)' colour, 0..255. */
function luminance(color: string): number {
    const rgb = color.startsWith('#')
        ? [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)]
        : (color.match(/\d+/g) ?? []).map(Number);
    if (rgb.length < 3) return 0;
    return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
}

function firstPartColor(category: string, fallback: string): string {
    const first = categoryParts(catalog, category)[0];
    return first ? keyColor(category, first) : fallback;
}

function renderBrush(): void {
    paletteEl.replaceChildren();

    // Picking a swatch opens its list of parts; clicking the open one closes it.
    const pick = (label: string, color: string, kind: Brush['kind'], select: () => void): void => {
        const list = kind === 'entity' ? 'entity' : BRUSH_CATEGORY[kind];
        swatch(paletteEl, label, color, brush.kind === kind, () => {
            if (partMenuFor === list) {
                closePartMenu();
                return;
            }
            closePartMenu();
            select();
            renderBrush();
            if (!list) return;
            const active = paletteEl.querySelector<HTMLElement>('.swatch.active');
            if (active) openPartMenu(active, list);
        });
    };

    pick('Wall', firstPartColor(WALLS, '#6b6b6b'), 'wall', () => {
        brush = { kind: 'wall' };
    });
    pick('Floor', firstPartColor(GROUNDS, '#4a4438'), 'floor', () => {
        brush = { kind: 'floor' };
    });
    pick('Pit', rgbCss(PIT_COLOR), 'empty', () => {
        brush = { kind: 'empty' };
    });
    if (categoryParts(catalog, PROPS).length > 0) {
        pick('Prop', firstPartColor(PROPS, '#888'), 'prop', () => {
            brush = { kind: 'prop', part: categoryParts(catalog, PROPS)[0] };
        });
    }
    if (entityNames.length > 0) {
        pick('Entity', ENTITY_COLOR, 'entity', () => {
            brush = { kind: 'entity', name: entityNames[0], yaw: 0 };
        });
    }

    brushLabelEl.textContent = brushLabel();
    yawField.style.display = brush.kind === 'entity' ? '' : 'none';
    if (brush.kind === 'entity') yawInput.value = String(brush.yaw);
}

yawInput.addEventListener('input', () => {
    if (brush.kind !== 'entity') return;
    const v = Number(yawInput.value);
    brush = { ...brush, yaw: Number.isFinite(v) ? v : 0 };
    brushLabelEl.textContent = brushLabel();
});

// --- painting ---------------------------------------------------------------

type OverlayKey = 'floorParts' | 'wallParts' | 'propParts';

function clearPart(room: Room, key: OverlayKey, idx: number): void {
    const map = room[key];
    if (!map) return;
    delete map[idx];
    if (Object.keys(map).length === 0) delete room[key];
}

function setPart(room: Room, key: OverlayKey, idx: number, part: string | undefined): void {
    if (part === undefined) {
        clearPart(room, key, idx);
        return;
    }
    (room[key] ??= {})[idx] = part;
}

function clearEntity(room: Room, idx: number): void {
    if (!room.entities) return;
    delete room.entities[idx];
    if (Object.keys(room.entities).length === 0) delete room.entities;
}

// Every brush is additive — removing things is a menu choice, not a modifier:
// Pit wipes a tile, and the Prop / Entity lists start with a "None" entry that
// clears that overlay.
function paintTile(tx: number, tz: number): void {
    const room = currentRoom();
    const idx = tileIndex(dungeon, tx, tz);

    if (brush.kind === 'empty') {
        room.tiles[idx] = TILE_EMPTY;
        clearPart(room, 'floorParts', idx);
        clearPart(room, 'wallParts', idx);
        clearPart(room, 'propParts', idx);
        clearEntity(room, idx);
        return;
    }
    if (brush.kind === 'wall') {
        room.tiles[idx] = TILE_WALL;
        // Props and entities stand on floor tiles only.
        clearPart(room, 'propParts', idx);
        clearEntity(room, idx);
        setPart(room, 'wallParts', idx, brush.part);
        return;
    }
    if (brush.kind === 'floor') {
        room.tiles[idx] = TILE_FLOOR;
        clearPart(room, 'wallParts', idx);
        setPart(room, 'floorParts', idx, brush.part);
        return;
    }
    if (brush.kind === 'prop') {
        room.tiles[idx] = TILE_FLOOR;
        clearPart(room, 'wallParts', idx);
        setPart(room, 'propParts', idx, brush.part);
        return;
    }
    room.tiles[idx] = TILE_FLOOR;
    clearPart(room, 'wallParts', idx);
    if (!brush.name) {
        clearEntity(room, idx);
        return;
    }
    (room.entities ??= {})[idx] = { name: brush.name, ...(brush.yaw ? { yaw: brush.yaw } : {}) };
}

// Eyedropper: make the brush whatever the clicked tile shows. It picks the
// RESOLVED part — click an auto floor and you get the concrete ground it drew,
// ready to spread. (Click "auto" in the sidebar to go back to varying.)
function pickTile(tx: number, tz: number): void {
    const room = currentRoom();
    const idx = tileIndex(dungeon, tx, tz);
    const { floor, wall, prop } = resolveTile(dungeon, catalog, selected.rc, selected.rr, tx, tz);
    const entity = room.entities?.[idx];

    if (room.tiles[idx] === TILE_EMPTY) brush = { kind: 'empty' };
    else if (entity) brush = { kind: 'entity', name: entity.name, yaw: entity.yaw ?? 0 };
    else if (prop) brush = { kind: 'prop', part: prop };
    else if (room.tiles[idx] === TILE_WALL) brush = { kind: 'wall', part: wall ?? undefined };
    else brush = { kind: 'floor', part: floor ?? undefined };

    renderBrush();
    setStatus(`Picked from ${tx},${tz} — ${brushLabel().replace('Brush: ', '')}`);
}

// --- 2D map -----------------------------------------------------------------

const paintCanvas = $<HTMLCanvasElement>('paint');
const paintCtx = paintCanvas.getContext('2d')!;
const CELL = 26;

function resizePaintCanvas(): void {
    paintCanvas.width = dungeon.tileCols * CELL;
    paintCanvas.height = dungeon.tileRows * CELL;
}

function drawMap(): void {
    const room = currentRoom();
    paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);

    for (let tz = 0; tz < dungeon.tileRows; tz++) {
        for (let tx = 0; tx < dungeon.tileCols; tx++) {
            const idx = tileIndex(dungeon, tx, tz);
            const { floor, wall, prop } = resolveTile(dungeon, catalog, selected.rc, selected.rr, tx, tz);
            const x = tx * CELL;
            const y = tz * CELL;

            paintCtx.fillStyle = wall ? keyColor(WALLS, wall) : floor ? keyColor(GROUNDS, floor) : rgbCss(PIT_COLOR);
            paintCtx.fillRect(x, y, CELL, CELL);
            if (wall) {
                // Darken the lower half so walls read as raised blocks.
                paintCtx.fillStyle = 'rgba(0, 0, 0, 0.28)';
                paintCtx.fillRect(x, y + CELL * 0.5, CELL, CELL * 0.5);
            }
            if (prop) {
                paintCtx.fillStyle = keyColor(PROPS, prop);
                paintCtx.beginPath();
                paintCtx.arc(x + CELL / 2, y + CELL / 2, CELL * 0.26, 0, Math.PI * 2);
                paintCtx.fill();
                paintCtx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
                paintCtx.lineWidth = 1;
                paintCtx.stroke();
            }
            const entity = room.entities?.[idx];
            if (entity) {
                const cx = x + CELL / 2;
                const cy = y + CELL / 2;
                const r = CELL * 0.3;
                paintCtx.fillStyle = ENTITY_COLOR;
                paintCtx.beginPath();
                paintCtx.moveTo(cx, cy - r);
                paintCtx.lineTo(cx + r, cy);
                paintCtx.lineTo(cx, cy + r);
                paintCtx.lineTo(cx - r, cy);
                paintCtx.closePath();
                paintCtx.fill();
                // A tick along the entity's yaw: 0° faces +Z, which is down the map.
                const yaw = ((entity.yaw ?? 0) * Math.PI) / 180;
                paintCtx.strokeStyle = '#000';
                paintCtx.lineWidth = 2;
                paintCtx.beginPath();
                paintCtx.moveTo(cx, cy);
                paintCtx.lineTo(cx + Math.sin(yaw) * r, cy + Math.cos(yaw) * r);
                paintCtx.stroke();
            }
        }
    }

    paintCtx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    paintCtx.lineWidth = 1;
    for (let tx = 1; tx < dungeon.tileCols; tx++) {
        paintCtx.beginPath();
        paintCtx.moveTo(tx * CELL, 0);
        paintCtx.lineTo(tx * CELL, paintCanvas.height);
        paintCtx.stroke();
    }
    for (let tz = 1; tz < dungeon.tileRows; tz++) {
        paintCtx.beginPath();
        paintCtx.moveTo(0, tz * CELL);
        paintCtx.lineTo(paintCanvas.width, tz * CELL);
        paintCtx.stroke();
    }

    // Door openings, so the band the room-slide trigger covers is obvious.
    const [cx0, cx1] = doorTileSpan(dungeon.tileCols);
    const [cz0, cz1] = doorTileSpan(dungeon.tileRows);
    paintCtx.strokeStyle = ENTITY_COLOR;
    paintCtx.lineWidth = 2;
    for (const edge of DOOR_EDGES) {
        if (!room.doors[edge] || !hasNeighbour(dungeon, selected.rc, selected.rr, edge)) continue;
        if (edge === 'top') paintCtx.strokeRect(cx0 * CELL, 0, (cx1 - cx0 + 1) * CELL, CELL);
        else if (edge === 'bottom') paintCtx.strokeRect(cx0 * CELL, paintCanvas.height - CELL, (cx1 - cx0 + 1) * CELL, CELL);
        else if (edge === 'left') paintCtx.strokeRect(0, cz0 * CELL, CELL, (cz1 - cz0 + 1) * CELL);
        else paintCtx.strokeRect(paintCanvas.width - CELL, cz0 * CELL, CELL, (cz1 - cz0 + 1) * CELL);
    }
}

function tileAtPointer(event: PointerEvent): { tx: number; tz: number } | null {
    const rect = paintCanvas.getBoundingClientRect();
    const tx = Math.floor(((event.clientX - rect.left) / rect.width) * dungeon.tileCols);
    const tz = Math.floor(((event.clientY - rect.top) / rect.height) * dungeon.tileRows);
    if (tx < 0 || tz < 0 || tx >= dungeon.tileCols || tz >= dungeon.tileRows) return null;
    return { tx, tz };
}

let painting = false;

paintCanvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const hit = tileAtPointer(event);
    if (!hit) return;
    event.preventDefault();

    // Ctrl/⌘-click is the eyedropper, not a stroke.
    if (event.ctrlKey || event.metaKey) {
        pickTile(hit.tx, hit.tz);
        return;
    }

    paintCanvas.setPointerCapture(event.pointerId);
    painting = true;
    paintTile(hit.tx, hit.tz);
    refreshRoom();
});
paintCanvas.addEventListener('pointermove', (event) => {
    if (!painting) return;
    // A button released off-canvas never sends us a pointerup.
    if (event.buttons === 0) {
        painting = false;
        return;
    }
    const hit = tileAtPointer(event);
    if (!hit) return;
    paintTile(hit.tx, hit.tz);
    refreshRoom();
});
const endPaint = (): void => {
    painting = false;
};
paintCanvas.addEventListener('pointerup', endPaint);
paintCanvas.addEventListener('pointercancel', endPaint);
window.addEventListener('pointerup', endPaint);

// --- 3D preview -------------------------------------------------------------

const viewport = createEditorViewport($<HTMLCanvasElement>('viewport'), { background: '#12161b' });
let roomGroup: Object3D | null = null;
let rebuildQueued = false;

// Painting drags fire per tile; one rebuild per frame is plenty.
function queueRebuild(): void {
    if (rebuildQueued) return;
    rebuildQueued = true;
    requestAnimationFrame(() => {
        rebuildQueued = false;
        if (roomGroup) viewport.scene.remove(roomGroup);
        roomGroup = buildRoom(dungeon, selected.rc, selected.rr, catalog, spawn);
        viewport.scene.add(roomGroup);
    });
}

function frameRoom(): void {
    const [cx, , cz] = roomCenter(dungeon, selected.rc, selected.rr);
    viewport.frame({ x: cx, y: 0, z: cz }, Math.max(dungeon.tileCols, dungeon.tileRows) * 0.55, { yaw: 0, pitch: 0.85 });
}

// --- sidebar ----------------------------------------------------------------

const dungeonSelect = $<HTMLSelectElement>('dungeon-select');
const dungeonName = $<HTMLInputElement>('dungeon-name');
const roomNav = $('room-nav');
const roomCoordLabel = $('room-coord');
const gridDims = $('grid-dims');
const roomColsInput = $<HTMLInputElement>('room-cols');
const roomRowsInput = $<HTMLInputElement>('room-rows');
const tileColsInput = $<HTMLInputElement>('tile-cols');
const tileRowsInput = $<HTMLInputElement>('tile-rows');
const doorInputs: Record<DoorEdge, HTMLInputElement> = {
    top: $<HTMLInputElement>('door-top'),
    bottom: $<HTMLInputElement>('door-bottom'),
    left: $<HTMLInputElement>('door-left'),
    right: $<HTMLInputElement>('door-right'),
};

function renderDungeonSelect(): void {
    dungeonSelect.replaceChildren();
    list.forEach((entry, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = entry.name || '(unnamed)';
        dungeonSelect.append(option);
    });
    dungeonSelect.value = String(list.indexOf(current));
    dungeonName.value = current.name;
}

function renderRoomNav(): void {
    roomNav.replaceChildren();
    for (let rr = 0; rr < dungeon.roomRows; rr++) {
        const row = document.createElement('div');
        row.className = 'rn-row';
        row.style.gridTemplateColumns = `repeat(${dungeon.roomCols}, 1fr)`;
        for (let rc = 0; rc < dungeon.roomCols; rc++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = rc === selected.rc && rr === selected.rr ? 'rn-cell active' : 'rn-cell';
            cell.textContent = `${rc},${rr}`;
            cell.addEventListener('click', () => {
                selected = { rc, rr };
                renderRoomNav();
                frameRoom();
                refreshRoom();
            });
            row.append(cell);
        }
        roomNav.append(row);
    }
}

function syncSizeInputs(): void {
    roomColsInput.value = String(dungeon.roomCols);
    roomRowsInput.value = String(dungeon.roomRows);
    tileColsInput.value = String(dungeon.tileCols);
    tileRowsInput.value = String(dungeon.tileRows);
    gridDims.textContent = `${dungeon.tileCols} × ${dungeon.tileRows}`;
}

function syncDoorInputs(): void {
    const room = currentRoom();
    for (const edge of DOOR_EDGES) {
        doorInputs[edge].checked = room.doors[edge];
        doorInputs[edge].disabled = !hasNeighbour(dungeon, selected.rc, selected.rr, edge);
    }
}

/** Everything that depends on the selected room's contents. */
function refreshRoom(): void {
    roomCoordLabel.textContent = `${selected.rc},${selected.rr}`;
    syncDoorInputs();
    drawMap();
    queueRebuild();
}

/** Everything, after the dungeon itself changed. */
function refreshAll(): void {
    selected = { rc: Math.min(selected.rc, dungeon.roomCols - 1), rr: Math.min(selected.rr, dungeon.roomRows - 1) };
    syncSizeInputs();
    resizePaintCanvas();
    renderRoomNav();
    frameRoom();
    refreshRoom();
}

const OPPOSITE: Record<DoorEdge, DoorEdge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// Punches (or fills) the opening in a room's edge wall, mirrored onto the
// neighbour: a one-sided door is a trap, since the trigger only fires for the
// room that declares it.
function setDoor(rc: number, rr: number, edge: DoorEdge, open: boolean): void {
    const room = roomAt(dungeon, rc, rr);
    if (!room) return;
    room.doors[edge] = open;
    const tile = open ? TILE_FLOOR : TILE_WALL;
    const [cx0, cx1] = doorTileSpan(dungeon.tileCols);
    const [cz0, cz1] = doorTileSpan(dungeon.tileRows);
    if (edge === 'top' || edge === 'bottom') {
        const tz = edge === 'top' ? 0 : dungeon.tileRows - 1;
        for (let tx = cx0; tx <= cx1; tx++) room.tiles[tileIndex(dungeon, tx, tz)] = tile;
    } else {
        const tx = edge === 'left' ? 0 : dungeon.tileCols - 1;
        for (let tz = cz0; tz <= cz1; tz++) room.tiles[tileIndex(dungeon, tx, tz)] = tile;
    }
}

for (const edge of DOOR_EDGES) {
    doorInputs[edge].addEventListener('change', () => {
        const open = doorInputs[edge].checked;
        setDoor(selected.rc, selected.rr, edge, open);
        const neighbour = neighbourRoom(dungeon, selected.rc, selected.rr, edge);
        if (neighbour) setDoor(neighbour.rc, neighbour.rr, OPPOSITE[edge], open);
        refreshRoom();
    });
}

$('apply-size').addEventListener('click', () => {
    dungeon = makeDungeon(
        Math.max(1, Number(roomColsInput.value) || 1),
        Math.max(1, Number(roomRowsInput.value) || 1),
        Math.max(4, Number(tileColsInput.value) || 4),
        Math.max(4, Number(tileRowsInput.value) || 4),
    );
    current.data = dungeon;
    selected = { rc: 0, rr: 0 };
    refreshAll();
    setStatus('Rebuilt every room as a plain walled box.');
});

function switchTo(entry: WorkingDungeon): void {
    current = entry;
    dungeon = entry.data;
    selected = { rc: 0, rr: 0 };
    renderDungeonSelect();
    refreshAll();
}

dungeonSelect.addEventListener('change', () => {
    switchTo(list[Number(dungeonSelect.value)] ?? current);
    setStatus('');
});

dungeonName.addEventListener('input', () => {
    current.name = dungeonName.value.trim();
    const index = list.indexOf(current);
    renderDungeonSelect();
    dungeonSelect.value = String(index);
    // Saving under a new name writes a new file; the old one stays behind.
    if (current.savedName && current.name !== current.savedName) {
        setWarning(`Saving writes src/assets/dungeons/${current.name}.ts — ${current.savedName}.ts stays on disk until you delete it.`);
    } else {
        setStatus('');
    }
});

$('new-btn').addEventListener('click', () => {
    let name = 'dungeon';
    let n = 1;
    while (list.some((entry) => entry.name === `${name}${n}`)) n++;
    name = `${name}${n}`;
    const entry: WorkingDungeon = { name, savedName: null, data: makeDungeon() };
    list.push(entry);
    switchTo(entry);
    setStatus(`New dungeon "${name}" — paint it, then Save.`);
});

// --- save -------------------------------------------------------------------

function serializeRoom(room: Room): string {
    const fields = [`tiles: [${room.tiles.join(',')}]`, `doors: ${JSON.stringify(room.doors)}`];
    for (const key of ['floorParts', 'wallParts', 'propParts'] as const) {
        if (room[key]) fields.push(`${key}: ${JSON.stringify(room[key])}`);
    }
    if (room.entities) fields.push(`entities: ${JSON.stringify(room.entities)}`);
    return `        { ${fields.join(', ')} },`;
}

function generateDungeonModule(name: string, data: Dungeon): string {
    const categories = Object.keys(categoryTexts).sort();
    const usesEntities = data.rooms.some((room) => room.entities !== undefined);

    const lines = [
        '// GENERATED by the Dungeon editor (/editor_dungeon.html) — Save regenerates',
        '// this file via the editor-save middleware. A dungeon is a grid of rooms; each',
        '// room is a tile grid (0 pit / 1 floor / 2 wall) plus sparse overlays saying',
        '// which authored part fills a tile and which entity spawns on it.',
        '//',
        `//     import { buildDungeon } from './assets/dungeons/${name}';`,
        '//     scene.add(buildDungeon());',
        "import { buildDungeon as build, buildRoom as buildOne, type Dungeon, type DungeonCatalog, loadDungeonCatalog } from '../../lib/dungeon';",
        "import type { Object3D } from '../../lib/object3d';",
        ...(usesEntities ? ["import { entities, spawnEntity } from '../entities';"] : []),
        ...categories.map((category) => `import ${category}Text from '../dungeon/${category}.txt?raw';`),
        '',
        'export const dungeon: Dungeon = {',
        `    roomCols: ${data.roomCols}, roomRows: ${data.roomRows}, tileCols: ${data.tileCols}, tileRows: ${data.tileRows},`,
        '    rooms: [',
        ...data.rooms.map(serializeRoom),
        '    ],',
        '};',
        '',
        '// Part libraries are parsed on first build, then shared by every room.',
        'let catalog: DungeonCatalog | null = null;',
        `const parts = (): DungeonCatalog => (catalog ??= loadDungeonCatalog({ ${categories.map((c) => `${c}: ${c}Text`).join(', ')} }));`,
    ];

    if (usesEntities) {
        lines.push(
            '',
            '// Names are plain strings in the map data, so a blueprint deleted since the',
            '// last Save just spawns nothing instead of throwing.',
            'const names: readonly string[] = Object.keys(entities);',
            'const spawnAny = spawnEntity as (name: string) => Object3D;',
            'const spawn = (name: string): Object3D | null => (names.includes(name) ? spawnAny(name) : null);',
        );
    }

    const spawnArg = usesEntities ? ', spawn' : '';
    lines.push(
        '',
        `export const buildDungeon = (): Object3D => build(dungeon, parts()${spawnArg});`,
        `export const buildRoom = (rc: number, rr: number): Object3D => buildOne(dungeon, rc, rr, parts()${spawnArg});`,
        '',
    );
    return lines.join('\n');
}

async function saveCurrent(): Promise<boolean> {
    const name = current.name;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        setStatus(`"${name || '(unnamed)'}" is not a valid dungeon file name (e.g. castle, dungeon1).`, true);
        return false;
    }
    if (list.some((entry) => entry !== current && entry.name === name)) {
        setStatus(`Another dungeon is already named "${name}".`, true);
        return false;
    }
    current.savedName = name;
    return saveGenerated(
        setStatus,
        '/__editor/save-dungeon',
        { name, source: generateDungeonModule(name, dungeon) },
        SAVED_MESSAGE_KEY,
        `Saved src/assets/dungeons/${name}.ts (${dungeon.rooms.length} rooms).`,
    );
}

$('save-btn').addEventListener('click', () => {
    void saveCurrent();
});

// The play page loads the GENERATED module, so previewing saves first —
// otherwise you would walk around the last save, not what is on screen. The
// tab is opened NOW, while the click is still a user gesture (opening it after
// the save resolves gets eaten by the popup blocker) and pointed at the page
// once the file is written.
$('preview-btn').addEventListener('click', () => {
    const tab = window.open('', '_blank');
    void saveCurrent().then((ok) => {
        if (!ok) {
            tab?.close();
            return;
        }
        if (tab) tab.location.href = `/dungeon_play.html?dungeon=${encodeURIComponent(current.name)}`;
        else setWarning('Saved — allow pop-ups for this page to open the preview automatically.');
    });
});

renderDungeonSelect();
renderBrush();
refreshAll();
restoreSavedMessage(setStatus, SAVED_MESSAGE_KEY);

Object.assign(window as unknown as Record<string, unknown>, { viewport });
