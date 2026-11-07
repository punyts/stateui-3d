// Imported first by chunk.ts, so it runs before three.js does. three.js sets `window.__THREE__` to its revision when
// that is not set yet; the chunk removes it again so that its only global is `__stateui3d`, but keeps one a page had
// before (another copy of three.js)

/** The property three.js sets on `window` */
export const THREE_GLOBAL = '__THREE__';

/** True when the page had `window.__THREE__` before the chunk ran */
export const hadThreeGlobal = typeof window !== 'undefined' && THREE_GLOBAL in window;
