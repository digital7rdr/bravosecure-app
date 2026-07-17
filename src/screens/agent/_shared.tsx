/**
 * Agent Portal shared UI primitives.
 *
 * Matches the Bravo Agent Portal design bundle (Command Navy system):
 * nav header with 3px glowing accent bar, step pills, segmented progress
 * rail, section labels, and section headers. Colors mirror the HTML tokens
 * from bravo/project/Bravo Agent Portal.html.
 */
import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';

export const BRAND = {
  ok:      '#00C853',
  warn:    '#FFC107',
  err:     '#D50000',
  info:    '#3BA6FF',
  acc:     '#00A3FF',
  glow:    '#7ED6FF',
  actDim:  '#244C82',
  mapGrid: '#4CC2FF',
};

export function NavHeader({
  title,
  onBack,
  stepPill,
  stepPillTone = 'default',
}: {
  title: string;
  onBack?: () => void;
  stepPill?: string;
  stepPillTone?: 'default' | 'warn';
}) {
  return (
    <View style={nav.row}>
      {/* B-98 — no handler ⇒ spacer, never a dead-looking chevron (ObHeader idiom). */}
      {onBack ? (
        <TouchableOpacity
          style={nav.back}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={18} color={Colors.textPrimary} />
        </TouchableOpacity>
      ) : (
        <View style={nav.back} />
      )}

      <View style={nav.titleWrap}>
        <View style={nav.accentBar} />
        <Text style={nav.title} numberOfLines={1}>{title}</Text>
      </View>

      {stepPill ? (
        <View style={[nav.pill, stepPillTone === 'warn' && nav.pillWarn]}>
          <Text style={[nav.pillText, stepPillTone === 'warn' && nav.pillTextWarn]}>
            {stepPill}
          </Text>
        </View>
      ) : <View style={{width: 0}} />}
    </View>
  );
}

export function ProgressRail({total, active}: {total: number; active: number}) {
  return (
    <View style={bar.row}>
      {Array.from({length: total}).map((_, i) => (
        <View key={i} style={[bar.seg, i < active && bar.segOn]} />
      ))}
    </View>
  );
}

export function SectionLabel({children}: {children: React.ReactNode}) {
  return <Text style={sec.h}>{children}</Text>;
}

export function CTAButton({
  label,
  onPress,
  variant = 'primary',
  trailingArrow = true,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'ghost' | 'disabled';
  trailingArrow?: boolean;
}) {
  const disabled = variant === 'disabled';
  return (
    <View style={cta.wrap}>
      <TouchableOpacity
        style={[
          cta.btn,
          variant === 'ghost' && cta.btnGhost,
          variant === 'disabled' && cta.btnDisabled,
        ]}
        disabled={disabled}
        onPress={onPress}
        activeOpacity={0.85}>
        <Text style={[
          cta.txt,
          variant === 'ghost' && cta.txtGhost,
          variant === 'disabled' && cta.txtDisabled,
        ]}>
          {label}
        </Text>
        {trailingArrow && variant !== 'disabled' && (
          <Icon
            name="arrow-right"
            size={14}
            color={variant === 'ghost' ? Colors.primary : '#fff'}
            style={{marginLeft: 6}}
          />
        )}
      </TouchableOpacity>
    </View>
  );
}

export function AlertWarn({children}: {children: React.ReactNode}) {
  return (
    <View style={warn.box}>
      <Icon name="alert-outline" size={14} color={BRAND.warn} style={{marginTop: 1}} />
      <Text style={warn.txt}>{children}</Text>
    </View>
  );
}

const nav = StyleSheet.create(scaleTextStyles({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 10,
  },
  back: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  titleWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0,
  },
  accentBar: {
    width: 3, height: 16, borderRadius: 3, backgroundColor: BRAND.glow,
    shadowColor: BRAND.glow, shadowOpacity: 0.5, shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
  },
  title: {
    fontFamily: BravoFont.bold, fontSize: 12, letterSpacing: 1.6,
    color: Colors.textPrimary, textTransform: 'uppercase',
  },
  pill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.primary,
  },
  pillWarn: {backgroundColor: 'rgba(255,193,7,0.1)', borderColor: BRAND.warn},
  pillText: {
    fontFamily: BravoFont.bold, fontSize: 9.5, letterSpacing: 1,
    color: Colors.primary, textTransform: 'uppercase',
  },
  pillTextWarn: {color: BRAND.warn},
}));

const bar = StyleSheet.create(scaleTextStyles({
  row: {flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingBottom: 10},
  seg: {flex: 1, height: 3, borderRadius: 2, backgroundColor: Colors.surfaceElevated},
  segOn: {
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary, shadowOpacity: 0.35, shadowRadius: 8,
    shadowOffset: {width: 0, height: 0},
  },
}));

const sec = StyleSheet.create(scaleTextStyles({
  h: {
    fontFamily: BravoFont.bold, fontSize: 10.5, letterSpacing: 1.5,
    color: Colors.textMuted, textTransform: 'uppercase', marginTop: 6,
  },
}));

const cta = StyleSheet.create(scaleTextStyles({
  wrap: {
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.background,
  },
  btn: {
    width: '100%', height: 44, borderRadius: 8,
    backgroundColor: Colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.primary, shadowOpacity: 0.3, shadowRadius: 20,
    shadowOffset: {width: 0, height: 8}, elevation: 6,
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1, borderColor: Colors.primary,
    shadowOpacity: 0, elevation: 0,
  },
  btnDisabled: {
    backgroundColor: BRAND.actDim,
    shadowOpacity: 0, elevation: 0,
  },
  txt: {
    fontFamily: BravoFont.bold, fontSize: 12, letterSpacing: 1.2,
    color: '#fff', textTransform: 'uppercase',
  },
  txtGhost: {color: Colors.primary},
  txtDisabled: {color: 'rgba(255,255,255,0.6)'},
}));

const warn = StyleSheet.create(scaleTextStyles({
  box: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    padding: 10, borderRadius: 8,
    backgroundColor: 'rgba(255,193,7,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.28)',
  },
  txt: {flex: 1, fontSize: 11, color: Colors.textSecondary, lineHeight: 15},
}));
