import React, {useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {openVault, useVaultStore, moveBytesToVault, findVaultRow} from '@/modules/messenger/vault';
import {useEntitlements, showTierUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';
import {readUriBytes} from '@/modules/messenger/media';
import {haptics} from '@utils/haptics';
import {useMessengerStore, selectMediaMessages} from '@/modules/messenger/store';
import type {LocalMessage} from '@/modules/messenger/store';
import {AttachmentFileViewer, type AttachmentViewTarget} from '@/modules/messenger/ui/AttachmentFileViewer';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {Halo} from '@components/Halo';
import Svg, {Rect} from 'react-native-svg';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {OB} from '@screens/deptchat/_obsidian';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'Files'>;

type FileTab = 'all' | 'docs' | 'img' | 'vid' | 'voice';

// Gold — the File Vault sits apart from the blue system (design spec).
const GOLD = OB.amber; // '#E2C893'
const GOLD_BORDER = 'rgba(212,179,122,0.4)';

interface FileRow {
  id:             string;
  conversationId: string;
  name:           string;
  sizeBytes:      number;
  mimeType:       string;
  senderLabel:    string;
  source:         string;
  createdAt:      number;
  mediaUrl?:      string;
  mediaObjectKey?: string;
  mediaKey?:      string;
  mediaIv?:       string;
  tab:            Exclude<FileTab, 'all'>;
  inVault:        boolean;
}

/**
 * Derive the tab bucket from the message type + mime. `vid` and `voice`
 * are both reported as `audio`/`video` mime types the server already
 * bucketized, so we key on the leading word.
 */
function bucketFor(msg: LocalMessage): Exclude<FileTab, 'all'> | null {
  if (msg.type === 'image') {return 'img';}
  if (msg.type === 'audio') {return 'voice';}
  if (msg.type === 'file') {
    const mime = msg.media_mime ?? '';
    if (mime.startsWith('video/')) {return 'vid';}
    if (mime.startsWith('audio/')) {return 'voice';}
    return 'docs';
  }
  return null;
}

function humanSize(bytes: number): string {
  if (!bytes) {return '—';}
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) {return 'now';}
  if (mins < 60) {return `${mins}m`;}
  const hrs = Math.round(mins / 60);
  if (hrs < 24) {return `${hrs}h`;}
  const days = Math.round(hrs / 24);
  if (days < 7) {return `${days}d`;}
  return new Date(ms).toLocaleDateString([], {day: '2-digit', month: 'short'});
}

function iconFor(row: FileRow): {name: string; color: string; bg: string; border: string} {
  if (row.tab === 'img')   {return {name: 'image-outline',        color: '#A78BFA', bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.28)'};}
  if (row.tab === 'vid')   {return {name: 'video-outline',        color: '#60A5FA', bg: 'rgba(96,165,250,0.12)',  border: 'rgba(96,165,250,0.28)'};}
  if (row.tab === 'voice') {return {name: 'microphone-outline',   color: '#F472B6', bg: 'rgba(244,114,182,0.12)', border: 'rgba(244,114,182,0.28)'};}
  if (row.mimeType.includes('pdf')) {return {name: 'file-pdf-box', color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.28)'};}
  return {name: 'file-document-outline', color: '#7FA8FF', bg: 'rgba(91,141,239,0.1)', border: 'rgba(91,141,239,0.25)'};
}

const TAB_META: {key: FileTab; label: string}[] = [
  {key: 'all',   label: 'ALL'},
  {key: 'docs',  label: 'DOCS'},
  {key: 'img',   label: 'IMG'},
  {key: 'vid',   label: 'VID'},
  {key: 'voice', label: 'VOICE'},
];

export default function FilesScreen() {
  const navigation = useNavigation<Nav>();
  const entitlements = useEntitlements();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<FileTab>('all');
  const [viewerFile, setViewerFile] = useState<AttachmentViewTarget | null>(null);
  const conversations = useMessengerStore(s => s.conversations);
  // Round 6 / perf — narrow subscription to the media-only slice. The
  // selector is memoised on the live `messages` map identity, so every
  // call returns the same frozen array until any append/remove flips
  // the top-level reference. Previously this screen subscribed to the
  // entire `s.messages` map, so a typed-message append in any chat
  // re-rendered the file picker.
  const mediaMessages = useMessengerStore(selectMediaMessages);
  const removeMessage = useMessengerStore(s => s.removeMessage);
  const vaultFiles    = useVaultStore(s => s.files);
  const removeFromVault = useVaultStore(s => s.removeFile);

  // Set of vault handles: real rows carry `sourceKey` (`msg:<id>`) while
  // legacy rows used the message id AS the objectKey — index both so the
  // dupe check stays O(1) per row.
  const vaultKeys = useMemo(
    () => new Set(vaultFiles.flatMap(f => (f.sourceKey ? [f.objectKey, f.sourceKey] : [f.objectKey]))),
    [vaultFiles],
  );

  const rows = useMemo<FileRow[]>(() => {
    const out: FileRow[] = [];
    for (const m of mediaMessages) {
      const bucket = bucketFor(m);
      if (!bucket) {continue;}
      const convId = m.conversation_id;
      const conv = conversations[convId];
      const source = conv?.name ?? conv?.peer?.userId ?? 'Unknown';
      out.push({
        id:             m.id,
        conversationId: convId,
        // Media-parity M14 — real filename / caption / type fallback.
        name:           m.media_meta?.name || m.content || (bucket === 'img' ? 'Photo' : 'Attachment'),
        // Media-parity — real size now travels in media_meta.
        sizeBytes:      m.media_meta?.sizeBytes ?? 0,
        mimeType:       m.media_mime ?? '',
        senderLabel:    m.sender_id === 'self' ? 'You' : source,
        source,
        createdAt:      new Date(m.created_at).getTime(),
        mediaUrl:       m.media_url,
        // Carry the encrypted-attachment fields so the Files tab can
        // actually OPEN a received attachment (M2). Before, canView was
        // gated on media_url which is only set for the sender's own picks.
        mediaObjectKey: m.media_object_key,
        mediaKey:       m.media_key,
        mediaIv:        m.media_iv,
        tab:            bucket,
        inVault:        vaultKeys.has(`msg:${m.id}`),
      });
    }
    // mediaMessages is already sorted newest-first by the selector.
    return out;
  }, [mediaMessages, conversations, vaultKeys]);

  const counts = useMemo(() => ({
    all:   rows.length,
    docs:  rows.filter(r => r.tab === 'docs').length,
    img:   rows.filter(r => r.tab === 'img').length,
    vid:   rows.filter(r => r.tab === 'vid').length,
    voice: rows.filter(r => r.tab === 'voice').length,
  }), [rows]);

  const visible = rows.filter(r => tab === 'all' ? true : r.tab === tab);

  // B-86 — one MFA-gated move at a time (proofs are single-use).
  const vaultBusyRef = useRef(false);
  const pushToVault = (r: FileRow) => {
    const row = findVaultRow(vaultFiles, `msg:${r.id}`);
    if (row) {
      Alert.alert(
        'Already in vault',
        'Remove it from the vault?',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Remove', style: 'destructive', onPress: () => removeFromVault(row.objectKey)},
        ],
      );
      return;
    }
    if (vaultBusyRef.current) {return;}
    vaultBusyRef.current = true;
    // B-86 — real pipeline (audit S1 stub retired): resolve the plaintext
    // bytes (cached encrypted blob → decrypt, or the sender's local pick),
    // then biometric ceremony → single-use MFA action token → VaultClient
    // encrypt-and-upload. Fails CLOSED with an honest alert; the store
    // refuses key-less rows (M-02) as defense in depth.
    void (async () => {
      try {
        let bytes: Uint8Array | null = null;
        if (r.mediaObjectKey && r.mediaKey && r.mediaIv) {
          const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
          const rt = await getMessengerRuntime('production');
          if (rt.downloadMedia) {
            bytes = await rt.downloadMedia({objectKey: r.mediaObjectKey, keyB64: r.mediaKey, ivB64: r.mediaIv});
          }
        } else if (r.mediaUrl) {
          bytes = await readUriBytes(r.mediaUrl);
        }
        if (!bytes) {
          Alert.alert('Not moved to vault', 'No local or downloadable copy of this file is available.');
          return;
        }
        const res = await moveBytesToVault({
          sourceKey: `msg:${r.id}`,
          name:      r.name,
          mimeType:  r.mimeType || 'application/octet-stream',
          bytes,
        });
        if (res.ok) {
          haptics.impact();
        } else if (res.reason !== 'cancelled') {
          Alert.alert('Not moved to vault', res.message);
        }
      } catch (e) {
        Alert.alert('Not moved to vault', e instanceof Error ? e.message : 'Could not read the file.');
      } finally {
        vaultBusyRef.current = false;
      }
    })();
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{top: 10, left: 10, right: 10, bottom: 10}}
          style={styles.hBtn}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>
        <Text style={styles.wordmark}>FILES</Text>
        <TouchableOpacity style={[styles.hBtn, styles.hBtnAccent]} activeOpacity={0.7}>
          <Icon name="magnify" size={19} color={OB.accentSoft} />
        </TouchableOpacity>
      </View>

      {/* Filter tabs */}
      <View style={styles.tabRow}>
        {TAB_META.map(t => {
          const on = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={styles.tab}
              onPress={() => setTab(t.key)}
              activeOpacity={0.8}>
              <Text style={[styles.tabName, on && styles.tabNameActive]}>{t.label}</Text>
              <Text style={[styles.tabCount, on && styles.tabCountActive]}>{counts[t.key]}</Text>
              {on ? <View style={styles.tabUnderline} /> : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 24}]}
        showsVerticalScrollIndicator={false}>

        {visible.length === 0 ? (
          <View style={styles.emptyWrap}>
            <View style={styles.dropTile}>
              {/* Dashed drop-zone ring via SVG — RN's borderStyle:'dashed' renders
                  solid on Android when combined with borderRadius, so draw it here. */}
              <Svg width={116} height={116} style={StyleSheet.absoluteFill}>
                <Rect
                  x={1.5}
                  y={1.5}
                  width={113}
                  height={113}
                  rx={28.5}
                  ry={28.5}
                  fill="none"
                  stroke="rgba(91,141,239,0.45)"
                  strokeWidth={1.5}
                  strokeDasharray="6 5"
                />
              </Svg>
              <Icon name="folder-outline" size={46} color="#7FA8FF" />
            </View>
            <Text style={styles.emptyTitle}>No files yet</Text>
            <Text style={styles.emptyHint}>
              Send an attachment from any chat — it encrypts locally, uploads to R2, and appears here.
            </Text>
            <View style={styles.chipRow}>
              <TrustChip label="End-to-end encrypted" fg={OB.accentSoft} border="rgba(91,141,239,0.3)" />
              <TrustChip label="R2 storage" fg={OB.textDim} border={OB.hair2} />
            </View>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Recent Files · {visible.length}</Text>
            {visible.map(f => {
              const iconConf = iconFor(f);
              // Media-parity M2 — openable when we have EITHER the local pick
              // (sender) OR the encrypted object reference (received).
              const canView = !!f.mediaUrl || !!(f.mediaObjectKey && f.mediaKey && f.mediaIv);
              return (
                <TouchableOpacity
                  key={f.id}
                  style={styles.fileRow}
                  activeOpacity={0.8}
                  disabled={!canView}
                  onPress={() => {
                    if (!canView) {return;}
                    setViewerFile({
                      id:               f.id,
                      conversationId:   f.conversationId,
                      name:             f.name,
                      media_url:        f.mediaUrl,
                      media_object_key: f.mediaObjectKey,
                      media_key:        f.mediaKey,
                      media_iv:         f.mediaIv,
                      media_mime:       f.mimeType || (f.tab === 'img' ? 'image/jpeg' : f.tab === 'vid' ? 'video/mp4' : f.tab === 'voice' ? 'audio/mp4' : 'application/octet-stream'),
                      sizeBytes:        f.sizeBytes,
                      createdAt:        f.createdAt,
                    });
                  }}>
                  <View style={[styles.fileIcon, {backgroundColor: iconConf.bg, borderColor: iconConf.border}]}>
                    <Icon name={iconConf.name} size={20} color={iconConf.color} />
                  </View>
                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName} numberOfLines={1}>{f.name}</Text>
                    <Text style={styles.fileMeta} numberOfLines={1}>{f.sizeBytes ? humanSize(f.sizeBytes) + ' · ' : ''}{f.senderLabel}</Text>
                    <Text style={styles.fileSource} numberOfLines={1}>{f.source}</Text>
                  </View>
                  <View style={styles.fileRight}>
                    <Text style={styles.fileTime}>{relativeTime(f.createdAt)}</Text>
                    <TouchableOpacity
                      style={[styles.vaultPushBtn, f.inVault && styles.vaultPushBtnActive]}
                      activeOpacity={0.7}
                      onPress={() => pushToVault(f)}
                      accessibilityRole="button"
                      accessibilityLabel={f.inVault ? 'Remove from vault' : 'Move to vault'}>
                      <Icon
                        name={f.inVault ? 'shield-check' : 'shield-plus-outline'}
                        size={16}
                        color={f.inVault ? OB.signal : GOLD}
                      />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* File Vault promo — gold, stands apart from the blue system.
            B-91 M1 R7 — first-time entry shows the Cloud/Drive Vault prompt
            (spec p.10, exact copy): free 100MB, paid plans, or cancel. Once
            a PIN exists the vault opens directly as before. */}
        <VaultPromo
          count={vaultFiles.length}
          onOpen={() => {
            // M1A rule 12 — Cloud Vault is Pro+: a Lite tap gets the upgrade
            // ask, never the 100MB-free prompt (that free tier belongs to
            // paid plans; openVault would gate anyway — this keeps the first
            // dialog honest instead of a two-step dead end).
            if (!entitlements.hasCloudVault) {
              showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
              return;
            }
            if (!useVaultStore.getState().hasPin()) {
              Alert.alert(
                'Use Cloud/Drive Vault',
                'Store your files securely in the cloud. Your first 100MB is free.',
                [
                  {text: 'Continue with 100MB Free', onPress: () => { openVault(navigation); }},
                  {text: 'View Storage Plans', onPress: () => navigation.navigate('FileVaultPurchase')},
                  {text: 'Cancel', style: 'cancel'},
                ],
              );
              return;
            }
            openVault(navigation);
          }}
        />

      </ScrollView>

      {/* Shared image/video/audio viewer — action bar wires into vault +
          removes the underlying chat message on Delete. */}
      <AttachmentFileViewer
        target={viewerFile}
        onClose={() => setViewerFile(null)}
        onDelete={t => { removeMessage(t.conversationId, t.id); }}
      />
    </View>
  );
}

function TrustChip({label, fg, border}: {label: string; fg: string; border: string}) {
  return (
    <View style={[styles.chip, {borderColor: border}]}>
      <View style={[styles.chipDot, {backgroundColor: fg}]} />
      <Text style={[styles.chipText, {color: fg}]}>{label}</Text>
    </View>
  );
}

function VaultPromo({count, onOpen}: {count: number; onOpen: () => void}) {
  return (
    <LinearGradient
      colors={['rgba(46,39,24,0.7)', 'rgba(20,20,17,0.6)']}
      start={{x: 0, y: 0}}
      end={{x: 1, y: 1}}
      style={styles.promo}>
      {/* gold corner glow */}
      <Halo size={140} color={GOLD} innerOpacity={0.14} midOpacity={0.04} style={styles.promoGlow} />
      <View style={styles.promoRow}>
        <View style={styles.promoIcon}>
          <Icon name="shield-lock-outline" size={24} color={GOLD} />
        </View>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={styles.promoTitle} numberOfLines={1}>{count} {count === 1 ? 'file' : 'files'} in your File Vault</Text>
          <Text style={styles.promoSub}>Tap the shield on any row to move it here · MFA per session</Text>
        </View>
      </View>
      <TouchableOpacity activeOpacity={0.85} onPress={onOpen} accessibilityRole="button" accessibilityLabel="Open File Vault">
        <LinearGradient
          colors={['#EBD9AE', GOLD, '#C9AB6F']}
          locations={[0, 0.6, 1]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={styles.promoBtn}>
          <Icon name="shield-outline" size={16} color="#1A1710" />
          <Text style={styles.promoBtnText}>OPEN VAULT</Text>
        </LinearGradient>
      </TouchableOpacity>
    </LinearGradient>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  header: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14},
  hBtn: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  hBtnAccent: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.28)'},
  wordmark: {flex: 1, color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 24, letterSpacing: 3},

  tabRow: {flexDirection: 'row', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: OB.hair},
  tab: {flex: 1, alignItems: 'center', paddingTop: 4, paddingBottom: 12, position: 'relative'},
  tabName: {fontFamily: BravoFont.mono, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, color: OB.textMute},
  tabNameActive: {color: OB.text},
  tabCount: {fontFamily: BravoFont.bold, fontSize: 12, fontWeight: '700', color: 'rgba(180,188,204,0.3)', marginTop: 4},
  tabCountActive: {color: OB.accentSoft},
  tabUnderline: {
    position: 'absolute', bottom: -1, left: '22%', right: '22%', height: 2.5, borderRadius: 2,
    backgroundColor: OB.accent,
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.9, shadowRadius: 6, elevation: 3,
  },

  scroll: {flexGrow: 1, paddingHorizontal: 20, paddingTop: 4},

  sectionLabel: {
    fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 2.5,
    textTransform: 'uppercase', color: OB.textMute, paddingTop: 12, paddingBottom: 8,
  },

  fileRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: OB.hair},
  fileIcon: {width: 42, height: 42, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  fileInfo: {flex: 1, minWidth: 0},
  fileName: {fontFamily: BravoFont.bold, fontSize: 14, color: OB.text},
  fileMeta: {fontFamily: BravoFont.regular, fontSize: 11, color: OB.textMute, marginTop: 2},
  fileSource: {fontFamily: BravoFont.regular, fontSize: 11, color: OB.textMute, marginTop: 1},
  fileRight: {alignItems: 'center', gap: 6, flexShrink: 0},
  fileTime: {fontFamily: BravoFont.mono, fontSize: 10, color: OB.textMute},
  vaultPushBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(226,200,147,0.08)', borderWidth: 1, borderColor: 'rgba(226,200,147,0.25)',
  },
  vaultPushBtnActive: {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.3)'},

  // Empty state
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40, paddingBottom: 20},
  dropTile: {
    width: 116, height: 116, borderRadius: 30, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: OB.hair,
    overflow: 'hidden',
  },
  emptyTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5, marginTop: 26},
  emptyHint: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13.5, textAlign: 'center', lineHeight: 21, maxWidth: 290, marginTop: 10},
  chipRow: {flexDirection: 'row', gap: 8, marginTop: 22, justifyContent: 'center', flexWrap: 'wrap'},
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1,
  },
  chipDot: {width: 5, height: 5, borderRadius: 3},
  chipText: {fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase'},

  // Gold File Vault promo
  promo: {borderRadius: 20, padding: 18, marginTop: 24, borderWidth: 1, borderColor: 'rgba(212,179,122,0.34)', overflow: 'hidden'},
  promoGlow: {position: 'absolute', top: -40, right: -30},
  promoRow: {flexDirection: 'row', alignItems: 'center', gap: 15},
  promoIcon: {
    width: 50, height: 50, borderRadius: 15, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    backgroundColor: 'rgba(212,179,122,0.12)', borderWidth: 1, borderColor: GOLD_BORDER,
  },
  promoTitle: {color: '#F4EAD4', fontFamily: BravoFont.extraBold, fontSize: 15.5, letterSpacing: -0.2},
  promoSub: {color: 'rgba(226,200,147,0.7)', fontFamily: BravoFont.regular, fontSize: 12, marginTop: 3, lineHeight: 17},
  promoBtn: {
    height: 46, marginTop: 16, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: GOLD, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.24, shadowRadius: 12, elevation: 5,
  },
  promoBtnText: {color: '#1A1710', fontFamily: BravoFont.extraBold, fontSize: 13.5, letterSpacing: 2},
}));
