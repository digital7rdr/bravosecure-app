/**
 * Agora RTC — Voice & Video Calls
 * Peer-to-peer, no media passes through our servers
 */
import {
  createAgoraRtcEngine,
  IRtcEngine,
  RtcConnection,
  ChannelProfileType,
  ClientRoleType,
} from 'react-native-agora';
import {AGORA_APP_ID} from '@utils/constants';
import api from './api';

let engine: IRtcEngine | null = null;

export type CallType = 'voice' | 'video';

export interface AgoraToken {
  token: string;
  channel: string;
  uid: number;
}

// ─── Engine Lifecycle ────────────────────────────────────────────────────────

export const agoraService = {
  initialize: (): IRtcEngine => {
    if (engine) return engine;
    engine = createAgoraRtcEngine();
    engine.initialize({appId: AGORA_APP_ID});
    engine.setChannelProfile(ChannelProfileType.ChannelProfileCommunication);
    return engine;
  },

  destroy: (): void => {
    if (engine) {
      engine.leaveChannel();
      engine.release();
      engine = null;
    }
  },

  getEngine: (): IRtcEngine | null => engine,

  // ─── Token ────────────────────────────────────────────────────────────────

  getToken: (conversationId: string, callType: CallType): Promise<AgoraToken> =>
    api
      .post('/calls/token', {conversation_id: conversationId, call_type: callType})
      .then(r => r.data),

  // ─── Call Actions ────────────────────────────────────────────────────────

  joinChannel: async (
    token: string,
    channel: string,
    uid: number,
    callType: CallType,
  ): Promise<void> => {
    if (!engine) agoraService.initialize();
    engine!.setClientRole(ClientRoleType.ClientRoleBroadcaster);
    if (callType === 'video') {
      engine!.enableVideo();
    } else {
      engine!.disableVideo();
      engine!.enableAudio();
    }
    engine!.joinChannel(token, channel, uid, {});
  },

  leaveChannel: (): void => {
    engine?.leaveChannel();
  },

  toggleMute: (muted: boolean): void => {
    engine?.muteLocalAudioStream(muted);
  },

  toggleCamera: (enabled: boolean): void => {
    engine?.enableLocalVideo(enabled);
  },

  switchCamera: (): void => {
    engine?.switchCamera();
  },

  toggleSpeaker: (speakerOn: boolean): void => {
    engine?.setEnableSpeakerphone(speakerOn);
  },

  // ─── Event listeners (attach in screen) ─────────────────────────────────

  onUserJoined: (callback: (connection: RtcConnection, uid: number) => void): void => {
    engine?.addListener('onUserJoined', callback);
  },

  onUserOffline: (callback: (connection: RtcConnection, uid: number) => void): void => {
    engine?.addListener('onUserOffline', callback);
  },

  removeAllListeners: (): void => {
    engine?.removeAllListeners();
  },
};
