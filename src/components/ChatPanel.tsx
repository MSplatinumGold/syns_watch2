import React, { useState, useRef, useEffect } from 'react';
import { Send, Smile, Sparkles, Crown } from 'lucide-react';
import type { ChatMessage, User } from '../types/watchparty.ts';

interface ChatPanelProps {
  messages: ChatMessage[];
  users: Record<string, User>;
  hostId: string;
  currentUserId: string;
  onSendMessage: (text: string) => void;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const EXTENDED_EMOJIS = [
  '🍿', '🎬', '🎉', '🚀', '👏', '🥳', 
  '🤔', '😴', '👀', '💀', '💯', '🤝', 
  '😎', '🙌', '✨', '⚡', '🤩', '😱'
];

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  users,
  hostId,
  currentUserId,
  onSendMessage,
}) => {
  const [text, setText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // Track if user was scrolled near bottom before new messages
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceToBottom < 60;
  };

  // Safe inner container scroll (never scrolls the entire window/page on tablets)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const lastMsg = messages[messages.length - 1];
    const isMe = lastMsg && lastMsg.userId === currentUserId;

    // Only scroll if user is already at the bottom or sent the message themselves
    if (isNearBottomRef.current || isMe) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, currentUserId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean) return;
    onSendMessage(clean);
    setText('');
    setShowEmojiPicker(false);
  };

  const handleQuickEmoji = (emoji: string) => {
    onSendMessage(emoji);
  };

  const handleInsertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
  };

  const formatMessageTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl min-h-0">
      {/* Messages Feed */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-2.5 overscroll-contain"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-500">
            <Sparkles className="w-8 h-8 mb-2 text-neutral-600" />
            <p className="text-sm">Чат пока пуст.</p>
            <p className="text-xs text-neutral-600 mt-1">Отправьте сообщение или реакцию!</p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.type === 'system') {
              return (
                <div key={msg.id} className="text-center my-2">
                  <span className="inline-block px-2.5 py-1 rounded-full bg-neutral-800/80 border border-neutral-700/50 text-[11px] text-neutral-400 font-medium">
                    {msg.text}
                  </span>
                </div>
              );
            }

            const isMe = msg.userId === currentUserId;
            const isMsgHost = msg.userId === hostId;

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span className={`text-[11px] font-semibold flex items-center gap-1 ${
                    isMsgHost ? 'text-amber-400' : isMe ? 'text-rose-400' : 'text-neutral-300'
                  }`}>
                    {isMsgHost && <Crown className="w-3 h-3 fill-amber-400 text-amber-400" />}
                    {msg.nickname}
                  </span>
                  <span className="text-[10px] text-neutral-500 font-mono">
                    {formatMessageTime(msg.timestamp)}
                  </span>
                </div>

                <div
                  className={`px-3 py-2 rounded-2xl text-xs md:text-sm max-w-[85%] break-words shadow-sm ${
                    isMe
                      ? 'bg-rose-600 text-white rounded-tr-xs'
                      : 'bg-neutral-800 text-neutral-200 border border-neutral-700/60 rounded-tl-xs'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Quick Reaction Emoji Row */}
      <div className="px-3 py-1.5 bg-neutral-950/80 border-t border-neutral-800/80 flex items-center justify-between gap-1 overflow-x-auto shrink-0">
        <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-500 mr-1 select-none">
          Реакции
        </span>
        <div className="flex items-center gap-1">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleQuickEmoji(emoji)}
              className="w-7 h-7 rounded-lg hover:bg-neutral-800 active:scale-110 transition flex items-center justify-center text-sm cursor-pointer select-none"
              title={`Отправить ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      {/* Input Box - strictly fixed in visible screen area */}
      <div className="p-2.5 sm:p-3 pb-[max(0.625rem,calc(0.5rem+env(safe-area-inset-bottom)))] bg-neutral-950 border-t border-neutral-800 relative shrink-0 z-20">
        {/* Extended Emoji Picker Popup */}
        {showEmojiPicker && (
          <div className="absolute bottom-full mb-2 right-3 w-56 p-2 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl grid grid-cols-6 gap-1 z-30">
            {EXTENDED_EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => handleInsertEmoji(em)}
                className="w-8 h-8 rounded hover:bg-neutral-800 flex items-center justify-center text-base cursor-pointer transition select-none"
              >
                {em}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className={`p-2 rounded-xl border transition cursor-pointer ${
              showEmojiPicker
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Эмодзи"
          >
            <Smile className="w-4 h-4" />
          </button>

          <input
            type="text"
            placeholder="Написать в чат..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="flex-1 bg-neutral-900 border border-neutral-700 focus:border-rose-500 text-neutral-200 placeholder-neutral-500 text-xs md:text-sm rounded-xl px-3 py-2 outline-none transition"
          />

          <button
            type="submit"
            disabled={!text.trim()}
            className="p-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:hover:bg-rose-600 text-white transition shadow cursor-pointer"
            title="Отправить (Enter)"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
