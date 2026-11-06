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
  DanmakuItem,
  ClientToServerEvents,
  ServerToClientEvents,
} from './types/watchparty.ts';
import { Navbar } from './components/Navbar.tsx';
import { VideoPlayer } from './components/VideoPlayer.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { PlaylistPanel } from './components/PlaylistPanel.tsx';
import { ParticipantsPanel } from './components/ParticipantsPanel.tsx';
import { JoinModal } from './components/JoinModal.tsx';
import { MessageSquare, Film, Users } from 'lucide-react';

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
  const [bufferingUsers, setBufferingUsers] = useState<string[]>([]);

  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  // Check initial query parameter ?room=...
  const [initialUrlRoomId, setInitialUrlRoomId] = useState<string | undefined>(undefined);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape');
  const [isTablet, setIsTablet] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);

  useEffect(() => {
    const handleLayoutCheck = () => {
      const isPortrait = window.matchMedia('(orientation: portrait)').matches || window.innerHeight > window.innerWidth;
      setOrientation(isPortrait ? 'portrait' : 'landscape');
      setIsTablet(window.innerWidth < 1024);
    };

    handleLayoutCheck();
    window.addEventListener('resize', handleLayoutCheck);
    window.addEventListener('orientationchange', handleLayoutCheck);
    return () => {
      window.removeEventListener('resize', handleLayoutCheck);
      window.removeEventListener('orientationchange', handleLayoutCheck);
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

  // Initialize socket connection when roomId and nickname are present
  useEffect(() => {
    if (!roomId || !nickname) return;

    // Connect to server (using current host)
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      if (socket.id) {
        setSocketId(socket.id);
      }
      // Emit room:join
      socket.emit('room:join', {
        roomId,
        nickname,
        hostToken: hostToken || undefined,
      });
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    // Room initial state
    socket.on('room:init_state', (state: RoomState) => {
      setRoomState(state);
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

    // Chat message received
    socket.on('chat:message', (message: ChatMessage) => {
      setMessages((prev) => [...prev, message]);

      // If message is a user message, trigger Danmaku item at the BOTTOM of the screen
      if (message.type === 'message') {
        const danmaku: DanmakuItem = {
          ...message,
          topPercent: 72 + (Math.floor(Math.random() * 3) * 5), // 72%, 77%, 82% (bottom area, clear center)
        };
        setDanmakuItems((prev) => [...prev, danmaku]);

        // Auto remove danmaku after 7 seconds
        setTimeout(() => {
          setDanmakuItems((prev) => prev.filter((item) => item.id !== danmaku.id));
        }, 7000);
      }

      // Increment unread count if chat tab not currently open
      setActiveTab((currentTab) => {
        if (currentTab !== 'chat') {
          setUnreadChatCount((cnt) => cnt + 1);
        }
        return currentTab;
      });
    });

    // Room closed by host or empty (Item 4)
    socket.on('room:closed', ({ reason }) => {
      alert(reason || 'Комната была закрыта. Все файлы и данные удалены.');
      handleLeaveRoom();
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, nickname, hostToken]);

  // Create room flow via HTTP API
  const handleCreateRoom = async (nick: string) => {
    try {
      const res = await fetch('/api/rooms/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick }),
      });
      const data = await res.json();
      if (data.roomId) {
        setNickname(nick);
        setHostToken(data.hostToken);
        sessionStorage.setItem('watchparty_host_token', data.hostToken);
        setRoomId(data.roomId);
        window.history.pushState({}, '', `?room=${data.roomId}`);
      }
    } catch (err) {
      console.error('Error creating room:', err);
      alert('Не удалось создать комнату. Попробуйте еще раз.');
    }
  };

  // Join room flow
  const handleJoinRoom = (rId: string, nick: string) => {
    setNickname(nick);
    setRoomId(rId);
    window.history.pushState({}, '', `?room=${rId}`);
  };

  // Leave room flow
  const handleLeaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    setRoomId(null);
    setRoomState(null);
    setMessages([]);
    setDanmakuItems([]);
    window.history.pushState({}, '', window.location.pathname);
  };

  // Close room flow (Host purges all room files and users immediately - Item 4)
  const handleCloseRoom = useCallback(() => {
    socketRef.current?.emit('host:close_room');
    handleLeaveRoom();
  }, []);

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

  const handleDeleteTrack = useCallback((fileId: string) => {
    socketRef.current?.emit('host:delete_track', { fileId });
  }, []);

  const handleTransferHost = useCallback((newHostUserId: string) => {
    socketRef.current?.emit('host:transfer_host', { newHostUserId });
  }, []);

  const handleSendMessage = useCallback((text: string) => {
    socketRef.current?.emit('chat:send', { text });
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

  const handleAddDemo = useCallback(
    async (sampleName: string, sampleUrl: string) => {
      if (!isHost || !roomId) return;
      try {
        await fetch(`/api/rooms/${roomId}/add-sample`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-host-token': hostToken,
            'x-socket-id': socketId,
          },
          body: JSON.stringify({ sampleName, sampleUrl }),
        });
      } catch (err) {
        console.error('Failed to add sample:', err);
      }
    },
    [isHost, roomId, hostToken, socketId]
  );

  // Not in room -> Show Join/Create Modal
  if (!roomId || !nickname) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col justify-center items-center">
        <JoinModal
          initialRoomId={initialUrlRoomId}
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
          <span className="ml-1 px-1.5 py-0.2 rounded-full bg-rose-600 text-[10px] text-white font-bold animate-pulse">
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
          <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-neutral-700 text-neutral-300">
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
        <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-neutral-700 text-neutral-300">
          {userCount}
        </span>
      </button>
    </div>
  );

  // Tab panel content component
  const TabContent = (
    <div className="flex-1 min-h-0 overflow-hidden">
      {activeTab === 'chat' && (
        <ChatPanel
          messages={messages}
          users={roomState?.users || {}}
          hostId={roomState?.hostId || ''}
          currentUserId={socketId}
          onSendMessage={handleSendMessage}
        />
      )}

      {activeTab === 'playlist' && (
        <PlaylistPanel
          playlist={roomState?.playlist || []}
          currentTrackIndex={roomState?.currentTrackIndex || 0}
          isHost={isHost}
          roomId={roomId}
          hostToken={hostToken}
          socketId={socketId}
          onChangeTrack={handleChangeTrack}
          onReorder={handleReorderPlaylist}
          onDeleteTrack={handleDeleteTrack}
        />
      )}

      {activeTab === 'participants' && (
        <ParticipantsPanel
          users={roomState?.users || {}}
          hostId={roomState?.hostId || ''}
          currentUserId={socketId}
          isHost={isHost}
          roomId={roomId}
          hostCurrentTime={roomState?.playbackState.currentTime || 0}
          onTransferHost={handleTransferHost}
        />
      )}
    </div>
  );

  return (
    <div className="h-screen w-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans antialiased overflow-hidden select-none">
      {/* 1. Header (Navbar): compact and responsive */}
      <Navbar
        roomId={roomId}
        isHost={isHost}
        nickname={nickname}
        userCount={userCount}
        isConnected={isConnected}
        onLeaveRoom={handleLeaveRoom}
        onCloseRoom={handleCloseRoom}
      />

      {/* 2. Responsive Orientation Layout (Item 3) */}
      {isPortraitMode ? (
        /* TABLET / MOBILE PORTRAIT: Fixed Header -> 16:9 Video across full width -> Tabs -> Full-height Chat without gaps */
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Fixed 16:9 Video Player full width */}
          <div className="w-full shrink-0 bg-black">
            <VideoPlayer
              currentTrack={currentTrack}
              playlist={roomState?.playlist || []}
              currentTrackIndex={roomState?.currentTrackIndex || 0}
              isHost={isHost}
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
              onPlay={handlePlay}
              onPause={handlePause}
              onSeek={handleSeek}
              onForcePlay={handleForcePlay}
              onBufferingStart={handleBufferingStart}
              onBufferingEnd={handleBufferingEnd}
              onTrackEnded={handleTrackEnded}
              onProgressReport={handleProgressReport}
              onTriggerUpload={() => setActiveTab('playlist')}
              onAddDemo={handleAddDemo}
            />
          </div>

          {/* Under video: Tab Navigation */}
          <div className="p-1.5 bg-neutral-950 border-b border-neutral-800 shrink-0">
            {TabNavButtons}
          </div>

          {/* Chat / Tab takes ALL remaining height without page scrolling */}
          <div className="flex-1 min-h-0 p-1.5 flex flex-col overflow-hidden">
            {TabContent}
          </div>
        </main>
      ) : (
        /* DESKTOP / TABLET LANDSCAPE: Full-width responsive stage without artificial limits */
        <main className="flex-1 flex flex-row overflow-hidden p-2 md:p-3 gap-3 w-full min-h-0">
          {/* Left Column: Maximum 16:9 Cinema Stage */}
          <section className="flex-1 min-w-0 h-full flex items-center justify-center overflow-hidden">
            <VideoPlayer
              currentTrack={currentTrack}
              playlist={roomState?.playlist || []}
              currentTrackIndex={roomState?.currentTrackIndex || 0}
              isHost={isHost}
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
              isTheaterMode={isTheaterMode}
              onPlay={handlePlay}
              onPause={handlePause}
              onSeek={handleSeek}
              onForcePlay={handleForcePlay}
              onBufferingStart={handleBufferingStart}
              onBufferingEnd={handleBufferingEnd}
              onTrackEnded={handleTrackEnded}
              onProgressReport={handleProgressReport}
              onTriggerUpload={() => setActiveTab('playlist')}
              onAddDemo={handleAddDemo}
              onToggleTheater={() => setIsTheaterMode((prev) => !prev)}
            />
          </section>

          {/* Right Column: Chat, Playlist, Participants (collapsible in theater mode) */}
          {!isTheaterMode && (
            <aside className="w-[340px] md:w-[380px] lg:w-[400px] xl:w-[440px] flex flex-col shrink-0 h-full min-h-0 gap-2 transition-all duration-300">
              {TabNavButtons}
              {TabContent}
            </aside>
          )}
        </main>
      )}
    </div>
  );
}
