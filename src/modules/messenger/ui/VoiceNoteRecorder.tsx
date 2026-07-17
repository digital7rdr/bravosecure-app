import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Animated, Easing, Vibration, Platform} from 'react-native';
import {Audio} from 'expo-av';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

/**
 * WhatsApp-style TAP-to-record microphone for quick voice notes. ONE tap
 * on the mic starts recording and shows the live recorder (timer + a
 * staggered bar animation + a Delete (✕) and a Send button); it keeps
 * recording until the user taps Send or Delete (or the 5-min cap). This
 * replaced the old press-and-hold model, where a quick tap cancelled
 * itself and a hold started recording but the mic button unmounted under
 * the finger so releasing never sent — the "voice button does nothing /
 * no recording UI" report. (The bars are decorative — a real waveform
 * needs native meter polling that expo-av only surfaces on iOS; Android
 * returns -160dB constants until we switch to expo-audio.)
 *
 * On Send we hand the local file URI off to `onComplete`; on Delete we
 * `onCancel`. The caller owns uploading + wrapping into a sealed
 * attachment. Recordings shorter than 400ms are discarded as accidental
 * so the user doesn't end up with a 100ms silent blip message.
 *
 * Audit M-P1-2 — recordings auto-finalise at `MAX_DURATION_MS` (5
 * minutes by default) so an open mic left running in someone's pocket
 * doesn't produce a multi-hour file that exceeds the chunk-upload
 * limits AND drains battery indefinitely. The clip is shipped to
 * `onComplete` rather than discarded — losing 5 minutes of recording
 * the user thought they were making is worse than auto-sending.
 */
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;

interface Props {
  onComplete: (rec: {uri: string; durationMs: number; mimeType: string}) => void;
  onCancel:   () => void;
  renderIdle?: () => React.ReactNode; // pre-recording UI (usually just the mic button)
  /** Cap on a single recording. Defaults to 5 minutes. */
  maxDurationMs?: number;
}

export function VoiceNoteRecorder({onComplete, onCancel, renderIdle, maxDurationMs}: Props) {
  const maxMs = Math.max(1000, maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const bar1 = useRef(new Animated.Value(0)).current;
  const bar2 = useRef(new Animated.Value(0)).current;
  const bar3 = useRef(new Animated.Value(0)).current;

  // Latest stop() reference — the max-duration timer fires async and
  // must always call the most recent closure (which closes over the
  // current `recording` + `startedAt`). A ref avoids capturing a stale
  // closure from the effect's mount-time render.
  const stopRef = useRef<(forceDiscard?: boolean) => Promise<void>>(async () => {});

  // BS-VOICE-TAP — re-entrancy guard for the async start() (permission +
  // createAsync). WhatsApp-style: ONE TAP starts recording and it stays
  // recording until the user taps Send or Delete (or the 5-min cap). A
  // second tap while arming is ignored so we never open two recorders.
  const startingRef = useRef(false);

  useEffect(() => {
    if (!startedAt) {return;}
    const id = setInterval(() => setTick(t => t + 1), 200);
    return () => clearInterval(id);
  }, [startedAt]);

  // Audit M-P1-2 — schedule an auto-finalise when the clip hits the cap.
  // Auto-send (not discard) so an over-cap recording still makes it to
  // the recipient instead of vanishing without warning.
  useEffect(() => {
    if (!startedAt) {return;}
    const remaining = Math.max(0, maxMs - (Date.now() - startedAt));
    const id = setTimeout(() => { void stopRef.current(false); }, remaining);
    return () => clearTimeout(id);
  }, [startedAt, maxMs]);

  useEffect(() => {
    if (!startedAt) {return;}
    const loop = Animated.loop(
      Animated.stagger(140, [bump(bar1), bump(bar2), bump(bar3)]),
    );
    loop.start();
    return () => { loop.stop(); bar1.setValue(0); bar2.setValue(0); bar3.setValue(0); };
  }, [startedAt, bar1, bar2, bar3]);

  const start = async () => {
    if (startingRef.current || startedAt) {return;}   // already arming / recording
    startingRef.current = true;
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { onCancel(); return; }
      await Audio.setAudioModeAsync({allowsRecordingIOS: true, playsInSilentModeIOS: true});
      const {recording: rec} = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecording(rec);
      setStartedAt(Date.now());
      Vibration.vibrate(12);
    } catch {
      onCancel();
    } finally {
      startingRef.current = false;
    }
  };

  const stop = async (forceDiscard = false) => {
    const rec = recording;
    const started = startedAt;
    setRecording(null);
    setStartedAt(null);
    if (!rec || !started) {return;}
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      const durationMs = Date.now() - started;
      if (forceDiscard || !uri || durationMs < 400) { onCancel(); return; }
      onComplete({
        uri,
        durationMs,
        mimeType: Platform.OS === 'ios' ? 'audio/mp4' : 'audio/m4a',
      });
    } catch {
      onCancel();
    }
  };
  stopRef.current = stop;

  if (!startedAt) {
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => { void start(); }}
        accessibilityRole="button"
        accessibilityLabel="Record voice message">
        {renderIdle ? renderIdle() : (
          <View style={styles.idleBtn}>
            <Icon name="microphone" size={18} color="#94A3B8" />
          </View>
        )}
      </TouchableOpacity>
    );
  }

  const elapsedMs = Date.now() - (startedAt ?? Date.now());
  return (
    <View style={styles.active}>
      <TouchableOpacity onPress={() => { void stop(true); }} style={styles.cancelBtn} activeOpacity={0.8}>
        <Icon name="close" size={18} color="#F87171" />
      </TouchableOpacity>
      <Animated.View style={[styles.bar, barStyle(bar1)]} />
      <Animated.View style={[styles.bar, barStyle(bar2)]} />
      <Animated.View style={[styles.bar, barStyle(bar3)]} />
      <Text style={styles.timer}>{formatDuration(elapsedMs)}</Text>
      <TouchableOpacity onPress={() => { void stop(false); }} style={styles.sendBtn} activeOpacity={0.85}>
        <Icon name="send" size={18} color="#FFF" />
      </TouchableOpacity>
      <Text style={{display:'none'}}>{tick}</Text>
    </View>
  );
}

function bump(v: Animated.Value) {
  return Animated.sequence([
    Animated.timing(v, {toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true}),
    Animated.timing(v, {toValue: 0, duration: 220, easing: Easing.in(Easing.quad),  useNativeDriver: true}),
  ]);
}

function barStyle(v: Animated.Value) {
  return {
    transform: [{scaleY: v.interpolate({inputRange: [0, 1], outputRange: [0.3, 1]})}],
    opacity:   v.interpolate({inputRange: [0, 1], outputRange: [0.5, 1]}),
  };
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  idleBtn: {width:36, height:36, borderRadius:18, backgroundColor:'#1E293B', alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'#334155'},
  active: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:10, paddingVertical:6, borderRadius:20, backgroundColor:'#1E293B', borderWidth:1, borderColor:'#DC262644'},
  cancelBtn: {width:28, height:28, alignItems:'center', justifyContent:'center'},
  bar:   {width:3, height:18, borderRadius:1.5, backgroundColor:'#EF4444'},
  timer: {color:'#E2E8F0', fontSize:12, fontWeight:'700', minWidth:42, textAlign:'center', fontVariant:['tabular-nums']},
  sendBtn: {width:32, height:32, borderRadius:16, backgroundColor:'#DC2626', alignItems:'center', justifyContent:'center'},
});
