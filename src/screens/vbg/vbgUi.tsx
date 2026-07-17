/**
 * VBG (Virtual Bodyguard) shared design system.
 *
 * React Native port of the standalone design mockup's atoms — the
 * "obsidian premium" look (deep #07090D bg, glass cards with a top
 * edge-light, accent rails, mono eyebrows, tactical map). Every VBG
 * screen composes these so the four screens stay visually consistent
 * and the markup per screen stays small.
 *
 * Tokens live here (not in the app `Colors` theme) because VBG is a
 * self-contained obsidian surface distinct from the rest of the app's
 * Command-Navy chrome — matching the mockup exactly.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path} from 'react-native-svg';
import {scaleTextStyles} from '@utils/scaling';

// ── Design tokens (mirrors mockup `BRAVO`) ────────────────────────────────────
export const VBG = {
  bg:        '#07090D',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  cardTop:   'rgba(22,27,37,0.9)',
  cardBot:   'rgba(17,21,29,0.82)',

  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',

  signal:    '#4ADE80',
  signalDim: 'rgba(74,222,128,0.14)',
  amber:     '#F5B544',
  amberDim:  'rgba(245,181,68,0.12)',
  alert:     '#FF5D5D',
  alertDim:  'rgba(255,93,93,0.16)',
  info:      '#6EA8FE',

  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  accentSoft: '#A9C5FF',

  indigo:    '#A78BFA',
} as const;

// ── Screen frame — obsidian bg + ambient top glow + VBG footer nav ────────────
// VBG screens go fullscreen (the app's root tab bar hides for VBG* routes),
// so VBG owns its OWN bottom nav: pass `footer` (the 5-tab VbgFooter) and the
// body reserves room for it. Screens that want no footer omit it.
export function VbgScreen({
  children,
  scroll = true,
  footer,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  footer?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // Reserve space at the bottom so the last card clears the floating footer.
  // 116 = opaque bar (~76) + the bar's upward shadow reach (~18, shadowRadius
  // 18 / elevation 18) + a breathing gap, so the last card never lands in the
  // shadowed zone. insets.bottom matches the footer's own paddingBottom.
  const bottomPad = footer ? insets.bottom + 116 : insets.bottom + 16;
  // Scroll mode: the inner View just pads the ScrollView content. Non-scroll
  // mode: the children own their own scrolling (e.g. a FlatList), so the
  // wrapper must FLEX to give them a bounded height — and we drop the bottom
  // pad (the child applies its own footer clearance via contentContainerStyle).
  const body = (
    <View style={scroll
      ? {paddingTop: insets.top + 6, paddingBottom: bottomPad}
      : {flex: 1, paddingTop: insets.top + 6}}>
      {children}
    </View>
  );
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // Lift content above the keyboard so a focused TextInput (e.g. the GeoRisk
      // search) stays visible. iOS needs 'padding'. On Android the manifest's
      // adjustResize already resizes the window + scrolls the field into view,
      // so we pass NO behavior — using 'height' here double-handles the resize
      // and shrinks the container even with no keyboard, which pulled the
      // absolute footer up off the bottom edge (the mid-screen-footer bug).
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* ambient top radial glow */}
      <View pointerEvents="none" style={styles.ambientGlow} />
      {scroll ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{flex: 1}}>{body}</View>
      )}
      {footer}
    </KeyboardAvoidingView>
  );
}

// ── Card — gradient fill, hairline, top edge-light, optional accent rail ──────
export function VbgCard({
  children,
  rail,
  pad = 15,
  radius = 18,
  style,
}: {
  children: React.ReactNode;
  /** Solid colour for the left accent rail. */
  rail?: string;
  pad?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.card, {padding: pad, borderRadius: radius}, style]}>
      {/* top edge-light */}
      <View pointerEvents="none" style={styles.cardEdge} />
      {rail ? <View style={[styles.cardRail, {backgroundColor: rail}]} /> : null}
      {children}
    </View>
  );
}

// ── Section label — mono eyebrow, optional bullet ─────────────────────────────
export function SectionLabel({
  children,
  color = VBG.textDim,
  dot,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  dot?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <View style={styles.labelRow}>
      {dot ? <View style={[styles.labelDot, {backgroundColor: dot, shadowColor: dot}]} /> : null}
      <Text style={[styles.label, {color}, style]}>{children}</Text>
    </View>
  );
}

// ── Risk badge ────────────────────────────────────────────────────────────────
export type RiskLevel =
  | 'high' | 'elevated' | 'medium' | 'low' | 'critical' | 'caution' | 'info' | 'blue';

const RISK: Record<RiskLevel, {fg: string; bg: string; bd: string}> = {
  high:     {fg: '#FF8B8B', bg: 'rgba(255,93,93,0.13)', bd: 'rgba(255,93,93,0.34)'},
  critical: {fg: '#FF8B8B', bg: 'rgba(255,93,93,0.13)', bd: 'rgba(255,93,93,0.34)'},
  elevated: {fg: VBG.amber, bg: VBG.amberDim,           bd: 'rgba(245,181,68,0.34)'},
  medium:   {fg: VBG.amber, bg: VBG.amberDim,           bd: 'rgba(245,181,68,0.30)'},
  caution:  {fg: VBG.amber, bg: VBG.amberDim,           bd: 'rgba(245,181,68,0.30)'},
  low:      {fg: VBG.signal, bg: VBG.signalDim,         bd: 'rgba(74,222,128,0.30)'},
  info:     {fg: VBG.info,  bg: 'rgba(110,168,254,0.12)', bd: 'rgba(110,168,254,0.30)'},
  blue:     {fg: '#A9C5FF', bg: 'rgba(91,141,239,0.13)', bd: 'rgba(91,141,239,0.32)'},
};

export function RiskBadge({
  level = 'low',
  children,
  small,
}: {
  level?: RiskLevel;
  children: React.ReactNode;
  small?: boolean;
}) {
  const c = RISK[level] ?? RISK.low;
  return (
    <View style={[
      styles.badge,
      {backgroundColor: c.bg, borderColor: c.bd, paddingHorizontal: small ? 8 : 10, paddingVertical: small ? 3 : 4},
    ]}>
      <Text style={[styles.badgeText, {color: c.fg, fontSize: small ? 8.5 : 9.5}]}>
        {children}
      </Text>
    </View>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────────
export function Chip({
  children,
  active,
  onPress,
}: {
  children: React.ReactNode;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity activeOpacity={0.75} onPress={onPress}
      style={[styles.chip, active ? styles.chipOn : styles.chipOff]}>
      <Text style={[styles.chipText, {color: active ? '#A9C5FF' : VBG.textMute}]}>{children}</Text>
    </TouchableOpacity>
  );
}

// ── Pill button ───────────────────────────────────────────────────────────────
export function PillButton({
  children,
  variant = 'ghost',
  full,
  onPress,
  height = 40,
  style,
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'ghost';
  full?: boolean;
  onPress?: () => void;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const primary = variant === 'primary';
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress}
      style={[
        styles.pill,
        {height, width: full ? '100%' : undefined},
        primary ? styles.pillPrimary : styles.pillGhost,
        style,
      ]}>
      <View style={styles.pillInner}>{children}</View>
    </TouchableOpacity>
  );
}


// ── Tactical map — grid + streets + optional route. Children = pins ───────────
export function TacticalMap({
  height = 240,
  route = false,
  radius = 16,
  children,
}: {
  height?: number;
  route?: boolean;
  radius?: number;
  children?: React.ReactNode;
}) {
  return (
    <View style={[styles.map, {height, borderRadius: radius}]}>
      <Svg width="100%" height="100%" viewBox="0 0 380 280" preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}>
        {/* grid */}
        {Array.from({length: 9}).map((_, i) => (
          <Path key={`h${i}`} d={`M0 ${i * 35} L380 ${i * 35}`} stroke="rgba(91,141,239,0.10)" strokeWidth={1} />
        ))}
        {Array.from({length: 13}).map((_, i) => (
          <Path key={`v${i}`} d={`M${i * 30} 0 L${i * 30} 280`} stroke="rgba(91,141,239,0.10)" strokeWidth={1} />
        ))}
        {/* streets */}
        <Path d="M-10,120 C60,100 120,150 190,120 C260,90 320,130 400,110" stroke="#1E3E70" strokeWidth={3} fill="none" opacity={0.7} />
        <Path d="M40,210 C120,190 200,220 280,200 C330,188 360,200 400,196" stroke="#1B375F" strokeWidth={2.2} fill="none" opacity={0.5} />
        {/* river */}
        <Path d="M-10,180 C70,165 130,200 200,182 C270,164 330,196 400,178" stroke="#1E5099" strokeWidth={13} opacity={0.32} fill="none" strokeLinecap="round" />
        {route ? (
          <>
            <Path d="M70,235 C120,190 150,150 175,110 C200,70 250,55 300,60" stroke="rgba(91,141,239,0.25)" strokeWidth={6} fill="none" strokeLinecap="round" />
            <Path d="M70,235 C120,190 150,150 175,110 C200,70 250,55 300,60" stroke={VBG.accent} strokeWidth={3} fill="none" strokeLinecap="round" />
          </>
        ) : null}
      </Svg>
      {children}
    </View>
  );
}

// Map pin with label + glow dot
export function MapPin({
  x, y, color, label, sub,
}: {
  x: number; y: number; color: string; label: string; sub?: string;
}) {
  return (
    <View style={[styles.pin, {left: `${x}%`, top: `${y}%`}]}>
      <View style={[styles.pinLabel, {borderColor: `${color}66`}]}>
        <Text style={styles.pinLabelText}>{label}</Text>
        {sub ? <Text style={[styles.pinSub, {color}]}>{sub}</Text> : null}
      </View>
      <View style={[styles.pinDot, {backgroundColor: color, shadowColor: color}]} />
    </View>
  );
}

// Principal / you locator (pulsing rings, static border in RN)
export function LocatorDot({x, y, color = VBG.accent}: {x: number; y: number; color?: string}) {
  return (
    <View style={[styles.locator, {left: `${x}%`, top: `${y}%`}]}>
      <View style={[styles.locatorRing, {width: 40, height: 40, marginLeft: -20, marginTop: -20, borderColor: color, opacity: 0.35}]} />
      <View style={[styles.locatorRing, {width: 28, height: 28, marginLeft: -14, marginTop: -14, borderColor: color, opacity: 0.55}]} />
      <View style={[styles.locatorCore, {backgroundColor: color, shadowColor: color}]} />
    </View>
  );
}

// ── Reusable bordered icon button (back / menu) ───────────────────────────────
export function IconButton({children, onPress}: {children: React.ReactNode; onPress?: () => void}) {
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={styles.iconBtn} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
      {children}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  screen: {flex: 1, backgroundColor: VBG.bg},
  ambientGlow: {
    position: 'absolute', top: -160, left: 0, right: 0, height: 400,
    backgroundColor: 'rgba(91,141,239,0.05)', borderRadius: 400,
  },

  card: {
    position: 'relative', overflow: 'hidden',
    backgroundColor: VBG.cardBot, borderWidth: 1, borderColor: VBG.hair,
  },
  cardEdge: {
    position: 'absolute', top: 0, left: 16, right: 16, height: 1,
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  cardRail: {position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 3},

  labelRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  labelDot: {width: 6, height: 6, borderRadius: 3, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  label: {fontSize: 10, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase'},

  badge: {alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1, flexDirection: 'row', alignItems: 'center'},
  badgeText: {fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase'},

  chip: {paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1},
  chipOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.34)'},
  chipOff: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: VBG.hair2},
  chipText: {fontSize: 9.5, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase'},

  pill: {borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  pillInner: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  pillPrimary: {backgroundColor: VBG.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  pillGhost: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: VBG.hair2},


  map: {width: '100%', overflow: 'hidden', borderWidth: 1, borderColor: VBG.hair2, backgroundColor: '#0A1830'},
  pin: {position: 'absolute', alignItems: 'center', transform: [{translateX: -14}, {translateY: -52}], zIndex: 4},
  pinLabel: {alignItems: 'center', backgroundColor: 'rgba(7,12,22,0.86)', borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, marginBottom: 5},
  pinLabelText: {fontSize: 9.5, fontWeight: '600', color: VBG.text, letterSpacing: -0.1},
  pinSub: {fontSize: 8, letterSpacing: 0.4, marginTop: 1, fontWeight: '600'},
  pinDot: {width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)', shadowOpacity: 0.8, shadowRadius: 7, shadowOffset: {width: 0, height: 0}},

  locator: {position: 'absolute', zIndex: 5},
  locatorRing: {position: 'absolute', borderRadius: 999, borderWidth: 1},
  locatorCore: {width: 16, height: 16, borderRadius: 8, marginLeft: -8, marginTop: -8, borderWidth: 2, borderColor: '#fff', shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: {width: 0, height: 0}},

  iconBtn: {width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: VBG.hair2, alignItems: 'center', justifyContent: 'center'},
}));
