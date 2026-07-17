/**
 * B-91 M0/M1 — the shared left-side profile drawer (spec pp.12/21/26).
 *
 * One drawer for all three product shells: account rows (kept "as currently
 * designed" per spec p.12 — My Profile, My Bookings, Bravo Pro), the
 * Switch Dashboard section (the ONLY cross-product control), and Log Out.
 * Hosts mount it behind an avatar control and pass a `guard` when leaving
 * the product needs a confirm (M3's unsaved-booking case).
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Image, ScrollView} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {useAuthStore} from '@store/authStore';
import {SwitchDashboardSection} from '@components/SwitchDashboardSection';
import type {BravoProduct} from '@store/productStore';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Veto a product switch (e.g. unsaved booking). */
  switchGuard?: (next: BravoProduct) => boolean;
}

type MenuRow = {icon: React.ComponentProps<typeof Icon>['name']; label: string; go: () => void};

export function ProfileDrawerModal({visible, onClose, switchGuard}: Props) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<{navigate: (name: string, params?: object) => void}>();
  const {user, signOut} = useAuthStore();

  const initials = (user?.full_name ?? user?.email ?? 'B')
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';

  const go = (name: string, params?: object) => {
    onClose();
    setTimeout(() => navigation.navigate(name, params), 220);
  };

  const rows: MenuRow[] = [
    {icon: 'account', label: 'My Profile', go: () => go('ProfileTab')},
    {icon: 'calendar', label: 'My Bookings', go: () => go('SecureTab', {screen: 'BookingHome'})},
    {icon: 'check-decagram', label: 'Bravo Pro', go: () => go('SecureTab', {screen: 'ProLanding'})},
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close drawer">
        <Pressable
          style={[s.panel, {paddingTop: insets.top + 18, paddingBottom: insets.bottom + 16}]}
          onPress={e => e.stopPropagation()}>
          {/* Identity */}
          <View style={s.identity}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={s.avatar} />
            ) : (
              <View style={[s.avatar, s.avatarFallback]}>
                <Text style={s.avatarText}>{initials}</Text>
              </View>
            )}
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.name} numberOfLines={1}>{user?.full_name ?? 'Bravo user'}</Text>
              <Text style={s.email} numberOfLines={1}>{user?.email ?? ''}</Text>
            </View>
          </View>

          <ScrollView style={{flex: 1}} showsVerticalScrollIndicator={false}>
            {rows.map(row => (
              <TouchableOpacity
                key={row.label}
                style={s.row}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={row.label}
                onPress={row.go}>
                <View style={s.rowLeft}>
                  <Icon name={row.icon} size={19} color="#5B8DEF" />
                  <Text style={s.rowLabel}>{row.label}</Text>
                </View>
                <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
              </TouchableOpacity>
            ))}

            <View style={{marginTop: 18}}>
              <SwitchDashboardSection
                guard={switchGuard}
                onSwitched={() => onClose()}
                onOpenGate={() => onClose()}
              />
            </View>
          </ScrollView>

          <TouchableOpacity
            style={s.logout}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Log out"
            onPress={() => { onClose(); void signOut(); }}>
            <Icon name="logout" size={18} color="#FF5D5D" />
            <Text style={s.logoutText}>Log Out</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', flexDirection: 'row'},
  panel: {
    width: '78%', maxWidth: 340, height: '100%',
    backgroundColor: '#07090D', paddingHorizontal: 18,
    borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.08)',
  },
  identity: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingBottom: 16, marginBottom: 8,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  avatar: {width: 46, height: 46, borderRadius: 23},
  avatarFallback: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  avatarText: {color: '#A9C5FF', fontSize: 15, fontWeight: '800'},
  name: {color: '#F2F4F8', fontSize: 15, fontWeight: '700'},
  email: {color: 'rgba(180,188,204,0.45)', fontSize: 11.5, marginTop: 2},
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rowLeft: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rowLabel: {color: '#F2F4F8', fontSize: 14, fontWeight: '600'},
  logout: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    height: 48, borderRadius: 14, marginTop: 12,
    backgroundColor: 'rgba(255,93,93,0.07)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.26)',
  },
  logoutText: {color: '#FF5D5D', fontSize: 13.5, fontWeight: '700'},
});
