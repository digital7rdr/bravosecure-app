import React, {useEffect, useRef} from 'react';
import {View, StyleSheet, Animated, Easing} from 'react-native';

/**
 * Three staggered pulsing dots — the "peer is typing" indicator that
 * sits as a short bubble on the incoming side of the chat. Dots animate
 * via opacity + translateY for a gentle bounce, offset so the cadence
 * reads as "wave" rather than synchronized flash.
 *
 * The bubble vanishes instantly when `visible` flips to false — typing
 * frames arrive with start/stop, and a server-side 6s safety timer
 * emits `stop` if the client disconnects mid-burst, so we don't need
 * a client-side timeout here.
 */
export function TypingBubble({visible}: {visible: boolean}) {
  // Three independent Animated.Value refs so each dot has its own phase.
  const a = useRef(new Animated.Value(0)).current;
  const b = useRef(new Animated.Value(0)).current;
  const c = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {return;}
    const loop = Animated.loop(
      Animated.stagger(180, [
        pulse(a),
        pulse(b),
        pulse(c),
      ]),
    );
    loop.start();
    return () => { loop.stop(); a.setValue(0); b.setValue(0); c.setValue(0); };
  }, [visible, a, b, c]);

  if (!visible) {return null;}

  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <Animated.View style={[styles.dot, dotStyle(a)]} />
        <Animated.View style={[styles.dot, dotStyle(b)]} />
        <Animated.View style={[styles.dot, dotStyle(c)]} />
      </View>
    </View>
  );
}

function pulse(v: Animated.Value) {
  return Animated.sequence([
    Animated.timing(v, {toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true}),
    Animated.timing(v, {toValue: 0, duration: 320, easing: Easing.in(Easing.quad),  useNativeDriver: true}),
  ]);
}

function dotStyle(v: Animated.Value) {
  return {
    opacity:  v.interpolate({inputRange: [0, 1], outputRange: [0.35, 1]}),
    transform: [
      {translateY: v.interpolate({inputRange: [0, 1], outputRange: [0, -3]})},
    ],
  };
}

const styles = StyleSheet.create({
  row: {paddingHorizontal: 12, paddingVertical: 4, alignItems: 'flex-start'},
  bubble: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#1E293B',
    borderRadius: 16, borderTopLeftRadius: 4,
  },
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#94A3B8'},
});
