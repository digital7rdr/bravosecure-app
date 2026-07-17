/**
 * iOS-style scroll-wheel time picker (hour + minute columns).
 *
 * Each column is a vertical `ScrollView` that snaps to ITEM_HEIGHT.
 * A ScrollView (not FlatList) deliberately sidesteps RN's "nested
 * VirtualizedLists on same axis" warning when the host screen wraps
 * this widget in its own ScrollView; the data sets (24 hours / 12
 * minute steps) are small enough that full render isn't an issue.
 */
import React, {useCallback, useEffect, useRef} from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

// Obsidian/cobalt palette (Bravo "Schedule" design handoff) — mirrors
// BookingDateTimeScreen so the wheel reads as part of the same card.
const D = {
  text:      '#F2F4F8',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair2:     'rgba(255,255,255,0.09)',
  fSemi:     'Manrope_600SemiBold',
  fBold:     'Manrope_700Bold',
  fMono:     'monospace',
};

const ITEM_HEIGHT = 42;
const VISIBLE_ROWS = 5;                        // odd so centre row is unambiguous
const PICKER_HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;
const PAD_ROWS = (VISIBLE_ROWS - 1) / 2;

const pad = (n: number) => n.toString().padStart(2, '0');

interface ColumnProps {
  values: number[];
  selected: number;
  onChange: (v: number) => void;
}

function Column({values, selected, onChange}: ColumnProps) {
  const ref = useRef<ScrollView>(null);
  const hasInit = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const idx = values.indexOf(selected);
    if (idx >= 0) {
      ref.current.scrollTo({y: idx * ITEM_HEIGHT, animated: hasInit.current});
      hasInit.current = true;
    }
  }, [selected, values]);

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.y;
      const idx = Math.round(offset / ITEM_HEIGHT);
      const clamped = Math.max(0, Math.min(values.length - 1, idx));
      const next = values[clamped];
      if (next !== selected) onChange(next);
    },
    [values, selected, onChange],
  );

  return (
    <View style={s.col}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        onMomentumScrollEnd={onMomentumEnd}
        nestedScrollEnabled
        contentContainerStyle={{paddingVertical: PAD_ROWS * ITEM_HEIGHT}}
        overScrollMode="never"
        bounces={false}>
        {values.map(v => {
          const isCentre = v === selected;
          return (
            <View key={v} style={s.item}>
              <Text style={[s.itemText, isCentre && s.itemTextSel]}>{pad(v)}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

interface Props {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  /** Minute step (defaults to 5). */
  minuteStep?: number;
}

export default function WheelTimePicker({hour, minute, onChange, minuteStep = 5}: Props) {
  const hours = Array.from({length: 24}, (_, i) => i);
  const minutes = Array.from({length: Math.floor(60 / minuteStep)}, (_, i) => i * minuteStep);

  const snappedMinute = minutes.reduce(
    (best, v) => (Math.abs(v - minute) < Math.abs(best - minute) ? v : best),
    minutes[0],
  );

  return (
    <View style={s.wrap}>
      <View pointerEvents="none" style={s.topLight} />
      <View pointerEvents="none" style={s.rail} />
      <View style={s.cols}>
        <Column
          values={hours}
          selected={hour}
          onChange={v => onChange(v, snappedMinute)}
        />
        <View pointerEvents="none" style={s.colDivider} />
        <Column
          values={minutes}
          selected={snappedMinute}
          onChange={v => onChange(hour, v)}
        />
      </View>
      <View style={s.labels}>
        <Text style={s.label}>HOUR</Text>
        <Text style={s.label}>MIN</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    borderRadius: 20, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(16,22,34,0.85)',
    borderWidth: 1, borderColor: D.hair2,
  },
  topLight: {
    position: 'absolute', top: 0, left: 22, right: 22, height: 1,
    backgroundColor: 'rgba(120,160,255,0.25)',
  },
  rail: {
    position: 'absolute', left: 16, right: 16,
    top: 16 + PAD_ROWS * ITEM_HEIGHT, height: ITEM_HEIGHT,
    borderRadius: 13, borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    backgroundColor: 'rgba(91,141,239,0.10)',
    zIndex: 1,
  },
  cols: {flexDirection: 'row', height: PICKER_HEIGHT},
  colDivider: {width: 1, marginVertical: 8, backgroundColor: D.hair2},
  col: {flex: 1, overflow: 'hidden'},
  item: {height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center'},
  itemText: {
    fontFamily: D.fMono, fontSize: 18,
    color: D.textMute, letterSpacing: 0,
  },
  itemTextSel: {
    fontFamily: D.fBold, fontSize: 30,
    color: D.text, letterSpacing: -0.5,
  },
  labels: {
    flexDirection: 'row', marginTop: 6,
  },
  label: {
    flex: 1, textAlign: 'center',
    fontFamily: D.fMono, fontSize: 9,
    color: D.textFaint, letterSpacing: 2,
  },
});
