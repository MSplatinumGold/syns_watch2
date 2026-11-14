import React, { useState, useEffect, useRef } from 'react';
import { Film, Copy, Check, Users, Crown, LogOut, Radio, Settings, X, Trash2 } from 'lucide-react';

interface NavbarProps {
  roomId: string;
  isHost: boolean;
  nickname: string;
  userCount: number;
  isConnected: boolean;
  onChangeNickname: (newNickname: string) => void;
  onLeaveRoom: () => void;
  onCloseRoom: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  roomId,
  isHost,
  nickname,
  userCount,
  isConnected,
  onChangeNickname,
  onLeaveRoom,
  onCloseRoom,
}) => {
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [nickInput, setNickInput] = useState(nickname);
  const [nickSaved, setNickSaved] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNickInput(nickname);
  }, [nickname]);

  useEffect(() => {
    if (!showSettings) {
      setShowCloseConfirm(false);
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSettings]);

  const handleCopyLink = () => {
    const inviteUrl = `${window.location.origin}?room=${roomId}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveNickname = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = nickInput.trim().slice(0, 24);
    if (!clean) return;
    if (clean !== nickname) {
      onChangeNickname(clean);
    }
    setNickSaved(true);
    setTimeout(() => setNickSaved(false), 1800);
  };

  const handleConfirmClose = () => {
    setShowCloseConfirm(false);
    setShowSettings(false);
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
            <Radio className={`w-3 h-3 ${isConnected ? 'text-rose-500 animate-pulse' : 'text-neutral-500'}`} />
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

      {/* Right: User Info & Settings Button */}
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

        {/* Settings Menu (replaces Exit/Close button) */}
        <div className="relative" ref={settingsRef}>
          <button
            onClick={() => {
              setNickInput(nickname);
              setShowSettings((prev) => !prev);
            }}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
              showSettings
                ? 'bg-neutral-800 border-neutral-600 text-white'
                : 'bg-neutral-900 hover:bg-neutral-800 border-neutral-800 text-neutral-300 hover:text-white'
            }`}
            title="Настройки"
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Настройки</span>
          </button>

          {showSettings && (
            <div className="absolute right-0 top-full mt-2 w-72 p-3.5 bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl z-50 text-left space-y-3.5">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  <Settings className="w-3.5 h-3.5 text-rose-400" />
                  <span>Настройки</span>
                </div>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* In-Lobby Nickname Change */}
              <form onSubmit={handleSaveNickname} className="space-y-1.5">
                <label className="block text-[11px] font-medium text-neutral-400">
                  Сменить никнейм в лобби
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    maxLength={24}
                    value={nickInput}
                    onChange={(e) => setNickInput(e.target.value)}
                    placeholder="Ваш ник..."
                    className="flex-1 min-w-0 bg-neutral-950 border border-neutral-700 focus:border-rose-500 text-white text-xs rounded-lg px-2.5 py-1.5 outline-none transition"
                  />
                  <button
                    type="submit"
                    disabled={!nickInput.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-semibold transition cursor-pointer shrink-0 flex items-center gap-1"
                  >
                    {nickSaved ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Ок</span>
                      </>
                    ) : (
                      <span>Сохранить</span>
                    )}
                  </button>
                </div>
              </form>

              <div className="pt-2 border-t border-neutral-800 space-y-2">
                {/* Leave Room (available for any user) */}
                <button
                  onClick={() => {
                    setShowSettings(false);
                    onLeaveRoom();
                  }}
                  className="w-full py-2 px-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 hover:text-white text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-2"
                >
                  <LogOut className="w-3.5 h-3.5 text-neutral-400" />
                  <span>Выйти из комнаты</span>
                </button>

                {/* Host: Close Room & Purge */}
                {isHost && (
                  <>
                    {!showCloseConfirm ? (
                      <button
                        onClick={() => setShowCloseConfirm(true)}
                        className="w-full py-2 px-3 rounded-xl bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/50 text-rose-300 hover:text-white text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-2"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Закрыть комнату и удалить файлы</span>
                      </button>
                    ) : (
                      <div className="p-2.5 rounded-xl bg-rose-950/40 border border-rose-600/40 space-y-2">
                        <p className="text-[11px] text-rose-200 leading-snug">
                          Отключить всех участников и безвозвратно удалить видео и медиа?
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleConfirmClose}
                            className="flex-1 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition cursor-pointer"
                          >
                            Да, удалить
                          </button>
                          <button
                            onClick={() => setShowCloseConfirm(false)}
                            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-xs transition cursor-pointer"
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
