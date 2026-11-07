import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT, DEFAULT_FOG_FAR, DEFAULT_FOG_NEAR, ENVIRONMENT_NAMES, ENVIRONMENT_PRESETS, environmentPreset, fogParams, isEnvironmentName } from './environment.js';

describe('environment presets', () => {
    it('should be the values of the scene3d shape, with studio as the default', () => {
        // Assert
        expect(ENVIRONMENT_NAMES).toEqual(['none', 'studio', 'daylight', 'neutral']);
        expect(DEFAULT_ENVIRONMENT).toBe('studio');
        expect(Object.keys(ENVIRONMENT_PRESETS)).toEqual([...ENVIRONMENT_NAMES]);
        expect(isEnvironmentName('daylight')).toBe(true);
        expect(isEnvironmentName('sunset')).toBe(false);
        expect(isEnvironmentName(1)).toBe(false);
    });

    it('should give none no light and no background', () => {
        // Assert
        expect(ENVIRONMENT_PRESETS.none).toEqual({ lights: [] });
    });

    it('should give studio an ambient light of the scene ambient colour at 0.4, a key light and a rim light', () => {
        // Assert
        expect(ENVIRONMENT_PRESETS.studio).toEqual({
            background: '#e9ebee',
            lights: [
                { kind: 'ambient', color: '#ffffff', sceneAmbient: true, intensity: 0.4 },
                { kind: 'directional', color: '#ffffff', intensity: 0.8, position: [3, 5, 8] },
                { kind: 'directional', color: '#ffffff', intensity: 0.3, position: [-5, 3, -8] }
            ]
        });
    });

    it('should give daylight a sky and ground light and a warm sun from high up', () => {
        // Assert
        expect(ENVIRONMENT_PRESETS.daylight).toEqual({
            background: '#cfe6ff',
            lights: [
                { kind: 'hemisphere', color: '#cfe6ff', groundColor: '#6b5a45', intensity: 0.9 },
                { kind: 'directional', color: '#fff1d6', intensity: 1.2, position: [4, 12, 6] }
            ]
        });
    });

    it('should give neutral one even white ambient light', () => {
        // Assert
        expect(ENVIRONMENT_PRESETS.neutral).toEqual({ background: '#808080', lights: [{ kind: 'ambient', color: '#ffffff', intensity: 0.5 }] });
    });

    it('should take the default preset for an unset value or one that names no preset', () => {
        // Act and assert
        expect(environmentPreset('daylight').name).toBe('daylight');
        expect(environmentPreset('none').preset).toBe(ENVIRONMENT_PRESETS.none);
        expect(environmentPreset(undefined).name).toBe('studio');
        expect(environmentPreset(null).name).toBe('studio');
        expect(environmentPreset('sunset').name).toBe('studio');
    });

    it('should be frozen, so no caller changes a preset', () => {
        // Assert
        expect(Object.isFrozen(ENVIRONMENT_PRESETS)).toBe(true);
    });
});

describe('fogParams', () => {
    it('should be no fog unless the value is an object', () => {
        // Act and assert
        expect(fogParams(undefined)).toBeUndefined();
        expect(fogParams(null)).toBeUndefined();
        expect(fogParams('#ffffff')).toBeUndefined();
        expect(fogParams([1, 2])).toBeUndefined();
    });

    it('should keep the colour value and the distances', () => {
        // Act and assert
        expect(fogParams({ color: '{color.surface.base}', near: 2, far: 20 })).toEqual({ color: '{color.surface.base}', near: 2, far: 20 });
    });

    it('should default near and far, take the background for no colour, and keep far beyond near', () => {
        // Act and assert
        expect(fogParams({})).toEqual({ color: undefined, near: DEFAULT_FOG_NEAR, far: DEFAULT_FOG_FAR });
        expect(fogParams({ color: '', near: -1, far: 'x' })).toEqual({ color: undefined, near: 1, far: 100 });
        expect(fogParams({ near: 50, far: 10 })).toEqual({ color: undefined, near: 50, far: 51 });
        expect(fogParams({ near: 5, far: 5 })?.far).toBe(6);
    });
});
