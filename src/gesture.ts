/**
 * When a camera gesture of a scene's controls starts and ends (G3.8b of the graphics epic 3). The camera moves in the
 * renderer on every frame of a gesture and is written to state once, when the gesture ends: a pointer gesture at the
 * pointer's release, a wheel gesture once the wheel has been idle for `WHEEL_IDLE`, a key gesture when the last of its
 * keys is released. This module only times the gesture: what the camera does and what is written is the hooks' (the
 * scene's controls, `controls.ts`), so it runs in Node with fake controls and a fake clock.
 */

/** How long, in milliseconds, the wheel is idle before a wheel gesture ends and the camera is written */
export const WHEEL_IDLE = 200;

/** What a camera gesture is made with: a pointer drag, the wheel, or keys */
export type GestureKind = 'pointer' | 'wheel' | 'key';

/** The timers a gesture uses (the window's, or a fake clock in a test) */
export interface GestureClock {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
}

/** The events of the controls a gesture follows (three.js's `OrbitControls`: `start`, `change` and `end`) */
export type ControlsEventType = 'start' | 'change' | 'end';

/** Controls that tell when they start, change and end moving the camera (`OrbitControls`, or fake controls in a test) */
export interface ControlsEvents {
    addEventListener(type: ControlsEventType, listener: () => void): void;
    removeEventListener(type: ControlsEventType, listener: () => void): void;
}

/** What a gesture asks of the scene */
export interface CameraGestureHooks {
    /** A gesture starts: the scene takes the camera from the tree into the controls and keeps where it was */
    begin(kind: GestureKind): void;
    /** The controls moved the camera: the scene draws a frame */
    change(): void;
    /** The gesture ended: the scene writes the camera (once, and only when it moved) */
    commit(): void;
    /** Escape during a pointer gesture: the camera goes back to where the gesture started, and nothing is written */
    restore(): void;
    /** The state's camera changed during the gesture (or after one, while the controls hold the camera): it is shown, and nothing is written */
    release(): void;
}

/**
 * Times the camera gestures of one scene's controls: one at a time. `startKind` tells whether a `start` of the controls
 * is the wheel's (the scene marks it from its own `wheel` listener, which runs before the controls'), else it is a
 * pointer's. A gesture of another kind that starts while one is under way ends that one first (a wheel still waiting
 * for its idle time is written before a drag starts), except that keys are ignored during a pointer gesture.
 *
 * A change of the state's camera during a gesture is applied when the gesture ends (`release`), and the gesture then
 * writes nothing: the state wins over a view no one has written yet. Outside a gesture it is applied at once
 */
export class CameraGestures {
    private kind: GestureKind | undefined;
    /** True after Escape: the camera is back where the pointer gesture started, and its end writes nothing */
    private cancelled = false;
    /** True when the state's camera changed during the gesture */
    private stateChanged = false;
    private timer: unknown;
    private readonly keys = new Set<string>();
    private disposed = false;

    constructor(
        private readonly controls: ControlsEvents,
        private readonly hooks: CameraGestureHooks,
        private readonly clock: GestureClock,
        private readonly startKind: () => 'pointer' | 'wheel'
    ) {
        controls.addEventListener('start', this.onStart);
        controls.addEventListener('change', this.onChange);
        controls.addEventListener('end', this.onEnd);
    }

    /** The kind of the gesture under way, or undefined */
    get active(): GestureKind | undefined {
        return this.kind;
    }

    /**
     * A key that moves the camera went down (`code` names the physical key, so its release is known whatever the
     * modifiers): it starts a key gesture, or joins the one under way. False during a pointer gesture, when the key is
     * ignored; the scene moves the camera by the key's step only when this is true
     */
    keyDown(code: string): boolean {
        if (this.disposed || this.kind === 'pointer') return false;
        if (this.kind === 'wheel') this.end();
        if (this.kind === undefined) this.begin('key');
        this.keys.add(code);
        return true;
    }

    /** A key went up: the key gesture ends when it was the last of its keys held */
    keyUp(code: string): void {
        if (this.kind !== 'key' || !this.keys.delete(code) || this.keys.size > 0) return;
        this.end();
    }

    /** Escape: cancels a pointer gesture (the camera goes back, nothing is written); true when there was one to cancel */
    cancel(): boolean {
        if (this.kind !== 'pointer' || this.cancelled) return false;
        this.cancelled = true;
        this.hooks.restore();
        return true;
    }

    /** The state's camera changed: applied at once, or when the gesture under way ends */
    stateChange(): void {
        if (this.disposed) return;
        if (this.kind === undefined) this.hooks.release();
        else this.stateChanged = true;
    }

    /** Ends a wheel or key gesture now (the scene lost the focus, so a key's release may never come); a pointer gesture goes on */
    finish(): void {
        if (this.kind === 'wheel' || this.kind === 'key') this.end();
    }

    /** Stops following the controls; a gesture under way ends with no hook called */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.clearTimer();
        this.kind = undefined;
        this.keys.clear();
        this.controls.removeEventListener('start', this.onStart);
        this.controls.removeEventListener('change', this.onChange);
        this.controls.removeEventListener('end', this.onEnd);
    }

    private readonly onStart = (): void => {
        if (this.disposed) return;
        const kind = this.startKind();
        if (this.kind === 'wheel' && kind === 'wheel') {
            // The wheel turned again before it was idle: the same gesture
            this.clearTimer();
            return;
        }
        if (this.kind !== undefined) this.end();
        this.begin(kind);
    };

    private readonly onChange = (): void => {
        if (!this.disposed) this.hooks.change();
    };

    private readonly onEnd = (): void => {
        if (this.kind === 'wheel') {
            this.clearTimer();
            this.timer = this.clock.setTimeout(() => {
                this.timer = undefined;
                if (this.kind === 'wheel') this.end();
            }, WHEEL_IDLE);
        } else if (this.kind === 'pointer') {
            this.end();
        }
    };

    private begin(kind: GestureKind): void {
        this.kind = kind;
        this.cancelled = false;
        this.stateChanged = false;
        this.hooks.begin(kind);
    }

    /** Ends the gesture under way: the state's camera when it changed, else the gesture's write unless it was cancelled */
    private end(): void {
        const { stateChanged, cancelled } = this;
        this.kind = undefined;
        this.cancelled = false;
        this.stateChanged = false;
        this.keys.clear();
        this.clearTimer();
        if (stateChanged) this.hooks.release();
        else if (!cancelled) this.hooks.commit();
    }

    private clearTimer(): void {
        if (this.timer === undefined) return;
        this.clock.clearTimeout(this.timer);
        this.timer = undefined;
    }
}
