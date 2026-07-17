import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, Animated, Easing, Platform} from 'react-native';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import BravoMark from './BravoMark';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Palette for the loading / secure-access surface, imported from the
 * "Bravo — Verifying Session" design. Intentionally distinct from the
 * Command Navy app theme (Bravo tokens): this is the obsidian + cobalt +
 * signal-green secure-access look the design specifies for loading states.
 */
const T = {
  bg:        '#07090D',
  accent:    '#5B8DEF',
  accentDeep:'#2F5BE0',
  signal:    '#4ADE80',
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  blue:      '#A9C5FF',
} as const;

const FONT = {
  sans:  'Manrope_400Regular',
  med:   'Manrope_500Medium',
  semi:  'Manrope_600SemiBold',
  bold:  'Manrope_700Bold',
  extra: 'Manrope_800ExtraBold',
  mono:  Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'}) ?? 'monospace',
} as const;

/** One staged security check shown in the loading checklist. */
export interface LoadingStep {
  /** Row headline, e.g. "Establishing secure channel". */
  label: string;
  /** Mono sub-line, e.g. "TLS 1.3 · end-to-end handshake". */
  sub?: string;
}

interface Props {
  /** Status headline, e.g. "Verifying session…". Keep it specific, not generic. */
  label?: string;
  /** Subtitle below the headline (used when no `steps` are supplied). */
  hint?: string;
  /** When true, renders as a full-screen overlay with brand mark + encrypted footer. */
  fullscreen?: boolean;
  /**
   * Optional staged checklist. When provided, the steps auto-advance and the
   * medallion ring fills with progress (holding on the last step until this
   * view unmounts — a loader never fakes a "done" it can't observe).
   */
  steps?: LoadingStep[];
  /** Override the accent color (defaults to the cobalt secure-access accent). */
  accent?: string;
}

const RING = 52;
const C = 2 * Math.PI * RING;

// ── shield + lock glyph (loading state) ──────────────────────────────────
function ShieldLock({size, color}: {size: number; color: string}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2.6l7 2.5v5.6c0 4.6-3 8.4-7 9.7-4-1.3-7-5.1-7-9.7V5.1L12 2.6Z"
        stroke={color} strokeWidth={1.6} strokeLinejoin="round"
      />
      <Rect x={9} y={11} width={6} height={5} rx={1.2} stroke={color} strokeWidth={1.5} />
      <Path d="M10.2 11V9.6a1.8 1.8 0 0 1 3.6 0V11" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

// ── per-step status pip ───────────────────────────────────────────────────
function StepPip({state, acc, spin}: {state: 'done' | 'active' | 'pending'; acc: string; spin: Animated.Value}) {
  const rotate = spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
  if (state === 'done') {
    return (
      <View style={[styles.pip, {backgroundColor: 'rgba(74,222,128,0.14)', borderColor: 'rgba(74,222,128,0.4)'}]}>
        <Svg width={13} height={13} viewBox="0 0 24 24" fill="none">
          <Path d="M5 12.5l4.2 4.2L19 7" stroke={T.signal} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    );
  }
  if (state === 'active') {
    return (
      <View style={[styles.pip, {borderColor: 'transparent'}]}>
        <Animated.View style={[StyleSheet.absoluteFill, {transform: [{rotate}]}]}>
          <Svg width={26} height={26} viewBox="0 0 26 26" fill="none">
            <Circle cx={13} cy={13} r={10} stroke="rgba(255,255,255,0.08)" strokeWidth={2.4} fill="none" />
            <Circle cx={13} cy={13} r={10} stroke={acc} strokeWidth={2.4} strokeLinecap="round" strokeDasharray="62.8" strokeDashoffset={44} fill="none" />
          </Svg>
        </Animated.View>
        <View style={{width: 6, height: 6, borderRadius: 3, backgroundColor: acc}} />
      </View>
    );
  }
  return (
    <View style={[styles.pip, {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: T.hair2}]}>
      <View style={{width: 5, height: 5, borderRadius: 2.5, backgroundColor: T.textFaint}} />
    </View>
  );
}

function StepRow({step, state, acc, spin}: {step: LoadingStep; state: 'done' | 'active' | 'pending'; acc: string; spin: Animated.Value}) {
  const active = state === 'active', done = state === 'done';
  return (
    <View
      style={[
        styles.stepRow,
        active && {backgroundColor: 'rgba(20,28,46,0.7)', borderColor: 'rgba(91,141,239,0.28)'},
        state === 'pending' && {opacity: 0.42},
      ]}>
      <StepPip state={state} acc={acc} spin={spin} />
      <View style={{flex: 1, minWidth: 0}}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: active || done ? FONT.bold : FONT.med,
            fontSize: 14,
            letterSpacing: -0.2,
            color: active ? T.text : done ? T.textDim : T.textMute,
          }}>
          {step.label}
        </Text>
        {step.sub ? (
          <Text numberOfLines={1} style={{fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 0.4, marginTop: 3, color: active ? T.blue : T.textMute}}>
            {step.sub}
          </Text>
        ) : null}
      </View>
      {done ? <Text style={{fontFamily: FONT.mono, fontSize: 9, fontWeight: '700', letterSpacing: 1, color: T.signal}}>OK</Text> : null}
    </View>
  );
}

/**
 * Branded loading indicator — a security medallion (progress ring + shield)
 * with a status headline, optional staged checklist, and (in fullscreen) a
 * brand mark and "end-to-end encrypted" footer. Use whenever a surface is
 * waiting on async work; give it text specific to what it's doing.
 */
export default function LoadingView({label, hint, fullscreen, steps, accent}: Props) {
  const acc = accent ?? T.accent;
  const stepList = steps ?? [];
  const staged = stepList.length > 0;

  const spin  = useRef(new Animated.Value(0)).current;   // active-pip + sweep rotation
  const sweep = useRef(new Animated.Value(0)).current;   // indeterminate ring rotation
  const pulse = useRef(new Animated.Value(0)).current;   // outer halo
  const prog  = useRef(new Animated.Value(0)).current;   // staged progress (0..1)

  const [activeIdx, setActiveIdx] = useState(0);

  // Loop animations.
  useEffect(() => {
    const loops = [
      Animated.loop(Animated.timing(spin,  {toValue: 1, duration: 700,  easing: Easing.linear, useNativeDriver: true})),
      Animated.loop(Animated.timing(sweep, {toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true})),
      Animated.loop(Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 1100, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0, duration: 0, useNativeDriver: true}),
      ])),
    ];
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [spin, sweep, pulse]);

  // Auto-advance the staged checklist; hold on the last step.
  useEffect(() => {
    const list = steps ?? [];
    if (list.length === 0) {return;}
    setActiveIdx(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stepMs = 850;
    for (let i = 1; i < list.length; i++) {
      timers.push(setTimeout(() => setActiveIdx(i), stepMs * i));
    }
    return () => timers.forEach(clearTimeout);
  }, [steps]);

  // Animate the progress ring on each step change.
  useEffect(() => {
    const list = steps ?? [];
    if (list.length === 0) {return;}
    const p = Math.min(1, (activeIdx + 0.5) / list.length);
    Animated.timing(prog, {toValue: p, duration: 500, easing: Easing.out(Easing.ease), useNativeDriver: false}).start();
  }, [activeIdx, steps, prog]);

  const sweepRotate = sweep.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
  const haloOpacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.55, 0]});
  const haloScale   = pulse.interpolate({inputRange: [0, 1], outputRange: [0.96, 1.18]});
  const dashoffset  = prog.interpolate({inputRange: [0, 1], outputRange: [C, 0]});

  const subtitle = staged ? (stepList[activeIdx]?.label ?? '') : hint;
  const stepState = (i: number): 'done' | 'active' | 'pending' =>
    i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';

  return (
    <View style={[styles.root, fullscreen && styles.fullscreen]} pointerEvents="none">
      {fullscreen ? (
        <View style={styles.brand}>
          {/* Official Bravo logo mark — same component + props as the
              Welcome screen and the source of the splash/icon PNGs. */}
          <BravoMark size={72} primary="#FFFFFF" accent="#5B8DEF" />
          <Text style={styles.brandName}>BRAVO</Text>
          <Text style={styles.brandSub}>SECURE ACCESS</Text>
        </View>
      ) : null}

      {/* ── security medallion ── */}
      <View style={styles.medallion}>
        <Animated.View style={[styles.halo, {opacity: haloOpacity, transform: [{scale: haloScale}], borderColor: 'rgba(91,141,239,0.3)'}]} />
        <Svg width={132} height={132} viewBox="0 0 132 132" style={{transform: [{rotate: '-90deg'}]}}>
          <Circle cx={66} cy={66} r={RING} stroke="rgba(255,255,255,0.07)" strokeWidth={3} fill="none" />
          {staged ? (
            <AnimatedCircle
              cx={66} cy={66} r={RING} stroke={acc} strokeWidth={3} strokeLinecap="round" fill="none"
              strokeDasharray={C} strokeDashoffset={dashoffset}
            />
          ) : null}
        </Svg>
        {!staged ? (
          <Animated.View style={[StyleSheet.absoluteFill, styles.center, {transform: [{rotate: sweepRotate}]}]}>
            <Svg width={132} height={132} viewBox="0 0 132 132" style={{transform: [{rotate: '-90deg'}]}}>
              <Circle
                cx={66} cy={66} r={RING} stroke={acc} strokeWidth={3} strokeLinecap="round" fill="none"
                strokeDasharray={`${C * 0.28} ${C}`}
              />
            </Svg>
          </Animated.View>
        ) : null}
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <View style={styles.shieldChip}>
            <ShieldLock size={38} color={T.blue} />
          </View>
        </View>
      </View>

      {/* ── status headline + subtitle ── */}
      <View style={styles.statusWrap}>
        {label ? <Text style={styles.headline}>{label}</Text> : null}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>

      {/* ── staged checklist ── */}
      {staged ? (
        <View style={styles.steps}>
          {stepList.map((s, i) => (
            <StepRow key={s.label} step={s} state={stepState(i)} acc={acc} spin={spin} />
          ))}
        </View>
      ) : null}

      {/* ── encrypted footer ── */}
      {fullscreen ? (
        <View style={styles.footer}>
          <Svg width={11} height={11} viewBox="0 0 14 14" fill="none">
            <Rect x={2.5} y={6} width={9} height={6} rx={1.2} stroke={T.signal} strokeWidth={1.3} />
            <Path d="M4.5 6V4a2.5 2.5 0 0 1 5 0v2" stroke={T.signal} strokeWidth={1.3} strokeLinecap="round" />
          </Svg>
          <Text style={styles.footerText}>256-bit end-to-end encrypted</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 18},
  fullscreen: {...StyleSheet.absoluteFillObject, backgroundColor: T.bg, paddingVertical: 0, zIndex: 999},
  center: {alignItems: 'center', justifyContent: 'center'},

  brand: {alignItems: 'center', marginBottom: 8},
  brandName: {fontFamily: FONT.extra, fontSize: 22, letterSpacing: 5, color: T.text, marginTop: 16},
  brandSub:  {fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 3, color: T.textMute, marginTop: 7},

  medallion: {width: 132, height: 132, alignItems: 'center', justifyContent: 'center'},
  halo: {position: 'absolute', top: 6, left: 6, right: 6, bottom: 6, borderRadius: 66, borderWidth: 1},
  shieldChip: {
    width: 80, height: 80, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },

  statusWrap: {alignItems: 'center', paddingHorizontal: 32, gap: 6},
  headline: {fontFamily: FONT.extra, fontSize: 21, letterSpacing: -0.5, color: T.text, textAlign: 'center'},
  subtitle: {fontFamily: FONT.sans, fontSize: 13, letterSpacing: -0.1, color: T.textDim, textAlign: 'center'},

  steps: {width: '100%', maxWidth: 360, paddingHorizontal: 26, gap: 2, marginTop: 2},
  stepRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1, borderColor: 'transparent'},
  pip: {width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},

  footer: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8},
  footerText: {fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 0.6, color: T.textMute},
});
