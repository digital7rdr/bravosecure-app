/**
 * B-87/MX-04 — pre-send review tray for multi-photo selection. Obsidian
 * bottom sheet matching the ChatScreen attach sheet: thumbnail strip,
 * per-item remove, explicit "Send N" — so a 10-photo pick is a reviewed
 * action, not a burst of accidental sends. Captions are intentionally
 * out of scope (media messages carry no caption field in the envelope
 * yet).
 */
import React from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TouchableOpacity,
  Image, FlatList,
} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {PickedAsset} from './pickedAssets';

const T = {
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  signal:     '#4ADE80',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  glassFill:  'rgba(255,255,255,0.04)',
} as const;
const SHEET_GRADIENT = ['#131A28', '#0C111B'] as const;
const SEND_GRADIENT  = ['#4C86F0', T.accentDeep] as const;

function fmtDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || ms <= 0) {return null;}
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MediaPreviewTray({assets, onRemoveAt, onCancel, onSend}: {
  assets:     PickedAsset[];
  onRemoveAt: (index: number) => void;
  onCancel:   () => void;
  onSend:     () => void;
}) {
  const visible = assets.length > 0;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Discard selected media">
        <Pressable>
          <LinearGradient colors={SHEET_GRADIENT} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.title}>
                {assets.length} {assets.length === 1 ? 'item' : 'items'} selected
              </Text>
              <View style={styles.encBadge}>
                <Icon name="lock" size={11} color={T.signal} />
                <Text style={styles.encBadgeText}>Encrypted</Text>
              </View>
            </View>

            <FlatList
              data={assets}
              horizontal
              keyExtractor={(a, i) => `${a.uri}:${i}`}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
              renderItem={({item, index}) => {
                const dur = fmtDuration(item.meta.durationMs);
                return (
                  <View style={styles.thumbWrap}>
                    <Image source={{uri: item.uri}} style={styles.thumb} resizeMode="cover" />
                    {item.kind === 'video' && (
                      <View style={styles.videoBadge}>
                        <Icon name="play" size={11} color="#FFF" />
                        {dur ? <Text style={styles.videoBadgeText}>{dur}</Text> : null}
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => onRemoveAt(index)}
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove item ${index + 1}`}>
                      <Icon name="close" size={13} color="#FFF" />
                    </TouchableOpacity>
                  </View>
                );
              }}
            />

            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={onCancel}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Cancel sending">
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sendBtn}
                onPress={onSend}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`Send ${assets.length} ${assets.length === 1 ? 'item' : 'items'}`}>
                <LinearGradient
                  colors={SEND_GRADIENT}
                  start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, styles.sendBtnFill]}
                />
                <Icon name="send" size={15} color="#FFF" />
                <Text style={styles.sendText}>Send {assets.length}</Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(4,6,10,0.72)'},
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: 26,
    borderTopWidth: 1, borderColor: T.hair2,
  },
  handle: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: T.hair2, marginBottom: 12},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  title: {color: T.text, fontSize: 15, fontWeight: '800'},
  encBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 10, backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.26)'},
  encBadgeText: {color: T.signal, fontSize: 10, fontWeight: '700', letterSpacing: 0.4},
  strip: {gap: 10, paddingVertical: 4},
  thumbWrap: {position: 'relative'},
  thumb: {width: 92, height: 92, borderRadius: 14, backgroundColor: T.glassFill, borderWidth: 1, borderColor: T.hair},
  videoBadge: {position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: 'rgba(4,6,10,0.75)'},
  videoBadgeText: {color: '#FFF', fontSize: 9, fontWeight: '700'},
  removeBtn: {position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: '#2A3348', borderWidth: 1, borderColor: T.hair2, alignItems: 'center', justifyContent: 'center'},
  actionsRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16},
  cancelBtn: {flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 14, backgroundColor: T.glassFill, borderWidth: 1, borderColor: T.hair2},
  cancelText: {color: T.textDim, fontSize: 13, fontWeight: '700'},
  sendBtn: {flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 14, overflow: 'hidden'},
  sendBtnFill: {borderRadius: 14},
  sendText: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.3},
});
