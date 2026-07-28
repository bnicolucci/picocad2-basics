// Keyboard + gamepad input with the PICO-8 split: movement is ALWAYS
// WASD/arrows (and the gamepad stick/d-pad) via move(); everything else is a
// small set of named action buttons defined in the generated src/controls.ts
// (edit them in /editor_controls.html). Game code reads input, it never binds
// keys.
//
// held(name) is true while the button is down; pressed(name) is true for
// exactly one update step per press (the run loop consumes presses between
// steps).

export type ControlAction = {
    name: string;
    key: string; // KeyboardEvent.code, e.g. "KeyZ", "Space"
    gamepadButton: number; // standard mapping: 0=A 1=B 2=X 3=Y ...
};

let actions: readonly ControlAction[] = [];

const down = new Set<string>();
const justPressed = new Set<string>();
const padDown = new Set<number>();
const padJustPressed = new Set<number>();
let padMove = { x: 0, z: 0 };

const MOVE_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

function isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (event) => {
        if (isEditable(event.target)) return;
        if (MOVE_KEYS.has(event.code) || actions.some((a) => a.key === event.code)) event.preventDefault();
        if (!event.repeat && !down.has(event.code)) justPressed.add(event.code);
        down.add(event.code);
    });
    window.addEventListener('keyup', (event) => {
        down.delete(event.code);
    });
    // Browsers often skip the keyup when the tab loses focus mid-hold; clearing
    // here prevents movement from getting stuck.
    window.addEventListener('blur', () => {
        down.clear();
        justPressed.clear();
    });
}

/** Called once by the generated src/controls.ts with the action list. */
export function setActions(list: readonly ControlAction[]): void {
    actions = list;
}

function findAction(name: string): ControlAction | undefined {
    return actions.find((a) => a.name === name);
}

/**
 * Ground-plane movement, -1..1 per axis, diagonals normalized. `x` is
 * left/right; `z` is up/down with W / up-arrow / stick-up = -1 (into the
 * screen for the default camera).
 */
export function move(): { x: number; z: number } {
    let x = (down.has('KeyD') || down.has('ArrowRight') ? 1 : 0) - (down.has('KeyA') || down.has('ArrowLeft') ? 1 : 0);
    let z = (down.has('KeyS') || down.has('ArrowDown') ? 1 : 0) - (down.has('KeyW') || down.has('ArrowUp') ? 1 : 0);
    x += padMove.x;
    z += padMove.z;
    const len = Math.hypot(x, z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    return { x, z };
}

/** True while the action's key or gamepad button is held. */
export function held(name: string): boolean {
    const action = findAction(name);
    return !!action && (down.has(action.key) || padDown.has(action.gamepadButton));
}

/** True for exactly one update step when the action was just pressed. */
export function pressed(name: string): boolean {
    const action = findAction(name);
    return !!action && (justPressed.has(action.key) || padJustPressed.has(action.gamepadButton));
}

/** Run-loop hook: consume the just-pressed edges after an update step. */
export function stepInput(): void {
    justPressed.clear();
    padJustPressed.clear();
}

const PAD_DEADZONE = 0.25;

/** Run-loop hook: poll the first gamepad once per frame. */
export function pollGamepad(): void {
    const pad = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads()[0] : null;
    if (!pad) {
        padMove = { x: 0, z: 0 };
        padDown.clear();
        return;
    }

    let x = Math.abs(pad.axes[0] ?? 0) > PAD_DEADZONE ? pad.axes[0] : 0;
    let z = Math.abs(pad.axes[1] ?? 0) > PAD_DEADZONE ? pad.axes[1] : 0;
    // Standard-mapping d-pad: 12=up 13=down 14=left 15=right.
    x += (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0);
    z += (pad.buttons[13]?.pressed ? 1 : 0) - (pad.buttons[12]?.pressed ? 1 : 0);
    padMove = { x, z };

    for (const action of actions) {
        const isDown = pad.buttons[action.gamepadButton]?.pressed ?? false;
        if (isDown && !padDown.has(action.gamepadButton)) padJustPressed.add(action.gamepadButton);
        if (isDown) padDown.add(action.gamepadButton);
        else padDown.delete(action.gamepadButton);
    }
}
