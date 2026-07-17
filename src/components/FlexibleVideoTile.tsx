/**
 * FlexibleVideoTile — RTCView wrapper that bends its container to the
 * source video's natural aspect ratio so we never show black bars or
 * cut frames. WhatsApp-style "flexible" tiles.
 *
 * Why: with `objectFit: 'cover'` the video crops to fill a fixed-size
 * tile (cuts edges off). With `objectFit: 'contain'` the video fits
 * fully but adds black letterbox bars when ratios mismatch. Neither
 * matches what WhatsApp does in its grid — they reshape the tile
 * itself to match the video's natural aspect, so the whole frame is
 * visible AND no padding/bars appear.
 *
 * Implementation: react-native-webrtc's RTCView fires
 * `onDimensionsChange({nativeEvent: {width, height}})` when it knows
 * the source's natural pixel dimensions (and again on camera flip /
 * orientation change). We capture that, compute width/height, and
 * apply it to the wrapper via React Native's `aspectRatio` style.
 *
 * Until the first dimensions event fires we default to 16:9 (the most
 * common phone camera ratio) so the tile doesn't briefly appear as
 * a 1:1 square then snap. Once the real ratio arrives we update; the
 * brief layout change is barely perceptible because the first frame
 * usually fires the dimensions callback within ~150 ms of the first
 * decoded keyframe.
 *
 * Camera-off / no-video paths must NOT use this component — render
 * the avatar fallback as a fixed-dimension View instead.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {RTCView} from 'react-native-webrtc';

interface Props {
  streamURL: string;
  /** Front camera mirror — only set true for the user's own self-tile. */
  mirror?: boolean;
  /** RTCView z-order. Defaults to 0. Set 1 for PiP-on-top. */
  zOrder?: number;
  /**
   * Container style applied alongside the dynamic aspectRatio. Width
   * is taken from the parent layout; height is computed automatically
   * from `aspectRatio`. Pass background, border, and overflow rules
   * here. Don't pass a fixed height — it'd defeat the flexing.
   */
  containerStyle?: StyleProp<ViewStyle>;
}

/** WhatsApp-grid default — most phone cameras shoot 16:9 portrait/landscape. */
const DEFAULT_RATIO = 16 / 9;

export default function FlexibleVideoTile({
  streamURL,
  mirror = false,
  zOrder = 0,
  containerStyle,
}: Props): React.ReactElement {
  const [ratio, setRatio] = useState<number>(DEFAULT_RATIO);
  // Fix #41: reset to DEFAULT_RATIO whenever streamURL changes. Without
  // this, swapping between streams (e.g. hero ↔ small role swap on
  // group calls, or a track replacement on screen-share toggle) kept
  // the previous source's measured ratio until the new source fired
  // its first onDimensionsChange. Visual symptom: the new tile briefly
  // rendered at the wrong aspect — landscape video squashed into a
  // portrait-ratio frame for ~150 ms after the swap. Snapping to the
  // 16:9 default on swap means the worst case is a ~150 ms 16:9 view
  // before the real ratio lands, which matches the cold-start path
  // and is barely perceptible.
  useEffect(() => {
    setRatio(DEFAULT_RATIO);
  }, [streamURL]);
  const onDims = useCallback((e: {nativeEvent: {width: number; height: number}}) => {
    const w = e.nativeEvent?.width;
    const h = e.nativeEvent?.height;
    if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) {return;}
    const next = w / h;
    setRatio(prev => (Math.abs(prev - next) > 0.01 ? next : prev));
  }, []);
  // Fix #42: memoize the merged style array. Returning a fresh array
  // literal on every render makes RN's StyleSheet diff treat the
  // outer View's style as "changed" each frame, which can cascade
  // into layout-recalculation calls in the parent grid. Memoising
  // keys on (containerStyle, ratio) stabilises the reference so the
  // diff short-circuits when both inputs are equal.
  const mergedStyle = useMemo(
    // BS-GC-0x0 — backstop against a 0x0 render surface. Field logcat
    // (TECNO + Pixel both) showed the decoder emitting real frames while
    // `BLASTBufferQueue ... rejecting buffer:active_size=0x0` repeated
    // forever: the RTCView's SurfaceView had zero size, so every decoded
    // frame was dropped at the compositor and the tile showed blank/card.
    // Root cause: this View is sized ONLY by `aspectRatio` + a width the
    // PARENT supplies; when the group-call grid slot hadn't been measured
    // (or measured 0), the parent passed width:0 → aspectRatio → height:0
    // → RTCView fills a 0x0 box. A minWidth/minHeight floor guarantees a
    // real surface even if the parent width momentarily resolves to 0, so
    // frames are never rejected wholesale; the real width/aspectRatio
    // take over the instant layout settles.
    () => [containerStyle, {aspectRatio: ratio, minWidth: 1, minHeight: 1}],
    [containerStyle, ratio],
  );
  return (
    <View style={mergedStyle}>
      <RTCView
        streamURL={streamURL}
        style={StyleSheet.absoluteFill}
        objectFit="cover"
        mirror={mirror}
        zOrder={zOrder}
        onDimensionsChange={onDims}
      />
    </View>
  );
}
