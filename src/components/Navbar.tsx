import React, { useState, useEffect, useRef } from 'react';
import {
  Copy,
  Check,
  Users,
  LogOut,
  Radio,
  Settings,
  X,
  Trash2,
  Mic,
  MessageSquare,
  Volume2,
  Headphones,
  Square,
  Sparkles,
  Tag,
  Palette,
  Sun,
  BookOpen,
  ChevronRight,
} from 'lucide-react';
import { copyToClipboard } from '../utils/format.ts';
import { APP_VERSION, CHANGELOG } from '../utils/changelog.ts';
import { UI_THEMES, type UiThemeId } from '../utils/themes.ts';
import type { MechanicsTabId } from '../utils/mechanics.ts';
import type { VoiceMode } from '../types/watchparty.ts';

interface NavbarProps {
  roomId: string;
  isHost: boolean;
  nickname: string;
  userCount: number;
  isConnected: boolean;
  voiceMode?: VoiceMode;
  isMicOn?: boolean;
  isSelfSpeaking?: boolean;
  voiceVolumePercent?: number;
  voicePriorityRatio?: number; // 0 = 100:0 (Video:Voice), 50 = 50:50, 67 = default (33:67), 100 = 0:100
  selfDuckPercent?: number; // 0..100, default 30 (video drops to 30% when speaking)
  isMicTestActive?: boolean;
  subscribeMicLevel?: (cb: (level: number) => void) => () => void;
  isPeerSimActive?: boolean;
  voiceError?: string | null;
  onToggleMicTest?: () => void;
  onTogglePeerSim?: () => void;
  onSwitchVoiceMode?: (mode: VoiceMode) => void;
  onChangeVoiceVolume?: (val: number) => void;
  onChangeVoicePriority?: (val: number) => void;
  onChangeSelfDuckPercent?: (val: number) => void;
  onChangeNickname: (newNickname: string) => void;
  onLeaveRoom: () => void;
  onCloseRoom: () => void;
  uiTheme?: UiThemeId;
  onChangeUiTheme?: (theme: UiThemeId) => void;
  ambilightEnabled?: boolean;
  onToggleAmbilight?: (enabled: boolean) => void;
  onOpenMechanics?: (tab?: MechanicsTabId) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  roomId,
  isHost,
  nickname,
  userCount,
  isConnected,
  voiceMode = 'text',
  isMicOn = false,
  isSelfSpeaking = false,
  voiceVolumePercent = 100,
  voicePriorityRatio = 67,
  selfDuckPercent = 30,
  isMicTestActive = false,
  subscribeMicLevel,
  isPeerSimActive = false,
  voiceError = null,
  onToggleMicTest,
  onTogglePeerSim,
  onSwitchVoiceMode,
  onChangeVoiceVolume,
  onChangeVoicePriority,
  onChangeSelfDuckPercent,
  onChangeNickname,
  onLeaveRoom,
  onCloseRoom,
  uiTheme = 'default',
  onChangeUiTheme,
  ambilightEnabled = true,
  onToggleAmbilight,
  onOpenMechanics,
}) => {
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'updates'>('general');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [nickInput, setNickInput] = useState(nickname);
  const [nickSaved, setNickSaved] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const micLevelBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMicTestActive || !subscribeMicLevel) {
      if (micLevelBarRef.current) micLevelBarRef.current.style.width = '0%';
      return;
    }
    return subscribeMicLevel((level) => {
      if (micLevelBarRef.current) {
        micLevelBarRef.current.style.width = `${level}%`;
      }
    });
  }, [isMicTestActive, subscribeMicLevel]);

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

  const handleCopyLink = async () => {
    const inviteUrl = `${window.location.origin}?room=${roomId}`;
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
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

  const videoPriorityPart = 100 - voicePriorityRatio;
  const voicePriorityPart = voicePriorityRatio;

  return (
    <header className="h-12 md:h-14 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur-md px-2.5 md:px-4 flex items-center justify-between gap-2 shrink-0 z-30">
      {/* Left: Voice / Text Chat Mode Toggle (if voice enabled) or compact brand label */}
      <div className="flex items-center shrink-0">
        {onSwitchVoiceMode ? (
          <button
            type="button"
            onClick={() => onSwitchVoiceMode(voiceMode === 'text' ? 'voice' : 'text')}
            className={`px-2.5 py-1.5 rounded-lg border text-[11px] sm:text-xs font-medium transition cursor-pointer flex items-center gap-1.5 ${
              voiceMode === 'voice'
                ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                : 'bg-neutral-900 hover:bg-neutral-800 border-neutral-800 text-neutral-200 hover:text-white'
            }`}
            title={
              voiceMode === 'text'
                ? 'Переключиться в голосовой чат'
                : 'Вернуться в текстовый чат (микрофон выключится)'
            }
          >
            {voiceMode === 'text' ? (
              <>
                <Mic className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Голосовой чат</span>
              </>
            ) : (
              <>
                <MessageSquare className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span>Текстовый чат</span>
                {isMicOn && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      isSelfSpeaking ? 'bg-emerald-400 animate-ping' : 'bg-emerald-400'
                    }`}
                  />
                )}
              </>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-neutral-900/70 border border-neutral-800/80 text-xs font-semibold text-neutral-200">
            <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
            <span className="hidden sm:inline">SyncWatch</span>
          </div>
        )}
      </div>

      {/* Center: Room Code Pill & Share */}
      <div className="flex items-center gap-1.5 min-w-0">
        <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded-full pl-2.5 pr-1 py-0.5 md:py-1">
          <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-300">
            <Radio className={`w-3 h-3 shrink-0 ${isConnected ? 'text-rose-500 animate-pulse' : 'text-neutral-500'}`} />
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

      {/* Right: Online Count & Settings Menu (no nickname or crown in header) */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden md:flex items-center gap-1.5 px-2 py-0.5 md:py-1 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-400">
          <Users className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-mono tabular-nums text-white text-[11px]">{userCount}</span>
        </div>

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
            <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-1.5rem)] max-h-[82vh] overflow-y-auto p-3.5 bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl z-50 text-left space-y-3.5">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  <Settings className="w-3.5 h-3.5 text-rose-400" />
                  <span>Настройки</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700/60">
                    {APP_VERSION}
                  </span>
                </div>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Settings Tabs: General / Updates */}
              <div className="flex p-1 bg-neutral-950 rounded-xl border border-neutral-800">
                <button
                  type="button"
                  onClick={() => setSettingsTab('general')}
                  className={`flex-1 py-1.5 text-[11px] font-semibold rounded-lg transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    settingsTab === 'general'
                      ? 'bg-neutral-800 text-white shadow'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  <Settings className="w-3 h-3" />
                  <span>Основные</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab('updates')}
                  className={`flex-1 py-1.5 text-[11px] font-semibold rounded-lg transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    settingsTab === 'updates'
                      ? 'bg-neutral-800 text-white shadow'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  <span>Обновления</span>
                </button>
              </div>

              {settingsTab === 'general' ? (
                <>
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

              {/* Interface Theme Selector (persisted in localStorage) */}
              {onChangeUiTheme && (
                <div className="pt-2.5 border-t border-neutral-800 space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-400">
                    <Palette className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    <span>Стиль интерфейса</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {UI_THEMES.map((theme) => {
                      const isActive = uiTheme === theme.id;
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          onClick={() => onChangeUiTheme(theme.id)}
                          title={theme.description}
                          className={`px-2.5 py-2 rounded-xl border text-left transition cursor-pointer flex items-center gap-2 ${
                            isActive
                              ? 'bg-neutral-800 border-rose-500/70 text-white shadow-sm'
                              : 'bg-neutral-950/70 border-neutral-800 text-neutral-300 hover:bg-neutral-800/70 hover:border-neutral-700'
                          }`}
                        >
                          <span
                            className="w-4 h-4 rounded-full shrink-0 border border-white/15 flex items-center justify-center overflow-hidden"
                            style={{
                              background: `linear-gradient(135deg, ${theme.swatches[1]} 0%, ${theme.swatches[2]} 100%)`,
                            }}
                          />
                          <span className="text-[11px] font-medium truncate flex-1">
                            {theme.name}
                          </span>
                          {isActive && <Check className="w-3 h-3 text-rose-400 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Ambilight Toggle */}
              {onToggleAmbilight && (
                <div className="pt-2.5 border-t border-neutral-800 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-neutral-200 leading-tight">
                        Подсветка Ambilight
                      </div>
                      <div className="text-[10px] text-neutral-500 leading-tight mt-0.5">
                        Мягкое свечение вокруг плеера
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={ambilightEnabled}
                    onClick={() => onToggleAmbilight(!ambilightEnabled)}
                    className={`w-9 h-5 rounded-full transition-colors p-0.5 shrink-0 cursor-pointer flex items-center ${
                      ambilightEnabled ? 'bg-rose-600 justify-end' : 'bg-neutral-800 border border-neutral-700 justify-start'
                    }`}
                    title={ambilightEnabled ? 'Выключить Ambilight' : 'Включить Ambilight'}
                  >
                    <span className="w-4 h-4 rounded-full bg-white shadow-sm block" />
                  </button>
                </div>
              )}

              {/* Dedicated Mechanics & Commands Guide Button */}
              {onOpenMechanics && (
                <div className="pt-2.5 border-t border-neutral-800">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSettings(false);
                      onOpenMechanics('player');
                    }}
                    className="w-full px-3 py-2.5 rounded-xl bg-neutral-950/90 hover:bg-neutral-800 border border-neutral-800 hover:border-amber-500/40 transition cursor-pointer flex items-center justify-between gap-2 text-left group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                        <BookOpen className="w-3.5 h-3.5 text-amber-400" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">
                          Все механики и команды
                        </div>
                        <div className="text-[10px] text-neutral-400 truncate">
                          Плеер, спойлеры, Pin, RP-действия
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-neutral-500 group-hover:text-amber-300 transition shrink-0" />
                  </button>
                </div>
              )}

              {/* Voice Chat Audio & Ducking Priority Settings (when voice enabled) */}
              {onSwitchVoiceMode && (
              <div className="pt-2.5 border-t border-neutral-800 space-y-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
                  <Volume2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Звук голосового чата</span>
                </div>

                {/* Global Voice Volume Boost 0..200% */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-neutral-300">Громкость собеседников</span>
                    <span className="font-mono tabular-nums font-semibold text-emerald-400">
                      {voiceVolumePercent}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={5}
                    value={voiceVolumePercent}
                    onChange={(e) => onChangeVoiceVolume?.(Number(e.target.value))}
                    className="w-full accent-emerald-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
                  />
                </div>

                {/* Speaking Priority Ratio: 100:0 (Video) <-> 50:50 <-> 0:100 (Voice) */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-neutral-300">Приоритет при речи друзей</span>
                    <span className="font-mono tabular-nums font-semibold text-amber-300">
                      {videoPriorityPart}:{voicePriorityPart}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={voicePriorityRatio}
                    onChange={(e) => onChangeVoicePriority?.(Number(e.target.value))}
                    className="w-full accent-amber-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
                  />
                  <div className="flex items-center justify-between text-[10px] text-neutral-500">
                    <span>100:0 Видео</span>
                    <button
                      type="button"
                      onClick={() => onChangeVoicePriority?.(67)}
                      className="text-neutral-400 hover:text-amber-300 underline cursor-pointer"
                    >
                      Сброс (33:67)
                    </button>
                    <span>0:100 Голос</span>
                  </div>
                  <p className="text-[10px] text-neutral-500 leading-snug">
                    Срабатывает только во время речи собеседников. По умолчанию видео становится тише голоса на треть.
                  </p>
                </div>

                {/* Self Speaking Video Ducking (default 30%) */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-neutral-300">Видео, когда говорите вы</span>
                    <span className="font-mono tabular-nums font-semibold text-rose-300">
                      до {selfDuckPercent}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={selfDuckPercent}
                    onChange={(e) => onChangeSelfDuckPercent?.(Number(e.target.value))}
                    className="w-full accent-rose-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
                  />
                </div>

                {/* Debug Voice Test Buttons */}
                <div className="pt-2 border-t border-neutral-800/70 space-y-2">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
                    <span>Debug: тест голоса</span>
                    {(isMicTestActive || isPeerSimActive) && (
                      <span className="text-emerald-400 animate-pulse">Активен</span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => onToggleMicTest?.()}
                      className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition cursor-pointer flex items-center justify-center gap-1 ${
                        isMicTestActive
                          ? 'bg-emerald-600/25 border-emerald-500/60 text-emerald-200'
                          : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
                      }`}
                      title="Включить петлю микрофона (услышать свой голос с задержкой 0.18с)"
                    >
                      {isMicTestActive ? (
                        <>
                          <Square className="w-3 h-3 fill-emerald-400 text-emerald-400 shrink-0" />
                          <span>Стоп микро</span>
                        </>
                      ) : (
                        <>
                          <Mic className="w-3 h-3 text-emerald-400 shrink-0" />
                          <span>Тест микро</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => onTogglePeerSim?.()}
                      className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition cursor-pointer flex items-center justify-center gap-1 ${
                        isPeerSimActive
                          ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                          : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
                      }`}
                      title="Имитация речи собеседника для проверки громкости и приглушения видео"
                    >
                      {isPeerSimActive ? (
                        <>
                          <Square className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />
                          <span>Стоп тест</span>
                        </>
                      ) : (
                        <>
                          <Headphones className="w-3 h-3 text-amber-400 shrink-0" />
                          <span>Собеседник</span>
                        </>
                      )}
                    </button>
                  </div>

                  {isMicTestActive && (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full bg-neutral-950 rounded-full overflow-hidden border border-neutral-800">
                        <div
                          ref={micLevelBarRef}
                          className="h-full bg-gradient-to-r from-emerald-500 to-amber-400 transition-all duration-75"
                          style={{ width: '0%' }}
                        />
                      </div>
                      <p className="text-[10px] text-emerald-300/90">
                        Вы слышите свой голос через усиление {voiceVolumePercent}%.
                      </p>
                    </div>
                  )}

                  {voiceError && (
                    <p className="text-[10px] text-amber-300 leading-snug">{voiceError}</p>
                  )}
                </div>
              </div>
              )}

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
                </>
              ) : (
                <div className="space-y-3">
                  {/* Current Version Card */}
                  <div className="p-2.5 rounded-xl bg-gradient-to-br from-rose-500/10 via-neutral-950 to-amber-500/10 border border-rose-500/25 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
                        Текущая версия
                      </div>
                      <div className="text-xs font-bold text-white mt-0.5 flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5 text-amber-400" />
                        <span>{APP_VERSION}</span>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-semibold text-emerald-300">
                      Актуально
                    </span>
                  </div>

                  {/* Changelog Diary */}
                  <div className="space-y-2.5 max-h-72 overflow-y-auto pr-0.5">
                    <div className="text-[11px] font-semibold text-neutral-400">
                      Дневник изменений
                    </div>

                    {CHANGELOG.map((entry) => (
                      <div
                        key={entry.version}
                        className="p-2.5 rounded-xl bg-neutral-950/80 border border-neutral-800 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs font-bold text-white truncate">
                              {entry.version}
                            </span>
                            <span
                              className={`px-1.5 py-0.2 rounded border text-[9px] font-semibold shrink-0 ${
                                entry.tag === 'Release'
                                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                                  : entry.tag === 'Beta'
                                  ? 'bg-amber-500/15 border-amber-500/35 text-amber-300'
                                  : 'bg-sky-500/15 border-sky-500/35 text-sky-300'
                              }`}
                            >
                              {entry.tag}
                            </span>
                          </div>
                          <span className="text-[10px] font-mono text-neutral-500 shrink-0">
                            {entry.date}
                          </span>
                        </div>

                        <p className="text-[11px] font-medium text-amber-300/95 leading-snug">
                          {entry.title}
                        </p>

                        <ul className="space-y-1.5">
                          {entry.changes.map((item, idx) => (
                            <li
                              key={idx}
                              className="text-[11px] text-neutral-300 leading-snug flex items-start gap-1.5"
                            >
                              <span className="w-1 h-1 rounded-full bg-rose-400 mt-1.5 shrink-0" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

