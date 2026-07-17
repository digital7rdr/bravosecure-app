import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {twilioMessaging} from '@services/twilio';
import type {Conversation, Message} from '@appTypes/index';

interface MessengerState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  error: string | null;
}

interface MessengerActions {
  loadConversations: () => Promise<void>;
  setActiveConversation: (id: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  sendMessage: (conversationId: string, content: string, selfDestructSeconds?: number | null) => Promise<void>;
  receiveMessage: (message: Message) => void;
  markRead: (conversationId: string) => Promise<void>;
  createDirect: (userId: string) => Promise<Conversation>;
  createGroup: (name: string, userIds: string[]) => Promise<Conversation>;
  clearError: () => void;
}

export const useMessengerStore = create<MessengerState & MessengerActions>()(
  immer((set, get) => ({
    conversations: [],
    activeConversationId: null,
    messages: {},
    isLoadingConversations: false,
    isLoadingMessages: false,
    error: null,

    loadConversations: async () => {
      set(s => {s.isLoadingConversations = true;});
      try {
        const convos = await twilioMessaging.listConversations();
        set(s => {s.conversations = convos;});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load conversations';});
      } finally {
        set(s => {s.isLoadingConversations = false;});
      }
    },

    setActiveConversation: (id: string) =>
      set(s => {s.activeConversationId = id;}),

    loadMessages: async (conversationId: string) => {
      set(s => {s.isLoadingMessages = true;});
      try {
        const msgs = await twilioMessaging.getMessages(conversationId);
        set(s => {s.messages[conversationId] = msgs;});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load messages';});
      } finally {
        set(s => {s.isLoadingMessages = false;});
      }
    },

    sendMessage: async (conversationId, content, selfDestructSeconds) => {
      try {
        const msg = await twilioMessaging.sendMessage(conversationId, content, selfDestructSeconds);
        set(s => {
          if (!s.messages[conversationId]) s.messages[conversationId] = [];
          s.messages[conversationId].push(msg);
          // Update last message in conversation list
          const convo = s.conversations.find(c => c.id === conversationId);
          if (convo) convo.last_message = msg;
        });
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to send message';});
        throw e;
      }
    },

    receiveMessage: (message: Message) =>
      set(s => {
        const cid = message.conversation_id;
        if (!s.messages[cid]) s.messages[cid] = [];
        // Avoid duplicates
        if (!s.messages[cid].find(m => m.id === message.id)) {
          s.messages[cid].push(message);
        }
        const convo = s.conversations.find(c => c.id === cid);
        if (convo) {
          convo.last_message = message;
          if (get().activeConversationId !== cid) convo.unread_count++;
        }
      }),

    markRead: async (conversationId: string) => {
      await twilioMessaging.markRead(conversationId);
      set(s => {
        const convo = s.conversations.find(c => c.id === conversationId);
        if (convo) convo.unread_count = 0;
      });
    },

    createDirect: async (userId: string) => {
      const convo = await twilioMessaging.createDirect(userId);
      set(s => {
        if (!s.conversations.find(c => c.id === convo.id)) {
          s.conversations.unshift(convo);
        }
      });
      return convo;
    },

    createGroup: async (name: string, userIds: string[]) => {
      const convo = await twilioMessaging.createGroup(name, userIds);
      set(s => {s.conversations.unshift(convo);});
      return convo;
    },

    clearError: () => set(s => {s.error = null;}),
  })),
);
