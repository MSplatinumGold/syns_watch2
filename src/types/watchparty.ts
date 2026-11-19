export type VoiceMode = 'text' | 'voice';

export interface User {
  id: string;          // Socket.id
  nickname: string;
  prefix?: string;
  isHost: boolean;
  isBuffering: boolean;
  joinedAt: number;
  currentTime?: number;
  voiceMode?: VoiceMode;
  isMicOn?: boolean;
  isSpeaking?: boolean;
}

export interface PlaylistItem {
  id: string;          // UUID
  originalName: string;
  filename: string;    // Имя на диске сервера
  size: number;
  mimeType: string;
  duration?: number;
  url?: string;
}

export interface RoomPlaybackState {
  isPlaying: boolean;
  currentTime: number;
  lastUpdatedServerTime: number;
  isSystemPausedForBuffering: boolean;
}

export interface RoomUploadProgress {
  fileId: string;
  fileName: string;
  percent: number;
  status: 'uploading' | 'retrying' | 'error' | 'completed';
  uploaderName?: string;
}

export interface ReadyCheckState {
  id: string;
  startedBy: string;
  startedAt: number;
  readyUserIds: string[];
}

export interface PinnedChatMessage {
  id: string;
  nickname: string;
  text: string;
  pinnedBy: string;
  pinnedAt: number;
  hasMedia?: boolean;
  mediaKind?: 'image' | 'video' | 'audio';
  isSticker?: boolean;
}

export interface RoomState {
  roomId: string;
  hostId: string;
  users: Record<string, User>;
  playlist: PlaylistItem[];
  currentTrackIndex: number;
  playbackState: RoomPlaybackState;
  activeUpload?: RoomUploadProgress | null;
  readyCheck?: ReadyCheckState | null;
  pinnedMessage?: PinnedChatMessage | null;
  emptyTimeoutId?: NodeJS.Timeout | null;
}

export interface ChatMediaAttachment {
  id: string;
  url: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  mediaKind: 'image' | 'video' | 'audio';
  expired?: boolean;
}

export interface ChatReplyRef {
  id: string;
  userId: string;
  nickname: string;
  text: string;
  hasMedia?: boolean;
  mediaKind?: 'image' | 'video' | 'audio';
  isSticker?: boolean;
}

export interface ChatMessage {
  id: string;
  userId: string;
  nickname: string;
  prefix?: string;
  text: string;
  timestamp: number;
  editedAt?: number;
  type: 'message' | 'system' | 'action';
  media?: ChatMediaAttachment;
  stickerId?: string;
  stickerUrl?: string;
  replyTo?: ChatReplyRef;
}

export interface DanmakuItem extends ChatMessage {
  topPercent: number; // For floating danmaku position
}

export interface FloatingEmojiItem {
  id: string;
  emoji: string;
  nickname: string;
  xPercent: number;
}

export interface VoiceSignalPayload {
  type: 'offer' | 'answer' | 'ice-candidate';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export interface ClientToServerEvents {
  'room:join': (payload: { roomId: string; nickname: string; hostToken?: string }) => void;
  'user:change_nickname': (payload: { nickname: string }) => void;
  'user:set_prefix': (payload: { targetUserId: string; prefix: string }) => void;
  'sync:time_ping': (payload: { clientSentAt: number }) => void;
  'host:play': (payload: { currentTime: number }) => void;
  'host:pause': (payload: { currentTime: number }) => void;
  'host:seek': (payload: { targetTime: number }) => void;
  'host:force_play': () => void;
  'host:change_track': (payload: { trackIndex: number }) => void;
  'host:reorder_playlist': (payload: { newOrderIds: string[] }) => void;
  'host:delete_track': (payload: { fileId: string }) => void;
  'host:transfer_host': (payload: { newHostUserId: string }) => void;
  'host:start_ready_check': () => void;
  'host:cancel_ready_check': () => void;
  'client:ready_confirm': () => void;
  'host:pin_message': (payload: {
    messageId: string;
    text?: string;
    nickname?: string;
    hasMedia?: boolean;
    mediaKind?: 'image' | 'video' | 'audio';
    isSticker?: boolean;
  }) => void;
  'host:unpin_message': () => void;
  'client:buffering_start': () => void;
  'client:buffering_end': () => void;
  'client:progress': (payload: { currentTime: number }) => void;
  'host:close_room': () => void;
  'chat:send': (payload: { text: string; replyTo?: ChatReplyRef; stickerId?: string }) => void;
  'chat:edit': (payload: { messageId: string; text: string }) => void;
  'chat:delete': (payload: { messageId: string }) => void;
  'chat:typing': (payload: { isTyping: boolean }) => void;
  'chat:floating_emoji': (payload: { emoji: string }) => void;
  'upload:progress': (payload: {
    fileId: string;
    fileName: string;
    percent: number;
    status: 'uploading' | 'retrying' | 'error' | 'completed';
  }) => void;
  'upload:clear': (payload: { fileId: string }) => void;
  'voice:state': (payload: { mode: VoiceMode; isMicOn: boolean; isSpeaking: boolean }) => void;
  'voice:signal': (payload: VoiceSignalPayload & { targetUserId: string }) => void;
}

export interface ServerToClientEvents {
  'room:init_state': (state: RoomState) => void;
  'room:user_joined': (user: User) => void;
  'room:user_left': (payload: { userId: string; newHostId?: string }) => void;
  'room:user_updated': (payload: { userId: string; nickname: string }) => void;
  'room:user_prefix_updated': (payload: { userId: string; prefix: string }) => void;
  'room:host_changed': (payload: { hostId: string }) => void;
  'sync:time_pong': (payload: { clientSentAt: number; serverTime: number }) => void;
  'sync:play': (payload: { currentTime: number; serverTimestamp: number }) => void;
  'sync:pause': (payload: { currentTime: number }) => void;
  'sync:seek': (payload: { targetTime: number }) => void;
  'sync:buffering_wait': (payload: { waitingForUsers: string[] }) => void;
  'sync:buffering_resolved': () => void;
  'playlist:updated': (payload: { playlist: PlaylistItem[]; currentTrackIndex: number }) => void;
  'users:progress': (payload: { userId: string; currentTime: number }) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:edited': (payload: { messageId: string; text: string; editedAt: number }) => void;
  'chat:deleted': (payload: { messageId: string }) => void;
  'chat:typing': (payload: { userId: string; nickname: string; isTyping: boolean }) => void;
  'chat:floating_emoji': (item: FloatingEmojiItem) => void;
  'chat:media_pruned': (payload: { deletedMediaIds: string[] }) => void;
  'chat:pinned_updated': (pinned: PinnedChatMessage | null) => void;
  'room:ready_check_updated': (readyCheck: ReadyCheckState | null) => void;
  'upload:progress': (progress: RoomUploadProgress | null) => void;
  'voice:user_state': (payload: {
    userId: string;
    mode: VoiceMode;
    isMicOn: boolean;
    isSpeaking: boolean;
  }) => void;
  'voice:signal': (payload: VoiceSignalPayload & { fromUserId: string }) => void;
  'room:closed': (payload: { reason: string }) => void;
  'error:notification': (payload: { message: string }) => void;
}

