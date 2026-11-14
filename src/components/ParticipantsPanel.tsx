import React, { useState } from 'react';
import { Users, Crown, Check, Share2, Clock, Tag, X } from 'lucide-react';
import type { User } from '../types/watchparty.ts';
import { formatTime } from '../utils/format.ts';

const PRESET_PREFIXES = ['🍿 Киноман', '🐱 Котик', '👑 Легенда', '🔥 Босс', '😴 Сонный'];

interface ParticipantsPanelProps {
  users: Record<string, User>;
  hostId: string;
  currentUserId: string;
  isHost: boolean;
  roomId: string;
  hostCurrentTime?: number;
  onTransferHost: (newHostUserId: string) => void;
  onSetUserPrefix: (targetUserId: string, prefix: string) => void;
}

export const ParticipantsPanel: React.FC<ParticipantsPanelProps> = ({
  users,
  hostId,
  currentUserId,
  isHost,
  roomId,
  hostCurrentTime = 0,
  onTransferHost,
  onSetUserPrefix,
}) => {
  const [copied, setCopied] = useState(false);
  const [editingPrefixUserId, setEditingPrefixUserId] = useState<string | null>(null);
  const [prefixInput, setPrefixInput] = useState('');
  const userList = Object.values(users);

  const handleCopyLink = () => {
    const inviteUrl = `${window.location.origin}?room=${roomId}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const openPrefixEditor = (user: User) => {
    if (editingPrefixUserId === user.id) {
      setEditingPrefixUserId(null);
      return;
    }
    setEditingPrefixUserId(user.id);
    setPrefixInput(user.prefix || '');
  };

  const savePrefix = (targetUserId: string, value: string) => {
    onSetUserPrefix(targetUserId, value.trim().slice(0, 18));
    setEditingPrefixUserId(null);
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl">
      {/* Header */}
      <div className="p-3.5 bg-neutral-950/60 border-b border-neutral-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" />
          <h3 className="text-xs md:text-sm font-semibold text-white">Участники</h3>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 font-mono">
            {userList.length}
          </span>
        </div>

        <button
          onClick={handleCopyLink}
          className="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition border border-neutral-700/60 cursor-pointer"
          title="Скопировать ссылку для приглашения"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Скопировано!</span>
            </>
          ) : (
            <>
              <Share2 className="w-3.5 h-3.5" />
              <span>Пригласить</span>
            </>
          )}
        </button>
      </div>

      {/* Users List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {userList.map((user) => {
          const isUserHost = user.id === hostId || user.isHost;
          const isMe = user.id === currentUserId;
          const userTime = user.currentTime ?? (isUserHost ? hostCurrentTime : 0);
          const drift = Math.abs(userTime - hostCurrentTime);
          const isEditingThis = editingPrefixUserId === user.id;

          return (
            <div
              key={user.id}
              className={`p-2.5 rounded-xl border flex flex-col gap-2 transition ${
                isMe
                  ? 'bg-neutral-800/80 border-neutral-700 shadow-sm'
                  : 'bg-neutral-850/40 border-neutral-800'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                {/* User Info */}
                <div className="flex items-center gap-2.5 min-w-0">
                  {/* Status Dot */}
                  <div className="relative shrink-0">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        user.isBuffering
                          ? 'bg-amber-400 ring-2 ring-amber-400/30 animate-pulse'
                          : 'bg-emerald-400 ring-2 ring-emerald-400/30'
                      }`}
                      title={user.isBuffering ? 'Идет буферизация' : 'В эфире (синхрон)'}
                    />
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center flex-wrap gap-1.5">
                      {user.prefix && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-fuchsia-500/20 text-fuchsia-300 font-semibold border border-fuchsia-400/40 shrink-0 max-w-[115px] truncate">
                          {user.prefix}
                        </span>
                      )}
                      <span className="text-xs md:text-sm font-medium text-white truncate">
                        {user.nickname}
                      </span>
                      {isMe && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-neutral-700 text-neutral-300 font-medium shrink-0">
                          Вы
                        </span>
                      )}
                      {isUserHost && (
                        <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30 shrink-0">
                          <Crown className="w-3 h-3 fill-amber-400 text-amber-400" /> Хост
                        </span>
                      )}
                    </div>

                    {/* Real-Time Watching Second */}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        {formatTime(userTime)}
                      </span>

                      <span className="text-[10px] text-neutral-500 truncate">
                        {user.isBuffering
                          ? 'Буферизация...'
                          : isUserHost
                          ? 'Ведущий'
                          : drift < 0.3
                          ? 'В такт с хостом'
                          : drift <= 1.5
                          ? `Догоняет (${userTime < hostCurrentTime ? '-' : '+'}${drift.toFixed(1)}s)`
                          : `Отстает на ${drift.toFixed(1)}s`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions: Prefix (everyone) + Transfer Host (host only) */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openPrefixEditor(user)}
                    className={`px-2 py-1 rounded-lg text-[11px] font-medium border transition cursor-pointer flex items-center gap-1 ${
                      isEditingThis
                        ? 'bg-fuchsia-500/20 border-fuchsia-400/50 text-fuchsia-300'
                        : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-fuchsia-300 border-neutral-700'
                    }`}
                    title="Выдать или изменить префикс (видно в чате)"
                  >
                    <Tag className="w-3 h-3" />
                    <span className="hidden sm:inline">Префикс</span>
                  </button>

                  {isHost && !isMe && (
                    <button
                      onClick={() => onTransferHost(user.id)}
                      className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-amber-300 text-[11px] font-medium border border-neutral-700 transition cursor-pointer flex items-center gap-1"
                      title="Сделать этого участника хостом комнаты"
                    >
                      <Crown className="w-3 h-3" />
                      <span>Передать</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Inline Prefix Editor */}
              {isEditingThis && (
                <div className="pt-2 border-t border-neutral-800 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      maxLength={18}
                      autoFocus
                      value={prefixInput}
                      onChange={(e) => setPrefixInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          savePrefix(user.id, prefixInput);
                        } else if (e.key === 'Escape') {
                          setEditingPrefixUserId(null);
                        }
                      }}
                      placeholder="Префикс (до 18 симв.)..."
                      className="flex-1 min-w-0 bg-neutral-950 border border-neutral-700 focus:border-fuchsia-500 text-white placeholder-neutral-500 text-xs rounded-lg px-2.5 py-1 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => savePrefix(user.id, prefixInput)}
                      className="px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-medium cursor-pointer flex items-center gap-1 shrink-0"
                      title="Сохранить префикс"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    {user.prefix && (
                      <button
                        type="button"
                        onClick={() => savePrefix(user.id, '')}
                        className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-rose-950/70 text-rose-400 text-[11px] font-medium border border-neutral-700 cursor-pointer shrink-0"
                        title="Убрать префикс"
                      >
                        Убрать
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setEditingPrefixUserId(null)}
                      className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white cursor-pointer shrink-0"
                      title="Отмена"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                    {PRESET_PREFIXES.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => savePrefix(user.id, preset)}
                        className="px-2 py-0.5 rounded-md bg-neutral-800/90 hover:bg-fuchsia-500/20 border border-neutral-700 hover:border-fuchsia-400/40 text-[10px] text-neutral-300 whitespace-nowrap cursor-pointer shrink-0"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Info Card at bottom */}
      <div className="p-3 bg-neutral-950/70 border-t border-neutral-800 text-[11px] text-neutral-500 flex items-center justify-between">
        <span>Комната: <strong className="text-neutral-300 font-mono uppercase">{roomId}</strong></span>
        <span>Синхронизация по секундам</span>
      </div>
    </div>
  );
};
