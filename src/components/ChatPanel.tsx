import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Smile,
  Sparkles,
  Crown,
  Paperclip,
  X,
  Loader2,
  AlertTriangle,
  Film,
  Music,
  Image as ImageIcon,
  Trash2,
  Reply,
} from 'lucide-react';
import type { ChatMessage, ChatReplyRef, User } from '../types/watchparty.ts';
import { formatBytes } from '../utils/format.ts';

const MAX_CHAT_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB limit per file

interface ChatPanelProps {
  messages: ChatMessage[];
  users: Record<string, User>;
  hostId: string;
  currentUserId: string;
  roomId: string;
  isKeyboardOpen?: boolean;
  onSendMessage: (text: string, replyTo?: ChatReplyRef) => void;
  onDeleteMessage: (messageId: string) => void;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const EXTENDED_EMOJIS = [
  '🍿', '🎬', '🎉', '🚀', '👏', '🥳',
  '🤔', '😴', '👀', '💀', '💯', '🤝',
  '😎', '🙌', '✨', '⚡', '🤩', '😱',
];

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  hostId,
  currentUserId,
  roomId,
  isKeyboardOpen = false,
  onSendMessage,
  onDeleteMessage,
}) => {
  const [text, setText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [activeMenuMessageId, setActiveMenuMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    if (!activeMenuMessageId) return;
    const handleClose = () => setActiveMenuMessageId(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveMenuMessageId(null);
    };
    document.addEventListener('click', handleClose);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClose);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMenuMessageId]);

  useEffect(() => {
    if (!pendingFile) {
      setPendingPreviewUrl(null);
      return;
    }
    if (pendingFile.type.startsWith('image/')) {
      const objUrl = URL.createObjectURL(pendingFile);
      setPendingPreviewUrl(objUrl);
      return () => URL.revokeObjectURL(objUrl);
    }
    setPendingPreviewUrl(null);
  }, [pendingFile]);

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

    if (isNearBottomRef.current || isMe) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, currentUserId]);

  const handleSelectMediaFile = (file: File | null) => {
    setMediaError(null);
    if (!file) return;

    const isAllowed =
      file.type.startsWith('image/') ||
      file.type.startsWith('video/') ||
      file.type.startsWith('audio/');
    if (!isAllowed) {
      setMediaError('Поддерживаются только картинки, GIF, видео и аудио.');
      return;
    }

    if (file.size > MAX_CHAT_MEDIA_BYTES) {
      setMediaError(
        `Файл слишком большой (${formatBytes(file.size)}). Максимум — 10 МБ на файл.`
      );
      return;
    }

    setPendingFile(file);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const pastedFile = items[i].getAsFile();
        if (pastedFile) {
          e.preventDefault();
          handleSelectMediaFile(pastedFile);
          break;
        }
      }
    }
  };

  const resetTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const formatMediaLabel = (mediaKind?: 'image' | 'video' | 'audio') => {
    if (mediaKind === 'image') return 'Фото';
    if (mediaKind === 'video') return 'Видео';
    if (mediaKind === 'audio') return 'Аудио';
    return 'Медиа';
  };

  const toReplyRef = (msg: ChatMessage): ChatReplyRef => ({
    id: msg.id,
    userId: msg.userId,
    nickname: msg.nickname,
    text: msg.text.slice(0, 120),
    hasMedia: Boolean(msg.media && !msg.media.expired),
    mediaKind: msg.media?.mediaKind,
  });

  const startReply = (msg: ChatMessage) => {
    setReplyingTo(msg);
    setActiveMenuMessageId(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const scrollToMessage = (messageId: string) => {
    const el = document.getElementById(`chat-msg-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedMessageId(messageId);
      setTimeout(() => {
        setHighlightedMessageId((curr) => (curr === messageId ? null : curr));
      }, 1400);
    }
  };

  const submitMessage = async () => {
    if (isUploadingMedia) return;

    const clean = text.trim();
    const replyRef = replyingTo ? toReplyRef(replyingTo) : undefined;

    if (pendingFile) {
      setIsUploadingMedia(true);
      setMediaError(null);
      try {
        const formData = new FormData();
        formData.append('media', pendingFile);
        if (clean) {
          formData.append('text', clean);
        }
        if (replyRef) {
          formData.append('replyTo', JSON.stringify(replyRef));
        }

        const res = await fetch(`/api/rooms/${roomId}/chat/upload`, {
          method: 'POST',
          headers: {
            'x-socket-id': currentUserId,
          },
          body: formData,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Не удалось загрузить медиафайл');
        }

        setPendingFile(null);
        setText('');
        setReplyingTo(null);
        resetTextareaHeight();
        setShowEmojiPicker(false);
        if (mediaInputRef.current) mediaInputRef.current.value = '';
      } catch (err: any) {
        setMediaError(err?.message || 'Ошибка отправки медиафайла');
      } finally {
        setIsUploadingMedia(false);
      }
      return;
    }

    if (!clean) return;
    onSendMessage(clean, replyRef);
    setText('');
    setReplyingTo(null);
    resetTextareaHeight();
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
    <div
      className={`flex flex-col bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl min-h-0 ${
        isKeyboardOpen ? 'shrink-0' : 'h-full'
      }`}
    >
      {/* Image Lightbox Modal */}
      {lightboxImageUrl && (
        <div
          onClick={() => setLightboxImageUrl(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <button
            type="button"
            onClick={() => setLightboxImageUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-neutral-900/90 border border-neutral-700 text-white hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={lightboxImageUrl}
            alt="Просмотр изображения"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-[90vh] rounded-xl object-contain shadow-2xl"
          />
        </div>
      )}

      {/* Messages Feed (collapsed when mobile keyboard is open so video stays visible) */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`min-h-0 overflow-y-auto p-3.5 space-y-2.5 overscroll-contain ${
          isKeyboardOpen ? 'hidden' : 'flex-1'
        }`}
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-500">
            <Sparkles className="w-8 h-8 mb-2 text-neutral-600" />
            <p className="text-sm">Чат пока пуст.</p>
            <p className="text-xs text-neutral-600 mt-1">
              Отправьте сообщение, реакцию или медиафайл (до 10 МБ)!
            </p>
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

            if (msg.type === 'action') {
              return (
                <div key={msg.id} className="flex justify-center my-1.5">
                  <div className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-500/15 via-amber-500/15 to-rose-500/15 border border-rose-500/30 text-rose-100 text-xs font-medium text-center shadow-sm max-w-[92%]">
                    {msg.text}
                  </div>
                </div>
              );
            }

            const isMe = msg.userId === currentUserId;
            const isMsgHost = msg.userId === hostId;
            const isHighlighted = highlightedMessageId === msg.id;

            return (
              <div
                key={msg.id}
                id={`chat-msg-${msg.id}`}
                className={`flex flex-col transition-colors duration-300 rounded-xl ${
                  isMe ? 'items-end' : 'items-start'
                } ${isHighlighted ? 'bg-rose-500/10 ring-1 ring-rose-500/40 p-1 -m-1' : ''}`}
              >
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span
                    className={`text-[11px] font-semibold flex items-center gap-1 ${
                      isMsgHost
                        ? 'text-amber-400'
                        : isMe
                        ? 'text-rose-400'
                        : 'text-neutral-300'
                    }`}
                  >
                    {isMsgHost && <Crown className="w-3 h-3 fill-amber-400 text-amber-400" />}
                    {msg.nickname}
                  </span>
                  <span className="text-[10px] text-neutral-500 font-mono">
                    {formatMessageTime(msg.timestamp)}
                  </span>
                </div>

                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isMe) {
                      setActiveMenuMessageId((prev) => (prev === msg.id ? null : msg.id));
                    } else {
                      startReply(msg);
                    }
                  }}
                  title={isMe ? 'Нажмите для действий с сообщением' : 'Нажмите, чтобы ответить'}
                  className={`px-3 py-2 rounded-2xl text-xs md:text-sm max-w-[85%] break-words shadow-sm space-y-1.5 cursor-pointer active:scale-[0.99] transition select-text ${
                    isMe
                      ? 'bg-rose-600 hover:bg-rose-500/95 text-white rounded-tr-xs'
                      : 'bg-neutral-800 hover:bg-neutral-700/80 text-neutral-200 border border-neutral-700/60 rounded-tl-xs'
                  }`}
                >
                  {msg.replyTo && (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        scrollToMessage(msg.replyTo!.id);
                      }}
                      className={`px-2 py-1 rounded-lg border-l-2 text-[11px] cursor-pointer transition ${
                        isMe
                          ? 'bg-black/20 border-white/75 hover:bg-black/30 text-white/95'
                          : 'bg-neutral-900/80 border-rose-500 hover:bg-neutral-900 text-neutral-300'
                      }`}
                    >
                      <div className="font-semibold truncate">{msg.replyTo.nickname}</div>
                      <div className="truncate opacity-80">
                        {msg.replyTo.text ||
                          (msg.replyTo.hasMedia
                            ? `[${formatMediaLabel(msg.replyTo.mediaKind)}]`
                            : 'Сообщение')}
                      </div>
                    </div>
                  )}

                  {msg.media && (
                    <div>
                      {msg.media.expired ? (
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-black/25 text-[11px] text-neutral-300/80 italic">
                          <Trash2 className="w-3.5 h-3.5 shrink-0" />
                          <span>Медиа удалено (превышен лимит 100 МБ комнаты)</span>
                        </div>
                      ) : msg.media.mediaKind === 'image' ? (
                        <img
                          src={msg.media.url}
                          alt={msg.media.originalName}
                          loading="lazy"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLightboxImageUrl(msg.media!.url);
                          }}
                          className="max-h-60 w-auto max-w-full rounded-xl object-contain bg-black/30 cursor-pointer hover:opacity-95 transition"
                        />
                      ) : msg.media.mediaKind === 'video' ? (
                        <video
                          src={msg.media.url}
                          controls
                          playsInline
                          preload="metadata"
                          onClick={(e) => e.stopPropagation()}
                          className="max-h-60 w-full rounded-xl bg-black"
                        />
                      ) : (
                        <audio
                          src={msg.media.url}
                          controls
                          preload="metadata"
                          onClick={(e) => e.stopPropagation()}
                          className="w-full max-w-[250px]"
                        />
                      )}
                      {!msg.media.expired && (
                        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] opacity-75 font-mono">
                          <span className="truncate">{msg.media.originalName}</span>
                          <span className="shrink-0">{formatBytes(msg.media.size)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {msg.text && <p>{msg.text}</p>}
                </div>

                {/* Own message click context menu (Reply + Delete) */}
                {isMe && activeMenuMessageId === msg.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1 flex items-center gap-1 bg-neutral-950 border border-neutral-700/80 rounded-xl p-1 shadow-xl z-30"
                  >
                    <button
                      type="button"
                      onClick={() => startReply(msg)}
                      className="px-2.5 py-1 rounded-lg hover:bg-neutral-800 text-[11px] font-medium text-neutral-200 flex items-center gap-1.5 cursor-pointer transition"
                    >
                      <Reply className="w-3.5 h-3.5 text-sky-400" />
                      <span>Ответить</span>
                    </button>
                    <div className="w-px h-4 bg-neutral-800" />
                    <button
                      type="button"
                      onClick={() => {
                        onDeleteMessage(msg.id);
                        setActiveMenuMessageId(null);
                        if (replyingTo?.id === msg.id) setReplyingTo(null);
                      }}
                      className="px-2.5 py-1 rounded-lg hover:bg-rose-950/70 text-[11px] font-medium text-rose-400 flex items-center gap-1.5 cursor-pointer transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Удалить</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Quick Reaction Emoji Row (hidden when mobile keyboard is open) */}
      <div
        className={`px-3 py-1.5 bg-neutral-950/80 border-t border-neutral-800/80 items-center justify-between gap-1 overflow-x-auto shrink-0 ${
          isKeyboardOpen ? 'hidden' : 'flex'
        }`}
      >
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
      <div
        className={`${
          isKeyboardOpen
            ? 'p-1.5 bg-neutral-950 relative shrink-0 z-20 space-y-1'
            : 'p-2 sm:p-3 pb-[max(0.5rem,calc(0.35rem+env(safe-area-inset-bottom)))] bg-neutral-950 border-t border-neutral-800 relative shrink-0 z-20 space-y-1.5'
        }`}
      >
        {/* Reply target preview */}
        {replyingTo && (
          <div className="px-2.5 py-1 rounded-xl bg-neutral-900 border border-neutral-700/80 border-l-2 border-l-rose-500 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Reply className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-rose-400 truncate">
                  Ответ для {replyingTo.nickname}
                </div>
                <div className="text-[11px] text-neutral-400 truncate">
                  {replyingTo.text ||
                    (replyingTo.media
                      ? `[${formatMediaLabel(replyingTo.media.mediaKind)}]`
                      : 'Сообщение')}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white cursor-pointer shrink-0"
              title="Отменить ответ"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Media validation / upload error */}
        {mediaError && (
          <div className="px-2.5 py-1.5 rounded-xl bg-rose-950/70 border border-rose-700/50 text-rose-200 text-[11px] flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="truncate">{mediaError}</span>
            </div>
            <button
              type="button"
              onClick={() => setMediaError(null)}
              className="text-rose-300 hover:text-white cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Pending Media Attachment Preview */}
        {pendingFile && (
          <div className="px-2.5 py-1.5 rounded-xl bg-neutral-900 border border-neutral-700 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {pendingPreviewUrl ? (
                <img
                  src={pendingPreviewUrl}
                  alt={pendingFile.name}
                  className="w-9 h-9 rounded-lg object-cover shrink-0 border border-neutral-700"
                />
              ) : pendingFile.type.startsWith('video/') ? (
                <div className="w-9 h-9 rounded-lg bg-neutral-800 flex items-center justify-center shrink-0">
                  <Film className="w-4 h-4 text-rose-400" />
                </div>
              ) : pendingFile.type.startsWith('audio/') ? (
                <div className="w-9 h-9 rounded-lg bg-neutral-800 flex items-center justify-center shrink-0">
                  <Music className="w-4 h-4 text-amber-400" />
                </div>
              ) : (
                <div className="w-9 h-9 rounded-lg bg-neutral-800 flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4 text-neutral-300" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-xs text-white font-medium truncate">{pendingFile.name}</p>
                <p className="text-[10px] text-neutral-400 font-mono">
                  {formatBytes(pendingFile.size)} / 10 МБ макс.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={isUploadingMedia}
              onClick={() => {
                setPendingFile(null);
                if (mediaInputRef.current) mediaInputRef.current.value = '';
              }}
              className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white cursor-pointer disabled:opacity-40"
              title="Убрать вложение"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

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

        <input
          ref={mediaInputRef}
          type="file"
          accept="image/*,video/*,audio/*"
          onChange={(e) => handleSelectMediaFile(e.target.files?.[0] || null)}
          className="hidden"
        />

        <div className="flex items-end gap-1.5 sm:gap-2">
          <button
            type="button"
            disabled={isUploadingMedia}
            onClick={() => mediaInputRef.current?.click()}
            className={`p-2 rounded-xl border transition cursor-pointer shrink-0 disabled:opacity-40 ${
              pendingFile
                ? 'bg-rose-500/20 border-rose-500/50 text-rose-400'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Прикрепить медиа (фото, GIF, видео, аудио до 10 МБ)"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className={`p-2 rounded-xl border transition cursor-pointer shrink-0 ${
              showEmojiPicker
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-white'
            }`}
            title="Эмодзи"
          >
            <Smile className="w-4 h-4" />
          </button>

          {/* Using textarea instead of form+input prevents Chrome Android Password/Card/Address autofill bar */}
          <textarea
            ref={textareaRef}
            rows={1}
            name="syncwatch_chat_msg"
            autoComplete="off"
            enterKeyHint="send"
            data-form-type="other"
            data-lpignore="true"
            placeholder={pendingFile ? 'Подпись (необязательно)...' : 'Написать в чат...'}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 84)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitMessage();
              }
            }}
            onPaste={handlePaste}
            onFocus={() => {
              setTimeout(() => {
                const el = containerRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }, 150);
            }}
            className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 focus:border-rose-500 text-neutral-200 placeholder-neutral-500 text-base sm:text-xs md:text-sm rounded-xl px-3 py-1.5 sm:py-2 outline-none transition resize-none overflow-y-auto max-h-[84px] leading-snug"
          />

          <button
            type="button"
            onClick={() => submitMessage()}
            disabled={(!text.trim() && !pendingFile) || isUploadingMedia}
            className="p-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:hover:bg-rose-600 text-white transition shadow cursor-pointer shrink-0"
            title="Отправить (Enter)"
          >
            {isUploadingMedia ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
