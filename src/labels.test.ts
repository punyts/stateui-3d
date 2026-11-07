import { Box3, Group, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LABEL_COLOR,
    DEFAULT_LABEL_FONT_SIZE,
    LABEL_FONT_PX,
    LABEL_LINE_HEIGHT,
    LABEL_MAX_CHARS,
    LABEL_MAX_WIDTH,
    Labels,
    MAX_LABEL_FONT_SIZE,
    labelCanvasSize,
    labelFont,
    labelFontSize,
    labelText
} from './labels.js';
import { createColorConverter } from './materials.js';
import { SceneGraph } from './scene.js';
import type { JsonValue, Scene3dTree } from './tree.js';

const PATH = '$.app.children.tag';

/** What a fake 2D context was asked to draw */
interface Drawn {
    font: string;
    fillStyle: string;
    texts: string[];
}

/**
 * A document whose canvases have a fake 2D context: each character measures 10 texels, and `fillText` is recorded
 * (Node has no canvas). `fillStyle` keeps its value for anything that is not `#rgb`/`#rrggbb` or a name, as a real one
 */
function fakeDocument(): { doc: Document; canvases: { width: number; height: number; drawn: Drawn }[] } {
    const canvases: { width: number; height: number; drawn: Drawn }[] = [];
    const doc = {
        createElement: (name: string) => {
            if (name !== 'canvas') throw new Error(`unexpected element ${name}`);
            const drawn: Drawn = { font: '', fillStyle: '#000000', texts: [] };
            const canvas = {
                width: 300,
                height: 150,
                drawn,
                getContext: () => ({
                    set font(value: string) {
                        drawn.font = value;
                    },
                    get font() {
                        return drawn.font;
                    },
                    set fillStyle(value: string) {
                        if (/^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i.test(value)) drawn.fillStyle = value;
                    },
                    get fillStyle() {
                        return drawn.fillStyle;
                    },
                    textAlign: 'start',
                    textBaseline: 'alphabetic',
                    measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
                    fillText: (text: string) => drawn.texts.push(text)
                })
            };
            canvases.push(canvas);
            return canvas;
        }
    } as unknown as Document;
    return { doc, canvases };
}

const literal = (value: JsonValue): string | undefined => (typeof value === 'string' && !value.startsWith('{') ? value : undefined);

describe('labelText (G3.6b)', () => {
    it('should take a string, with its line breaks and tabs as spaces', () => {
        // Act / Assert
        expect(labelText('Price: 12 EUR')).toBe('Price: 12 EUR');
        expect(labelText('two\nlines\tand\r\na tab')).toBe('two lines and a tab');
    });

    it('should give no text for an empty or blank string and for anything that is not a string', () => {
        // Act / Assert
        for (const value of [undefined, null, '', '   ', '\n', 5, true, ['a'], { text: 'a' }] as (JsonValue | undefined)[]) expect(labelText(value)).toBe('');
    });

    it('should cut a very long text at LABEL_MAX_CHARS characters, not code units', () => {
        // Act
        const text = labelText('\u{1F600}'.repeat(LABEL_MAX_CHARS + 10));

        // Assert
        expect(Array.from(text)).toHaveLength(LABEL_MAX_CHARS);
    });
});

describe('labelFontSize and labelCanvasSize (G3.6b)', () => {
    it('should take a positive size up to the maximum, else the default', () => {
        // Act / Assert
        expect(labelFontSize(0.5)).toBe(0.5);
        expect(labelFontSize(MAX_LABEL_FONT_SIZE * 2)).toBe(MAX_LABEL_FONT_SIZE);
        for (const value of [undefined, 0, -1, Number.NaN, '1']) expect(labelFontSize(value as JsonValue)).toBe(DEFAULT_LABEL_FONT_SIZE);
    });

    it('should make the canvas the line box high and the padded text wide, cut at LABEL_MAX_WIDTH', () => {
        // Act
        const short = labelCanvasSize(100);
        const long = labelCanvasSize(LABEL_MAX_WIDTH * 5);

        // Assert
        expect(short.height).toBe(Math.ceil(LABEL_FONT_PX * LABEL_LINE_HEIGHT));
        expect(short.width).toBeGreaterThan(100);
        expect(long.width).toBe(LABEL_MAX_WIDTH);
        expect(labelCanvasSize(Number.NaN).width).toBeGreaterThan(0);
    });

    it('should draw in the font family at LABEL_FONT_PX', () => {
        // Act / Assert
        expect(labelFont('"Inter", sans-serif')).toBe(`${LABEL_FONT_PX}px "Inter", sans-serif`);
    });
});

describe('Labels (G3.6b), with a fake canvas', () => {
    it('should draw the text with fillText in the page font and its colour, as an sRGB texture on a sprite in the group', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        const labels = new Labels(literal, { doc, readFont: () => 'Georgia, serif' });
        const group = new Group();

        // Act
        labels.set(PATH, group, { _text: '<img src=x onerror=alert(1)>', color: '#ff0000', fontSize: 0.5 });

        // Assert: the text is drawn as text, characters and all, never parsed
        expect(canvases).toHaveLength(1);
        expect(canvases[0]?.drawn).toEqual({ font: `${LABEL_FONT_PX}px Georgia, serif`, fillStyle: '#ff0000', texts: ['<img src=x onerror=alert(1)>'] });
        const sprite = labels.spriteOf(PATH);
        expect(sprite?.parent).toBe(group);
        expect(sprite?.material.map?.colorSpace).toBe(SRGBColorSpace);
        expect(sprite?.material.map?.image).toBe(canvases[0]);
        expect(labels.drawn).toBe(1);
    });

    it('should size the sprite fontSize line boxes high and as wide as the canvas, with bounds that hold it from every side', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        const labels = new Labels(literal, { doc });
        const group = new Group();

        // Act
        labels.set(PATH, group, { _text: 'abcd', fontSize: 2 });

        // Assert
        const sprite = labels.spriteOf(PATH);
        const canvas = canvases[0];
        const height = 2 * LABEL_LINE_HEIGHT;
        expect(sprite?.scale.y).toBeCloseTo(height);
        expect(sprite?.scale.x).toBeCloseTo((height * (canvas?.width ?? 0)) / (canvas?.height ?? 1));
        const box = new Box3().setFromObject(group);
        expect(box.max.z - box.min.z).toBeCloseTo(box.max.x - box.min.x);
    });

    it('should draw again only when the text, the font or the colour changes, and a new size only rescales', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        let font = 'Arial';
        const labels = new Labels(literal, { doc, readFont: () => font });
        const group = new Group();
        labels.set(PATH, group, { _text: 'A', color: '#ff0000' });
        const first = labels.spriteOf(PATH)?.material.map;

        // Act / Assert: the same look draws nothing
        labels.set(PATH, group, { _text: 'A', color: '#ff0000', fontSize: 3 });
        expect(canvases).toHaveLength(1);
        expect(labels.spriteOf(PATH)?.scale.y).toBeCloseTo(3 * LABEL_LINE_HEIGHT);

        labels.set(PATH, group, { _text: 'AB', color: '#ff0000', fontSize: 3 });
        expect(canvases).toHaveLength(2);
        expect(canvases[1]?.drawn.texts).toEqual(['AB']);

        labels.set(PATH, group, { _text: 'AB', color: '#00ff00', fontSize: 3 });
        expect(canvases).toHaveLength(3);

        // The font is read again on restyle
        font = 'Courier';
        labels.restyle();
        expect(canvases).toHaveLength(4);
        expect(canvases[3]?.drawn.font).toBe(`${LABEL_FONT_PX}px Courier`);

        // A loaded web font draws the same text again
        labels.redraw();
        expect(canvases).toHaveLength(5);

        // One sprite throughout, a new texture each time
        expect(labels.spriteOf(PATH)?.material.map).not.toBe(first);
    });

    it('should take the default colour, then black, when the label sets none or it does not resolve', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        let fallback: JsonValue | undefined = '#0000ff';
        const labels = new Labels(literal, { doc, defaultColor: () => fallback });

        // Act
        labels.set(PATH, new Group(), { _text: 'A' });
        labels.set(`${PATH}2`, new Group(), { _text: 'A', color: '{color.unknown}' });
        fallback = undefined;
        labels.set(`${PATH}3`, new Group(), { _text: 'A' });

        // Assert
        expect(canvases.map((canvas) => canvas.drawn.fillStyle)).toEqual(['#0000ff', '#0000ff', DEFAULT_LABEL_COLOR]);
    });

    it('should draw nothing for an empty text, and free the sprite when the text empties', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        const labels = new Labels(literal, { doc });
        const group = new Group();

        // Act
        labels.set(PATH, group, { _text: '' });
        const none = labels.spriteOf(PATH);
        labels.set(PATH, group, { _text: 'A' });
        const sprite = labels.spriteOf(PATH);
        let disposed = 0;
        sprite?.material.addEventListener('dispose', () => (disposed += 1));
        sprite?.geometry.addEventListener('dispose', () => (disposed += 1));
        sprite?.material.map?.addEventListener('dispose', () => (disposed += 1));
        labels.set(PATH, group, { _text: '  ' });

        // Assert
        expect(none).toBeUndefined();
        expect(canvases).toHaveLength(1);
        expect(labels.spriteOf(PATH)).toBeUndefined();
        expect(group.children).toHaveLength(0);
        expect(disposed).toBe(3);
        expect(labels.drawn).toBe(0);
    });

    it('should cut a very long text at the widest canvas, not fail', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        const labels = new Labels(literal, { doc });

        // Act
        labels.set(PATH, new Group(), { _text: 'x'.repeat(100_000) });

        // Assert
        expect(canvases[0]?.width).toBe(LABEL_MAX_WIDTH);
        expect(canvases[0]?.drawn.texts[0]).toHaveLength(LABEL_MAX_CHARS);
    });

    it('should draw nothing without a document', () => {
        // Arrange
        const labels = new Labels(literal, {});

        // Act
        labels.set(PATH, new Group(), { _text: 'A' });

        // Assert
        expect(labels.spriteOf(PATH)).toBeUndefined();
        expect(labels.size).toBe(1);
    });
});

describe('SceneGraph label3d nodes (G3.6b)', () => {
    const label = (properties: Record<string, JsonValue>): Scene3dTree => ({ kind: 'label3d', key: 'tag', path: PATH, properties, children: [] });

    it('should draw a label3d in a group placed by its position, and free it when the node goes', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        const graph = new SceneGraph(literal, createColorConverter(undefined), {}, { doc });

        // Act
        graph.sync([label({ _text: 'Crate A', position: [1, 2, 3] })]);
        const group = graph.objectOf(PATH);

        // Assert
        expect(group?.position.toArray()).toEqual([1, 2, 3]);
        expect(group?.children).toHaveLength(1);
        expect(canvases[0]?.drawn.texts).toEqual(['Crate A']);

        // Act: removed
        graph.sync([]);

        // Assert
        expect(graph.labels.size).toBe(0);
        expect(group?.parent).toBeNull();
    });

    it('should draw a changed _text, and a label with no color again in a new labelColor', () => {
        // Arrange
        const { doc, canvases } = fakeDocument();
        const graph = new SceneGraph(literal, createColorConverter(undefined), {}, { doc });
        graph.applySettings({ labelColor: '#ff0000' });
        graph.sync([label({ _text: 'A' })]);

        // Act
        graph.sync([label({ _text: 'B' })]);
        graph.applySettings({ labelColor: '#00ff00' });
        graph.applySettings({ labelColor: '#00ff00' });

        // Assert
        expect(canvases.map((canvas) => [canvas.drawn.texts[0], canvas.drawn.fillStyle])).toEqual([
            ['A', '#ff0000'],
            ['B', '#ff0000'],
            ['B', '#00ff00']
        ]);
    });

    it('should free the labels on clear', () => {
        // Arrange
        const { doc } = fakeDocument();
        const graph = new SceneGraph(literal, createColorConverter(undefined), {}, { doc });
        graph.sync([label({ _text: 'A' })]);

        // Act
        graph.clear();

        // Assert
        expect(graph.labels.size).toBe(0);
    });
});
