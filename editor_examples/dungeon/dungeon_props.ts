// Per-prop behaviour: simple procedural animation + collection triggers.
//
// Keyed by PART NAME (the mesh node name inside src/assets/dungeon/props.txt),
// so adding a prop here is a one-line edit. Parts with no entry render static
// and aren't collectible.
//
// Deliberately NOT picoCAD2 clip playback (that's the main game's heavier
// native-animation system) — these are cheap procedural transforms evaluated
// per frame from the clock, which is all a spinning coin / bobbing crate needs.

export type PropBehavior = {
    /** Full turns per second around Y. Omit/0 = no spin. */
    spin?: number;
    /** Peak hover height in tiles. The bob rides 0..bobHeight so it never sinks
     *  through the floor. Omit/0 = no bob. */
    bobHeight?: number;
    /** Bob cycles per second (default 1). */
    bobSpeed?: number;
    /** Walking over it collects it: hides the prop and bumps the counter. */
    collect?: boolean;
};

export const DUNGEON_PROP_BEHAVIORS: Record<string, PropBehavior> = {
    coin: { spin: 0.9, collect: true },
    gem: { spin: 0.6, bobHeight: 0.14, bobSpeed: 1.1, collect: true },
    crate: { bobHeight: 0.08, bobSpeed: 0.7 },
};

const NO_BEHAVIOR: PropBehavior = {};

/** Behaviour for a prop part name (static + non-collectible if unlisted). */
export function propBehavior(name: string | undefined): PropBehavior {
    return (name ? DUNGEON_PROP_BEHAVIORS[name] : undefined) ?? NO_BEHAVIOR;
}

/** Does this prop animate at all (worth re-computing its matrix each frame)? */
export function propAnimates(b: PropBehavior): boolean {
    return !!b.spin || !!b.bobHeight;
}
