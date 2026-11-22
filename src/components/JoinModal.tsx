import React, { useState, useEffect } from 'react';
import { Film, Play, Users, Zap, Shield, Sparkles } from 'lucide-react';

interface JoinModalProps {
  initialRoomId?: string;
  onCreateRoom: (nickname: string) => void;
  onJoinRoom: (roomId: string, nickname: string) => void;
}

export const JoinModal: React.FC<JoinModalProps> = ({
  initialRoomId,
  onCreateRoom,
  onJoinRoom,
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'join'>(
    initialRoomId ? 'join' : 'create'
  );
  const [nickname, setNickname] = useState('');
  const [roomId, setRoomId] = useState(initialRoomId || '');
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialRoomId) {
      setRoomId(initialRoomId);
      setActiveTab('join');
    }
  }, [initialRoomId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const cleanNick = nickname.trim();
    if (!cleanNick) {
      setError('Пожалуйста, введите ваш никнейм');
      return;
    }

    if (activeTab === 'create') {
      onCreateRoom(cleanNick);
    } else {
      const cleanRoom = roomId.trim().toLowerCase();
      if (!cleanRoom) {
        setError('Введите ID комнаты');
        return;
      }
      onJoinRoom(cleanRoom, cleanNick);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md">
      <div className="relative w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-3xl p-6 md:p-8 shadow-2xl overflow-hidden">
        {/* Glow ambient background */}
        <div className="absolute -top-24 -left-24 w-48 h-48 bg-rose-600/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-amber-500/20 rounded-full blur-3xl pointer-events-none" />

        {/* Brand Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-rose-500/25">
            <Film className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">SyncWatch Party</h1>
            <p className="text-xs text-neutral-400">Синхронный просмотр видео с друзьями</p>
          </div>
        </div>

        {/* Feature Badges */}
        <div className="grid grid-cols-3 gap-2 mb-6">
          <div className="bg-neutral-800/60 border border-neutral-700/50 rounded-xl p-2.5 text-center">
            <Zap className="w-4 h-4 text-amber-400 mx-auto mb-1" />
            <span className="text-[10px] text-neutral-300 font-medium block">
              Time Drift Sync
            </span>
          </div>
          <div className="bg-neutral-800/60 border border-neutral-700/50 rounded-xl p-2.5 text-center">
            <Shield className="w-4 h-4 text-emerald-400 mx-auto mb-1" />
            <span className="text-[10px] text-neutral-300 font-medium block">
              Smart Buffer
            </span>
          </div>
          <div className="bg-neutral-800/60 border border-neutral-700/50 rounded-xl p-2.5 text-center">
            <Sparkles className="w-4 h-4 text-rose-400 mx-auto mb-1" />
            <span className="text-[10px] text-neutral-300 font-medium block">
              Danmaku Чат
            </span>
          </div>
        </div>

        {/* Tabs Switch */}
        <div className="flex p-1 bg-neutral-950 rounded-xl mb-5 border border-neutral-800">
          <button
            type="button"
            onClick={() => {
              setActiveTab('create');
              setError('');
            }}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition cursor-pointer ${
              activeTab === 'create'
                ? 'bg-neutral-800 text-white shadow'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            Создать комнату
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('join');
              setError('');
            }}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition cursor-pointer ${
              activeTab === 'join'
                ? 'bg-neutral-800 text-white shadow'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            Войти по коду
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {activeTab === 'join' && (
            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                Код комнаты (Room ID)
              </label>
              <input
                type="text"
                placeholder="например: 7x9k2a"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-700 focus:border-rose-500 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 font-mono outline-none transition"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-neutral-400 mb-1.5">
              Ваш никнейм
            </label>
            <input
              type="text"
              placeholder="Введите имя (например: Alex)"
              value={nickname}
              maxLength={24}
              onChange={(e) => setNickname(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-700 focus:border-rose-500 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 outline-none transition"
            />
          </div>

          {error && (
            <p className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-2 rounded-xl">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full py-3 bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 text-white font-semibold text-sm rounded-xl shadow-lg shadow-rose-600/30 transition transform active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2"
          >
            <Play className="w-4 h-4 fill-white" />
            <span>
              {activeTab === 'create' ? 'Создать и начать просмотр' : 'Присоединиться к просмотру'}
            </span>
          </button>
        </form>
      </div>
    </div>
  );
};
