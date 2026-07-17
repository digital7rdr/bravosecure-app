/**
 * Mobile-side adapter that exposes the local `useMessengerStore.groups`
 * slice as a platform-agnostic `GroupKeySource` (defined in
 * messenger-core). `useGroupCall` constructs a `GroupCallEncryption`
 * and wires this in as the keySource.
 *
 * Kept separate from the platform-agnostic orchestrator so that the
 * orchestrator can be tested in messenger-core's Node-mode jest
 * project without dragging in the messengerStore + SQLCipher graph.
 */

import type {GroupKeySource} from '@bravo/messenger-core';
import {useMessengerStore} from '../store/messengerStore';

export const messengerStoreKeySource: GroupKeySource = {
  current(conversationId) {
    const s = useMessengerStore.getState().groups[conversationId];
    if (!s?.masterKeyB64) {return null;}
    return {masterKeyB64: s.masterKeyB64, epoch: s.epoch};
  },
  subscribe(conversationId, listener) {
    let lastKey   = '';
    let lastEpoch = -1;
    return useMessengerStore.subscribe((state) => {
      const g = state.groups[conversationId];
      if (!g?.masterKeyB64) {return;}
      if (g.masterKeyB64 === lastKey && g.epoch === lastEpoch) {return;}
      lastKey   = g.masterKeyB64;
      lastEpoch = g.epoch;
      listener({masterKeyB64: g.masterKeyB64, epoch: g.epoch});
    });
  },
};
