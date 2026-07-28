// Controls Editor — curates the generated src/controls.ts: rename the game's
// action buttons and rebind their keys/gamepad buttons. Movement (WASD/arrows/
// stick) is fixed by design and only displayed. Dev-only page; Save POSTs the
// regenerated module to the editor-save middleware in vite.config.ts.

import { actions as savedActions, MAX_ACTIONS } from './controls';
import type { ControlAction } from './lib/input';

const actionListEl = document.getElementById('action-list') as HTMLDivElement;
const addBtn = document.getElementById('add-btn') as HTMLButtonElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const conflictEl = document.getElementById('conflict-note') as HTMLDivElement;

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const SAVED_MESSAGE_KEY = 'controls-editor:saved';
const PAD_BUTTONS = ['A (0)', 'B (1)', 'X (2)', 'Y (3)', 'LB (4)', 'RB (5)', 'LT (6)', 'RT (7)', 'Back (8)', 'Start (9)'];

// Working copy — editing never touches the live scheme until Save.
const actions: ControlAction[] = savedActions.map((a) => ({ ...a }));
let listening: ControlAction | null = null;

function prettyKey(code: string): string {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
    const named: Record<string, string> = {
        Space: 'SPACE', Enter: 'ENTER', Escape: 'ESC', Tab: 'TAB', Backspace: 'BKSP',
        ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
        AltLeft: 'L-ALT', AltRight: 'R-ALT', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
        BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
    };
    return named[code] ?? code.toUpperCase();
}

function setStatus(message: string, isError = false): void {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
}

function conflicts(): string[] {
    const problems: string[] = [];
    const seenKeys = new Map<string, string>();
    const seenPads = new Map<number, string>();
    const seenNames = new Set<string>();
    for (const action of actions) {
        if (!action.name.trim()) problems.push('an action has no name');
        else if (seenNames.has(action.name)) problems.push(`duplicate name "${action.name}"`);
        seenNames.add(action.name);
        if (MOVE_KEYS.has(action.key)) problems.push(`"${action.name}" uses a movement key (${prettyKey(action.key)})`);
        const keyOwner = seenKeys.get(action.key);
        if (keyOwner) problems.push(`"${keyOwner}" and "${action.name}" share ${prettyKey(action.key)}`);
        seenKeys.set(action.key, action.name);
        const padOwner = seenPads.get(action.gamepadButton);
        if (padOwner) problems.push(`"${padOwner}" and "${action.name}" share pad ${PAD_BUTTONS[action.gamepadButton] ?? action.gamepadButton}`);
        seenPads.set(action.gamepadButton, action.name);
    }
    return problems;
}

function refreshConflicts(): void {
    const problems = conflicts();
    conflictEl.textContent = problems.join(' · ');
    saveBtn.disabled = problems.length > 0;
}

function render(): void {
    actionListEl.replaceChildren();

    for (const action of actions) {
        const row = document.createElement('div');
        row.className = 'action-row';

        const keyCap = document.createElement('span');
        keyCap.className = 'key';
        keyCap.dataset.code = action.key;
        keyCap.textContent = prettyKey(action.key);
        keyCap.title = 'Click, then press the key you want';
        keyCap.addEventListener('click', () => {
            listening = listening === action ? null : action;
            render();
        });
        if (listening === action) {
            keyCap.classList.add('listening');
            keyCap.textContent = '. . .';
        }
        if (MOVE_KEYS.has(action.key) || actions.some((other) => other !== action && other.key === action.key)) {
            keyCap.classList.add('conflict');
        }

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = action.name;
        nameInput.spellcheck = false;
        nameInput.addEventListener('input', () => {
            action.name = nameInput.value.trim();
            refreshConflicts();
        });

        const padSelect = document.createElement('select');
        for (const [index, label] of PAD_BUTTONS.entries()) {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = label;
            padSelect.appendChild(option);
        }
        padSelect.value = String(action.gamepadButton);
        padSelect.addEventListener('change', () => {
            action.gamepadButton = Number(padSelect.value);
            refreshConflicts();
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '×';
        removeBtn.title = `Remove ${action.name}`;
        removeBtn.addEventListener('click', () => {
            actions.splice(actions.indexOf(action), 1);
            if (listening === action) listening = null;
            render();
        });

        row.append(keyCap, nameInput, padSelect, removeBtn);
        actionListEl.appendChild(row);
    }

    addBtn.disabled = actions.length >= MAX_ACTIONS;
    refreshConflicts();
}

// Key capture for rebinding, and live held-key highlighting for every keycap
// on the page (movement cluster included) so the layout doubles as a tester.
window.addEventListener(
    'keydown',
    (event) => {
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT') return;
        if (listening) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.code !== 'Escape') listening.key = event.code;
            listening = null;
            render();
            return;
        }
        for (const el of document.querySelectorAll<HTMLElement>(`.key[data-code="${event.code}"]`)) el.classList.add('held');
    },
    { capture: true },
);
window.addEventListener('keyup', (event) => {
    for (const el of document.querySelectorAll<HTMLElement>(`.key[data-code="${event.code}"]`)) el.classList.remove('held');
});

addBtn.addEventListener('click', () => {
    if (actions.length >= MAX_ACTIONS) return;
    let n = actions.length + 1;
    while (actions.some((a) => a.name === `action${n}`)) n++;
    const freeKeys = ['KeyZ', 'KeyX', 'KeyC', 'KeyV'].filter((k) => !actions.some((a) => a.key === k));
    const freePads = [0, 1, 2, 3].filter((p) => !actions.some((a) => a.gamepadButton === p));
    actions.push({ name: `action${n}`, key: freeKeys[0] ?? 'KeyC', gamepadButton: freePads[0] ?? actions.length });
    render();
});

function generateControlsModule(list: ControlAction[]): string {
    const lines = list.map((a) => `    { name: ${JSON.stringify(a.name)}, key: ${JSON.stringify(a.key)}, gamepadButton: ${a.gamepadButton} },`);
    return [
        `// GENERATED by the Controls editor (/editor_controls.html) — Save regenerates`,
        `// this file via the editor-save middleware. Movement is always WASD/arrows +`,
        `// gamepad stick/d-pad and is not configurable here; these are the game's named`,
        `// action buttons (4 max, PICO-8 style). Action names are typed: renaming one`,
        `// here turns every stale pressed('...')/held('...') into a compile error.`,
        `import { type ControlAction, held as heldAction, move, pressed as pressedAction, setActions } from './lib/input';`,
        ``,
        `export const MAX_ACTIONS = ${MAX_ACTIONS};`,
        ``,
        `export const actions = [`,
        ...lines,
        `] as const satisfies readonly ControlAction[];`,
        ``,
        `setActions(actions);`,
        ``,
        `export type ActionName = (typeof actions)[number]['name'];`,
        ``,
        `export const held = (name: ActionName): boolean => heldAction(name);`,
        `export const pressed = (name: ActionName): boolean => pressedAction(name);`,
        `export { move };`,
        ``,
    ].join('\n');
}

saveBtn.addEventListener('click', () => {
    void (async () => {
        setStatus('Saving…');
        try {
            const response = await fetch('/__editor/save-controls', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: generateControlsModule(actions) }),
            });
            const result = (await response.json()) as { ok?: boolean; error?: string };
            if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
            // Saving rewrites src/controls.ts, which this page imports, so vite
            // reloads us and would wipe the message — hand it across the reload.
            const message = `Saved src/controls.ts (${actions.length} actions).`;
            sessionStorage.setItem(SAVED_MESSAGE_KEY, message);
            setStatus(message);
        } catch (error) {
            setStatus(`Save failed: ${error instanceof Error ? error.message : error}`, true);
        }
    })();
});

render();

const savedMessage = sessionStorage.getItem(SAVED_MESSAGE_KEY);
if (savedMessage) {
    sessionStorage.removeItem(SAVED_MESSAGE_KEY);
    setStatus(savedMessage);
}
