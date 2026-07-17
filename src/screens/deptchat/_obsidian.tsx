/**
 * Department Chat v2 — shared obsidian UI kit.
 *
 * Matches the Bravo Secure Home / Booking Home design language (obsidian
 * #07090D base + platinum-cobalt #5B8DEF accent, edge-lit cards, BravoFont,
 * AmbientBg), NOT the legacy Command-Navy agent `_shared.tsx`. New attendance +
 * incident screens compose these primitives so the whole module reads as one
 * premium near-black surface.
 */
import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet, ActivityIndicator} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';

// Obsidian palette (Bravo Secure Home handoff). Single source for the module.
export const OB = {
  bg:         '#07090D',
  card:       'rgba(22,27,37,0.72)',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  glow:       '#A9C5FF',
  amber:      '#E2C893',
  signal:     '#4ADE80',
  alert:      '#F58B97',
} as const;

type IconName = React.ComponentProps<typeof Icon>['name'];

// 1px top edge-light across the top of every premium card.
export function EdgeLight() {
  return (
    <LinearGradient
      colors={['transparent', 'rgba(255,255,255,0.13)', 'transparent']}
      start={{x: 0, y: 0}}
      end={{x: 1, y: 0}}
      style={k.edgeLight}
      pointerEvents="none"
    />
  );
}

export function ObHeader({
  title, onBack, pill, pillTone = 'default',
}: {
  title: string;
  onBack?: () => void;
  pill?: string;
  pillTone?: 'default' | 'warn' | 'good';
}) {
  const tone = pillTone === 'warn' ? OB.amber : pillTone === 'good' ? OB.signal : OB.accentSoft;
  return (
    <View style={k.header}>
      {onBack ? (
        <TouchableOpacity
          style={k.back}
          onPress={onBack}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>
      ) : <View style={{width: 36}} />}
      <Text style={k.headerTitle} numberOfLines={1}>{title}</Text>
      {pill ? (
        <View style={[k.pill, {borderColor: tone + '4D', backgroundColor: tone + '1A'}]}>
          <Text style={[k.pillText, {color: tone}]}>{pill}</Text>
        </View>
      ) : <View style={{width: 36}} />}
    </View>
  );
}

export function SectionLabel({children, right}: {children: React.ReactNode; right?: React.ReactNode}) {
  return (
    <View style={k.sectionHeader}>
      <Text style={k.sectionLabel}>{children}</Text>
      {right}
    </View>
  );
}

export function Card({children, style, onPress}: {
  children: React.ReactNode;
  style?: object;
  onPress?: () => void;
}) {
  const body = (
    <>
      <EdgeLight />
      {children}
    </>
  );
  if (onPress) {
    return (
      <TouchableOpacity style={[k.card, style]} activeOpacity={0.85} onPress={onPress}>
        {body}
      </TouchableOpacity>
    );
  }
  return <View style={[k.card, style]}>{body}</View>;
}

export function PrimaryButton({
  label, icon, onPress, disabled, busy,
}: {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not a nullish default
  const off = disabled || busy;
  return (
    <TouchableOpacity activeOpacity={0.85} disabled={off} onPress={onPress}>
      <LinearGradient
        colors={off ? ['#2A3342', '#222936'] : ['#6E9BF5', OB.accent, OB.accentDeep]}
        locations={[0, 0.55, 1]}
        start={{x: 0.1, y: 0}}
        end={{x: 0.9, y: 1}}
        style={[k.primaryBtn, off && k.primaryBtnOff]}>
        {busy ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <>
            {icon && <Icon name={icon} size={18} color={off ? OB.textMute : '#FFF'} />}
            <Text style={[k.primaryBtnText, off && {color: OB.textMute}]}>{label}</Text>
          </>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

export function GhostButton({label, icon, onPress}: {label: string; icon?: IconName; onPress?: () => void}) {
  return (
    <TouchableOpacity style={k.ghostBtn} activeOpacity={0.8} onPress={onPress}>
      {icon && <Icon name={icon} size={16} color={OB.accentSoft} />}
      <Text style={k.ghostBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

// Attendance status → label + colour, shared by the result + history surfaces.
export function attendanceStatusMeta(status?: string | null): {label: string; color: string; icon: IconName} {
  switch (status) {
    case 'present':        return {label: 'Present', color: OB.signal, icon: 'check-circle'};
    case 'late':           return {label: 'Late', color: OB.amber, icon: 'clock-alert-outline'};
    case 'early_checkout': return {label: 'Early checkout', color: OB.amber, icon: 'clock-end'};
    case 'absent':         return {label: 'Absent', color: OB.alert, icon: 'close-circle-outline'};
    case 'leave':          return {label: 'Leave', color: OB.accentSoft, icon: 'beach'};
    case 'sick_leave':     return {label: 'Sick leave', color: OB.accentSoft, icon: 'pill'};
    case 'off_duty':       return {label: 'Off duty', color: OB.textMute, icon: 'sleep'};
    case 'pending_review': return {label: 'Pending review', color: OB.amber, icon: 'shield-alert-outline'};
    default:               return {label: 'Open', color: OB.accentSoft, icon: 'clock-outline'};
  }
}

// Channels Hub v2 per-channel state label (PDF p.4 mockup: Read only / Private /
// Active / Admin / Managers / Archive). Derived from type + access (+ the
// viewer's role / archived flag) so one helper feeds the hub and the manage list.
export function channelStateMeta(input: {
  channel_type?: 'board' | 'department' | 'incident' | null;
  access?: 'standard' | 'read_only' | 'restricted' | null;
  my_role?: 'admin' | 'viewer';
  archived?: boolean;
}): {label: string; color: string} {
  if (input.archived) {return {label: 'Archive', color: OB.textMute};}
  if (input.channel_type === 'incident') {return {label: 'Managers', color: OB.amber};}
  if (input.access === 'read_only') {return {label: 'Read only', color: OB.textMute};}
  if (input.access === 'restricted') {return {label: 'Private', color: OB.amber};}
  if (input.my_role === 'admin') {return {label: 'Admin', color: OB.accentSoft};}
  return {label: 'Active', color: OB.signal};
}

export function reviewReasonLabel(reason?: string | null): string | null {
  switch (reason) {
    case 'face_mismatch':      return 'Face check could not be confirmed';
    case 'camera_unavailable': return 'Camera unavailable or not allowed';
    case 'out_of_radius':      return 'Outside the approved site radius';
    case 'permission_denied':  return 'Location was not shared';
    case 'offline':            return 'Submitted offline';
    case 'disputed':           return 'Disputed by the member';
    default:                  return null;
  }
}

const k = StyleSheet.create(scaleTextStyles({
  edgeLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 10,
  },
  back: {
    width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  headerTitle: {
    flex: 1, textAlign: 'center', color: OB.text,
    fontFamily: BravoFont.extraBold, fontSize: 15, letterSpacing: 0.4,
  },
  pill: {minWidth: 36, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, borderWidth: 1, alignItems: 'center'},
  pillText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1},

  sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12},
  sectionLabel: {
    color: OB.textDim, fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase',
  },

  card: {
    borderRadius: 18, padding: 16, backgroundColor: OB.card,
    borderWidth: 1, borderColor: OB.hair, overflow: 'hidden',
  },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    height: 56, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.4,
    shadowRadius: 24, elevation: 8,
  },
  primaryBtnOff: {borderColor: 'rgba(255,255,255,0.06)', shadowOpacity: 0},
  primaryBtnText: {color: '#FFF', fontFamily: BravoFont.bold, fontSize: 16, letterSpacing: 0.2},

  ghostBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 50, borderRadius: 14, borderWidth: 1, borderColor: OB.hair2,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  ghostBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 14},
}));
