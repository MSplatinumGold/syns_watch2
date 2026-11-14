export interface User {
  id: string;          // Socket.id
  nickname: string;
  isHost: boolean;
  isBuffering: boolean;
  joinedAt: number;
  currentTime?: number;
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

export interface RoomState {
  roomId: string;
  hostId: string;
  users: Record<string, User>;
  playlist: PlaylistItem[];
  currentTrackIndex: number;
  playbackState: RoomPlaybackState;
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

export interface ChatMessage {
  id: string;
  userId: string;
  nickname: string;
  text: string;
  timestamp: number;
  type: 'message' | 'system';
  media?: ChatMediaAttachment;
}

export interface DanmakuItem extends ChatMessage {
  topPercent: number; // For floating danmaku position
}

export interface ClientToServerEvents {
  'room:join': (payload: { roomId: string; nickname: string; hostToken?: string }) => void;
  'user:change_nickname': (payload: { nickname: string }) => void;
  'sync:time_ping': (payload: { clientSentAt: number }) => void;
  'host:play': (payload: { currentTime: number }) => void;
  'host:pause': (payload: { currentTime: number }) => void;
  'host:seek': (payload: { targetTime: number }) => void;
  'host:force_play': () => void;
  'host:change_track': (payload: { trackIndex: number }) => void;
  'host:reorder_playlist': (payload: { newOrderIds: string[] }) => void;
  'host:delete_track': (payload: { fileId: string }) => void;
  'host:transfer_host': (payload: { newHostUserId: string }) => void;
  'client:buffering_start': () => void;
  'client:buffering_end': () => void;
  'client:progress': (payload: { currentTime: number }) => void;
  'host:close_room': () => void;
  'chat:send': (payload: { text: string }) => void;
}

export interface ServerToClientEvents {
  'room:init_state': (state: RoomState) => void;
  'room:user_joined': (user: User) => void;
  'room:user_left': (payload: { userId: string; newHostId?: string }) => void;
  'room:user_updated': (payload: { userId: string; nickname: string }) => void;
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
  'chat:media_pruned': (payload: { deletedMediaIds: string[] }) => void;
  'room:closed': (payload: { reason: string }) => void;
  'error:notification': (payload: { message: string }) => void;
}
