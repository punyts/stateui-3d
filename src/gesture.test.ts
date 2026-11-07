import { describe, expect, it } from 'vitest';
import { CameraGestures, WHEEL_IDLE } from './gesture.js';
import type { CameraGestureHooks, ControlsEventType, GestureClock } from './gesture.js';

/** Controls that start, change and end when the test says, as `OrbitControls` does */
class FakeControls {
    private readonly listeners = new Map<ControlsEventType, Set<() => void>>();

    addEventListener(type: ControlsEventType, listener: () => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    removeEventListener(type: ControlsEventType, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    emit(type: ControlsEventType): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
    }

    count(): number {
        return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    }
}

/** A clock whose time moves only when the test advances it */
class FakeClock implements GestureClock {
    now = 0;
    private next = 1;
    private readonly timers = new Map<number, { at: number; handler: () => void }>();

    setTimeout(handler: () => void, ms: number): unknown {
        const id = this.next++;
        this.timers.set(id, { at: this.now + ms, handler });
        return id;
    }

    clearTimeout(timer: unknown): void {
        this.timers.delete(timer as number);
    }

    advance(ms: number): void {
        const until = this.now + ms;
        for (;;) {
            const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (due === undefined) break;
            this.timers.delete(due[0]);
            this.now = due[1].at;
            due[1].handler();
        }
        this.now = until;
    }

    get pending(): number {
        return this.timers.size;
    }
}

/** The gesture under test with fake controls and a fake clock, and the hooks it called in order */
function setup(): { gestures: CameraGestures; controls: FakeControls; clock: FakeClock; calls: string[]; setWheel(on: boolean): void } {
    const controls = new FakeControls();
    const clock = new FakeClock();
    const calls: string[] = [];
    let wheel = false;
    const hooks: CameraGestureHooks = {
        begin: (kind) => calls.push(`begin ${kind}`),
        change: () => calls.push('change'),
        commit: () => calls.push('commit'),
        restore: () => calls.push('restore'),
        release: () => calls.push('release')
    };
    const gestures = new CameraGestures(controls, hooks, clock, () => (wheel ? 'wheel' : 'pointer'));
    return { gestures, controls, clock, calls, setWheel: (on) => (wheel = on) };
}

/** One turn of the wheel: the controls start, change and end at once, as `OrbitControls` does for a wheel event */
function turnWheel(controls: FakeControls): void {
    controls.emit('start');
    controls.emit('change');
    controls.emit('end');
}

describe('CameraGestures (G3.8b): when the camera is written', () => {
    it('should commit once when a pointer gesture ends, with every change before it', () => {
        // Arrange
        const { controls, calls, gestures } = setup();

        // Act
        controls.emit('start');
        controls.emit('change');
        controls.emit('change');
        const during = gestures.active;
        controls.emit('end');

        // Assert
        expect(during).toBe('pointer');
        expect(calls).toEqual(['begin pointer', 'change', 'change', 'commit']);
        expect(gestures.active).toBeUndefined();
    });

    it('should commit a wheel gesture once, WHEEL_IDLE ms after the last turn, however many turns came before', () => {
        // Arrange
        const { controls, clock, calls, setWheel } = setup();
        setWheel(true);

        // Act
        turnWheel(controls);
        clock.advance(WHEEL_IDLE - 50);
        turnWheel(controls);
        clock.advance(WHEEL_IDLE - 50);
        turnWheel(controls);
        clock.advance(WHEEL_IDLE - 1);
        const beforeIdle = [...calls];
        clock.advance(1);

        // Assert
        expect(WHEEL_IDLE).toBe(200);
        expect(beforeIdle).toEqual(['begin wheel', 'change', 'change', 'change']);
        expect(calls).toEqual(['begin wheel', 'change', 'change', 'change', 'commit']);
        expect(clock.pending).toBe(0);
    });

    it('should commit a waiting wheel gesture before a pointer gesture starts', () => {
        // Arrange
        const { controls, clock, calls, setWheel } = setup();
        setWheel(true);
        turnWheel(controls);

        // Act
        setWheel(false);
        controls.emit('start');
        clock.advance(WHEEL_IDLE * 2);
        controls.emit('end');

        // Assert
        expect(calls).toEqual(['begin wheel', 'change', 'commit', 'begin pointer', 'commit']);
    });

    it('should commit a key gesture when the last of its keys is released, a step per key press before it', () => {
        // Arrange
        const { gestures, calls } = setup();

        // Act: ArrowLeft pressed twice (a repeat), Equal pressed with it, then both released
        const accepted = [gestures.keyDown('ArrowLeft'), gestures.keyDown('ArrowLeft'), gestures.keyDown('Equal')];
        gestures.keyUp('ArrowLeft');
        const afterFirstUp = [...calls];
        gestures.keyUp('Equal');

        // Assert
        expect(accepted).toEqual([true, true, true]);
        expect(afterFirstUp).toEqual(['begin key']);
        expect(calls).toEqual(['begin key', 'commit']);
    });

    it('should ignore keys during a pointer gesture', () => {
        // Arrange
        const { gestures, controls, calls } = setup();
        controls.emit('start');

        // Act
        const accepted = gestures.keyDown('ArrowLeft');
        gestures.keyUp('ArrowLeft');
        controls.emit('end');

        // Assert
        expect(accepted).toBe(false);
        expect(calls).toEqual(['begin pointer', 'commit']);
    });

    it('should restore on Escape during a pointer gesture and write nothing at its end', () => {
        // Arrange
        const { gestures, controls, calls } = setup();
        controls.emit('start');
        controls.emit('change');

        // Act
        const first = gestures.cancel();
        const second = gestures.cancel();
        controls.emit('end');

        // Assert
        expect([first, second]).toEqual([true, false]);
        expect(calls).toEqual(['begin pointer', 'change', 'restore']);
        expect(gestures.active).toBeUndefined();
    });

    it('should not cancel anything but a pointer gesture', () => {
        // Arrange
        const { gestures, calls } = setup();
        gestures.keyDown('ArrowUp');

        // Act
        const cancelled = gestures.cancel();
        gestures.keyUp('ArrowUp');

        // Assert
        expect(cancelled).toBe(false);
        expect(calls).toEqual(['begin key', 'commit']);
    });

    it('should apply a state change during a gesture when it ends, instead of its write', () => {
        // Arrange
        const { gestures, controls, calls } = setup();
        controls.emit('start');
        controls.emit('change');

        // Act
        gestures.stateChange();
        const during = [...calls];
        controls.emit('end');

        // Assert
        expect(during).toEqual(['begin pointer', 'change']);
        expect(calls).toEqual(['begin pointer', 'change', 'release']);
    });

    it('should apply a state change during a wheel gesture when the wheel is idle', () => {
        // Arrange
        const { gestures, controls, clock, calls, setWheel } = setup();
        setWheel(true);
        turnWheel(controls);

        // Act
        gestures.stateChange();
        clock.advance(WHEEL_IDLE);

        // Assert
        expect(calls).toEqual(['begin wheel', 'change', 'release']);
    });

    it('should apply a state change at once outside a gesture', () => {
        // Arrange
        const { gestures, calls } = setup();

        // Act
        gestures.stateChange();

        // Assert
        expect(calls).toEqual(['release']);
    });

    it('should end a wheel or key gesture on finish (the focus left), but not a pointer gesture', () => {
        // Arrange
        const { gestures, controls, calls } = setup();
        gestures.keyDown('ArrowUp');

        // Act
        gestures.finish();
        controls.emit('start');
        gestures.finish();
        const pointerActive = gestures.active;

        // Assert
        expect(calls).toEqual(['begin key', 'commit', 'begin pointer']);
        expect(pointerActive).toBe('pointer');
    });

    it('should stop listening and call no hook after dispose', () => {
        // Arrange
        const { gestures, controls, clock, calls, setWheel } = setup();
        setWheel(true);
        turnWheel(controls);

        // Act
        gestures.dispose();
        clock.advance(WHEEL_IDLE * 2);
        turnWheel(controls);
        gestures.stateChange();

        // Assert
        expect(calls).toEqual(['begin wheel', 'change']);
        expect(controls.count()).toBe(0);
        expect(clock.pending).toBe(0);
    });
});
