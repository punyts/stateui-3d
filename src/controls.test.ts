import { describe, expect, it } from 'vitest';
import { KEY_PAN_STEP, KEY_ROTATE_STEP, KEY_ZOOM_STEP, controlsMode, keyAction } from './controls.js';

describe('the controls of a scene (G3.8b)', () => {
    it('should take orbit and pan as modes and anything else as none', () => {
        // Arrange
        const values = ['orbit', 'pan', 'none', undefined, null, 'ORBIT', 3];

        // Act
        const modes = values.map(controlsMode);

        // Assert
        expect(modes).toEqual(['orbit', 'pan', 'none', 'none', 'none', 'none', 'none']);
    });

    it('should turn with the arrow keys and zoom with + and - in orbit', () => {
        // Arrange
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-'];

        // Act
        const actions = keys.map((key) => keyAction(key, 'orbit'));

        // Assert
        expect(actions).toEqual([
            { rotate: [KEY_ROTATE_STEP, 0] },
            { rotate: [-KEY_ROTATE_STEP, 0] },
            { rotate: [0, KEY_ROTATE_STEP] },
            { rotate: [0, -KEY_ROTATE_STEP] },
            { zoom: KEY_ZOOM_STEP },
            { zoom: 1 / KEY_ZOOM_STEP }
        ]);
        expect(KEY_ROTATE_STEP).toBeCloseTo(Math.PI / 12);
    });

    it('should pan with the arrow keys and not zoom in pan', () => {
        // Arrange
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-'];

        // Act
        const actions = keys.map((key) => keyAction(key, 'pan'));

        // Assert
        expect(actions).toEqual([{ pan: [KEY_PAN_STEP, 0] }, { pan: [-KEY_PAN_STEP, 0] }, { pan: [0, KEY_PAN_STEP] }, { pan: [0, -KEY_PAN_STEP] }, undefined, undefined]);
    });

    it('should do nothing for any key in none, and for other keys in any mode', () => {
        // Arrange
        const keys = ['ArrowLeft', '+', 'Enter', 'a', 'Escape'];

        // Act
        const none = keys.map((key) => keyAction(key, 'none'));
        const others = ['Enter', 'a', 'Escape', ' '].flatMap((key) => [keyAction(key, 'orbit'), keyAction(key, 'pan')]);

        // Assert
        expect(none.every((action) => action === undefined)).toBe(true);
        expect(others.every((action) => action === undefined)).toBe(true);
    });
});
