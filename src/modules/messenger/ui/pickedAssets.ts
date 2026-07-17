/**
 * B-87/MX-04 — pure normalisation for multi-photo picker results. Free
 * of React / react-native imports so the mapping + cap logic is
 * unit-testable (chatListLayout.ts convention).
 */

/** WhatsApp caps multi-select at 30; 10 keeps worst-case memory (10 × ≤50 MB reads, sequential) sane on mid-range devices. */
export const MAX_PICKED_ASSETS = 10;

export interface PickerAssetLike {
  uri?:      string;
  type?:     string;
  fileName?: string;
  width?:    number;
  height?:   number;
  /** react-native-image-picker reports seconds for library videos. */
  duration?: number;
}

export interface PickedAsset {
  uri:  string;
  mime: string;
  /** Library picks are image/video; camera, documents and voice notes construct PickedAssets directly. */
  kind: 'image' | 'video' | 'audio' | 'file';
  meta: {name?: string; width?: number; height?: number; durationMs?: number};
}

export function normalizePickedAssets(assets: ReadonlyArray<PickerAssetLike> | undefined): PickedAsset[] {
  if (!assets?.length) {return [];}
  const out: PickedAsset[] = [];
  for (const a of assets) {
    if (!a?.uri) {continue;}
    const mime = a.type ?? 'image/jpeg';
    out.push({
      uri:  a.uri,
      mime,
      kind: mime.startsWith('video/') ? 'video' : 'image',
      meta: {
        name:       a.fileName ?? undefined,
        width:      a.width,
        height:     a.height,
        durationMs: typeof a.duration === 'number' ? Math.round(a.duration * 1000) : undefined,
      },
    });
    if (out.length >= MAX_PICKED_ASSETS) {break;}
  }
  return out;
}
