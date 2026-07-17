/**
 * StepperBar (Step 18 / B3) — generic horizontal step indicator: numbered dots joined by
 * connectors, filled up to `activeIndex` (1-based; 0 = nothing reached). RTL-aware (the
 * track reverses under I18nManager.isRTL) and text-scale-aware. Presentational + prop-driven;
 * MissionStepper is the mission-specific consumer.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';
import {isRTL, rowDirection} from '@utils/rtl';

export interface StepperBarProps {
  steps: readonly string[];
  /** 1-based index of the current/last-reached step; 0 means none reached. */
  activeIndex: number;
  tint?: string;
  /** Render the current dot in an error tint (terminal side-state). */
  errored?: boolean;
}

export default function StepperBar({steps, activeIndex, tint = UI.accent, errored = false}: StepperBarProps) {
  const rtl = isRTL();
  const order = rtl ? steps.map((_, i) => steps.length - 1 - i) : steps.map((_, i) => i);
  return (
    <View style={[s.row, {flexDirection: rowDirection()}]}>
      {order.map((stepIdx, pos) => {
        const n = stepIdx + 1;
        const done = n < activeIndex;
        const current = n === activeIndex;
        const dotColor = errored && current ? UI.alert : done || current ? tint : 'rgba(255,255,255,0.10)';
        const showConnector = pos < steps.length - 1;
        return (
          <React.Fragment key={n}>
            <View style={s.cell}>
              <View style={[s.dot, {borderColor: dotColor, backgroundColor: done ? dotColor : 'transparent'}]}>
                {done
                  ? <Icon name="check" size={12} color={UI.bg} />
                  : <Text style={[s.dotNum, {color: current ? dotColor : UI.textMute}]}>{n}</Text>}
              </View>
              <Text numberOfLines={2} style={[s.label, current && {color: UI.text}]}>{steps[stepIdx]}</Text>
            </View>
            {showConnector && <View style={[s.conn, {backgroundColor: n < activeIndex ? tint : 'rgba(255,255,255,0.10)'}]} />}
          </React.Fragment>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  row: {flexDirection: 'row', alignItems: 'flex-start'},
  cell: {width: 52, alignItems: 'center'},
  dot: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  dotNum: {fontFamily: UI.fBold, fontSize: 11},
  label: {fontFamily: UI.fSemi, fontSize: 8.5, lineHeight: 11, letterSpacing: 0.2, color: UI.textMute, textAlign: 'center', marginTop: 6},
  conn: {flex: 1, height: 2, borderRadius: 1, marginTop: 12},
}));
