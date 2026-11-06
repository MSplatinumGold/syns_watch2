import React, { useState } from 'react';
import { Film, Copy, Check, Users, Crown, LogOut, Radio } from 'lucide-react';

interface NavbarProps {
  roomId: string;
  isHost: boolean;
  nickname: string;
  userCount: number;
  isConnected: boolean;
  onLeaveRoom: () => void;
  onCloseRoom: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  roomId,
  isHost,
  nickname,
  userCount,
  isConnected,
  onLeaveRoom,
  onCloseRoom,
}) => {
  const [copied, setCopied] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const handleCopyLink = () => {
    const inviteUrl = `${window.location.origin}?room=${roomId}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirmClose = () => {
    setShowCloseConfirm(false);
    onCloseRoom();
  };

  return (
    <header className="h-12 md:h-14 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur-md px-3 md:px-4 flex items-center justify-between shrink-0 z-30">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl bg-gradient-to-tr from-rose-600 to-amber-500 flex items-center justify-center text-white shadow-md shadow-rose-600/20 shrink-0">
          <Film className="w-3.5 h-3.5 md:w-4 md:h-4" />
        </div>
        <span className="font-bold text-white text-xs md:text-sm tracking-tight hidden sm:inline">
          SyncWatch
        </span>
      </div>

      {/* Center: Room Code Pill & Share */}
      <div className="flex items-center gap-1.5">
        <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded-full pl-2.5 pr-1 py-0.5 md:py-1">
          <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-300">
            <Radio className="w-3 h-3 text-rose-500 animate-pulse" />
            <span className="text-neutral-500 hidden sm:inline">ID:</span>
            <strong className="text-white tracking-wider uppercase text-[11px] md:text-xs">{roomId}</strong>
          </div>
          <button
            onClick={handleCopyLink}
            className="ml-1.5 p-1 rounded-full hover:bg-neutral-800 text-neutral-400 hover:text-white transition cursor-pointer"
            title="Скопировать ссылку на комнату"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>

      {/* Right: User Info & Controls */}
      <div className="flex items-center gap-2">
        {/* Role Badge */}
        <div
          className={`px-2 py-0.5 md:py-1 rounded-full text-xs font-semibold flex items-center gap-1 ${
            isHost
              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              : 'bg-neutral-800 text-neutral-300 border border-neutral-700/60'
          }`}
        >
          {isHost && <Crown className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />}
          <span className="truncate max-w-[70px] sm:max-w-[110px]">{nickname}</span>
        </div>

        {/* Online Count */}
        <div className="hidden md:flex items-center gap-1.5 px-2 py-0.5 md:py-1 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-400">
          <Users className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-mono text-white text-[11px]">{userCount}</span>
        </div>

        {/* Host: Close Room Button (Item 4: Purges all files & room data) */}
        {isHost ? (
          <div className="relative">
            <button
              onClick={() => setShowCloseConfirm(!showCloseConfirm)}
              className="px-2 py-1 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-800/60 text-rose-300 hover:text-white text-xs font-medium transition cursor-pointer flex items-center gap-1"
              title="Закрыть комнату и удалить все данные"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Закрыть комнату</span>
            </button>

            {showCloseConfirm && (
              <div className="absolute right-0 top-full mt-2 w-64 p-3 bg-neutral-900 border border-rose-600/40 rounded-xl shadow-2xl z-50 text-left">
                <p className="text-xs text-white font-semibold">Закрыть комнату?</p>
                <p className="text-[11px] text-neutral-400 mt-1">
                  Все участники будут отключены, а загруженные видеофайлы безвозвратно удалены.
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    onClick={handleConfirmClose}
                    className="flex-1 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition cursor-pointer"
                  >
                    Да, удалить
                  </button>
                  <button
                    onClick={() => setShowCloseConfirm(false)}
                    className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-xs transition cursor-pointer"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={onLeaveRoom}
            className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-rose-400 transition cursor-pointer"
            title="Покинуть комнату"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </div>
    </header>
  );
};
