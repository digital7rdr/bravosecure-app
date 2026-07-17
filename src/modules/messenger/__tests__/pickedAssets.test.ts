import {MAX_PICKED_ASSETS, normalizePickedAssets} from '../ui/pickedAssets';

describe('normalizePickedAssets', () => {
  it('maps picker fields and classifies image vs video', () => {
    const out = normalizePickedAssets([
      {uri: 'file:///a.jpg', type: 'image/jpeg', fileName: 'a.jpg', width: 100, height: 50},
      {uri: 'file:///b.mp4', type: 'video/mp4', duration: 12.4},
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      uri: 'file:///a.jpg', mime: 'image/jpeg', kind: 'image',
      meta: {name: 'a.jpg', width: 100, height: 50, durationMs: undefined},
    });
    expect(out[1].kind).toBe('video');
    expect(out[1].meta.durationMs).toBe(12400);
  });

  it('drops uri-less assets and defaults mime to jpeg', () => {
    const out = normalizePickedAssets([
      {uri: undefined, type: 'image/png'},
      {uri: 'file:///c'},
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe('image/jpeg');
    expect(out[0].kind).toBe('image');
  });

  it('caps at MAX_PICKED_ASSETS', () => {
    const many = Array.from({length: MAX_PICKED_ASSETS + 5}, (_, i) => ({uri: `file:///p${i}.jpg`}));
    expect(normalizePickedAssets(many)).toHaveLength(MAX_PICKED_ASSETS);
  });

  it('handles empty/undefined input', () => {
    expect(normalizePickedAssets(undefined)).toEqual([]);
    expect(normalizePickedAssets([])).toEqual([]);
  });
});
