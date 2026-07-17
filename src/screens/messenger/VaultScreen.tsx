import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, AppState,
  TouchableOpacity, StatusBar, Modal, Pressable, Image, Vibration,
} from 'react-native';
import {Alert} from '@utils/alert';
/**
 * Brand-kit action palette — keep these in sync with `--color-action-*`
 * tokens in Bravo Kit v4. Pressed-state uses `pressed` (not an opacity
 * knockdown) so the button feels tactile on both Android and iOS.
 */
const ACTION = {
  default:  '#1E88FF',
  hover:    '#3BA6FF',
  pressed:  '#166ED1',
  disabled: '#244C82',
};
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {launchImageLibrary, launchCamera} from 'react-native-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {Colors} from '@theme/index';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useVaultStore, moveBytesToVault, openVaultFileUri, type VaultFile} from '@/modules/messenger/vault';
import {readUriBytes} from '@/modules/messenger/media';
import {haptics} from '@utils/haptics';
import {FileViewer, type ViewableFile} from '@/modules/messenger/ui/FileViewer';
import {scaleTextStyles} from '@utils/scaling';

const TABS = ['All', 'Images', 'Documents', 'Audio'] as const;
type Tab = typeof TABS[number];

/**
 * Pick a category from a vault file's mime type — drives which section
 * it lands in (Images / Documents / Audio) without relying on file
 * extensions the server may strip.
 */
function categorize(mime: string): 'image' | 'audio' | 'doc' {
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('audio/')) {return 'audio';}
  return 'doc';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], {day: '2-digit', month: 'short'}).toUpperCase();
}

function docIconFor(mime: string): {name: string; color: string; bg: string} {
  if (mime.includes('pdf')) {return {name: 'file-pdf-box', color: '#f87171', bg: 'rgba(248,113,113,0.12)'};}
  if (mime.includes('spreadsheet') || mime.includes('excel')) {return {name: 'file-table', color: '#4ade80', bg: 'rgba(74,222,128,0.12)'};}
  if (mime.includes('word') || mime.includes('document')) {return {name: 'file-document', color: '#60A5FA', bg: 'rgba(96,165,250,0.12)'};}
  if (mime.startsWith('audio/')) {return {name: 'music-note', color: '#A78BFA', bg: 'rgba(167,139,250,0.12)'};}
  return {name: 'file', color: '#B8C7E0', bg: 'rgba(180,199,224,0.12)'};
}

export default function VaultScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const [activeTab, setActiveTab] = useState<Tab>('All');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<ViewableFile | null>(null);
  const files = useVaultStore(s => s.files);
  const removeFile = useVaultStore(s => s.removeFile);

  // Why: VAULT-24/32 — BiometricGate relocks the store on background,
  // but this screen stayed mounted showing files. Re-check the lock on
  // focus and on foreground transitions and `replace` with the lock
  // screen (matches openVault routing). Loop-safe: replace unmounts
  // this screen, and VaultLock only comes back after a real unlock.
  const guardLock = useCallback(() => {
    if (!useVaultStore.getState().isUnlocked()) {
      navigation.replace('VaultLock');
    }
  }, [navigation]);

  useFocusEffect(guardLock);

  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active' && navigation.isFocused()) {guardLock();}
    });
    return () => sub.remove();
  }, [guardLock, navigation]);

  // B-86 — one MFA-gated transfer at a time (proofs are single-use).
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const openInViewer = (f: VaultFile) => {
    // Legacy pre-B-86 rows kept a local plaintext uri — still viewable.
    const legacyUri = (f as unknown as {uri?: string}).uri;
    if (legacyUri) {
      setViewerFile({
        // B-86 — vaultSourceKey is LOAD-BEARING: the viewer's vault
        // actions match the index by this handle; without it "Move to
        // Vault" re-uploads a duplicate and Delete removes nothing.
        id: f.objectKey, vaultSourceKey: f.objectKey, name: f.name, uri: legacyUri,
        mimeType: f.mimeType, size: f.size, createdAt: f.createdAt,
      });
      return;
    }
    if (busyKey) {return;}
    // B-86 — real rows: biometric ceremony → single-use MFA action token
    // → presigned download → local AES decrypt → temp uri for the viewer.
    setBusyKey(f.objectKey);
    void (async () => {
      try {
        const res = await openVaultFileUri(f);
        if (res.ok) {
          setViewerFile({
            id: f.objectKey, vaultSourceKey: f.objectKey, name: f.name, uri: res.uri,
            mimeType: f.mimeType, size: f.size, createdAt: f.createdAt,
          });
        } else if (res.reason !== 'cancelled') {
          Alert.alert('Could not open', res.message);
        }
      } finally {
        setBusyKey(null);
      }
    })();
  };

  const images    = files.filter(f => categorize(f.mimeType) === 'image');
  const documents = files.filter(f => categorize(f.mimeType) === 'doc');
  const audios    = files.filter(f => categorize(f.mimeType) === 'audio');

  // Why: audit S1 — the previous upload paths called addFile() with
  // keyB64:'' and ivB64:'' and a plaintext local uri. The "AES-256 · ACTIVE"
  // banner above suggested encryption was happening when nothing was
  // encrypted at all and nothing reached the vault backend. The pickers
  // stay functional so users can browse, but every upload entry point
  // shows an honest "not available yet" alert instead of writing a
  // pretend-encrypted row.
  // B-86 — direct vault uploads through the real pipeline (audit S1 stub
  // retired): read the picked bytes → biometric ceremony → single-use MFA
  // action token → VaultClient encrypt-and-upload → real key material in
  // the index. Fails CLOSED with an honest alert; vaultStore.addFile
  // refuses key-less rows (M-02) as defense in depth.
  const uploadToVault = async (asset: {uri: string; name: string; mimeType: string}) => {
    if (busyKey) {return;}
    setBusyKey('upload');
    try {
      const bytes = await readUriBytes(asset.uri);
      const res = await moveBytesToVault({
        sourceKey: `local:${Date.now()}`,
        name:      asset.name,
        mimeType:  asset.mimeType,
        bytes,
      });
      if (res.ok) {
        haptics.impact();
      } else if (res.reason !== 'cancelled') {
        Alert.alert('Not saved to vault', res.message);
      }
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setBusyKey(null);
    }
  };

  const pickImage = async () => {
    setUploadOpen(false);
    try {
      const res = await launchImageLibrary({mediaType: 'photo', selectionLimit: 1, includeBase64: false});
      const asset = res.assets?.[0];
      if (res.didCancel === true || !asset?.uri) {return;}
      await uploadToVault({
        uri:      asset.uri,
        name:     asset.fileName ?? 'photo.jpg',
        mimeType: asset.type ?? 'image/jpeg',
      });
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not open image picker');
    }
  };

  const captureImage = async () => {
    setUploadOpen(false);
    try {
      const res = await launchCamera({mediaType: 'photo', cameraType: 'back', saveToPhotos: false});
      const asset = res.assets?.[0];
      if (res.didCancel === true || !asset?.uri) {return;}
      await uploadToVault({
        uri:      asset.uri,
        name:     asset.fileName ?? `capture-${Date.now()}.jpg`,
        mimeType: asset.type ?? 'image/jpeg',
      });
    } catch (e) {
      Alert.alert('Camera failed', e instanceof Error ? e.message : 'Could not open camera');
    }
  };

  const pickDocument = async () => {
    setUploadOpen(false);
    try {
      const res = await DocumentPicker.getDocumentAsync({type: '*/*', copyToCacheDirectory: true});
      const asset = res.assets?.[0];
      if (res.canceled || !asset?.uri) {return;}
      await uploadToVault({
        uri:      asset.uri,
        name:     asset.name ?? 'document',
        mimeType: asset.mimeType ?? 'application/octet-stream',
      });
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not open document picker');
    }
  };

  const confirmRemove = (f: VaultFile) => {
    Alert.alert(
      'Remove from vault?',
      `"${f.name}" will be removed from your vault index.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Remove', style: 'destructive', onPress: () => removeFile(f.objectKey)},
      ],
    );
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
            style={{paddingRight: 8}}>
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Personal Vault</Text>
        </View>
        <Pressable
          onPress={() => { Vibration.vibrate(8); setUploadOpen(true); }}
          style={({pressed}) => [
            styles.uploadBtn,
            pressed && styles.uploadBtnPressed,
          ]}>
          <Icon name="upload" size={18} color="#FFF" />
        </Pressable>
      </View>

      {/* B-86 — the real encrypt-and-upload pipeline is wired (per-file
          AES-256, MFA action token per operation). Busy state narrates
          the in-flight transfer; failures alert honestly (S1 class:
          this card must never overclaim). */}
      <View style={styles.encWrap}>
        <View style={styles.encCard}>
          <View style={styles.encLeft}>
            <View style={styles.encIcon}>
              <Icon
                name={busyKey ? 'shield-sync-outline' : 'shield-lock'}
                size={18}
                color={busyKey ? '#F59E0B' : '#4ADE80'}
              />
            </View>
            <View>
              <Text style={styles.encTitle}>
                {busyKey ? 'Securing file…' : 'AES-256 · per-file keys'}
              </Text>
              <Text style={styles.encSub}>
                {busyKey ? 'Encrypting and transferring' : 'Every open and upload requires a fresh MFA proof'}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {TABS.map(tab => (
          <TouchableOpacity key={tab} style={styles.tab} onPress={() => setActiveTab(tab)} activeOpacity={0.7}>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
            {activeTab === tab && <View style={styles.tabUnderline} />}
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {files.length === 0 && (
          <View style={styles.emptyState}>
            <Icon name="shield-lock-outline" size={44} color="#244C82" />
            <Text style={styles.emptyText}>Your vault is empty</Text>
            <Text style={styles.emptyHint}>Tap the upload button to add your first encrypted file.</Text>
            <Pressable
              onPress={() => setUploadOpen(true)}
              style={({pressed}) => [
                styles.emptyCta,
                pressed && styles.emptyCtaPressed,
              ]}>
              <Icon name="plus" size={16} color="#FFF" />
              <Text style={styles.emptyCtaText}>Upload File</Text>
            </Pressable>
          </View>
        )}

        {files.length > 0 && (activeTab === 'All' || activeTab === 'Images') && images.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Images · {images.length}</Text>
            </View>
            <View style={styles.imageGrid}>
              {images.slice(0, 3).map(img => {
                const uri = (img as unknown as {uri?: string}).uri;
                return (
                  <TouchableOpacity
                    key={img.objectKey}
                    style={styles.imageCell}
                    activeOpacity={0.8}
                    onPress={() => openInViewer(img)}
                    onLongPress={() => confirmRemove(img)}>
                    <View style={styles.imageBox}>
                      {uri
                        ? <Image source={{uri}} style={styles.imageThumb} resizeMode="cover" />
                        : <Icon name="image" size={32} color="#244C82" />
                      }
                      <View style={styles.shieldBadge}>
                        <Icon name="shield" size={13} color="#FFF" />
                      </View>
                    </View>
                    <Text style={styles.imageName} numberOfLines={1}>{img.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {files.length > 0 && (activeTab === 'All' || activeTab === 'Documents') && documents.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Documents · {documents.length}</Text>
            </View>
            <View style={styles.docList}>
              {documents.map(doc => {
                const iconConf = docIconFor(doc.mimeType);
                return (
                  <TouchableOpacity
                    key={doc.objectKey}
                    style={styles.docRow}
                    activeOpacity={0.8}
                    onPress={() => openInViewer(doc)}
                    onLongPress={() => confirmRemove(doc)}>
                    <View style={[styles.docIcon, {backgroundColor: iconConf.bg}]}>
                      <Icon name={iconConf.name} size={18} color={iconConf.color} />
                    </View>
                    <View style={styles.docInfo}>
                      <Text style={styles.docName} numberOfLines={1}>{doc.name}</Text>
                      <Text style={styles.docMeta}>{humanSize(doc.size)}</Text>
                    </View>
                    <View style={styles.docRight}>
                      <Text style={styles.docDate}>{humanDate(doc.createdAt)}</Text>
                      <Icon name="download" size={18} color="#7E8AA6" />
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {activeTab === 'Audio' && (
          audios.length === 0 ? (
            <View style={styles.emptyState}>
              <Icon name="microphone-off" size={40} color="#244C82" />
              <Text style={styles.emptyText}>No audio files</Text>
            </View>
          ) : (
            <View style={styles.docList}>
              {audios.map(a => {
                const iconConf = docIconFor(a.mimeType);
                return (
                  <TouchableOpacity key={a.objectKey} style={styles.docRow} activeOpacity={0.8} onPress={() => openInViewer(a)} onLongPress={() => confirmRemove(a)}>
                    <View style={[styles.docIcon, {backgroundColor: iconConf.bg}]}>
                      <Icon name={iconConf.name} size={18} color={iconConf.color} />
                    </View>
                    <View style={styles.docInfo}>
                      <Text style={styles.docName} numberOfLines={1}>{a.name}</Text>
                      <Text style={styles.docMeta}>{humanSize(a.size)}</Text>
                    </View>
                    <Text style={styles.docDate}>{humanDate(a.createdAt)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )
        )}
      </ScrollView>

      {/* Upload sheet */}
      <Modal visible={uploadOpen} transparent animationType="fade" onRequestClose={() => setUploadOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setUploadOpen(false)}>
          <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Add to Vault</Text>
            <Text style={styles.sheetHint}>Files are encrypted with AES-256 before upload.</Text>
            <TouchableOpacity style={styles.sheetRow} onPress={() => { void captureImage(); }} activeOpacity={0.75}>
              <View style={[styles.sheetIcon, {backgroundColor: 'rgba(30,136,255,0.12)'}]}>
                <Icon name="camera-outline" size={20} color="#60A5FA" />
              </View>
              <Text style={styles.sheetRowText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetRow} onPress={() => { void pickImage(); }} activeOpacity={0.75}>
              <View style={[styles.sheetIcon, {backgroundColor: 'rgba(167,139,250,0.12)'}]}>
                <Icon name="image-outline" size={20} color="#A78BFA" />
              </View>
              <Text style={styles.sheetRowText}>Photo from Library</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetRow} onPress={() => { void pickDocument(); }} activeOpacity={0.75}>
              <View style={[styles.sheetIcon, {backgroundColor: 'rgba(74,222,128,0.12)'}]}>
                <Icon name="file-outline" size={20} color="#4ade80" />
              </View>
              <Text style={styles.sheetRowText}>Document</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setUploadOpen(false)} activeOpacity={0.75}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Shared image/audio/video viewer */}
      <FileViewer
        file={viewerFile}
        onClose={() => setViewerFile(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingTop:6, paddingBottom:8, borderBottomWidth:1, borderBottomColor:'rgba(30,136,255,0.1)'},
  headerLeft: {flexDirection:'row', alignItems:'center', gap:8},
  headerTitle: {color:'#FFFFFF', fontSize:16, fontWeight:'700'},
  uploadBtn: {width:36, height:36, borderRadius:10, backgroundColor:ACTION.default, alignItems:'center', justifyContent:'center', shadowColor: ACTION.default, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 4},
  uploadBtnPressed: {backgroundColor: ACTION.pressed, shadowOpacity: 0.55, transform: [{scale: 0.94}]},

  encWrap: {padding:12},
  encCard: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', borderRadius:12, borderWidth:1, borderColor:'rgba(30,136,255,0.2)', backgroundColor:'rgba(30,136,255,0.07)', paddingHorizontal:12, paddingVertical:10},
  encLeft: {flexDirection:'row', alignItems:'center', gap:10},
  encIcon: {width:32, height:32, borderRadius:16, backgroundColor:'rgba(30,136,255,0.15)', alignItems:'center', justifyContent:'center'},
  encTitle: {color:'#FFFFFF', fontSize:12, fontWeight:'700'},
  encSub: {color:'#B8C7E0', fontSize:10, marginTop:1},
  encBadgeActive: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  encBadgeActiveText: {color: '#4ade80', fontSize: 9, fontWeight: '800', letterSpacing: 1.2},

  tabs: {flexDirection:'row', paddingHorizontal:12, gap:16, borderBottomWidth:1, borderBottomColor:'rgba(30,136,255,0.1)'},
  tab: {paddingVertical:8, paddingHorizontal:4, position:'relative'},
  tabText: {color:'#7E8AA6', fontSize:12, fontWeight:'700'},
  tabTextActive: {color:'#1E88FF'},
  tabUnderline: {position:'absolute', bottom:0, left:0, right:0, height:2, backgroundColor:Colors.primary, borderRadius:1},

  content: {paddingHorizontal:12, paddingTop:12},
  section: {marginBottom:20},
  sectionHeader: {flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:8},
  sectionTitle: {color:'#FFFFFF', fontSize:14, fontWeight:'700'},
  viewAll: {color:'#1E88FF', fontSize:12, fontWeight:'600'},

  imageGrid: {flexDirection:'row', gap:8},
  imageCell: {flex:1, gap:4, maxWidth: '33%'},
  imageBox: {height:110, borderRadius:12, backgroundColor:'#162F54', alignItems:'center', justifyContent:'center', position:'relative', overflow: 'hidden'},
  imageThumb: {width: '100%', height: '100%'},
  shieldBadge: {position:'absolute', top:6, right:6, width:24, height:24, borderRadius:12, backgroundColor:'rgba(30,136,255,0.9)', alignItems:'center', justifyContent:'center'},
  imageName: {color:'#B8C7E0', fontSize:10, fontWeight:'500'},

  docList: {gap:8},
  docRow: {flexDirection:'row', alignItems:'center', gap:12, backgroundColor:'#162F54', borderRadius:12, borderWidth:1, borderColor:'#1C3B66', padding:10},
  docIcon: {width:36, height:36, borderRadius:8, alignItems:'center', justifyContent:'center', flexShrink:0},
  docInfo: {flex:1, minWidth:0},
  docName: {color:'#FFFFFF', fontSize:12, fontWeight:'700'},
  docMeta: {color:'#7E8AA6', fontSize:10, marginTop:2},
  docRight: {alignItems:'flex-end', gap:2},
  docDate: {color:'#7E8AA6', fontSize:9, fontWeight:'500', textTransform:'uppercase'},

  emptyState: {flex:1, alignItems:'center', justifyContent:'center', paddingTop:60, gap:10, paddingHorizontal: 32},
  emptyText: {color:'#B8C7E0', fontSize:14, fontWeight:'700', marginTop: 6},
  emptyHint: {color: '#7E8AA6', fontSize: 11, textAlign: 'center', lineHeight: 16},
  emptyCta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 99, backgroundColor: ACTION.default, shadowColor: ACTION.default, shadowOpacity: 0.35, shadowRadius: 10, elevation: 4},
  emptyCtaPressed: {backgroundColor: ACTION.pressed, transform: [{scale: 0.97}]},
  emptyCtaText: {color: '#FFF', fontSize: 13, fontWeight: '800'},

  // Upload sheet
  sheetBackdrop: {flex: 1, backgroundColor: 'rgba(6,20,43,0.75)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: '#07090D', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 8, paddingBottom: 32, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: '#244C82'},
  sheetTitle: {color: '#FFF', fontSize: 16, fontWeight: '800', textAlign: 'center', marginTop: 12},
  sheetHint: {color: '#7E8AA6', fontSize: 11, textAlign: 'center', marginTop: 4, marginBottom: 12},
  sheetRow: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, marginVertical: 2, backgroundColor: 'rgba(30,136,255,0.04)'},
  sheetIcon: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  sheetRowText: {color: '#FFF', fontSize: 14, fontWeight: '700'},
  sheetCancel: {marginTop: 10, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: 'rgba(180,199,224,0.06)'},
  sheetCancelText: {color: '#B8C7E0', fontSize: 13, fontWeight: '700'},
}));
