import {useEffect} from 'react';
import {supabase} from '@services/supabase';
import {useMessengerStore} from '@store/messengerStore';
import {useAuthStore} from '@store/authStore';
import type {Message} from '@appTypes/index';

/**
 * Subscribes to incoming messages for the current user via Supabase Realtime.
 * Runs globally in MessengerHomeScreen so new messages arrive in any conversation.
 */
export function useRealtimeMessages() {
  const {receiveMessage} = useMessengerStore();
  const {user} = useAuthStore();

  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`inbox:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `recipient_id=eq.${user.id}`,
        },
        payload => {
          receiveMessage(payload.new as Message);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, receiveMessage]);
}
