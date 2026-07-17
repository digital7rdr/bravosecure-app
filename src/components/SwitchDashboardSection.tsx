/**
 * B-91 M0 — "Switch Dashboard" (spec pp.12/21/26).
 *
 * The ONLY sanctioned cross-product control: lists the two products the user
 * is NOT currently in (never the active one), with the exact product names —
 * no "Open" prefix. Selecting one remounts the client shell on that product,
 * which structurally resets the old product's navigation stack. `guard`
 * lets the host veto a switch (M3's unsaved-booking confirm).
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {
  useProductStore,
  switchProduct,
  PRODUCT_LABELS,
  type BravoProduct,
} from '@store/productStore';

const PRODUCT_ICONS: Record<BravoProduct, React.ComponentProps<typeof Icon>['name']> = {
  messenger: 'message-lock-outline',
  secure: 'shield-check-outline',
  vbg: 'shield-account-outline',
};

const ALL_PRODUCTS: BravoProduct[] = ['messenger', 'secure', 'vbg'];

interface Props {
  /** Called before switching; return false to abort (e.g. unsaved booking). */
  guard?: (next: BravoProduct) => boolean;
  /** Called after a successful switch (hosts close their drawer/modal). */
  onSwitched?: (next: BravoProduct) => void;
  /** Called after the product gate is re-opened (hosts close their drawer/modal). */
  onOpenGate?: () => void;
}

export function SwitchDashboardSection({guard, onSwitched, onOpenGate}: Props) {
  const activeProduct = useProductStore(s => s.activeProduct);
  const options = ALL_PRODUCTS.filter(p => p !== activeProduct);

  // B-95 — reopen the post-login "where would you like to start?" gate. The
  // gate's own pick handler runs the unsaved-booking confirm, so no guard here.
  const openGate = () => {
    useProductStore.getState().requestGate();
    onOpenGate?.();
  };

  const attempt = (p: BravoProduct) => {
    if (guard && !guard(p)) {return;}
    // B-91 M3 R5 — leaving Secure Services with an unfinished booking form
    // must warn first (spec p.26). An in-flight booking switches freely.
    if (activeProduct === 'secure') {
      const {isBookingDraftDirty} =
        require('@store/bookingStore') as typeof import('@store/bookingStore');
      if (isBookingDraftDirty()) {
        const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
        Alert.alert(
          'Booking in progress',
          'You have an unfinished booking. Leave Secure Services and discard it?',
          [
            {text: 'Stay', style: 'cancel'},
            {
              text: 'Leave',
              style: 'destructive',
              onPress: () => { if (switchProduct(p)) {onSwitched?.(p);} },
            },
          ],
        );
        return;
      }
    }
    if (switchProduct(p)) {onSwitched?.(p);}
  };

  return (
    <View style={s.wrap}>
      <Text style={s.header}>SWITCH DASHBOARD</Text>
      {options.map(p => (
        <TouchableOpacity
          key={p}
          style={s.row}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Switch to ${PRODUCT_LABELS[p]}`}
          onPress={() => attempt(p)}>
          <View style={s.rowLeft}>
            <Icon name={PRODUCT_ICONS[p]} size={19} color="#5B8DEF" />
            <Text style={s.rowLabel}>{PRODUCT_LABELS[p]}</Text>
          </View>
          <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={s.row}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Choose dashboard"
        onPress={openGate}>
        <View style={s.rowLeft}>
          <Icon name="view-grid-outline" size={19} color="#5B8DEF" />
          <Text style={s.rowLabel}>Choose Dashboard</Text>
        </View>
        <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {marginTop: 8},
  header: {
    fontFamily: 'monospace', fontSize: 10, fontWeight: '700', letterSpacing: 2.5,
    color: 'rgba(180,188,204,0.45)', paddingHorizontal: 4, marginBottom: 6,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rowLeft: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rowLabel: {color: '#F2F4F8', fontSize: 14, fontWeight: '600'},
});
