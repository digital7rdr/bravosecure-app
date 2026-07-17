/**
 * Twilio Conversations client
 * Used for encrypted in-app messaging (1:1 and group chats)
 * Twilio Conversations SDK for React Native is accessed via REST from the Vercel API.
 * The Railway Go service handles Signal Protocol key exchange.
 */
import api from './api';
import type {Message, Conversation} from '@appTypes/index';

// ─── Conversations ────────────────────────────────────────────────────────────

export const twilioMessaging = {
  /**
   * Get or create a Twilio Conversations access token
   * (fetched from Vercel API which holds Twilio credentials securely)
   */
  getAccessToken: (): Promise<{token: string; identity: string}> =>
    api.post('/messaging/token').then(r => r.data),

  // ─── Conversations management ─────────────────────────────────────────────

  listConversations: (): Promise<Conversation[]> =>
    api.get('/messaging/conversations').then(r => r.data),

  createDirect: (participantUserId: string): Promise<Conversation> =>
    api.post('/messaging/conversations/direct', {participantUserId}).then(r => r.data),

  createGroup: (name: string, participantUserIds: string[]): Promise<Conversation> =>
    api.post('/messaging/conversations/group', {name, participantUserIds}).then(r => r.data),

  // ─── Messages ─────────────────────────────────────────────────────────────

  getMessages: (
    conversationId: string,
    params?: {before?: string; limit?: number},
  ): Promise<Message[]> =>
    api.get(`/messaging/conversations/${conversationId}/messages`, {params}).then(r => r.data),

  sendMessage: (
    conversationId: string,
    content: string,
    selfDestructSeconds?: number | null,
  ): Promise<Message> =>
    api
      .post(`/messaging/conversations/${conversationId}/messages`, {
        content,
        self_destruct_seconds: selfDestructSeconds,
      })
      .then(r => r.data),

  sendMedia: (
    conversationId: string,
    fileUri: string,
    mimeType: string,
    fileName: string,
  ): Promise<Message> => {
    const formData = new FormData();
    formData.append('file', {uri: fileUri, type: mimeType, name: fileName} as unknown as Blob);
    return api
      .post(`/messaging/conversations/${conversationId}/media`, formData, {
        headers: {'Content-Type': 'multipart/form-data'},
      })
      .then(r => r.data);
  },

  markRead: (conversationId: string): Promise<void> =>
    api.post(`/messaging/conversations/${conversationId}/read`).then(() => undefined),

  // ─── Ops Channel (booking encrypted chat) ────────────────────────────────

  getBookingChannel: (bookingId: string): Promise<Conversation> =>
    api.get(`/messaging/booking-channel/${bookingId}`).then(r => r.data),
};
