/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  RoomState,
  User,
  PlaylistItem,
  ChatMessage,
  ChatReplyRef,
  DanmakuItem,
  FloatingEmojiItem,
  RoomUploadProgress,
  ClientToServerEvents,
  ServerToClientEvents,
} from './types/watchparty.ts';
import { Navbar } from './components/Navbar.tsx';
import { VideoPlayer } from './components/VideoPlayer.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { PlaylistPanel } from './components/PlaylistPanel.tsx';
import { ParticipantsPanel } from './components/ParticipantsPanel.tsx';
import { JoinModal } from './components/JoinModal.tsx';
import { SiteMechanicsModal } from './components/SiteMechanicsModal.tsx';
import {
  clearAllSessionMediaCaches,
  registerLocalTrackFile,
  revokeLocalTrackUrl,
} from './utils/mediaCache.ts';
import { applyUiTheme, getSavedUiTheme, type UiThemeId } from './utils/themes.ts';
import type { MechanicsTabId } from './utils/mechanics.ts';
import {
  MessageSquare,
  Film,
  Users,
  ChevronUp,
  ChevronDown,
  GripHorizontal,
  AlertCircle,
  X,
} from 'lucide-react';

export default function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>('');
  const [hostToken, setHostToken] = useState<string>('');
  const [socketId, setSocketId] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);

  // Active tab on mobile/desktop right sidebar
  const [activeTab, setActiveTab] = useState<'chat' | 'playlist' | 'participants'>('chat');
  const [unreadChatCount, setUnreadChatCount] = useState(0);

  // Room state
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [danmakuItems, setDanmakuItems] = useState<DanmakuItem[]>([]);
  const [floatingEmojis, setFloatingEmojis] = useState<FloatingEmojiItem[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [bufferingUsers, setBufferingUsers] = useState<string[]>([]);
  const [roomUploadProgress, setRoomUploadProgress] = useState<RoomUploadProgress | null>(null);
  const [localTrackUrls, setLocalTrackUrls] = useState<Record<string, string>>({});
  const [uiTheme, setUiTheme] = useState<UiThemeId>(() => getSavedUiTheme());
  const [ambilightEnabled, setAmbilightEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('watchparty_ambilight');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [mechanicsModal, setMechanicsModal] = useState<{ open: boolean; tab: MechanicsTabId }>({
    open: false,
    tab: 'player',
  });

  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const roomIdRef = useRef<string | null>(null);
  roomIdRef.current = roomId;
  const loadedChatRoomRef = useRef<string | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const nicknameRef = useRef<string>('');
  nicknameRef.current = nickname;

  // Check initial query parameter ?room=...
  const [initialUrlRoomId, setInitialUrlRoomId] = useState<string | undefined>(undefined);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape');
  const [isTablet, setIsTablet] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const [customViewportHeight, setCustomViewportHeight] = useState<number | null>(null);
  const [portraitVideoPercent, setPortraitVideoPercent] = useState<number>(30);
  const [isPortraitVideoCollapsed, setIsPortraitVideoCollapsed] = useState<boolean>(false);
  const [appNotice, setAppNotice] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  const bestClockRttRef = useRef<number>(Infinity);
  const baselineViewportHeightRef = useRef<number>(
    typeof window !== 'undefined' ? window.innerHeight : 800
  );
  const lastOrientationRef = useRef<'portrait' | 'landscape' | null>(null);
  const portraitMainRef = useRef<HTMLElement>(null);
  const isResizingChatRef = useRef<boolean>(false);
  const danmakuTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const emojiTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const danmakuLaneExpiryRef = useRef<number[]>([0, 0, 0, 0]);
  const danmakuNextLaneRef = useRef<number>(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showAppNotice = useCallback((text: string, type: 'error' | 'info' = 'info') => {
    setAppNotice({ type, text });
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setAppNotice(null);
      noticeTimerRef.current = null;
    }, 6000);
  }, []);

  const clearOverlayTimers = useCallback(() => {
    danmakuTimersRef.current.forEach(clearTimeout);
    danmakuTimersRef.current.clear();
    emojiTimersRef.current.forEach(clearTimeout);
    emojiTimersRef.current.clear();
  }, []);

  // Load cached chat history from sessionStorage when entering a room (persists across F5 until tab/room closes)
  useEffect(() => {
    if (!roomId) {
      loadedChatRoomRef.current = null;
      seenMessageIdsRef.current.clear();
      return;
    }
    try {
      const raw = sessionStorage.getItem(`watchparty_chat_${roomId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (m): m is ChatMessage => Boolean(m && typeof m.id === 'string' && typeof m.timestamp === 'number')
          ).slice(-250);
          seenMessageIdsRef.current = new Set(valid.map((m) => m.id));
          setMessages(valid);
        }
      } else {
        seenMessageIdsRef.current.clear();
      }
    } catch {
      seenMessageIdsRef.current.clear();
    }
    loadedChatRoomRef.current = roomId;
  }, [roomId]);

  // Persist chat history in sessionStorage for the current tab session
  useEffect(() => {
    if (!roomId || loadedChatRoomRef.current !== roomId) return;
    try {
      sessionStorage.setItem(`watchparty_chat_${roomId}`, JSON.stringify(messages.slice(-250)));
    } catch {}
  }, [messages, roomId]);

  // Persist & apply selected UI theme
  useEffect(() => {
    applyUiTheme(uiTheme);
  }, [uiTheme]);

  // Persist Ambilight preference
  useEffect(() => {
    try {
      localStorage.setItem('watchparty_ambilight', String(ambilightEnabled));
    } catch {}
  }, [ambilightEnabled]);

  // Ensure session Blob URLs are released when App unmounts
  useEffect(() => {
    return () => {
      clearAllSessionMediaCaches();
    };
  }, []);

  useEffect(() => {
    const handleLayoutCheck = () => {
      const isTouch =
        'ontouchstart' in window ||
        (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0);

      let isPortrait: boolean;
      if (isTouch && window.screen?.orientation?.type) {
        // Physical device hardware orientation - immune to virtual keyboard resizing
        isPortrait = window.screen.orientation.type.startsWith('portrait');
      } else if (isTouch && typeof window.orientation === 'number') {
        isPortrait = window.orientation === 0 || window.orientation === 180;
      } else if (isTouch && window.screen?.height && window.screen?.width) {
        // Compare physical screen dimensions (static hardware values)
        isPortrait = window.screen.height >= window.screen.width;
      } else {
        // Desktop window resizing
        isPortrait = window.innerHeight >= window.innerWidth;
      }

      const nextOrientation: 'portrait' | 'landscape' = isPortrait ? 'portrait' : 'landscape';
      setOrientation(nextOrientation);
      const effectiveWidth =
        isTouch && window.screen?.width
          ? Math.min(window.innerWidth, window.screen.width)
          : window.innerWidth;
      setIsTablet(effectiveWidth < 1024);

      const vv = window.visualViewport;
      const vvHeight = vv ? vv.height : window.innerHeight;

      if (lastOrientationRef.current !== nextOrientation) {
        lastOrientationRef.current = nextOrientation;
        baselineViewportHeightRef.current = Math.max(vvHeight, window.innerHeight);
      } else if (vvHeight > baselineViewportHeightRef.current) {
        baselineViewportHeightRef.current = vvHeight;
      }

      if (isTouch && isPortrait) {
        const kbOpen = vvHeight < baselineViewportHeightRef.current * 0.78;
        setIsKeyboardOpen(kbOpen);
        if (kbOpen) {
          if (vv && vv.height < window.innerHeight - 20) {
            setCustomViewportHeight(Math.floor(vv.height));
          } else {
            setCustomViewportHeight(null);
          }
          if (window.scrollY !== 0) {
            window.scrollTo(0, 0);
          }
        } else {
          setCustomViewportHeight(null);
        }
      } else {
        setIsKeyboardOpen(false);
        setCustomViewportHeight(null);
      }
    };

    handleLayoutCheck();
    window.addEventListener('resize', handleLayoutCheck);
    window.addEventListener('orientationchange', handleLayoutCheck);
    window.visualViewport?.addEventListener('resize', handleLayoutCheck);
    window.visualViewport?.addEventListener('scroll', handleLayoutCheck);
    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener('change', handleLayoutCheck);
    }
    return () => {
      window.removeEventListener('resize', handleLayoutCheck);
      window.removeEventListener('orientationchange', handleLayoutCheck);
      window.visualViewport?.removeEventListener('resize', handleLayoutCheck);
      window.visualViewport?.removeEventListener('scroll', handleLayoutCheck);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener('change', handleLayoutCheck);
      }
    };
  }, []);

  // Drag handle resize support for portrait mobile chat/video split
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!isResizingChatRef.current || !portraitMainRef.current) return;
      const rect = portraitMainRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const relY = e.clientY - rect.top;
      const percent = (relY / rect.height) * 100;
      if (percent < 10) {
        setIsPortraitVideoCollapsed(true);
      } else {
        setIsPortraitVideoCollapsed(false);
        setPortraitVideoPercent(Math.max(15, Math.min(55, Math.round(percent))));
      }
    };

    const handlePointerUp = () => {
      isResizingChatRef.current = false;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setInitialUrlRoomId(roomFromUrl.trim().toLowerCase());
    }

    // Check saved session
    const savedToken = sessionStorage.getItem('watchparty_host_token');
    if (savedToken) {
      setHostToken(savedToken);
    }
  }, []);

  const hasNickname = Boolean(nickname);

  // Initialize socket connection when roomId and initial nickname are present
  useEffect(() => {
    if (!roomId || !hasNickname) return;

    // Connect to server (using current host)
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    let pingTimeouts: ReturnType<typeof setTimeout>[] = [];
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    const sendTimePing = () => {
      if (socket.connected) {
        socket.emit('sync:time_ping', { clientSentAt: Date.now() });
      }
    };

    socket.on('connect', () => {
      setIsConnected(true);
      if (socket.id) {
        setSocketId(socket.id);
      }
      // Emit room:join using latest nicknameRef so in-lobby nick changes never reconnect
      socket.emit('room:join', {
        roomId,
        nickname: nicknameRef.current,
        hostToken: hostToken || undefined,
      });

      // Calibrate clock offset against server time (3 quick probes + periodic refresh)
      bestClockRttRef.current = Infinity;
      pingTimeouts.forEach(clearTimeout);
      pingTimeouts = [
        setTimeout(sendTimePing, 50),
        setTimeout(sendTimePing, 450),
        setTimeout(sendTimePing, 950),
      ];
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(sendTimePing, 60000);
    });

    socket.on('sync:time_pong', ({ clientSentAt, serverTime }) => {
      const receivedAt = Date.now();
      const rtt = Math.max(0, receivedAt - clientSentAt);
      if (bestClockRttRef.current === Infinity || rtt <= bestClockRttRef.current * 1.25) {
        if (rtt < bestClockRttRef.current) {
          bestClockRttRef.current = rtt;
        }
        const estimatedServerNow = serverTime + rtt / 2;
        setClockOffsetMs(Math.round(estimatedServerNow - receivedAt));
      }
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    // Room initial state
    socket.on('room:init_state', (state: RoomState) => {
      setRoomState(state);
      setRoomUploadProgress(state.activeUpload || null);
      if (state.playbackState.isSystemPausedForBuffering) {
        const waiting = Object.values(state.users)
          .filter((u) => u.isBuffering)
          .map((u) => u.nickname);
        setBufferingUsers(waiting);
      } else {
        setBufferingUsers([]);
      }
    });

    // User joined
    socket.on('room:user_joined', (user: User) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          users: {
            ...prev.users,
            [user.id]: user,
          },
        };
      });
    });

    // User left
    socket.on('room:user_left', ({ userId, newHostId }) => {
      setTypingUsers((prev) => {
        if (!prev[userId]) return prev;
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setRoomState((prev) => {
        if (!prev) return prev;
        const newUsers = { ...prev.users };
        delete newUsers[userId];
        return {
          ...prev,
          hostId: newHostId || prev.hostId,
          users: newUsers,
        };
      });
    });

    // User nickname updated in lobby
    socket.on('room:user_updated', ({ userId, nickname: updatedNick }) => {
      setRoomState((prev) => {
        if (!prev || !prev.users[userId]) return prev;
        return {
          ...prev,
          users: {
            ...prev.users,
            [userId]: {
              ...prev.users[userId],
              nickname: updatedNick,
            },
          },
        };
      });
    });

    // User prefix updated (by any room participant)
    socket.on('room:user_prefix_updated', ({ userId, prefix }) => {
      setRoomState((prev) => {
        if (!prev || !prev.users[userId]) return prev;
        return {
          ...prev,
          users: {
            ...prev.users,
            [userId]: {
              ...prev.users[userId],
              prefix: prefix || undefined,
            },
          },
        };
      });
    });

    // Host changed
    socket.on('room:host_changed', ({ hostId }) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        const updatedUsers = { ...prev.users };
        Object.keys(updatedUsers).forEach((id) => {
          updatedUsers[id] = { ...updatedUsers[id], isHost: id === hostId };
        });
        return {
          ...prev,
          hostId,
          users: updatedUsers,
        };
      });
    });

    // Sync play
    socket.on('sync:play', ({ currentTime, serverTimestamp }) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          playbackState: {
            isPlaying: true,
            currentTime,
            lastUpdatedServerTime: serverTimestamp,
            isSystemPausedForBuffering: false,
          },
        };
      });
      setBufferingUsers([]);
    });

    // Sync pause
    socket.on('sync:pause', ({ currentTime }) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          playbackState: {
            ...prev.playbackState,
            isPlaying: false,
            currentTime,
            lastUpdatedServerTime: Date.now(),
          },
        };
      });
    });

    // Sync seek
    socket.on('sync:seek', ({ targetTime }) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          playbackState: {
            ...prev.playbackState,
            currentTime: targetTime,
            lastUpdatedServerTime: Date.now(),
          },
        };
      });
    });

    // Smart Buffering Wait
    socket.on('sync:buffering_wait', ({ waitingForUsers }) => {
      setBufferingUsers(waitingForUsers);
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          playbackState: {
            ...prev.playbackState,
            isPlaying: false,
            isSystemPausedForBuffering: true,
          },
        };
      });
    });

    // Smart Buffering Resolved
    socket.on('sync:buffering_resolved', () => {
      setBufferingUsers([]);
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          playbackState: {
            ...prev.playbackState,
            isSystemPausedForBuffering: false,
          },
        };
      });
    });

    // Playlist updated
    socket.on('playlist:updated', ({ playlist, currentTrackIndex }) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          playlist,
          currentTrackIndex,
        };
      });
    });

    // Real-time tracking of what second each user is watching
    socket.on('users:progress', ({ userId, currentTime }) => {
      setRoomState((prev) => {
        if (!prev || !prev.users[userId]) return prev;
        return {
          ...prev,
          users: {
            ...prev.users,
            [userId]: {
              ...prev.users[userId],
              currentTime,
            },
          },
        };
      });
    });

    const typingTimers: Record<string, ReturnType<typeof setTimeout>> = {};

    // Chat message received (deduplicated & capped at 250 messages in memory)
    socket.on('chat:message', (message: ChatMessage) => {
      if (seenMessageIdsRef.current.has(message.id)) return;
      seenMessageIdsRef.current.add(message.id);
      if (seenMessageIdsRef.current.size > 400) {
        const oldest = seenMessageIdsRef.current.values().next().value;
        if (oldest) seenMessageIdsRef.current.delete(oldest);
      }

      setMessages((prev) => [...prev, message].slice(-250));

      if (message.type === 'message') {
        if (typingTimers[message.userId]) {
          clearTimeout(typingTimers[message.userId]);
          delete typingTimers[message.userId];
        }
        setTypingUsers((prev) => {
          if (!prev[message.userId]) return prev;
          const next = { ...prev };
          delete next[message.userId];
          return next;
        });
      }

      // Trigger Danmaku item on 4 dedicated bottom lanes to prevent text collisions (mask spoilers)
      if ((message.type === 'message' || message.type === 'action') && message.text) {
        const maskedDanmakuText = message.text.replace(/\|\|[\s\S]+?\|\|/g, '[спойлер]');
        const lanes = [69, 75, 81, 87];
        const now = Date.now();
        let chosenIdx = -1;
        for (let offset = 0; offset < lanes.length; offset++) {
          const idx = (danmakuNextLaneRef.current + offset) % lanes.length;
          if (danmakuLaneExpiryRef.current[idx] <= now) {
            chosenIdx = idx;
            break;
          }
        }
        if (chosenIdx === -1) {
          chosenIdx = danmakuNextLaneRef.current;
        }
        danmakuLaneExpiryRef.current[chosenIdx] = now + 2200;
        danmakuNextLaneRef.current = (chosenIdx + 1) % lanes.length;

        const danmaku: DanmakuItem = {
          ...message,
          text: maskedDanmakuText,
          topPercent: lanes[chosenIdx],
        };
        setDanmakuItems((prev) => [...prev, danmaku]);

        // Auto remove danmaku after 7 seconds
        const timerId = setTimeout(() => {
          danmakuTimersRef.current.delete(timerId);
          setDanmakuItems((prev) => prev.filter((item) => item.id !== danmaku.id));
        }, 7000);
        danmakuTimersRef.current.add(timerId);
      }

      // Increment unread count if chat tab not currently open
      setActiveTab((currentTab) => {
        if (currentTab !== 'chat') {
          setUnreadChatCount((cnt) => cnt + 1);
        }
        return currentTab;
      });
    });

    // Chat message edited by author
    socket.on('chat:edited', ({ messageId, text, editedAt }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === messageId) {
            return { ...m, text, editedAt };
          }
          if (m.replyTo && m.replyTo.id === messageId) {
            return {
              ...m,
              replyTo: { ...m.replyTo, text: text.slice(0, 120) },
            };
          }
          return m;
        })
      );
      const maskedDanmakuText = text.replace(/\|\|[\s\S]+?\|\|/g, '[спойлер]');
      setDanmakuItems((prev) =>
        prev.map((item) =>
          item.id === messageId ? { ...item, text: maskedDanmakuText, editedAt } : item
        )
      );
    });

    // Chat message deleted by author
    socket.on('chat:deleted', ({ messageId }) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setDanmakuItems((prev) => prev.filter((item) => item.id !== messageId));
    });

    // Ready Check updates ("Все на месте? 🍿")
    socket.on('room:ready_check_updated', (readyCheck) => {
      setRoomState((prev) => (prev ? { ...prev, readyCheck } : prev));
    });

    // Pinned host message updates
    socket.on('chat:pinned_updated', (pinnedMessage) => {
      setRoomState((prev) => (prev ? { ...prev, pinnedMessage } : prev));
    });

    // Room-wide video upload progress badge
    socket.on('upload:progress', (progress) => {
      setRoomUploadProgress(progress);
    });

    // Typing indicator
    socket.on('chat:typing', ({ userId, nickname: typerNick, isTyping }) => {
      if (typingTimers[userId]) {
        clearTimeout(typingTimers[userId]);
        delete typingTimers[userId];
      }
      if (!isTyping) {
        setTypingUsers((prev) => {
          if (!prev[userId]) return prev;
          const next = { ...prev };
          delete next[userId];
          return next;
        });
        return;
      }

      setTypingUsers((prev) => ({ ...prev, [userId]: typerNick }));
      typingTimers[userId] = setTimeout(() => {
        delete typingTimers[userId];
        setTypingUsers((prev) => {
          if (!prev[userId]) return prev;
          const next = { ...prev };
          delete next[userId];
          return next;
        });
      }, 3500);
    });

    // Small floating emoji reaction over video (max 5 active per room)
    socket.on('chat:floating_emoji', (item: FloatingEmojiItem) => {
      setFloatingEmojis((prev) => [...prev, item].slice(-5));
      const timerId = setTimeout(() => {
        emojiTimersRef.current.delete(timerId);
        setFloatingEmojis((prev) => prev.filter((f) => f.id !== item.id));
      }, 2500);
      emojiTimersRef.current.add(timerId);
    });

    // Old chat media deleted due to 100 MB FIFO room limit
    socket.on('chat:media_pruned', ({ deletedMediaIds }) => {
      const deletedSet = new Set(deletedMediaIds);
      setMessages((prev) =>
        prev.map((m) =>
          m.media && deletedSet.has(m.media.id)
            ? { ...m, media: { ...m.media, expired: true } }
            : m
        )
      );
    });

    // Server error notification
    socket.on('error:notification', ({ message }) => {
      if (message) showAppNotice(message, 'error');
    });

    // Room closed by host or empty (Item 4)
    socket.on('room:closed', ({ reason }) => {
      showAppNotice(reason || 'Комната была закрыта. Все файлы и данные удалены.', 'info');
      handleLeaveRoom();
    });

    return () => {
      pingTimeouts.forEach(clearTimeout);
      if (pingInterval) clearInterval(pingInterval);
      Object.values(typingTimers).forEach(clearTimeout);
      clearOverlayTimers();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, hasNickname, hostToken, showAppNotice, clearOverlayTimers]);

  // Create room flow via HTTP API
  const handleCreateRoom = async (nick: string) => {
    try {
      const res = await fetch('/api/rooms/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.roomId) {
        setAppNotice(null);
        setNickname(nick);
        setHostToken(data.hostToken);
        sessionStorage.setItem('watchparty_host_token', data.hostToken);
        setRoomId(data.roomId);
        window.history.pushState({}, '', `?room=${data.roomId}`);
      } else {
        throw new Error('Room ID missing');
      }
    } catch (err) {
      console.error('Error creating room:', err);
      showAppNotice('Не удалось создать комнату. Попробуйте еще раз.', 'error');
    }
  };

  // Join room flow
  const handleJoinRoom = (rId: string, nick: string) => {
    setAppNotice(null);
    setNickname(nick);
    setRoomId(rId);
    window.history.pushState({}, '', `?room=${rId}`);
  };

  // Leave room flow
  const handleLeaveRoom = () => {
    clearOverlayTimers();
    clearAllSessionMediaCaches();
    setLocalTrackUrls({});
    const currentRId = roomIdRef.current;
    if (currentRId) {
      try {
        sessionStorage.removeItem(`watchparty_chat_${currentRId}`);
      } catch {}
    }
    loadedChatRoomRef.current = null;
    seenMessageIdsRef.current.clear();
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    setRoomId(null);
    setRoomState(null);
    setMessages([]);
    setDanmakuItems([]);
    setFloatingEmojis([]);
    setRoomUploadProgress(null);
    window.history.pushState({}, '', window.location.pathname);
  };

  // Close room flow (Host purges all room files and users immediately - Item 4)
  const handleCloseRoom = useCallback(() => {
    socketRef.current?.emit('host:close_room');
    handleLeaveRoom();
  }, [clearOverlayTimers]);

  // Switch tab and reset unread
  const handleSelectTab = (tab: 'chat' | 'playlist' | 'participants') => {
    setActiveTab(tab);
    if (tab === 'chat') {
      setUnreadChatCount(0);
    }
  };

  // Video player event callbacks
  const isHost = Boolean(roomState && socketId && roomState.hostId === socketId);

  const handlePlay = useCallback(
    (currentTime: number) => {
      socketRef.current?.emit('host:play', { currentTime });
    },
    []
  );

  const handlePause = useCallback(
    (currentTime: number) => {
      socketRef.current?.emit('host:pause', { currentTime });
    },
    []
  );

  const handleSeek = useCallback(
    (targetTime: number) => {
      socketRef.current?.emit('host:seek', { targetTime });
    },
    []
  );

  const handleForcePlay = useCallback(() => {
    socketRef.current?.emit('host:force_play');
  }, []);

  const handleBufferingStart = useCallback(() => {
    socketRef.current?.emit('client:buffering_start');
  }, []);

  const handleBufferingEnd = useCallback(() => {
    socketRef.current?.emit('client:buffering_end');
  }, []);

  const handleTrackEnded = useCallback(() => {
    if (!roomState) return;
    if (roomState.currentTrackIndex < roomState.playlist.length - 1) {
      socketRef.current?.emit('host:change_track', {
        trackIndex: roomState.currentTrackIndex + 1,
      });
    }
  }, [roomState]);

  const handleChangeTrack = useCallback((trackIndex: number) => {
    socketRef.current?.emit('host:change_track', { trackIndex });
  }, []);

  const handleReorderPlaylist = useCallback((newOrderIds: string[]) => {
    socketRef.current?.emit('host:reorder_playlist', { newOrderIds });
  }, []);

  const handleRegisterLocalTrack = useCallback((fileId: string, file: File) => {
    const blobUrl = registerLocalTrackFile(fileId, file);
    setLocalTrackUrls((prev) => ({ ...prev, [fileId]: blobUrl }));
  }, []);

  const handleRevokeLocalTrack = useCallback((fileId: string) => {
    revokeLocalTrackUrl(fileId);
    setLocalTrackUrls((prev) => {
      if (!prev[fileId]) return prev;
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  }, []);

  const handleDeleteTrack = useCallback((fileId: string) => {
    handleRevokeLocalTrack(fileId);
    socketRef.current?.emit('host:delete_track', { fileId });
  }, [handleRevokeLocalTrack]);

  const handleLocalMediaMessageSent = useCallback((message: ChatMessage) => {
    if (seenMessageIdsRef.current.has(message.id)) return;
    seenMessageIdsRef.current.add(message.id);
    setMessages((prev) => [...prev, message].slice(-250));
  }, []);

  const handleTransferHost = useCallback((newHostUserId: string) => {
    socketRef.current?.emit('host:transfer_host', { newHostUserId });
  }, []);

  const handleSendMessage = useCallback(
    (text: string, replyTo?: ChatReplyRef, stickerId?: string) => {
      socketRef.current?.emit('chat:send', { text, replyTo, stickerId });
    },
    []
  );

  const handleEditMessage = useCallback((messageId: string, text: string) => {
    socketRef.current?.emit('chat:edit', { messageId, text });
  }, []);

  const handleDeleteMessage = useCallback((messageId: string) => {
    socketRef.current?.emit('chat:delete', { messageId });
  }, []);

  const handleTypingChange = useCallback((isTyping: boolean) => {
    socketRef.current?.emit('chat:typing', { isTyping });
  }, []);

  const handleSendFloatingEmoji = useCallback((emoji: string) => {
    socketRef.current?.emit('chat:floating_emoji', { emoji });
  }, []);

  const handleEmitUploadProgress = useCallback(
    (payload: {
      fileId: string;
      fileName: string;
      percent: number;
      status: 'uploading' | 'retrying' | 'error' | 'completed';
    }) => {
      socketRef.current?.emit('upload:progress', payload);
    },
    []
  );

  const handleClearUploadProgress = useCallback((fileId: string) => {
    socketRef.current?.emit('upload:clear', { fileId });
  }, []);

  const handleProgressReport = useCallback(
    (time: number) => {
      socketRef.current?.emit('client:progress', { currentTime: time });
      if (socketId) {
        setRoomState((prev) => {
          if (!prev || !prev.users[socketId]) return prev;
          return {
            ...prev,
            users: {
              ...prev.users,
              [socketId]: {
                ...prev.users[socketId],
                currentTime: time,
              },
            },
          };
        });
      }
    },
    [socketId]
  );

  const handleChangeNickname = useCallback(
    (newNick: string) => {
      const clean = newNick.trim().slice(0, 24);
      if (!clean || clean === nicknameRef.current) return;
      setNickname(clean);
      socketRef.current?.emit('user:change_nickname', { nickname: clean });
    },
    []
  );

  const handleSetUserPrefix = useCallback((targetUserId: string, prefix: string) => {
    socketRef.current?.emit('user:set_prefix', { targetUserId, prefix });
  }, []);

  const handleStartReadyCheck = useCallback(() => {
    socketRef.current?.emit('host:start_ready_check');
  }, []);

  const handleCancelReadyCheck = useCallback(() => {
    socketRef.current?.emit('host:cancel_ready_check');
  }, []);

  const handleConfirmReady = useCallback(() => {
    socketRef.current?.emit('client:ready_confirm');
  }, []);

  const handlePinMessage = useCallback((msg: ChatMessage) => {
    socketRef.current?.emit('host:pin_message', {
      messageId: msg.id,
      text: msg.text,
      nickname: msg.nickname,
      hasMedia: Boolean(msg.media),
      mediaKind: msg.media?.mediaKind,
      isSticker: Boolean(msg.stickerId),
    });
  }, []);

  const handleUnpinMessage = useCallback(() => {
    socketRef.current?.emit('host:unpin_message');
  }, []);

  const handleOpenMechanics = useCallback((tab: MechanicsTabId = 'player') => {
    setMechanicsModal({ open: true, tab });
  }, []);

  const NoticeBanner = appNotice ? (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] max-w-md w-[calc(100%-2rem)]">
      <div
        className={`px-3.5 py-2.5 rounded-xl border shadow-2xl backdrop-blur-md flex items-center justify-between gap-2.5 text-xs sm:text-sm font-medium ${
          appNotice.type === 'error'
            ? 'bg-rose-950/95 border-rose-500/50 text-rose-100'
            : 'bg-neutral-900/95 border-neutral-700 text-neutral-100'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle
            className={`w-4 h-4 shrink-0 ${
              appNotice.type === 'error' ? 'text-rose-400' : 'text-amber-400'
            }`}
          />
          <span className="break-words">{appNotice.text}</span>
        </div>
        <button
          type="button"
          onClick={() => setAppNotice(null)}
          className="p-1 rounded-lg hover:bg-white/10 text-neutral-400 hover:text-white cursor-pointer shrink-0"
          title="Закрыть уведомление"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  ) : null;

  // Not in room -> Show Join/Create Modal
  if (!roomId || !nickname) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col justify-center items-center">
        {NoticeBanner}
        <JoinModal
          initialRoomId={initialUrlRoomId}
          uiTheme={uiTheme}
          onChangeUiTheme={setUiTheme}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
        />
      </div>
    );
  }

  const currentTrack = roomState?.playlist[roomState?.currentTrackIndex ?? 0];
  const userCount = roomState ? Object.keys(roomState.users).length : 1;
  const isPortraitMode = orientation === 'portrait' && isTablet;

  // Tab buttons component for clean reuse
  const TabNavButtons = (
    <div className="flex p-1 bg-neutral-900 border-neutral-800 rounded-xl shrink-0">
      <button
        onClick={() => handleSelectTab('chat')}
        className={`flex-1 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer relative ${
          activeTab === 'chat'
            ? 'bg-neutral-800 text-white shadow'
            : 'text-neutral-400 hover:text-white'
        }`}
      >
        <MessageSquare className="w-3.5 h-3.5" />
        <span>Чат</span>
        {unreadChatCount > 0 && activeTab !== 'chat' && (
          <span className="ml-1 px-1.5 py-0.2 rounded-full bg-rose-600 text-[10px] text-white font-bold tabular-nums animate-pulse">
            {unreadChatCount}
          </span>
        )}
      </button>

      <button
        onClick={() => handleSelectTab('playlist')}
        className={`flex-1 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
          activeTab === 'playlist'
            ? 'bg-neutral-800 text-white shadow'
            : 'text-neutral-400 hover:text-white'
        }`}
      >
        <Film className="w-3.5 h-3.5" />
        <span>Плейлист</span>
        {roomState?.playlist.length ? (
          <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-neutral-700 text-neutral-300 tabular-nums">
            {roomState.playlist.length}
          </span>
        ) : null}
      </button>

      <button
        onClick={() => handleSelectTab('participants')}
        className={`flex-1 py-1.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
          activeTab === 'participants'
            ? 'bg-neutral-800 text-white shadow'
            : 'text-neutral-400 hover:text-white'
        }`}
      >
        <Users className="w-3.5 h-3.5" />
        <span>Люди</span>
        <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-neutral-700 text-neutral-300 tabular-nums">
          {userCount}
        </span>
      </button>
    </div>
  );

  const isTypingInPortraitChat = isPortraitMode && isKeyboardOpen && activeTab === 'chat';

  // Tab panel content component (keep panels mounted so ongoing video uploads & drafts persist across tab switches)
  const TabContent = (
    <div className={isTypingInPortraitChat ? 'shrink-0' : 'flex-1 min-h-0 overflow-hidden'}>
      <div className={activeTab === 'chat' ? (isKeyboardOpen ? 'shrink-0' : 'h-full') : 'hidden'}>
        <ChatPanel
          messages={messages}
          users={roomState?.users || {}}
          hostId={roomState?.hostId || ''}
          currentUserId={socketId}
          roomId={roomId}
          isHost={isHost}
          isKeyboardOpen={isKeyboardOpen}
          typingNicknames={Object.values(typingUsers)}
          roomUploadProgress={roomUploadProgress}
          pinnedMessage={roomState?.pinnedMessage || null}
          onSendMessage={handleSendMessage}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          onPinMessage={handlePinMessage}
          onUnpinMessage={handleUnpinMessage}
          onTypingChange={handleTypingChange}
          onSendFloatingEmoji={handleSendFloatingEmoji}
          onSeekToTimecode={handleSeek}
          onLocalMediaMessageSent={handleLocalMediaMessageSent}
          onOpenMechanics={handleOpenMechanics}
        />
      </div>

      <div className={activeTab === 'playlist' ? 'h-full' : 'hidden'}>
        <PlaylistPanel
          playlist={roomState?.playlist || []}
          currentTrackIndex={roomState?.currentTrackIndex || 0}
          isHost={isHost}
          roomId={roomId}
          hostToken={hostToken}
          socketId={socketId}
          localTrackUrls={localTrackUrls}
          onRegisterLocalTrack={handleRegisterLocalTrack}
          onRevokeLocalTrack={handleRevokeLocalTrack}
          onChangeTrack={handleChangeTrack}
          onReorder={handleReorderPlaylist}
          onDeleteTrack={handleDeleteTrack}
          onBroadcastUploadProgress={handleEmitUploadProgress}
          onClearUploadProgress={handleClearUploadProgress}
        />
      </div>

      <div className={activeTab === 'participants' ? 'h-full' : 'hidden'}>
        <ParticipantsPanel
          users={roomState?.users || {}}
          hostId={roomState?.hostId || ''}
          currentUserId={socketId}
          isHost={isHost}
          roomId={roomId}
          hostCurrentTime={roomState?.playbackState.currentTime || 0}
          onTransferHost={handleTransferHost}
          onSetUserPrefix={handleSetUserPrefix}
          onStartReadyCheck={handleStartReadyCheck}
          isReadyCheckActive={Boolean(roomState?.readyCheck)}
        />
      </div>
    </div>
  );

  return (
    <div
      className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans antialiased overflow-hidden select-none"
      style={customViewportHeight ? { height: `${customViewportHeight}px` } : undefined}
    >
      {NoticeBanner}

      {/* 1. Header (Navbar): compact and responsive */}
      <Navbar
        roomId={roomId}
        isHost={isHost}
        nickname={nickname}
        userCount={userCount}
        isConnected={isConnected}
        uiTheme={uiTheme}
        onChangeUiTheme={setUiTheme}
        ambilightEnabled={ambilightEnabled}
        onToggleAmbilight={setAmbilightEnabled}
        onChangeNickname={handleChangeNickname}
        onLeaveRoom={handleLeaveRoom}
        onCloseRoom={handleCloseRoom}
        onOpenMechanics={handleOpenMechanics}
      />

      {/* 2. Unified Orientation Layout: VideoPlayer & Sidebar stay mounted across orientation/theater switches */}
      <main
        ref={portraitMainRef}
        className={
          isPortraitMode
            ? 'flex-1 flex flex-col min-h-0 overflow-hidden'
            : 'flex-1 flex flex-row overflow-hidden p-2 md:p-3 gap-3 w-full min-h-0'
        }
      >
        {/* Video Player Stage (always first child so VideoPlayer never unmounts) */}
        <section
          className={
            isPortraitMode
              ? `w-full bg-black overflow-hidden transition-[height] duration-150 ${
                  isTypingInPortraitChat
                    ? 'flex-1 min-h-0'
                    : isPortraitVideoCollapsed
                    ? 'shrink-0 h-0'
                    : 'shrink-0'
                }`
              : 'flex-1 min-w-0 h-full flex items-center justify-center overflow-hidden'
          }
          style={
            isPortraitMode
              ? isTypingInPortraitChat
                ? undefined
                : isPortraitVideoCollapsed
                ? { height: '0px' }
                : { height: `${portraitVideoPercent}%` }
              : undefined
          }
        >
          <VideoPlayer
            currentTrack={currentTrack}
            playlist={roomState?.playlist || []}
            currentTrackIndex={roomState?.currentTrackIndex || 0}
            isHost={isHost}
            clockOffsetMs={clockOffsetMs}
            localFileUrl={currentTrack ? localTrackUrls[currentTrack.id] : undefined}
            playbackState={
              roomState?.playbackState || {
                isPlaying: false,
                currentTime: 0,
                lastUpdatedServerTime: Date.now(),
                isSystemPausedForBuffering: false,
              }
            }
            bufferingUsers={bufferingUsers}
            danmakuItems={danmakuItems}
            floatingEmojis={floatingEmojis}
            isTheaterMode={isPortraitMode ? undefined : isTheaterMode}
            ambilightEnabled={ambilightEnabled}
            readyCheck={roomState?.readyCheck || null}
            users={roomState?.users || {}}
            currentUserId={socketId}
            onPlay={handlePlay}
            onPause={handlePause}
            onSeek={handleSeek}
            onForcePlay={handleForcePlay}
            onBufferingStart={handleBufferingStart}
            onBufferingEnd={handleBufferingEnd}
            onTrackEnded={handleTrackEnded}
            onProgressReport={handleProgressReport}
            onTriggerUpload={() => setActiveTab('playlist')}
            onToggleTheater={isPortraitMode ? undefined : () => setIsTheaterMode((prev) => !prev)}
            onStartReadyCheck={handleStartReadyCheck}
            onCancelReadyCheck={handleCancelReadyCheck}
            onConfirmReady={handleConfirmReady}
          />
        </section>

        {/* Portrait drag handle & quick resize controls */}
        {isPortraitMode && !isKeyboardOpen && (
          <div
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              isResizingChatRef.current = true;
            }}
            className="h-6 bg-neutral-900/95 border-y border-neutral-800/90 flex items-center justify-between px-2 shrink-0 touch-none cursor-row-resize select-none"
            title="Потяните вверх или вниз, чтобы изменить размер чата"
          >
            <span className="text-[10px] text-neutral-500 font-medium">
              {isPortraitVideoCollapsed ? 'Видео скрыто' : `Экран ${portraitVideoPercent}%`}
            </span>

            <div className="flex items-center gap-1 text-neutral-500">
              <GripHorizontal className="w-4 h-4" />
            </div>

            <button
              type="button"
              onClick={() => {
                if (isPortraitVideoCollapsed) {
                  setIsPortraitVideoCollapsed(false);
                  if (portraitVideoPercent < 18) setPortraitVideoPercent(30);
                } else if (portraitVideoPercent > 22) {
                  setPortraitVideoPercent(18);
                } else {
                  setIsPortraitVideoCollapsed(true);
                }
              }}
              className="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-medium text-neutral-300 flex items-center gap-1 cursor-pointer"
            >
              {isPortraitVideoCollapsed ? (
                <>
                  <ChevronDown className="w-3 h-3 text-rose-400" />
                  <span>Показать видео</span>
                </>
              ) : portraitVideoPercent > 22 ? (
                <>
                  <ChevronUp className="w-3 h-3 text-amber-400" />
                  <span>Больше чата</span>
                </>
              ) : (
                <>
                  <ChevronUp className="w-3 h-3 text-rose-400" />
                  <span>Скрыть видео</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Portrait tab navigation */}
        {isPortraitMode && !isTypingInPortraitChat && (
          <div className="p-1.5 bg-neutral-950 border-b border-neutral-800 shrink-0">
            {TabNavButtons}
          </div>
        )}

        {/* Sidebar / Bottom Chat+Playlist+Participants Container (never unmounted) */}
        <aside
          className={
            isPortraitMode
              ? isTypingInPortraitChat
                ? 'shrink-0 p-1.5 flex flex-col'
                : 'flex-1 min-h-0 p-1.5 flex flex-col overflow-hidden'
              : isTheaterMode
              ? 'hidden'
              : 'w-[340px] md:w-[380px] lg:w-[400px] xl:w-[440px] flex flex-col shrink-0 h-full min-h-0 gap-2 transition-all duration-300'
          }
        >
          {!isPortraitMode && TabNavButtons}
          {TabContent}
        </aside>
      </main>

      <SiteMechanicsModal
        isOpen={mechanicsModal.open}
        initialTab={mechanicsModal.tab}
        onClose={() => setMechanicsModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
