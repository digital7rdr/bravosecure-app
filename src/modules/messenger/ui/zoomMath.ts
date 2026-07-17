/**
 * B-87/MX-03 — pure geometry for the pinch-zoom image viewer. No React /
 * react-native imports so the clamp logic is unit-testable in a node env
 * (same convention as chatListLayout.ts).
 *
 * Coordinate model: the image is contain-fitted inside a viewport box and
 * transformed with `[{translateX}, {translateY}, {scale}]` — translate
 * FIRST so tx/ty are plain screen points regardless of zoom (RN applies
 * each transform in the local space of the previous one; scaling after
 * translating keeps the pan axis unscaled). All clamps below are
 * therefore in screen points.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Double-tap zooms to this when at rest. */
export const DOUBLE_TAP_SCALE = 2.5;

export function clampScale(s: number): number {
  if (!isFinite(s) || s <= 0) {return MIN_SCALE;}
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Contain-fit rectangle of an image inside a viewport. */
export function containRect(
  viewW: number, viewH: number, imgW: number, imgH: number,
): {width: number; height: number} {
  if (viewW <= 0 || viewH <= 0 || imgW <= 0 || imgH <= 0) {
    return {width: viewW > 0 ? viewW : 0, height: viewH > 0 ? viewH : 0};
  }
  const scale = Math.min(viewW / imgW, viewH / imgH);
  return {width: imgW * scale, height: imgH * scale};
}

/**
 * Clamp a screen-point translation so the scaled content can't be dragged
 * fully off-screen. Per axis: when the scaled content is SMALLER than the
 * viewport it stays centred (translation 0); when larger, the max pull in
 * either direction is half the overflow.
 */
export function clampTranslation(params: {
  scale:    number;
  viewW:    number;
  viewH:    number;
  contentW: number;
  contentH: number;
  tx:       number;
  ty:       number;
}): {tx: number; ty: number} {
  const {scale, viewW, viewH, contentW, contentH, tx, ty} = params;
  const clampAxis = (t: number, view: number, content: number): number => {
    const overflow = content * scale - view;
    if (overflow <= 0) {return 0;}
    const max = overflow / 2;
    return Math.min(max, Math.max(-max, t));
  };
  return {
    tx: clampAxis(isFinite(tx) ? tx : 0, viewW, contentW),
    ty: clampAxis(isFinite(ty) ? ty : 0, viewH, contentH),
  };
}
