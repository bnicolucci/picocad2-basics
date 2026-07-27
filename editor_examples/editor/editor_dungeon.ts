// Dungeon Editor app logic (/editor_dungeon.html).
//
// Paints the room-grid tilemap that src/dungeon/dungeon_main.ts runs. The 2D
// paint canvas and the 3D preview are both driven from the same Dungeon data,
// and the preview builds its instances with the runtime's own
// buildRoomPlacements + makeTileResolver, so what you see here is what the game
// draws.
//
// Save regenerates src/dungeon/dungeon_current.ts wholesale via
// POST /__editor/save-dungeon (HMR suppressed for that file, so saving does not
// reload the editor page).

import cubeRaw from '../assets/primitives/mesh_cube.txt?raw';
import { create_camera, install_orbit_camera_controls, OrbitCamera, OrbitCameraController, set_camera_from_orbit } from '../core/camera';
import { allCatalogMaterials, allCatalogParts, type DungeonCatalog, loadDungeonCatalog, makeTileResolver, tileVariant } from '../dungeon/dungeon_assets';
import { currentDungeon } from '../dungeon/dungeon_current';
import { buildRoomPlacements, roomWorldCenter, tileWorldCenter } from '../dungeon/dungeon_geometry';
import { DUNGEON_COLORS, loadPrimitiveMesh, makeFlatMaterial } from '../dungeon/dungeon_primitives';
import { type DungeonPartIcons, ICON_DISPLAY_SIZE, renderDungeonPartIcons } from './dungeon_part_icons';
import {
    type DoorEdge,
    DOOR_EDGES,
    doorTileSpan,
    type Dungeon,
    hasNeighbour,
    makeDefaultDungeon,
    neighbourRoom,
    type Room,
    roomIndex,
    sanitizeDungeon,
    TILE_EMPTY,
    TILE_FLOOR,
    TILE_WALL,
    tileIndex,
    type TileType,
} from '../dungeon/dungeon_types';
import { picoCadPalettes, type PicoCadPaletteId } from '../palettes/picocad_palettes';
import { Renderer } from '../renderer';
import type { RenderInstance } from '../scene';

const el = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing #${id}`);
    return found as T;
};

const saveButton = el<HTMLButtonElement>('save');
const openGameButton = el<HTMLButtonElement>('open-game');
const statusEl = el('status');
const roomColsInput = el<HTMLInputElement>('room-cols');
const roomRowsInput = el<HTMLInputElement>('room-rows');
const tileColsInput = el<HTMLInputElement>('tile-cols');
const tileRowsInput = el<HTMLInputElement>('tile-rows');
const applySizeButton = el<HTMLButtonElement>('apply-size');
const paletteSelect = el<HTMLSelectElement>('palette-select');
const palettePreview = el('palette-preview');
const brushPalette = el('palette');
const roomCoordLabel = el('room-coord');
const roomNav = el('room-nav');
const doorInputs: Record<DoorEdge, HTMLInputElement> = {
    top: el<HTMLInputElement>('door-top'),
    bottom: el<HTMLInputElement>('door-bottom'),
    left: el<HTMLInputElement>('door-left'),
    right: el<HTMLInputElement>('door-right'),
};
const paintCanvas = el<HTMLCanvasElement>('paint');
const paintCtx = paintCanvas.getContext('2d')!;
const gridDims = el('grid-dims');
const viewportCanvas = el<HTMLCanvasElement>('viewport');

let dungeon: Dungeon = sanitizeDungeon(currentDungeon);
let selected = { rc: 0, rr: 0 };

// The active paint brush. `part` is the authored part name for that category;
// undefined means "Auto" (the runtime's deterministic pick for floors, the
// first part for walls). Props always name a part — 'none' clears the overlay.
type Brush =
    | { kind: 'empty' }
    | { kind: 'floor'; part?: string }
    | { kind: 'wall'; part?: string }
    | { kind: 'prop'; part?: string };
let brush: Brush = { kind: 'wall' };

function currentRoom(): Room {
    return dungeon.rooms[roomIndex(dungeon, selected.rc, selected.rr)]!;
}

function setStatus(message: string, isError = false): void {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#e57373' : '#89c27d';
}

// --- part catalog -----------------------------------------------------------
// Rebuilt whenever the palette changes, because the palette recolours every
// part texture (and therefore every swatch colour and preview material).

let catalog: DungeonCatalog = loadDungeonCatalog(0.4, dungeon.paletteId);

function categoryParts(category: string): { name: string; previewColor: [number, number, number] }[] {
    return catalog.get(category)?.parts ?? [];
}

function rgbCss(c: readonly [number, number, number]): string {
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function unitRgbCss(c: readonly [number, number, number]): string {
    return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

// --- key colours ------------------------------------------------------------
// A part's 2D map colour is its real texture colour, so the map still looks like
// the room it builds. But parts in one file often paint from the same palette
// region — `castley` and `wall` differ in geometry, not colour — and would come
// out as one indistinguishable swatch. So each part keeps its own colour unless
// it lands too close to a part already assigned in that category, in which case
// it's shaded (darker first, then lighter) until it separates.

// Darker steps come first — a shaded-down twin is the least surprising way to
// tell two same-coloured parts apart. Lighter steps are the fallback for parts
// whose texture is already dark, where darkening barely moves the colour (or
// pushes it into the pit colour).
const KEY_SHADE_STEPS = [1, 0.58, 0.36, 1.5, 1.9, 0.22];
/** RGB distance below which two parts read as "the same colour" on the map. */
const MIN_KEY_DISTANCE = 48;
/** Empty tiles. Seeded as "taken" so no part is ever shaded into looking like a pit. */
const PIT_COLOR: [number, number, number] = [12, 14, 18];

function shade(c: readonly [number, number, number], factor: number): [number, number, number] {
    if (factor <= 1) return [Math.round(c[0] * factor), Math.round(c[1] * factor), Math.round(c[2] * factor)];
    const t = Math.min(1, factor - 1);
    return [Math.round(c[0] + (255 - c[0]) * t), Math.round(c[1] + (255 - c[1]) * t), Math.round(c[2] + (255 - c[2]) * t)];
}

function colorDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function buildKeyColors(source: DungeonCatalog): Map<string, string> {
    const out = new Map<string, string>();
    for (const [category, entry] of source) {
        // Only compared within a category: a wall matching a floor colour is not
        // worth shifting the floor for, and walls already read as raised.
        const assigned: [number, number, number][] = [PIT_COLOR];
        for (const part of entry.parts) {
            let chosen = part.previewColor;
            for (const step of KEY_SHADE_STEPS) {
                chosen = shade(part.previewColor, step);
                if (assigned.every((other) => colorDistance(other, chosen) >= MIN_KEY_DISTANCE)) break;
            }
            assigned.push(chosen);
            out.set(`${category}:${part.name}`, rgbCss(chosen));
        }
    }
    return out;
}

let keyColors = buildKeyColors(catalog);

// 3/4-view renders of each part, filled in asynchronously (they need a WebGL
// context). Menus fall back to a plain key-colour chip until they arrive.
let partIcons: DungeonPartIcons = new Map();

async function refreshPartIcons(): Promise<void> {
    partIcons = await renderDungeonPartIcons(catalog);
    if (partMenuCategory) openPartMenu(brushPalette.querySelector<HTMLElement>('.swatch.active')!, partMenuCategory);
}

function keyColor(category: string, name: string, fallback: string): string {
    return keyColors.get(`${category}:${name}`) ?? fallback;
}

// The colour a tile reads as in the 2D map — the key colour of the same part the
// runtime resolver would pick, so the map and the 3D preview always agree on
// which part is on a tile.
function floorColorAt(room: Room, tx: number, tz: number): string {
    const parts = categoryParts('grounds');
    if (parts.length === 0) return unitRgbCss(DUNGEON_COLORS.floor);
    const idx = tileIndex(dungeon, tx, tz);
    const named = room.floorParts?.[idx];
    const part = (named ? parts.find((p) => p.name === named) : undefined) ?? (() => {
        const [wx, , wz] = tileWorldCenter(dungeon, selected.rc, selected.rr, tx, tz);
        return parts[tileVariant(wx, wz, parts.length)]!;
    })();
    return keyColor('grounds', part.name, unitRgbCss(DUNGEON_COLORS.floor));
}

function wallColorAt(room: Room, tx: number, tz: number): string {
    const parts = categoryParts('walls');
    if (parts.length === 0) return unitRgbCss(DUNGEON_COLORS.wall);
    const named = room.wallParts?.[tileIndex(dungeon, tx, tz)];
    const part = (named ? parts.find((p) => p.name === named) : undefined) ?? parts[0]!;
    return keyColor('walls', part.name, unitRgbCss(DUNGEON_COLORS.wall));
}

// --- brush palette ----------------------------------------------------------

const BRUSH_CATEGORY: Record<Brush['kind'], string | null> = {
    empty: null,
    floor: 'grounds',
    wall: 'walls',
    prop: 'props',
};

function brushLabel(): string {
    if (brush.kind === 'empty') return 'Pit (no tile)';
    const part = brush.part ?? (brush.kind === 'prop' ? 'none' : 'auto');
    return `${brush.kind} · ${part}`;
}

// The part list floats over the sidebar rather than sitting inline, so opening
// it never reflows the swatches underneath it. It lives on <body> because
// #controls scrolls and would clip an absolutely positioned child.
let partMenu: HTMLElement | null = null;
let partMenuCategory: string | null = null;

function closePartMenu(): void {
    partMenu?.remove();
    partMenu = null;
    partMenuCategory = null;
}

function openPartMenu(anchor: HTMLElement, category: string): void {
    closePartMenu();
    const menu = document.createElement('div');
    menu.style.cssText =
        'position: fixed; z-index: 50; min-width: 190px; padding: 5px; display: grid; gap: 1px;' +
        'background: #1a1a1a; border: 1px solid #3d3d3d; border-radius: 4px; box-shadow: 0 8px 22px rgba(0, 0, 0, 0.65);';

    // Each row shows the part's 3/4 render, framed in its key colour so the icon
    // and the colour that fills its tiles on the 2D map read as one thing.
    const option = (label: string, part: string | undefined, chip: string): void => {
        const row = document.createElement('button');
        row.type = 'button';
        const active = (brush as { part?: string }).part === part;
        row.style.cssText =
            'display: flex; align-items: center; gap: 8px; padding: 3px 6px; border: 0; border-radius: 3px;' +
            `cursor: pointer; font: 11px monospace; text-align: left; background: ${active ? '#2a2717' : 'transparent'};` +
            `color: ${active ? '#ffd23c' : '#cfcfcf'};`;
        row.addEventListener('mouseenter', () => {
            if (!active) row.style.background = '#262626';
        });
        row.addEventListener('mouseleave', () => {
            if (!active) row.style.background = 'transparent';
        });

        const icon = part ? partIcons.get(`${category}:${part}`) : undefined;
        const thumb = document.createElement(icon ? 'img' : 'span');
        thumb.style.cssText =
            `width: ${ICON_DISPLAY_SIZE}px; height: ${ICON_DISPLAY_SIZE}px; flex: 0 0 auto; border-radius: 2px;` +
            `border: 2px solid ${chip}; image-rendering: pixelated; ${icon ? '' : `background: ${chip};`}`;
        if (icon) (thumb as HTMLImageElement).src = icon;
        row.append(thumb, document.createTextNode(label));

        row.addEventListener('click', () => {
            brush = { kind: brush.kind, part } as Brush;
            closePartMenu();
            buildBrushPalette();
        });
        menu.append(row);
    };

    const parts = categoryParts(category);
    // "Auto" resolves to a real part for walls (the first one) but varies per
    // tile for floors, so only the wall case can show a meaningful part.
    if (category === 'props') option('None (clear prop)', undefined, rgbCss(PIT_COLOR));
    else if (category === 'walls') option('Auto (plain wall)', undefined, parts[0] ? keyColor('walls', parts[0].name, '#555') : '#555');
    else option('Auto (random)', undefined, '#555');
    for (const part of parts) option(part.name, part.name, keyColor(category, part.name, '#888'));

    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
    const below = rect.bottom + 4;
    menu.style.top = `${below + menu.offsetHeight > window.innerHeight ? Math.max(8, rect.top - menu.offsetHeight - 4) : below}px`;

    partMenu = menu;
    partMenuCategory = category;
}

function buildBrushPalette(): void {
    brushPalette.replaceChildren();

    const swatch = (label: string, color: string, kind: Brush['kind'], onSelect: () => void): void => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = brush.kind === kind ? 'swatch active' : 'swatch';
        button.style.background = color;
        button.textContent = label;
        button.addEventListener('click', () => {
            const category = BRUSH_CATEGORY[kind];
            // Clicking the already-open swatch closes its menu, so the list
            // toggles instead of only ever opening.
            if (partMenuCategory === category) {
                closePartMenu();
                return;
            }
            closePartMenu(); // switching brushes never leaves the old list up
            onSelect();
            buildBrushPalette();
            if (category && categoryParts(category).length > 0) {
                openPartMenu(brushPalette.querySelector<HTMLElement>('.swatch.active')!, category);
            }
        });
        brushPalette.append(button);
    };

    const firstKey = (category: string, fallback: readonly [number, number, number]): string => {
        const first = categoryParts(category)[0];
        return first ? keyColor(category, first.name, unitRgbCss(fallback)) : unitRgbCss(fallback);
    };

    swatch('Wall', firstKey('walls', DUNGEON_COLORS.wall), 'wall', () => {
        brush = { kind: 'wall' };
    });
    swatch('Floor', firstKey('grounds', DUNGEON_COLORS.floor), 'floor', () => {
        brush = { kind: 'floor' };
    });
    swatch('Pit', rgbCss(PIT_COLOR), 'empty', () => {
        brush = { kind: 'empty' };
    });
    const propParts = categoryParts('props');
    if (propParts.length > 0) {
        swatch('Prop', keyColor('props', propParts[0]!.name, '#888'), 'prop', () => {
            brush = { kind: 'prop', part: propParts[0]!.name };
        });
    }

    const label = document.createElement('div');
    label.className = 'muted';
    label.style.gridColumn = '1 / -1';
    label.textContent = `Brush: ${brushLabel()}`;
    brushPalette.append(label);
}

// A fixed-position menu can't follow the sidebar, so anything that moves its
// anchor closes it.
document.addEventListener('pointerdown', (event) => {
    if (!partMenu) return;
    const target = event.target as Node;
    if (partMenu.contains(target) || brushPalette.contains(target)) return;
    closePartMenu();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePartMenu();
});
el('controls').addEventListener('scroll', closePartMenu);
window.addEventListener('resize', closePartMenu);

// --- tile painting ----------------------------------------------------------

function clearPart(room: Room, key: 'floorParts' | 'wallParts' | 'propParts', idx: number): void {
    const map = room[key];
    if (!map) return;
    delete map[idx];
    if (Object.keys(map).length === 0) delete room[key];
}

function setPart(room: Room, key: 'floorParts' | 'wallParts' | 'propParts', idx: number, part: string | undefined): void {
    if (part === undefined) {
        clearPart(room, key, idx);
        return;
    }
    const map = room[key] ?? (room[key] = {});
    map[idx] = part;
}

function paintTile(tx: number, tz: number, erase: boolean): void {
    const room = currentRoom();
    const idx = tileIndex(dungeon, tx, tz);
    const applied: Brush = erase ? { kind: 'floor' } : brush;

    if (applied.kind === 'empty') {
        room.tiles[idx] = TILE_EMPTY;
        clearPart(room, 'floorParts', idx);
        clearPart(room, 'wallParts', idx);
        clearPart(room, 'propParts', idx);
        return;
    }
    if (applied.kind === 'wall') {
        room.tiles[idx] = TILE_WALL;
        clearPart(room, 'propParts', idx); // props only stand on floor tiles
        setPart(room, 'wallParts', idx, applied.part);
        return;
    }
    if (applied.kind === 'floor') {
        room.tiles[idx] = TILE_FLOOR;
        clearPart(room, 'wallParts', idx);
        if (erase) clearPart(room, 'propParts', idx);
        setPart(room, 'floorParts', idx, applied.part);
        return;
    }
    // Prop: an overlay on a floor tile, so painting one converts the tile first.
    room.tiles[idx] = TILE_FLOOR;
    clearPart(room, 'wallParts', idx);
    setPart(room, 'propParts', idx, applied.part);
}

// --- 2D paint canvas --------------------------------------------------------

function cellSize(): { w: number; h: number } {
    return { w: paintCanvas.width / dungeon.tileCols, h: paintCanvas.height / dungeon.tileRows };
}

function drawPaintCanvas(): void {
    const room = currentRoom();
    const { w, h } = cellSize();
    paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);

    for (let tz = 0; tz < dungeon.tileRows; tz++) {
        for (let tx = 0; tx < dungeon.tileCols; tx++) {
            const idx = tileIndex(dungeon, tx, tz);
            const t = room.tiles[idx] as TileType;
            paintCtx.fillStyle = t === TILE_WALL ? wallColorAt(room, tx, tz) : t === TILE_FLOOR ? floorColorAt(room, tx, tz) : rgbCss(PIT_COLOR);
            paintCtx.fillRect(tx * w, tz * h, w, h);
            if (t === TILE_WALL) {
                // Darken the lower half so walls read as raised blocks.
                paintCtx.fillStyle = 'rgba(0, 0, 0, 0.28)';
                paintCtx.fillRect(tx * w, tz * h + h * 0.5, w, h * 0.5);
            }
            const prop = room.propParts?.[idx];
            if (prop) {
                paintCtx.fillStyle = keyColor('props', prop, '#ffffff');
                paintCtx.beginPath();
                paintCtx.arc(tx * w + w / 2, tz * h + h / 2, Math.min(w, h) * 0.26, 0, Math.PI * 2);
                paintCtx.fill();
                paintCtx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
                paintCtx.lineWidth = 1;
                paintCtx.stroke();
            }
        }
    }

    paintCtx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    paintCtx.lineWidth = 1;
    for (let tx = 1; tx < dungeon.tileCols; tx++) {
        paintCtx.beginPath();
        paintCtx.moveTo(tx * w, 0);
        paintCtx.lineTo(tx * w, paintCanvas.height);
        paintCtx.stroke();
    }
    for (let tz = 1; tz < dungeon.tileRows; tz++) {
        paintCtx.beginPath();
        paintCtx.moveTo(0, tz * h);
        paintCtx.lineTo(paintCanvas.width, tz * h);
        paintCtx.stroke();
    }

    // Door openings, so it's obvious which band the room-slide trigger covers.
    const [cx0, cx1] = doorTileSpan(dungeon.tileCols);
    const [cz0, cz1] = doorTileSpan(dungeon.tileRows);
    paintCtx.strokeStyle = '#ffd23c';
    paintCtx.lineWidth = 2;
    for (const edge of DOOR_EDGES) {
        if (!room.doors[edge] || !hasNeighbour(dungeon, selected.rc, selected.rr, edge)) continue;
        if (edge === 'top') paintCtx.strokeRect(cx0 * w, 0, (cx1 - cx0 + 1) * w, h);
        else if (edge === 'bottom') paintCtx.strokeRect(cx0 * w, paintCanvas.height - h, (cx1 - cx0 + 1) * w, h);
        else if (edge === 'left') paintCtx.strokeRect(0, cz0 * h, w, (cz1 - cz0 + 1) * h);
        else paintCtx.strokeRect(paintCanvas.width - w, cz0 * h, w, (cz1 - cz0 + 1) * h);
    }
}

function tileAtPointer(event: PointerEvent): { tx: number; tz: number } | null {
    const rect = paintCanvas.getBoundingClientRect();
    const { w, h } = cellSize();
    const tx = Math.floor((((event.clientX - rect.left) / rect.width) * paintCanvas.width) / w);
    const tz = Math.floor((((event.clientY - rect.top) / rect.height) * paintCanvas.height) / h);
    if (tx < 0 || tz < 0 || tx >= dungeon.tileCols || tz >= dungeon.tileRows) return null;
    return { tx, tz };
}

let painting: { erase: boolean } | null = null;

paintCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
paintCanvas.addEventListener('pointerdown', (event) => {
    const hit = tileAtPointer(event);
    if (!hit) return;
    event.preventDefault();
    paintCanvas.setPointerCapture(event.pointerId);
    painting = { erase: event.button === 2 };
    paintTile(hit.tx, hit.tz, painting.erase);
    refreshRoom();
});
paintCanvas.addEventListener('pointermove', (event) => {
    if (!painting) return;
    const hit = tileAtPointer(event);
    if (!hit) return;
    paintTile(hit.tx, hit.tz, painting.erase);
    refreshRoom();
});
const endPaint = (): void => {
    painting = null;
};
paintCanvas.addEventListener('pointerup', endPaint);
paintCanvas.addEventListener('pointercancel', endPaint);

// --- sidebar ----------------------------------------------------------------

function buildRoomNav(): void {
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
                buildRoomNav();
                refreshRoom();
            });
            row.append(cell);
        }
        roomNav.append(row);
    }
}

function buildPaletteSelect(): void {
    paletteSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Authored colours (no override)';
    paletteSelect.append(none);
    for (const [id, theme] of Object.entries(picoCadPalettes)) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = theme.name;
        paletteSelect.append(option);
    }
    paletteSelect.value = dungeon.paletteId ?? '';
}

function drawPalettePreview(): void {
    palettePreview.replaceChildren();
    const id = dungeon.paletteId;
    const theme = id && id in picoCadPalettes ? picoCadPalettes[id as PicoCadPaletteId] : null;
    if (!theme) {
        palettePreview.style.display = 'none';
        return;
    }
    palettePreview.style.display = 'flex';
    for (const color of theme.colors) {
        const cell = document.createElement('span');
        cell.style.background = rgbCss(color);
        palettePreview.append(cell);
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

const OPPOSITE: Record<DoorEdge, DoorEdge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// Punches (or fills) the opening in a room's edge wall. Also mirrored onto the
// neighbour, because a one-sided door is a trap: the runtime trigger only fires
// for the room that declares the door, so the player could walk in and be stuck.
function setDoor(rc: number, rr: number, edge: DoorEdge, open: boolean): void {
    const room = dungeon.rooms[roomIndex(dungeon, rc, rr)];
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

applySizeButton.addEventListener('click', () => {
    dungeon = makeDefaultDungeon(
        Math.max(1, Number(roomColsInput.value) || 1),
        Math.max(1, Number(roomRowsInput.value) || 1),
        Math.max(4, Number(tileColsInput.value) || 4),
        Math.max(4, Number(tileRowsInput.value) || 4),
    );
    if (paletteSelect.value) dungeon.paletteId = paletteSelect.value;
    selected = { rc: 0, rr: 0 };
    syncSizeInputs();
    buildRoomNav();
    refreshRoom();
    setStatus('Rebuilt every room as a plain walled box.');
});

paletteSelect.addEventListener('change', () => {
    const id = paletteSelect.value;
    if (id) dungeon.paletteId = id;
    else delete dungeon.paletteId;
    catalog = loadDungeonCatalog(0.4, dungeon.paletteId);
    keyColors = buildKeyColors(catalog);
    drawPalettePreview();
    buildBrushPalette();
    refreshRoom();
    // Materials are baked into the renderer at creation, so a palette change
    // needs a fresh one.
    void rebuildPreview();
    void refreshPartIcons();
});

openGameButton.addEventListener('click', () => window.open('/dungeon.html', '_blank'));

// --- 3D preview -------------------------------------------------------------

const cube = loadPrimitiveMesh('mesh_cube', cubeRaw);
const orbit = new OrbitCamera([0, 0, 0], Math.max(dungeon.tileCols, dungeon.tileRows) * 0.5);
const orbitController = new OrbitCameraController(orbit);
const previewCamera = create_camera({ near: 0.1, far: 400, fovYRadians: Math.PI / 3.4 });
let previewRenderer: Renderer | null = null;
let previewInstances: RenderInstance[] = [];

install_orbit_camera_controls(viewportCanvas, orbitController);

function frameSelectedRoom(): void {
    const center = roomWorldCenter(dungeon, selected.rc, selected.rr);
    orbitController.setTarget(center[0], center[1], center[2]);
    orbitController.setDistanceLimits({
        minDistance: 4,
        maxDistance: Math.max(dungeon.tileCols, dungeon.tileRows) * 4,
        distance: Math.max(dungeon.tileCols, dungeon.tileRows) * 1.1,
    });
    orbit.yaw = Math.PI / 2;
    orbit.pitch = 0.85;
    orbitController.snapToOrbitPose({ yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance });
}

// Instances for the selected room only — the same placements and resolver the
// runtime uses, so the preview is the game's geometry.
function buildPreviewInstances(): RenderInstance[] {
    const resolveTile = makeTileResolver(catalog, cube.meshId);
    return buildRoomPlacements(dungeon, selected.rc, selected.rr).map((placement, i) => {
        const spec = resolveTile(placement);
        return {
            nodeId: `preview:${i}`,
            nodeName: placement.prim,
            meshAssetId: spec.meshId,
            materialId: spec.matBright,
            visible: true,
            worldMatrix: spec.worldMatrix,
        };
    });
}

function resizePreview(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = viewportCanvas.getBoundingClientRect();
    viewportCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    viewportCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    viewportCanvas.style.width = '100%';
    viewportCanvas.style.height = '100%';
}

async function rebuildPreview(): Promise<void> {
    previewRenderer?.stopAnimationLoop();

    const meshes = new Map([[cube.meshId, cube.builtMesh]]);
    for (const part of allCatalogParts(catalog)) meshes.set(part.meshId, part.builtMesh);
    const materials = [
        { materialId: 'mat:floor', texture: makeFlatMaterial(DUNGEON_COLORS.floor) },
        { materialId: 'mat:wall', texture: makeFlatMaterial(DUNGEON_COLORS.wall) },
        { materialId: 'mat:floor_dim', texture: makeFlatMaterial(DUNGEON_COLORS.floor) },
        { materialId: 'mat:wall_dim', texture: makeFlatMaterial(DUNGEON_COLORS.wall) },
        ...allCatalogMaterials(catalog),
    ];

    previewInstances = buildPreviewInstances();
    const renderer = await Renderer.create(viewportCanvas, materials, meshes, previewInstances, previewCamera, {
        retroRenderScale: 1,
        maxPixelRatio: 2,
        lockAspectRatio: false,
        viewBackgroundColor: '#12161b',
    });
    previewRenderer = renderer;
    renderer.setWireframeEnabled(false);
    resizePreview();
    renderer.setAnimationLoop((frame) => {
        orbitController.update(frame.deltaTime);
        set_camera_from_orbit(previewCamera, orbit);
        renderer.updateCamera(previewCamera);
        renderer.updateRenderInstances(previewInstances);
    });
}

window.addEventListener('resize', resizePreview);

// --- refresh + save ---------------------------------------------------------

function refreshRoom(): void {
    roomCoordLabel.textContent = `${selected.rc},${selected.rr}`;
    syncDoorInputs();
    drawPaintCanvas();
    previewInstances = buildPreviewInstances();
}

// One room per line, matching the shape of the file the runtime imports.
function generateDungeonSource(): string {
    const rooms = dungeon.rooms
        .map((room) => {
            const parts: string[] = [`"tiles": [${room.tiles.join(',')}]`, `"doors": ${JSON.stringify(room.doors)}`];
            if (room.floorParts) parts.push(`"floorParts": ${JSON.stringify(room.floorParts)}`);
            if (room.wallParts) parts.push(`"wallParts": ${JSON.stringify(room.wallParts)}`);
            if (room.propParts) parts.push(`"propParts": ${JSON.stringify(room.propParts)}`);
            return `        { ${parts.join(', ')} }`;
        })
        .join(',\n');

    return `// >>> DUNGEON EDITOR GENERATED — regenerated wholesale on Save Dungeon, do not hand-edit >>>
import type { Dungeon } from './dungeon_types';

export const currentDungeon: Dungeon = {
    "roomCols": ${dungeon.roomCols}, "roomRows": ${dungeon.roomRows}, "tileCols": ${dungeon.tileCols}, "tileRows": ${dungeon.tileRows},
${dungeon.paletteId ? `    "paletteId": ${JSON.stringify(dungeon.paletteId)},\n` : ''}    "rooms": [
${rooms}
    ],
};
// <<< DUNGEON EDITOR GENERATED END <<<
`;
}

saveButton.addEventListener('click', async () => {
    setStatus('Saving…');
    try {
        const response = await fetch('/__editor/save-dungeon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: generateDungeonSource() }),
        });
        if (!response.ok) throw new Error(await response.text());
        setStatus('Saved src/dungeon/dungeon_current.ts');
    } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
    }
});

buildPaletteSelect();
drawPalettePreview();
buildBrushPalette();
syncSizeInputs();
buildRoomNav();
frameSelectedRoom();
refreshRoom();
void rebuildPreview();
void refreshPartIcons();
