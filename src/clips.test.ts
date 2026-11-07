import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnimationClip, Group, Object3D, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import { ModelClips, unknownClipReason } from './clips.js';
import { parseModel } from './models.js';
import type { Scene3dIssue } from './scene.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const PATH = '$.app.children.chair';

/** A parsed model as `parseModel` gives it: a part named `box` and two clips, `slide` (x 0 to 2) and `lift` (y 0 to 2), 1 s each */
function animatedModel(): { model: Group; part: Object3D } {
    const model = new Group();
    const part = new Object3D();
    part.name = 'box';
    model.add(part);
    model.userData.animations = [
        new AnimationClip('slide', 1, [new VectorKeyframeTrack('box.position', [0, 1], [0, 0, 0, 2, 0, 0])]),
        new AnimationClip('lift', 1, [new VectorKeyframeTrack('box.position', [0, 1], [0, 0, 0, 0, 2, 0])])
    ];
    return { model, part };
}

const chair = (properties: Record<string, JsonValue>): Scene3dTree => ({ kind: 'model', key: 'chair', path: PATH, properties, children: [] });

function clipsWith(): { clips: ModelClips; issues: Scene3dIssue[] } {
    const issues: Scene3dIssue[] = [];
    return { clips: new ModelClips({ onIssue: (issue) => issues.push(issue) }), issues };
}

describe('ModelClips', () => {
    it('should play the named clip while playing is true, moving only when advanced', () => {
        // Arrange
        const { clips, issues } = clipsWith();
        const { model, part } = animatedModel();
        clips.follow([chair({ animation: 'slide', playing: true })]);

        // Act
        clips.attach(PATH, model);
        const playing = clips.playing;
        const atStart = part.position.x;
        clips.advance(0.5);

        // Assert
        expect(playing).toBe(1);
        expect(atStart).toBe(0);
        expect(part.position.x).toBeCloseTo(1);
        expect(issues).toEqual([]);
    });

    it('should pause where the clip is on playing false, and play on from there', () => {
        // Arrange
        const { clips } = clipsWith();
        const { model, part } = animatedModel();
        clips.attach(PATH, model);
        clips.follow([chair({ animation: 'slide', playing: true })]);
        clips.advance(0.25);

        // Act
        clips.follow([chair({ animation: 'slide', playing: false })]);
        const stillPlaying = clips.advance(0.5);
        const paused = part.position.x;
        clips.follow([chair({ animation: 'slide', playing: true })]);
        clips.advance(0.25);

        // Assert
        expect(stillPlaying).toBe(false);
        expect(clips.playing).toBe(1);
        expect(paused).toBeCloseTo(0.5);
        expect(part.position.x).toBeCloseTo(1);
    });

    it('should play the first clip when animation is unset, and nothing while playing is unset', () => {
        // Arrange
        const { clips } = clipsWith();
        const { model, part } = animatedModel();
        clips.attach(PATH, model);

        // Act
        clips.follow([chair({})]);
        const idle = clips.playing;
        clips.follow([chair({ playing: true })]);
        clips.advance(0.5);

        // Assert
        expect(idle).toBe(0);
        expect(part.position.x).toBeCloseTo(1);
        expect(part.position.y).toBe(0);
    });

    it('should report an unknown clip once with the names of the file clips, and play nothing', () => {
        // Arrange
        const { clips, issues } = clipsWith();
        const { model } = animatedModel();
        clips.attach(PATH, model);

        // Act
        clips.follow([chair({ animation: 'walk', playing: true })]);
        clips.follow([chair({ animation: 'walk', playing: false })]);
        clips.follow([chair({ animation: 'walk', playing: true })]);

        // Assert
        expect(clips.playing).toBe(0);
        expect(issues).toEqual([{ kind: 'model', path: PATH, node: 'model', reason: 'unknown_clip: the file has no clip "walk"; its clips are "slide", "lift"' }]);
    });

    it('should name a file with no clips in the reason', () => {
        // Act
        const reason = unknownClipReason('walk', []);

        // Assert
        expect(reason).toBe('unknown_clip: the file has no clip "walk"; it has no clips');
    });

    it('should switch to another clip by name, from its beginning', () => {
        // Arrange
        const { clips } = clipsWith();
        const { model, part } = animatedModel();
        clips.attach(PATH, model);
        clips.follow([chair({ animation: 'slide', playing: true })]);
        clips.advance(0.5);

        // Act
        clips.follow([chair({ animation: 'lift', playing: true })]);
        clips.advance(0.25);

        // Assert
        expect(part.position.x).toBeCloseTo(0);
        expect(part.position.y).toBeCloseTo(0.5);
    });

    it('should show the first frame, still, with reduced motion, and play from it when reduced motion is turned off', () => {
        // Arrange
        const { clips } = clipsWith();
        const { model, part } = animatedModel();
        clips.attach(PATH, model);
        clips.follow([chair({ animation: 'slide', playing: true })]);
        clips.advance(0.5);

        // Act
        clips.setReduced(true);
        const reduced = { playing: clips.playing, x: part.position.x, time: clips.timeOf(PATH) };
        clips.advance(0.5);
        const afterAdvance = part.position.x;
        clips.setReduced(false);
        clips.advance(0.25);

        // Assert
        expect(reduced).toEqual({ playing: 0, x: 0, time: 0 });
        expect(afterAdvance).toBe(0);
        expect(clips.playing).toBe(1);
        expect(part.position.x).toBeCloseTo(0.5);
    });

    it('should show the first frame of a clip that is not playing yet with reduced motion', () => {
        // Arrange
        const { clips } = clipsWith();
        const { model, part } = animatedModel();
        part.position.set(9, 9, 9);
        clips.setReduced(true);
        clips.follow([chair({ animation: 'slide', playing: true })]);

        // Act
        clips.attach(PATH, model);

        // Assert
        expect(clips.playing).toBe(0);
        expect(part.position.toArray()).toEqual([0, 0, 0]);
    });

    it('should play a clip of the fixture box-clips.glb as parsed from its bytes', async () => {
        // Arrange
        const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'box-clips.glb'))).buffer;
        const model = await parseModel(bytes);
        const { clips } = clipsWith();
        clips.follow([chair({ animation: 'lift', playing: true })]);

        // Act
        clips.attach(PATH, model);
        clips.advance(0.5);

        // Assert
        expect((model.userData.animations as AnimationClip[]).map((clip) => clip.name)).toEqual(['slide', 'lift']);
        expect(model.getObjectByName('box')?.position.toArray()).toEqual([0, 0.5, 0]);
    });

    it('should not play a hidden model, and stop and forget a model that is freed', () => {
        // Arrange
        const { clips } = clipsWith();
        const { model } = animatedModel();
        clips.attach(PATH, model);

        // Act
        clips.follow([chair({ animation: 'slide', playing: true, visible: false })]);
        const hidden = clips.playing;
        clips.follow([chair({ animation: 'slide', playing: true })]);
        const shown = clips.playing;
        clips.attach(PATH, undefined);

        // Assert
        expect(hidden).toBe(0);
        expect(shown).toBe(1);
        expect(clips.playing).toBe(0);
        expect(clips.timeOf(PATH)).toBeUndefined();
    });
});
