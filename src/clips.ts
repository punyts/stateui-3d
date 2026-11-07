import { AnimationMixer } from 'three';
import type { AnimationAction, AnimationClip, Object3D } from 'three';
import type { Scene3dIssue } from './scene.js';
import type { JsonValue, Scene3dTree } from './tree.js';

/**
 * The animation clips of `model` nodes (G3.9b of the graphics epic 3): a GLB's own clips (`userData.animations` of the
 * parsed model, `models.ts`) played with one three.js `AnimationMixer` per model. The scene advances the mixers in the
 * frames of its scheduler only while a clip plays (`advance`), so a model whose clip is paused, or that has none, asks
 * for no frame. Nothing is written to the store
 */

/** What a `model` node asks of its clip: the clip's name (unset or empty: the file's first clip) and whether it plays */
interface ClipWish {
    readonly name: string | undefined;
    readonly playing: boolean;
}

/** A drawn model and its mixer */
interface ModelEntry {
    readonly root: Object3D;
    readonly clips: readonly AnimationClip[];
    readonly mixer: AnimationMixer;
    action: AnimationAction | undefined;
    /** The clip name last reported as unknown for this model, so a report is made once per name */
    reported: string | undefined;
}

/** What the clips need of their scene */
export interface ModelClipsHooks {
    /** Told an unknown clip name (`model`, so the feeder's `SUI-RUN-3D`), naming the clips the file has */
    readonly onIssue?: (issue: Scene3dIssue) => void;
}

/** The reason an unknown clip is told with: the name asked for and the names the file has */
export function unknownClipReason(name: string, clips: readonly AnimationClip[]): string {
    const names = clips.map((clip) => JSON.stringify(clip.name));
    return `unknown_clip: the file has no clip "${name}"; ${names.length === 0 ? 'it has no clips' : `its clips are ${names.join(', ')}`}`;
}

const wishOf = (node: Scene3dTree): ClipWish => {
    const { animation, playing, hidden, visible } = node.properties as Readonly<Record<string, JsonValue | undefined>>;
    return {
        name: typeof animation === 'string' && animation !== '' ? animation : undefined,
        // A hidden model asks for no frame: its clip pauses where it is
        playing: playing === true && hidden !== true && visible !== false
    };
};

/**
 * The clips of a scene's models, by the model node's path. A model's `animation` names its clip (unset or empty: the
 * file's first clip, so a file with one clip needs no name); while `playing` is true the clip loops, and `playing:
 * false` pauses it where it is. A name the file does not have is told once (`unknownClipReason`) and nothing plays.
 * While motion is reduced no clip plays and each clip shows its first frame; turning it off plays them from there
 */
export class ModelClips {
    private readonly models = new Map<string, ModelEntry>();
    private wishes = new Map<string, ClipWish>();
    private reduced = false;

    constructor(private readonly hooks: ModelClipsHooks = {}) {}

    /** The number of clips playing: the scene asks for frames while it is more than 0 */
    get playing(): number {
        let count = 0;
        for (const entry of this.models.values()) if (entry.action !== undefined && !entry.action.paused) count += 1;
        return count;
    }

    /** The time in seconds of the clip of the model at this path, or undefined when it has none */
    timeOf(path: string): number | undefined {
        return this.models.get(path)?.action?.time;
    }

    /** A model was drawn at this path (`model` its parsed object, with its clips), or was freed (`undefined`) */
    attach(path: string, model: Object3D | undefined): void {
        this.detach(path);
        if (model === undefined) return;
        const clips = Array.isArray(model.userData.animations) ? (model.userData.animations as AnimationClip[]) : [];
        const entry: ModelEntry = { root: model, clips, mixer: new AnimationMixer(model), action: undefined, reported: undefined };
        this.models.set(path, entry);
        this.refresh(path, entry);
    }

    /** Takes the tree of an update: each model's `animation` and `playing` */
    follow(tree: readonly Scene3dTree[]): void {
        const wishes = new Map<string, ClipWish>();
        const collect = (nodes: readonly Scene3dTree[]): void => {
            for (const node of nodes) {
                if (node.kind === 'model') wishes.set(node.path, wishOf(node));
                if (node.kind !== 'repeat3d') collect(node.children);
            }
        };
        collect(tree);
        const before = this.wishes;
        this.wishes = wishes;
        for (const [path, entry] of this.models) {
            const was = before.get(path);
            const now = wishes.get(path);
            if (was?.name !== now?.name || was?.playing !== now?.playing) this.refresh(path, entry);
        }
    }

    /** Turns reduced motion on (every clip pauses at its first frame) or off (the playing ones play from there) */
    setReduced(reduced: boolean): void {
        if (reduced === this.reduced) return;
        this.reduced = reduced;
        for (const [path, entry] of this.models) this.refresh(path, entry);
    }

    /** Moves every playing clip on by `seconds` (a frame of the scene's scheduler); true while one still plays */
    advance(seconds: number): boolean {
        for (const entry of this.models.values()) {
            if (entry.action !== undefined && !entry.action.paused) entry.mixer.update(seconds);
        }
        return this.playing > 0;
    }

    /** Stops every clip and forgets the models */
    dispose(): void {
        for (const path of [...this.models.keys()]) this.detach(path);
        this.wishes = new Map();
    }

    /** Stops a model's clip and frees its mixer's cached bindings (the model's pose goes back to how it was loaded) */
    private detach(path: string): void {
        const entry = this.models.get(path);
        if (entry === undefined) return;
        this.models.delete(path);
        entry.mixer.stopAllAction();
        entry.mixer.uncacheRoot(entry.root);
    }

    /** Brings a model's action in line with its node's wish and reduced motion */
    private refresh(path: string, entry: ModelEntry): void {
        const wish = this.wishes.get(path) ?? { name: undefined, playing: false };
        const clip = wish.name === undefined ? entry.clips[0] : entry.clips.find((candidate) => candidate.name === wish.name);
        if (wish.name !== undefined && clip === undefined) {
            this.stop(entry);
            if (entry.reported !== wish.name) {
                entry.reported = wish.name;
                this.hooks.onIssue?.({ kind: 'model', path, reason: unknownClipReason(wish.name, entry.clips), node: 'model' });
            }
            return;
        }
        entry.reported = undefined;
        if (clip === undefined || (entry.action?.getClip() !== clip && !wish.playing && !this.reduced)) {
            // No clip, or another clip named while not playing: the model shows its pose as loaded until it plays
            this.stop(entry);
            return;
        }
        if (entry.action?.getClip() !== clip) {
            this.stop(entry);
            entry.action = entry.mixer.clipAction(clip);
            entry.action.play();
        }
        const action = entry.action!;
        if (this.reduced) {
            // Reduced motion: the clip's first frame, still
            action.time = 0;
            action.paused = true;
        } else action.paused = !wish.playing;
        // Puts the pose at the action's time on the model (no time passes)
        entry.mixer.update(0);
    }

    private stop(entry: ModelEntry): void {
        if (entry.action === undefined) return;
        entry.action.stop();
        entry.mixer.uncacheAction(entry.action.getClip(), entry.root);
        entry.action = undefined;
    }
}
