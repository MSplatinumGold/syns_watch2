import React, { useEffect, useState } from 'react';
import {
  X,
  BookOpen,
  PlayCircle,
  MessageSquare,
  Sparkles,
  Users,
  Crown,
} from 'lucide-react';
import {
  CHAT_MECHANICS,
  MECHANICS_TABS,
  PLAYER_MECHANICS,
  ROOM_MECHANICS,
  RP_ACTIONS_GROUPS,
  RP_CATEGORIES,
  type MechanicItem,
  type MechanicsTabId,
  type RpCategoryId,
} from '../utils/mechanics.ts';

interface SiteMechanicsModalProps {
  isOpen: boolean;
  initialTab?: MechanicsTabId;
  onClose: () => void;
}

export const SiteMechanicsModal: React.FC<SiteMechanicsModalProps> = ({
  isOpen,
  initialTab = 'player',
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<MechanicsTabId>(initialTab);
  const [rpCategory, setRpCategory] = useState<RpCategoryId>('all');

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const renderMechanicList = (items: MechanicItem[]) => (
    <div className="space-y-2.5">
      {items.map((item, idx) => (
        <div
          key={idx}
          className="p-3 rounded-xl bg-neutral-950/80 border border-neutral-800 space-y-1.5"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="text-xs sm:text-sm font-semibold text-white">{item.title}</h4>
            <div className="flex items-center gap-1.5 shrink-0">
              {item.role === 'Хост' && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300 text-[10px] font-semibold">
                  <Crown className="w-2.5 h-2.5" />
                  Хост
                </span>
              )}
              {item.badge && (
                <span className="px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 font-mono text-[10px] font-medium">
                  {item.badge}
                </span>
              )}
            </div>
          </div>
          <p className="text-[11px] sm:text-xs text-neutral-300 leading-relaxed">
            {item.description}
          </p>
        </div>
      ))}
    </div>
  );

  const filteredRpGroups =
    rpCategory === 'all'
      ? RP_ACTIONS_GROUPS
      : RP_ACTIONS_GROUPS.filter((g) => g.category === rpCategory);

  const tabIcons: Record<MechanicsTabId, React.ReactNode> = {
    player: <PlayCircle className="w-3.5 h-3.5" />,
    chat: <MessageSquare className="w-3.5 h-3.5" />,
    rp: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
    room: <Users className="w-3.5 h-3.5" />,
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[88vh] bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-950/75 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
              <BookOpen className="w-4 h-4 text-rose-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white truncate">
                Все механики и команды
              </h3>
              <p className="text-[11px] text-neutral-400 truncate">
                Возможности плеера, чата, спойлеров и RP-действий
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition cursor-pointer shrink-0"
            title="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Category Filter Tabs */}
        <div className="px-3 pt-2.5 pb-2 bg-neutral-950/40 border-b border-neutral-800/80 flex items-center gap-1.5 overflow-x-auto shrink-0">
          {MECHANICS_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition cursor-pointer shrink-0 ${
                  isActive
                    ? 'bg-neutral-800 text-white border border-neutral-600/70 shadow-sm'
                    : 'bg-neutral-950/60 text-neutral-400 hover:text-white border border-neutral-800/80 hover:bg-neutral-800/60'
                }`}
              >
                {tabIcons[tab.id]}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3.5 sm:p-4 overscroll-contain">
          {activeTab === 'player' && renderMechanicList(PLAYER_MECHANICS)}
          {activeTab === 'chat' && renderMechanicList(CHAT_MECHANICS)}
          {activeTab === 'room' && renderMechanicList(ROOM_MECHANICS)}

          {activeTab === 'rp' && (
            <div className="space-y-3">
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] sm:text-xs text-neutral-200 leading-relaxed">
                Нажмите на сообщение участника и ответьте (Reply) одним из слов ниже. Можно добавить уточнение, например:{' '}
                <span className="text-amber-300 font-semibold">поцеловать в щеку</span>,{' '}
                <span className="text-amber-300 font-semibold">налить какао</span> или{' '}
                <span className="text-amber-300 font-semibold">дать печеньку</span>.
              </div>

              {/* RP Sub-filter chips */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                {RP_CATEGORIES.map((cat) => {
                  const isActive = rpCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setRpCategory(cat.id)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap transition cursor-pointer shrink-0 border ${
                        isActive
                          ? 'bg-rose-600/25 border-rose-500/50 text-rose-200'
                          : 'bg-neutral-950/70 border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-700'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {filteredRpGroups.map((grp, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2.5 p-2.5 rounded-xl bg-neutral-950/80 border border-neutral-800/80"
                  >
                    <span className="text-base leading-none mt-0.5 shrink-0">{grp.emoji}</span>
                    <div className="min-w-0 text-[11px] sm:text-xs text-neutral-200 leading-snug">
                      <span>{grp.words}</span>
                      {grp.example && (
                        <span className="block text-[10px] text-amber-300/90 mt-1">
                          напр.: «{grp.example}»
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
