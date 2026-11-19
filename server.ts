import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import type {
  RoomState,
  User,
  PlaylistItem,
  ChatMessage,
  ChatReplyRef,
  ClientToServerEvents,
  ServerToClientEvents,
} from './src/types/watchparty.ts';
import { resolveStickerUrl } from './src/utils/stickers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const STORAGE_BASE_DIR = path.join(process.cwd(), 'storage', 'rooms');

// Ensure base storage directory exists
if (!fs.existsSync(STORAGE_BASE_DIR)) {
  fs.mkdirSync(STORAGE_BASE_DIR, { recursive: true });
}

interface ChatMediaEntry {
  id: string;
  filename: string;
  filePath: string;
  size: number;
  createdAt: number;
}

interface ServerRoomState extends RoomState {
  hostToken: string;
  creatorIp?: string;
  chatMediaFiles: ChatMediaEntry[];
  chatMediaTotalBytes: number;
  lastActivityAt: number;
}

const MAX_CHAT_MEDIA_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_CHAT_MEDIA_ROOM_TOTAL = 100 * 1024 * 1024; // 100 MB total per room
const MAX_PLAYLIST_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB max per video
const MAX_ROOM_PLAYLIST_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB total playlist quota per room
const NEVER_JOINED_ROOM_TTL_MS = 5 * 60 * 1000; // 5 min TTL if room created but never joined
const ROOM_IDLE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours idle TTL

const SAFE_ROOM_ID_RE = /^[a-z0-9_-]{3,24}$/;
const SAFE_FILE_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && SAFE_ROOM_ID_RE.test(roomId);
}

function isValidFileId(fileId: unknown): fileId is string {
  return typeof fileId === 'string' && SAFE_FILE_ID_RE.test(fileId);
}

function getRoomPlaylistBytes(room: ServerRoomState): number {
  return room.playlist.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
}

// In-memory room store
const rooms = new Map<string, ServerRoomState>();

// Helper to get or create room storage directory safely
function getRoomStorageDir(roomId: string): string {
  const baseResolved = path.resolve(STORAGE_BASE_DIR);
  const safeId = path.basename(roomId);
  const dir = path.resolve(baseResolved, safeId);
  if (!dir.startsWith(baseResolved + path.sep)) {
    throw new Error('Invalid room storage path');
  }
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getRoomChatMediaDir(roomId: string): string {
  const roomDir = getRoomStorageDir(roomId);
  const dir = path.join(roomDir, 'chat_media');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Fix Busboy/Multer latin1 mojibake for UTF-8 Cyrillic/Unicode filenames
function decodeOriginalName(rawName: string): string {
  if (!rawName) return 'file';
  try {
    if (/[\u0080-\u00ff]/.test(rawName)) {
      const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD')) {
        return decoded;
      }
    }
  } catch {}
  return rawName;
}

// Track recent chat message ownership per room for safe deletion & media cleanup (capped at 300 entries)
const chatMessageRegistry = new Map<string, Map<string, { userId: string; mediaId?: string }>>();
// Track active floating emojis per room (hard limit: 5 concurrent active emojis per room)
const roomFloatingEmojis = new Map<string, number[]>();
const MAX_ROOM_FLOATING_EMOJIS = 5;
const FLOATING_EMOJI_TTL_MS = 2400;

function registerChatMessage(roomId: string, messageId: string, userId: string, mediaId?: string) {
  let roomMsgs = chatMessageRegistry.get(roomId);
  if (!roomMsgs) {
    roomMsgs = new Map();
    chatMessageRegistry.set(roomId, roomMsgs);
  }
  roomMsgs.set(messageId, { userId, mediaId });
  if (roomMsgs.size > 300) {
    const oldestKey = roomMsgs.keys().next().value;
    if (oldestKey) roomMsgs.delete(oldestKey);
  }
}

function sanitizeReplyTo(raw: unknown): ChatReplyRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.nickname !== 'string') return undefined;
  const mediaKind =
    r.mediaKind === 'image' || r.mediaKind === 'video' || r.mediaKind === 'audio'
      ? r.mediaKind
      : undefined;
  return {
    id: r.id.slice(0, 64),
    userId: typeof r.userId === 'string' ? r.userId.slice(0, 64) : '',
    nickname: r.nickname.trim().slice(0, 24) || 'Участник',
    text: typeof r.text === 'string' ? r.text.slice(0, 120) : '',
    hasMedia: Boolean(r.hasMedia),
    mediaKind,
    isSticker: Boolean(r.isSticker),
  };
}

const REPLY_ACTION_TEMPLATES: Record<string, (actor: string, target: string, tail?: string) => string> = {
  // Романтика, забота и нежность
  поцеловать: (a, t, tail) => (tail ? `💋 ${a} поцеловал ${t} ${tail}` : `💋 ${a} поцеловал ${t}`),
  поцелуй: (a, t, tail) => (tail ? `💋 ${a} поцеловал ${t} ${tail}` : `💋 ${a} поцеловал ${t}`),
  чмок: (a, t, tail) => (tail ? `💋 ${a} чмокнул ${t} ${tail}` : `💋 ${a} чмокнул ${t}`),
  чмокнуть: (a, t, tail) => (tail ? `💋 ${a} чмокнул ${t} ${tail}` : `💋 ${a} чмокнул ${t}`),
  'воздушный поцелуй': (a, t, tail) =>
    tail ? `😘 ${a} послал воздушный поцелуй ${t} ${tail}` : `😘 ${a} послал воздушный поцелуй ${t}`,
  обнять: (a, t, tail) => (tail ? `🫂 ${a} обнял ${t} ${tail}` : `🫂 ${a} обнял ${t}`),
  обними: (a, t, tail) => (tail ? `🫂 ${a} обнял ${t} ${tail}` : `🫂 ${a} обнял ${t}`),
  обнимаю: (a, t, tail) => (tail ? `🫂 ${a} обнял ${t} ${tail}` : `🫂 ${a} обнял ${t}`),
  обнимашки: (a, t, tail) => (tail ? `🫂 ${a} крепко обнял ${t} ${tail}` : `🫂 ${a} крепко обнял ${t}`),
  прижать: (a, t, tail) => (tail ? `🫶 ${a} прижал ${t} ${tail}` : `🫶 ${a} крепко прижал к себе ${t}`),
  прижми: (a, t, tail) => (tail ? `🫶 ${a} прижал ${t} ${tail}` : `🫶 ${a} крепко прижал к себе ${t}`),
  приласкать: (a, t, tail) => (tail ? `🥰 ${a} приласкал ${t} ${tail}` : `🥰 ${a} приласкал ${t}`),
  погладить: (a, t, tail) => (tail ? `🥹 ${a} погладил ${t} ${tail}` : `🥹 ${a} погладил по голове ${t}`),
  погладь: (a, t, tail) => (tail ? `🥹 ${a} погладил ${t} ${tail}` : `🥹 ${a} погладил по голове ${t}`),
  глажу: (a, t, tail) => (tail ? `🥹 ${a} погладил ${t} ${tail}` : `🥹 ${a} погладил по голове ${t}`),
  укрыть: (a, t, tail) => (tail ? `🧣 ${a} укрыл ${t} ${tail}` : `🧣 ${a} заботливо укрыл пледом ${t}`),
  укрой: (a, t, tail) => (tail ? `🧣 ${a} укрыл ${t} ${tail}` : `🧣 ${a} заботливо укрыл пледом ${t}`),
  'взять за руку': (a, t, tail) => (tail ? `🤝 ${a} взял за руку ${t} ${tail}` : `🤝 ${a} взял за руку ${t}`),
  'держать за руку': (a, t, tail) => (tail ? `🤝 ${a} держит за руку ${t} ${tail}` : `🤝 ${a} держит за руку ${t}`),
  почесать: (a, t, tail) => (tail ? `🐱 ${a} почесал ${t} ${tail}` : `🐱 ${a} почесал за ушком ${t}`),
  почеши: (a, t, tail) => (tail ? `🐱 ${a} почесал ${t} ${tail}` : `🐱 ${a} почесал за ушком ${t}`),
  потрепать: (a, t, tail) => (tail ? `🐾 ${a} потрепал ${t} ${tail}` : `🐾 ${a} потрепал по волосам ${t}`),
  помассировать: (a, t, tail) => (tail ? `💆 ${a} сделал массаж ${t} ${tail}` : `💆 ${a} сделал массаж ${t}`),
  массаж: (a, t, tail) => (tail ? `💆 ${a} сделал массаж ${t} ${tail}` : `💆 ${a} сделал массаж ${t}`),
  убаюкать: (a, t, tail) => (tail ? `😴 ${a} убаюкал ${t} ${tail}` : `😴 ${a} убаюкал ${t}`),
  люблю: (a, t) => `❤️ ${a} признался в любви ${t}`,

  // Игривые и шуточные
  пощекотать: (a, t, tail) => (tail ? `🤭 ${a} пощекотал ${t} ${tail}` : `🤭 ${a} пощекотал ${t}`),
  щекотать: (a, t, tail) => (tail ? `🤭 ${a} пощекотал ${t} ${tail}` : `🤭 ${a} пощекотал ${t}`),
  щекотка: (a, t, tail) => (tail ? `🤭 ${a} пощекотал ${t} ${tail}` : `🤭 ${a} пощекотал ${t}`),
  ткнуть: (a, t, tail) => (tail ? `👉 ${a} ткнул ${t} ${tail}` : `👉 ${a} ткнул ${t}`),
  тык: (a, t, tail) => (tail ? `👉 ${a} сделал тык ${t} ${tail}` : `👉 ${a} сделал тык ${t}`),
  буп: (a, t, tail) => (tail ? `👃 ${a} сделал буп ${t} ${tail}` : `👃 ${a} сделал буп в носик ${t}`),
  ущипнуть: (a, t, tail) => (tail ? `🤏 ${a} ущипнул ${t} ${tail}` : `🤏 ${a} ущипнул ${t}`),
  щипнуть: (a, t, tail) => (tail ? `🤏 ${a} ущипнул ${t} ${tail}` : `🤏 ${a} ущипнул ${t}`),
  понюхать: (a, t, tail) => (tail ? `👃 ${a} понюхал ${t} ${tail}` : `👃 ${a} понюхал ${t}`),
  утащить: (a, t, tail) => (tail ? `🐾 ${a} утащил ${t} ${tail}` : `🐾 ${a} утащил ${t} в пледик`),
  спрятать: (a, t, tail) => (tail ? `🫣 ${a} спрятал ${t} ${tail}` : `🫣 ${a} спрятал ${t}`),
  закидать: (a, t, tail) => (tail ? `🛋️ ${a} закидал ${t} ${tail}` : `🛋️ ${a} закидал подушками ${t}`),
  рассмешить: (a, t, tail) => (tail ? `😂 ${a} рассмешил ${t} ${tail}` : `😂 ${a} рассмешил ${t}`),
  ударить: (a, t, tail) => (tail ? `💥 ${a} ударил ${t} ${tail}` : `💥 ${a} ударил ${t}`),
  стукнуть: (a, t, tail) => (tail ? `💥 ${a} стукнул ${t} ${tail}` : `💥 ${a} стукнул ${t}`),
  треснуть: (a, t, tail) => (tail ? `💥 ${a} треснул ${t} ${tail}` : `💥 ${a} треснул ${t}`),
  бонк: (a, t, tail) => (tail ? `🔨 ${a} бонкнул ${t} ${tail}` : `🔨 ${a} бонкнул ${t}`),
  пнуть: (a, t, tail) => (tail ? `🦶 ${a} пнул ${t} ${tail}` : `🦶 ${a} пнул ${t}`),
  пинок: (a, t, tail) => (tail ? `🦶 ${a} пнул ${t} ${tail}` : `🦶 ${a} пнул ${t}`),
  шлепнуть: (a, t, tail) => (tail ? `👋 ${a} шлёпнул ${t} ${tail}` : `👋 ${a} шлёпнул ${t}`),
  укусить: (a, t, tail) => (tail ? `🦷 ${a} укусил ${t} ${tail}` : `🦷 ${a} укусил ${t}`),
  кусь: (a, t, tail) => (tail ? `🦷 ${a} сделал кусь ${t} ${tail}` : `🦷 ${a} сделал кусь ${t}`),
  куснуть: (a, t, tail) => (tail ? `🦷 ${a} укусил ${t} ${tail}` : `🦷 ${a} укусил ${t}`),
  лизнуть: (a, t, tail) => (tail ? `👅 ${a} лизнул ${t} ${tail}` : `👅 ${a} лизнул ${t}`),
  лизь: (a, t, tail) => (tail ? `👅 ${a} лизнул ${t} ${tail}` : `👅 ${a} лизнул ${t}`),

  // Еда, напитки и подарки
  покормить: (a, t, tail) => (tail ? `🍿 ${a} покормил ${t} ${tail}` : `🍿 ${a} покормил ${t}`),
  покорми: (a, t, tail) => (tail ? `🍿 ${a} покормил ${t} ${tail}` : `🍿 ${a} покормил ${t}`),
  угостить: (a, t, tail) => (tail ? `🍪 ${a} угостил ${t} ${tail}` : `🍪 ${a} угостил вкусняшкой ${t}`),
  угости: (a, t, tail) => (tail ? `🍪 ${a} угостил ${t} ${tail}` : `🍪 ${a} угостил вкусняшкой ${t}`),
  напоить: (a, t, tail) => (tail ? `☕ ${a} напоил ${t} ${tail}` : `☕ ${a} напоил чаем ${t}`),
  чай: (a, t, tail) => (tail ? `☕ ${a} налил чай для ${t} ${tail}` : `☕ ${a} налил чай для ${t}`),
  налить: (a, t, tail) => (tail ? `☕ ${a} налил ${t} ${tail}` : `☕ ${a} налил чаю ${t}`),
  налей: (a, t, tail) => (tail ? `☕ ${a} налил ${t} ${tail}` : `☕ ${a} налил чаю ${t}`),
  насыпать: (a, t, tail) => (tail ? `🍿 ${a} насыпал ${t} ${tail}` : `🍿 ${a} насыпал попкорна ${t}`),
  насыпь: (a, t, tail) => (tail ? `🍿 ${a} насыпал ${t} ${tail}` : `🍿 ${a} насыпал попкорна ${t}`),
  чокнуться: (a, t, tail) => (tail ? `🥂 ${a} чокнулся с ${t} ${tail}` : `🥂 ${a} чокнулся с ${t}`),
  выпить: (a, t, tail) => (tail ? `🥂 ${a} выпил с ${t} ${tail}` : `🥂 ${a} выпил с ${t}`),
  'подарить цветы': (a, t, tail) => (tail ? `💐 ${a} подарил цветы ${t} ${tail}` : `💐 ${a} подарил цветы ${t}`),
  цветы: (a, t, tail) => (tail ? `💐 ${a} подарил цветы ${t} ${tail}` : `💐 ${a} подарил цветы ${t}`),
  подарить: (a, t, tail) => (tail ? `🎁 ${a} подарил ${t} ${tail}` : `🎁 ${a} сделал подарок ${t}`),
  дать: (a, t, tail) => (tail ? `🎁 ${a} дал ${t} ${tail}` : `🎁 ${a} дал что-то ${t}`),
  дай: (a, t, tail) => (tail ? `🎁 ${a} дал ${t} ${tail}` : `🎁 ${a} дал что-то ${t}`),
  даю: (a, t, tail) => (tail ? `🎁 ${a} дал ${t} ${tail}` : `🎁 ${a} дал что-то ${t}`),
  передать: (a, t, tail) => (tail ? `📩 ${a} передал ${t} ${tail}` : `📩 ${a} передал привет ${t}`),
  передай: (a, t, tail) => (tail ? `📩 ${a} передал ${t} ${tail}` : `📩 ${a} передал привет ${t}`),
  отдать: (a, t, tail) => (tail ? `🎁 ${a} отдал ${t} ${tail}` : `🎁 ${a} отдал подарок ${t}`),
  отдай: (a, t, tail) => (tail ? `🎁 ${a} отдал ${t} ${tail}` : `🎁 ${a} отдал подарок ${t}`),
  вручить: (a, t, tail) => (tail ? `🏆 ${a} вручил ${t} ${tail}` : `🏆 ${a} вручил награду ${t}`),
  вручи: (a, t, tail) => (tail ? `🏆 ${a} вручил ${t} ${tail}` : `🏆 ${a} вручил награду ${t}`),
  принести: (a, t, tail) => (tail ? `🍽️ ${a} принёс ${t} ${tail}` : `🍽️ ${a} принёс вкусняшку ${t}`),
  принеси: (a, t, tail) => (tail ? `🍽️ ${a} принёс ${t} ${tail}` : `🍽️ ${a} принёс вкусняшку ${t}`),
  купить: (a, t, tail) => (tail ? `🛍️ ${a} купил ${t} ${tail}` : `🛍️ ${a} купил подарок ${t}`),
  купи: (a, t, tail) => (tail ? `🛍️ ${a} купил ${t} ${tail}` : `🛍️ ${a} купил подарок ${t}`),
  показать: (a, t, tail) => (tail ? `👀 ${a} показал ${t} ${tail}` : `👀 ${a} показал кое-что ${t}`),
  покажи: (a, t, tail) => (tail ? `👀 ${a} показал ${t} ${tail}` : `👀 ${a} показал кое-что ${t}`),
  сделать: (a, t, tail) => (tail ? `✨ ${a} сделал ${t} ${tail}` : `✨ ${a} сделал приятное ${t}`),
  сделай: (a, t, tail) => (tail ? `✨ ${a} сделал ${t} ${tail}` : `✨ ${a} сделал приятное ${t}`),
  надеть: (a, t, tail) => (tail ? `🧢 ${a} надел на ${t} ${tail}` : `🧢 ${a} надел корону на ${t}`),
  надень: (a, t, tail) => (tail ? `🧢 ${a} надел на ${t} ${tail}` : `🧢 ${a} надел корону на ${t}`),
  кинуть: (a, t, tail) => (tail ? `🎯 ${a} кинул в ${t} ${tail}` : `🎯 ${a} кинул подушку в ${t}`),
  бросить: (a, t, tail) => (tail ? `🎯 ${a} бросил в ${t} ${tail}` : `🎯 ${a} бросил подушку в ${t}`),
  шепнуть: (a, t, tail) => (tail ? `🤫 ${a} шепнул ${t} ${tail}` : `🤫 ${a} что-то шепнул ${t}`),
  прошептать: (a, t, tail) => (tail ? `🤫 ${a} прошептал ${t} ${tail}` : `🤫 ${a} что-то прошептал ${t}`),

  // Эмоции, общение и поддержка
  'дать пять': (a, t, tail) => (tail ? `🙌 ${a} дал пять ${t} ${tail}` : `🙌 ${a} дал пять ${t}`),
  'дай пять': (a, t, tail) => (tail ? `🙌 ${a} дал пять ${t} ${tail}` : `🙌 ${a} дал пять ${t}`),
  пятюня: (a, t, tail) => (tail ? `🙌 ${a} дал пять ${t} ${tail}` : `🙌 ${a} дал пять ${t}`),
  'пожать руку': (a, t, tail) => (tail ? `🤝 ${a} пожал руку ${t} ${tail}` : `🤝 ${a} пожал руку ${t}`),
  'жму руку': (a, t, tail) => (tail ? `🤝 ${a} пожал руку ${t} ${tail}` : `🤝 ${a} пожал руку ${t}`),
  помахать: (a, t, tail) => (tail ? `👋 ${a} помахал ${t} ${tail}` : `👋 ${a} помахал ${t}`),
  подмигнуть: (a, t, tail) => (tail ? `😉 ${a} подмигнул ${t} ${tail}` : `😉 ${a} подмигнул ${t}`),
  улыбнуться: (a, t, tail) => (tail ? `😊 ${a} улыбнулся ${t} ${tail}` : `😊 ${a} улыбнулся ${t}`),
  потанцевать: (a, t, tail) => (tail ? `💃 ${a} позвал танцевать ${t} ${tail}` : `💃 ${a} позвал танцевать ${t}`),
  танцевать: (a, t, tail) => (tail ? `💃 ${a} позвал танцевать ${t} ${tail}` : `💃 ${a} позвал танцевать ${t}`),
  похлопать: (a, t, tail) => (tail ? `👏 ${a} похлопал ${t} ${tail}` : `👏 ${a} похлопал ${t}`),
  аплодисменты: (a, t, tail) => (tail ? `👏 ${a} поаплодировал ${t} ${tail}` : `👏 ${a} поаплодировал ${t}`),
  похвалить: (a, t, tail) => (tail ? `🌟 ${a} похвалил ${t} ${tail}` : `🌟 ${a} похвалил ${t}`),
  молодец: (a, t, tail) => (tail ? `🌟 ${a} похвалил ${t} ${tail}` : `🌟 ${a} похвалил ${t}`),
  восхититься: (a, t, tail) => (tail ? `🤩 ${a} восхитился ${t} ${tail}` : `🤩 ${a} восхитился ${t}`),
  милота: (a, t, tail) => (tail ? `🎀 ${a} умилился с ${t} ${tail}` : `🎀 ${a} умилился с ${t}`),
  поддержать: (a, t, tail) => (tail ? `💪 ${a} поддержал ${t} ${tail}` : `💪 ${a} поддержал ${t}`),
  подбодрить: (a, t, tail) => (tail ? `✨ ${a} подбодрил ${t} ${tail}` : `✨ ${a} подбодрил ${t}`),
  утешить: (a, t, tail) => (tail ? `❤️‍🩹 ${a} утешил ${t} ${tail}` : `❤️‍🩹 ${a} утешил ${t}`),
  пожалеть: (a, t, tail) => (tail ? `❤️‍🩹 ${a} пожалел ${t} ${tail}` : `❤️‍🩹 ${a} пожалел ${t}`),
  поблагодарить: (a, t, tail) => (tail ? `🙏 ${a} поблагодарил ${t} ${tail}` : `🙏 ${a} поблагодарил ${t}`),
  спасибо: (a, t, tail) => (tail ? `🙏 ${a} поблагодарил ${t} ${tail}` : `🙏 ${a} поблагодарил ${t}`),
  поздравить: (a, t, tail) => (tail ? `🎉 ${a} поздравил ${t} ${tail}` : `🎉 ${a} поздравил ${t}`),
  поздравляю: (a, t, tail) => (tail ? `🎉 ${a} поздравил ${t} ${tail}` : `🎉 ${a} поздравил ${t}`),
  извиниться: (a, t, tail) => (tail ? `🙇 ${a} извинился перед ${t} ${tail}` : `🙇 ${a} извинился перед ${t}`),
  прости: (a, t, tail) => (tail ? `🙇 ${a} попросил прощения у ${t} ${tail}` : `🙇 ${a} попросил прощения у ${t}`),
  извини: (a, t, tail) => (tail ? `🙇 ${a} извинился перед ${t} ${tail}` : `🙇 ${a} извинился перед ${t}`),
  разбудить: (a, t, tail) => (tail ? `⏰ ${a} разбудил ${t} ${tail}` : `⏰ ${a} разбудил ${t}`),
  проснись: (a, t, tail) => (tail ? `⏰ ${a} разбудил ${t} ${tail}` : `⏰ ${a} разбудил ${t}`),
  'спокойной ночи': (a, t, tail) =>
    tail ? `🌙 ${a} пожелал спокойной ночи ${t} ${tail}` : `🌙 ${a} пожелал спокойной ночи ${t}`,
  'пожелать спокойной ночи': (a, t, tail) =>
    tail ? `🌙 ${a} пожелал спокойной ночи ${t} ${tail}` : `🌙 ${a} пожелал спокойной ночи ${t}`,
};

const PREFIX_ONLY_ACTION_KEYS = new Set([
  'дать',
  'дай',
  'даю',
  'передать',
  'передай',
  'отдать',
  'отдай',
  'вручить',
  'вручи',
  'принести',
  'принеси',
  'купить',
  'купи',
  'налить',
  'налей',
  'насыпать',
  'насыпь',
  'показать',
  'покажи',
  'сделать',
  'сделай',
  'надеть',
  'надень',
  'кинуть',
  'бросить',
  'шепнуть',
  'прошептать',
]);

function sanitizeActionTail(rawTail: string): string | undefined {
  let clean = rawTail
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.,!?;:()\s]+|[.,!?;:\s]+$/g, '')
    .trim();
  clean = clean.replace(/^(?:тебя|тебе|вас|вам)(?:\s+|$)/i, '').trim();
  if (!clean) return undefined;
  const words = clean.split(' ');
  if (words.length > 6) return undefined;
  return clean.slice(0, 60);
}

function buildReplyActionText(actorNick: string, targetNick: string, text: string): string | null {
  const rawClean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = rawClean
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:()\[\]"'«»~*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return null;

  const exactBuilder = REPLY_ACTION_TEMPLATES[norm];
  if (exactBuilder) {
    return exactBuilder(actorNick, targetNick);
  }

  // Match prefix trigger + arbitrary continuation (e.g., "поцеловать в щеку", "дать печеньку")
  const rawTokens = rawClean.split(' ');
  const normTokens = rawTokens.map((tok) =>
    tok
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/^[.,!?;:()\[\]"'«»~*]+|[.,!?;:()\[\]"'«»~*]+$/g, '')
  );

  if (rawTokens.length <= 8) {
    if (normTokens.length >= 3) {
      const trigramPrefix = `${normTokens[0]} ${normTokens[1]} ${normTokens[2]}`;
      const trigramBuilder = REPLY_ACTION_TEMPLATES[trigramPrefix];
      if (trigramBuilder) {
        const tail = sanitizeActionTail(rawTokens.slice(3).join(' '));
        return trigramBuilder(actorNick, targetNick, tail);
      }
    }
    if (normTokens.length >= 2) {
      const bigramPrefix = `${normTokens[0]} ${normTokens[1]}`;
      const bigramBuilder = REPLY_ACTION_TEMPLATES[bigramPrefix];
      if (bigramBuilder) {
        const tail = sanitizeActionTail(rawTokens.slice(2).join(' '));
        return bigramBuilder(actorNick, targetNick, tail);
      }
    }
    const singlePrefixBuilder = REPLY_ACTION_TEMPLATES[normTokens[0]];
    if (singlePrefixBuilder) {
      const tail = sanitizeActionTail(rawTokens.slice(1).join(' '));
      return singlePrefixBuilder(actorNick, targetNick, tail);
    }
  }

  const words = norm.split(' ');
  if (words.length <= 5) {
    for (let i = 0; i < words.length - 2; i++) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      const trigramBuilder = !PREFIX_ONLY_ACTION_KEYS.has(trigram)
        ? REPLY_ACTION_TEMPLATES[trigram]
        : undefined;
      if (trigramBuilder) return trigramBuilder(actorNick, targetNick);
    }
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      const bigramBuilder = !PREFIX_ONLY_ACTION_KEYS.has(bigram)
        ? REPLY_ACTION_TEMPLATES[bigram]
        : undefined;
      if (bigramBuilder) return bigramBuilder(actorNick, targetNick);
    }
    for (const w of words) {
      const wordBuilder = !PREFIX_ONLY_ACTION_KEYS.has(w) ? REPLY_ACTION_TEMPLATES[w] : undefined;
      if (wordBuilder) return wordBuilder(actorNick, targetNick);
    }
  }

  return null;
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const roomId = req.params.roomId;
    if (!isValidRoomId(roomId)) {
      cb(new Error('Некорректный ID комнаты'), '');
      return;
    }
    const roomDir = getRoomStorageDir(roomId);
    cb(null, roomDir);
  },
  filename: (_req, file, cb) => {
    const fileId = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${fileId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_PLAYLIST_FILE_BYTES, // 2 GB limit per file
  },
});

const chatMediaStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const roomId = req.params.roomId;
    if (!isValidRoomId(roomId)) {
      cb(new Error('Некорректный ID комнаты'), '');
      return;
    }
    const mediaDir = getRoomChatMediaDir(roomId);
    cb(null, mediaDir);
  },
  filename: (_req, file, cb) => {
    const mediaId = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${mediaId}${ext}`);
  },
});

const chatMediaUpload = multer({
  storage: chatMediaStorage,
  limits: {
    fileSize: MAX_CHAT_MEDIA_FILE_SIZE,
  },
  fileFilter: (_req, file, cb) => {
    const isAllowed =
      (file.mimetype.startsWith('image/') && file.mimetype !== 'image/svg+xml') ||
      file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('audio/');
    if (!isAllowed) {
      cb(new Error('Разрешены только изображения (PNG/JPG/GIF/WebP), видео и аудиофайлы'));
      return;
    }
    cb(null, true);
  },
});

const app = express();
app.set('trust proxy', true);

const server = http.createServer(app);

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  perMessageDeflate: false, // Save 0.1 vCPU from compressing small JSON sync packets
});

app.use(express.json());

// Track rooms per creator IP (FIFO limit: max 10 rooms per IP)
const ipToRooms = new Map<string, string[]>();

// In-memory upload sessions for concurrent chunked upload
interface ChunkUploadSession {
  fileId: string;
  roomId: string;
  totalChunks: number;
  totalSize: number;
  fileName: string;
  completedChunks: Set<number>;
  lastActivity: number;
  isFinalizing: boolean;
}

const uploadSessions = new Map<string, ChunkUploadSession>();

// Immediate Room Purge (cleans storage, clears upload sessions, updates IP limits, and notifies sockets)
function purgeRoom(roomId: string, reason = 'Комната закрыта. Все файлы и данные удалены.') {
  const room = rooms.get(roomId);
  if (room && room.emptyTimeoutId) {
    clearTimeout(room.emptyTimeoutId);
    room.emptyTimeoutId = null;
  }

  io.to(roomId).emit('room:closed', { reason });

  // Remove room from ipToRooms registry
  for (const [ip, roomIds] of ipToRooms.entries()) {
    const nextList = roomIds.filter((id) => id !== roomId);
    if (nextList.length === 0) {
      ipToRooms.delete(ip);
    } else {
      ipToRooms.set(ip, nextList);
    }
  }

  // Clean up any in-flight upload sessions for this room
  for (const [fId, sess] of uploadSessions.entries()) {
    if (sess.roomId === roomId) {
      uploadSessions.delete(fId);
    }
  }

  // Asynchronously purge room directory on disk without blocking the event loop
  const baseResolved = path.resolve(STORAGE_BASE_DIR);
  const roomDir = path.resolve(baseResolved, path.basename(roomId));
  if (roomDir.startsWith(baseResolved + path.sep)) {
    fsPromises
      .rm(roomDir, { recursive: true, force: true })
      .then(() => {
        console.log(`[WatchParty] Хранилище очищено для комнаты ${roomId}`);
      })
      .catch((err) => {
        console.error(`Ошибка при удалении хранилища комнаты ${roomId}:`, err);
      });
  }

  chatMessageRegistry.delete(roomId);
  roomFloatingEmojis.delete(roomId);
  rooms.delete(roomId);
}

// Auto-cleanup abandoned uploads older than 60 seconds (checks every 15 seconds)
setInterval(async () => {
  const now = Date.now();
  const ABANDONED_TIMEOUT_MS = 60 * 1000;

  for (const [fileId, session] of uploadSessions.entries()) {
    if (!session.isFinalizing && now - session.lastActivity > ABANDONED_TIMEOUT_MS) {
      console.log(
        `[Auto-Cleanup] Удалена заброшенная загрузка ${fileId} ("${session.fileName}") в комнате ${session.roomId}`
      );
      uploadSessions.delete(fileId);

      if (isValidRoomId(session.roomId) && isValidFileId(fileId)) {
        const roomDir = getRoomStorageDir(session.roomId);
        const partPath = path.join(roomDir, `${fileId}.part`);
        try {
          await fsPromises.unlink(partPath).catch(() => {});
        } catch (err) {
          console.error(`[Auto-Cleanup] Ошибка удаления файлов для ${fileId}:`, err);
        }
      }
    }
  }
}, 15000);

// Auto-cleanup forgotten idle rooms (3 hours without activity and no active upload)
setInterval(() => {
  const now = Date.now();
  for (const [rId, room] of rooms.entries()) {
    if (room.activeUpload) continue;
    if (now - room.lastActivityAt > ROOM_IDLE_TTL_MS) {
      console.log(`[Idle-Cleanup] Закрытие неактивной комнаты ${rId}`);
      purgeRoom(rId, 'Комната закрыта из-за длительного бездействия.');
    }
  }
}, 5 * 60 * 1000);

// -----------------------------------------------------------------------------
// REST API Endpoints
// -----------------------------------------------------------------------------

// Create a new room with 10-room FIFO limit per IP
app.post('/api/rooms/create', (req, res) => {
  const clientIp =
    req.ip ||
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const userRooms = ipToRooms.get(clientIp) || [];

  // FIFO rotation: if user already has 10 rooms, close the oldest one
  while (userRooms.length >= 10) {
    const oldestRoomId = userRooms.shift();
    if (oldestRoomId) {
      console.log(`[Limit] IP ${clientIp} превысил лимит 10 комнат. Закрытие старой комнаты ${oldestRoomId}`);
      purgeRoom(oldestRoomId, 'Лимит комнат (10) для вашего IP исчерпан. Старая комната закрыта.');
    }
  }

  const { nickname } = req.body;
  const rawNick = (nickname || 'Хост').toString().trim().slice(0, 30);
  const roomId = Math.random().toString(36).substring(2, 8).toLowerCase();
  const hostToken = uuidv4();

  const newRoom: ServerRoomState = {
    roomId,
    hostId: '',
    hostToken,
    creatorIp: clientIp,
    users: {},
    playlist: [],
    currentTrackIndex: 0,
    playbackState: {
      isPlaying: false,
      currentTime: 0,
      lastUpdatedServerTime: Date.now(),
      isSystemPausedForBuffering: false,
    },
    emptyTimeoutId: null,
    activeUpload: null,
    chatMediaFiles: [],
    chatMediaTotalBytes: 0,
    lastActivityAt: Date.now(),
  };

  // Auto-purge if creator never connects via WebSocket within 5 minutes
  newRoom.emptyTimeoutId = setTimeout(() => {
    const current = rooms.get(roomId);
    if (current && Object.keys(current.users).length === 0) {
      console.log(`[TTL] Удалена неактивированная комната ${roomId}`);
      purgeRoom(roomId, 'Время ожидания входа в комнату истекло.');
    }
  }, NEVER_JOINED_ROOM_TTL_MS);

  rooms.set(roomId, newRoom);
  getRoomStorageDir(roomId);

  userRooms.push(roomId);
  ipToRooms.set(clientIp, userRooms);

  res.json({
    roomId,
    hostToken,
    nickname: rawNick,
  });
});

// Room details
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'Некорректный ID комнаты' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  res.json({
    roomId: room.roomId,
    userCount: Object.keys(room.users).length,
    playlistCount: room.playlist.length,
    currentTrackIndex: room.currentTrackIndex,
    isPlaying: room.playbackState.isPlaying,
  });
});

// Upload video files to a room
app.post('/api/rooms/:roomId/upload', (req, res, next) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'Некорректный ID комнаты' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }
  const token = req.headers['x-host-token'] || req.query.token;
  const socketId = req.headers['x-socket-id'] || req.query.socketId;
  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId);
  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может загружать видео' });
    return;
  }
  next();
}, upload.array('videos', 10), async (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) {
    res.status(400).json({ error: 'Файлы не были переданы' });
    return;
  }

  const incomingBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (getRoomPlaylistBytes(room) + incomingBytes > MAX_ROOM_PLAYLIST_BYTES) {
    await Promise.all(files.map((f) => fsPromises.unlink(f.path).catch(() => {})));
    res.status(413).json({ error: 'Превышен общий лимит плейлиста комнаты (2 ГБ)' });
    return;
  }

  room.lastActivityAt = Date.now();

  const newItems: PlaylistItem[] = [];

  for (const file of files) {
    const decodedName = decodeOriginalName(file.originalname);
    const ext = path.extname(decodedName).toLowerCase();
    const isSupported = ['.mp4', '.webm', '.ogg', '.mov'].includes(ext);

    const item: PlaylistItem = {
      id: path.basename(file.filename, ext),
      originalName: decodedName,
      filename: file.filename,
      size: file.size,
      mimeType: file.mimetype || (ext === '.webm' ? 'video/webm' : 'video/mp4'),
      url: `/api/rooms/${roomId}/stream/${file.filename}`,
    };

    newItems.push(item);
    room.playlist.push(item);
  }

  // Broadcast playlist update via socket.io
  io.to(roomId).emit('playlist:updated', {
    playlist: room.playlist,
    currentTrackIndex: room.currentTrackIndex,
  });

  io.to(roomId).emit('chat:message', {
    id: uuidv4(),
    userId: 'system',
    nickname: 'Система',
    text: `Загружено файлов в плейлист: ${files.length} шт.`,
    timestamp: Date.now(),
    type: 'system',
  });

  res.json({
    success: true,
    added: newItems,
    playlist: room.playlist,
  });
});

// Check upload status of a file for concurrent chunked upload
app.get('/api/rooms/:roomId/upload/status/:fileId', async (req, res) => {
  const { roomId, fileId } = req.params;
  if (!isValidRoomId(roomId) || !isValidFileId(fileId)) {
    res.status(400).json({ error: 'Некорректные параметры запроса' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const roomDir = getRoomStorageDir(roomId);
  const partPath = path.join(roomDir, `${fileId}.part`);

  // Check active in-memory session
  const session = uploadSessions.get(fileId);
  if (session) {
    session.lastActivity = Date.now();
    try {
      await fsPromises.access(partPath);
      res.json({
        exists: true,
        completed: session.isFinalizing,
        completedChunks: Array.from(session.completedChunks),
        totalChunks: session.totalChunks,
      });
      return;
    } catch {}
  }

  // Check if already completed and in playlist
  const existingItem = room.playlist.find((item) => item.id === fileId);
  if (existingItem) {
    res.json({
      exists: true,
      completed: true,
      uploadedBytes: existingItem.size,
      item: existingItem,
    });
    return;
  }

  // Check if finalized file exists on disk
  try {
    const files = await fsPromises.readdir(roomDir);
    const matched = files.find((f) => f.startsWith(fileId) && !f.endsWith('.part') && !f.endsWith('.info'));
    if (matched) {
      const stat = await fsPromises.stat(path.join(roomDir, matched));
      res.json({
        exists: true,
        completed: true,
        uploadedBytes: stat.size,
      });
      return;
    }
  } catch {}

  res.json({
    exists: false,
    completed: false,
    completedChunks: [],
    totalChunks: 0,
  });
});

// Concurrent Chunked Upload with fully async Zero-Copy streaming disk I/O and race condition protection
app.post('/api/rooms/:roomId/upload/chunk', async (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'Некорректный ID комнаты' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const token = (req.headers['x-host-token'] as string) || (req.query.token as string);
  const socketId = (req.headers['x-socket-id'] as string) || (req.query.socketId as string);

  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId);

  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может загружать видео' });
    return;
  }

  const fileId = req.headers['x-file-id'] as string;
  if (!isValidFileId(fileId)) {
    res.status(400).json({ error: 'Некорректный x-file-id' });
    return;
  }

  const rawFileName = (req.headers['x-file-name'] as string) || 'video.mp4';
  let fileName = 'video.mp4';
  try {
    fileName = path.basename(decodeURIComponent(rawFileName)).slice(0, 180) || 'video.mp4';
  } catch {
    fileName = 'video.mp4';
  }
  const totalSize = Number(req.headers['x-file-size'] || '0');
  const chunkOffset = Number(req.headers['x-chunk-offset'] || '0');
  const chunkIndex = Number(req.headers['x-chunk-index'] || '0');
  const totalChunks = Number(req.headers['x-total-chunks'] || '1');

  if (
    !Number.isInteger(totalSize) ||
    totalSize <= 0 ||
    totalSize > MAX_PLAYLIST_FILE_BYTES ||
    !Number.isInteger(totalChunks) ||
    totalChunks < 1 ||
    totalChunks > 5000 ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= totalChunks ||
    !Number.isInteger(chunkOffset) ||
    chunkOffset < 0 ||
    chunkOffset >= totalSize
  ) {
    res.status(400).json({ error: 'Некорректные параметры чанка' });
    return;
  }

  if (getRoomPlaylistBytes(room) + totalSize > MAX_ROOM_PLAYLIST_BYTES) {
    res.status(413).json({ error: 'Превышен общий лимит плейлиста комнаты (2 ГБ)' });
    return;
  }

  room.lastActivityAt = Date.now();

  const roomDir = getRoomStorageDir(roomId);
  const partPath = path.join(roomDir, `${fileId}.part`);

  // Ensure file exists on disk asynchronously so concurrent chunk writes can open with 'r+' safely
  try {
    await fsPromises.access(partPath);
  } catch {
    try {
      const handle = await fsPromises.open(partPath, 'w');
      await handle.close();
    } catch {}
  }

  // Get or initialize active session in memory (zero per-chunk .info disk writes for higher I/O speed)
  let session = uploadSessions.get(fileId);
  if (!session) {
    session = {
      fileId,
      roomId,
      totalChunks,
      totalSize,
      fileName,
      completedChunks: new Set<number>(),
      lastActivity: Date.now(),
      isFinalizing: false,
    };
    uploadSessions.set(fileId, session);
  }

  // Keep alive: update last activity timestamp
  session.lastActivity = Date.now();

  // If session is already finalizing from other completed chunks, ignore further writes
  if (session.isFinalizing) {
    res.json({ success: true, completed: true, alreadyFinalized: true });
    return;
  }

  // Open writeStream directly at chunk offset with 512 KB buffer to drastically reduce syscalls on 0.1 vCPU
  const writeStream = fs.createWriteStream(partPath, {
    flags: 'r+',
    start: chunkOffset,
    highWaterMark: 512 * 1024,
  });

  req.pipe(writeStream);

  req.on('error', (err) => {
    console.error('Request stream error during chunk upload:', err);
    writeStream.destroy();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Ошибка передачи данных чанка' });
    }
  });

  writeStream.on('error', (err) => {
    console.error('File write stream error during chunk upload:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Ошибка записи на диск' });
    }
  });

  writeStream.on('finish', async () => {
    try {
      if (!session || !rooms.has(roomId) || !uploadSessions.has(fileId)) {
        await fsPromises.unlink(partPath).catch(() => {});
        if (!res.headersSent) {
          res.status(409).json({ error: 'Загрузка была отменена или комната закрыта' });
        }
        return;
      }

      session.completedChunks.add(chunkIndex);
      session.lastActivity = Date.now();
      room.lastActivityAt = Date.now();

      // Finalize ONLY when every single chunk has completed, strictly guarded against race conditions
      const isAllCompleted = session.completedChunks.size === totalChunks;

      if (isAllCompleted) {
        // Race condition guard: execute finalization strictly once across concurrent chunks
        if (session.isFinalizing) {
          if (!res.headersSent) {
            res.json({ success: true, completed: true, alreadyFinalized: true, chunkIndex });
          }
          return;
        }
        session.isFinalizing = true;

        if (totalSize > 0) {
          await fsPromises.truncate(partPath, totalSize).catch(() => {});
        }

        const ext = path.extname(fileName).toLowerCase() || '.mp4';
        const finalFilename = `${fileId}${ext}`;
        const finalPath = path.join(roomDir, finalFilename);

        // Fully async atomic rename .part -> permanent file
        await fsPromises.rename(partPath, finalPath);

        uploadSessions.delete(fileId);

        const finalStat = await fsPromises.stat(finalPath);
        const item: PlaylistItem = {
          id: fileId,
          originalName: fileName,
          filename: finalFilename,
          size: finalStat.size,
          mimeType: ext === '.webm' ? 'video/webm' : ext === '.ogg' ? 'video/ogg' : 'video/mp4',
          url: `/api/rooms/${roomId}/stream/${finalFilename}`,
        };

        room.playlist.push(item);
        room.activeUpload = null;

        // Clear upload badge & broadcast playlist update
        io.to(roomId).emit('upload:progress', null);
        io.to(roomId).emit('playlist:updated', {
          playlist: room.playlist,
          currentTrackIndex: room.currentTrackIndex,
        });

        io.to(roomId).emit('chat:message', {
          id: uuidv4(),
          userId: 'system',
          nickname: 'Система',
          text: `Загружен видеофайл: "${fileName}" (${(item.size / (1024 * 1024)).toFixed(1)} МБ)`,
          timestamp: Date.now(),
          type: 'system',
        });

        if (!res.headersSent) {
          res.json({
            success: true,
            completed: true,
            uploadedBytes: item.size,
            chunkIndex,
            completedCount: session.completedChunks.size,
            totalChunks,
            item,
            playlist: room.playlist,
          });
        }
      } else {
        if (!res.headersSent) {
          res.json({
            success: true,
            completed: false,
            chunkIndex,
            completedCount: session.completedChunks.size,
            totalChunks,
          });
        }
      }
    } catch (err) {
      console.error('Error finalizing chunk write:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Ошибка финализации чанка' });
      }
    }
  });
});

// Cancel in-flight chunked upload and immediately delete .part files asynchronously
app.post('/api/rooms/:roomId/upload/cancel/:fileId', async (req, res) => {
  const { roomId, fileId } = req.params;
  if (!isValidRoomId(roomId) || !isValidFileId(fileId)) {
    res.status(400).json({ error: 'Некорректные параметры запроса' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const token = (req.headers['x-host-token'] as string) || (req.query.token as string);
  const socketId = (req.headers['x-socket-id'] as string) || (req.query.socketId as string);

  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId);

  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может отменять загрузку' });
    return;
  }

  uploadSessions.delete(fileId);
  if (room.activeUpload?.fileId === fileId) {
    room.activeUpload = null;
    io.to(roomId).emit('upload:progress', null);
  }

  const roomDir = getRoomStorageDir(roomId);
  const partPath = path.join(roomDir, `${fileId}.part`);

  try {
    await fsPromises.unlink(partPath).catch(() => {});
  } catch (err) {
    console.error('Error removing .part on cancel:', err);
  }

  res.json({ success: true, cancelled: true });
});

// Upload chat media (10 MB per file limit, 100 MB FIFO room quota)
app.post('/api/rooms/:roomId/chat/upload', (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    res.status(400).json({ error: 'Некорректный ID комнаты' });
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const socketId = (req.headers['x-socket-id'] as string) || '';
  const user = room.users[socketId];
  if (!user) {
    res.status(403).json({ error: 'Только участники комнаты могут отправлять медиа в чат' });
    return;
  }
  room.lastActivityAt = Date.now();

  chatMediaUpload.single('media')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'Файл превышает лимит 10 МБ' });
        return;
      }
      res.status(400).json({ error: err.message || 'Ошибка загрузки медиафайла' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Файл не был передан' });
      return;
    }

    if (file.size > MAX_CHAT_MEDIA_FILE_SIZE) {
      await fsPromises.unlink(file.path).catch(() => {});
      res.status(413).json({ error: 'Файл превышает лимит 10 МБ' });
      return;
    }

    // FIFO cleanup if total chat media in room exceeds 100 MB
    const deletedMediaIds: string[] = [];
    while (
      room.chatMediaTotalBytes + file.size > MAX_CHAT_MEDIA_ROOM_TOTAL &&
      room.chatMediaFiles.length > 0
    ) {
      const oldest = room.chatMediaFiles.shift();
      if (oldest) {
        room.chatMediaTotalBytes = Math.max(0, room.chatMediaTotalBytes - oldest.size);
        deletedMediaIds.push(oldest.id);
        await fsPromises.unlink(oldest.filePath).catch(() => {});
      }
    }

    const mediaId = path.basename(file.filename, path.extname(file.filename));
    room.chatMediaFiles.push({
      id: mediaId,
      filename: file.filename,
      filePath: file.path,
      size: file.size,
      createdAt: Date.now(),
    });
    room.chatMediaTotalBytes += file.size;

    if (deletedMediaIds.length > 0) {
      io.to(roomId).emit('chat:media_pruned', { deletedMediaIds });
    }

    let mediaKind: 'image' | 'video' | 'audio' = 'image';
    if (file.mimetype.startsWith('video/')) mediaKind = 'video';
    else if (file.mimetype.startsWith('audio/')) mediaKind = 'audio';

    const captionText = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 500) : '';
    let parsedReplyTo: ChatReplyRef | undefined;
    if (typeof req.body?.replyTo === 'string' && req.body.replyTo.trim()) {
      try {
        parsedReplyTo = sanitizeReplyTo(JSON.parse(req.body.replyTo));
      } catch {}
    }

    const messageId = uuidv4();
    const message: ChatMessage = {
      id: messageId,
      userId: socketId,
      nickname: user.nickname,
      prefix: user.prefix,
      text: captionText,
      timestamp: Date.now(),
      type: 'message',
      media: {
        id: mediaId,
        url: `/api/rooms/${roomId}/chat/media/${file.filename}`,
        filename: file.filename,
        originalName: decodeOriginalName(file.originalname),
        mimeType: file.mimetype,
        size: file.size,
        mediaKind,
      },
      replyTo: parsedReplyTo,
    };

    registerChatMessage(roomId, messageId, socketId, mediaId);
    io.to(roomId).emit('chat:message', message);

    if (parsedReplyTo && captionText) {
      const targetNick = room.users[parsedReplyTo.userId]?.nickname || parsedReplyTo.nickname;
      const actionText = buildReplyActionText(user.nickname, targetNick, captionText);
      if (actionText) {
        io.to(roomId).emit('chat:message', {
          id: uuidv4(),
          userId: 'system',
          nickname: 'Реакция',
          text: actionText,
          timestamp: Date.now(),
          type: 'action',
        });
      }
    }

    res.json({
      success: true,
      message,
      roomMediaUsageBytes: room.chatMediaTotalBytes,
    });
  });
});

// Serve chat media with HTTP 206 support
app.get('/api/rooms/:roomId/chat/media/:filename', async (req, res) => {
  const { roomId, filename } = req.params;
  if (!isValidRoomId(roomId)) {
    res.status(400).send('Invalid room ID');
    return;
  }
  const safeFilename = path.basename(filename);
  const mediaDir = path.resolve(STORAGE_BASE_DIR, path.basename(roomId), 'chat_media');
  const filePath = path.resolve(mediaDir, safeFilename);

  if (!filePath.startsWith(mediaDir + path.sep)) {
    res.status(403).send('Forbidden');
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fsPromises.stat(filePath);
  } catch {
    res.status(404).send('Медиафайл удалён или не найден');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const rawEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const end = Math.min(isNaN(rawEnd) ? fileSize - 1 : rawEnd, fileSize - 1);

    if (isNaN(start) || start >= fileSize || end < start) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).send('Requested range not satisfiable');
      return;
    }

    const chunksize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, {
      start,
      end,
      highWaterMark: 256 * 1024,
    });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400, no-transform',
    });

    req.on('close', () => fileStream.destroy());
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400, no-transform',
    });
    const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    req.on('close', () => fileStream.destroy());
    fileStream.pipe(res);
  }
});

// Stream video via HTTP 206 Partial Content (async non-blocking stat + 256KB buffer)
app.get('/api/rooms/:roomId/stream/:fileId', async (req, res) => {
  const { roomId, fileId } = req.params;
  if (!isValidRoomId(roomId)) {
    res.status(400).send('Invalid room ID');
    return;
  }
  const roomDir = path.resolve(STORAGE_BASE_DIR, path.basename(roomId));
  let filePath = path.resolve(roomDir, path.basename(fileId));

  if (!filePath.startsWith(roomDir + path.sep)) {
    res.status(403).send('Forbidden');
    return;
  }

  let stat: fs.Stats | null = null;
  try {
    stat = await fsPromises.stat(filePath);
  } catch {
    try {
      const files = await fsPromises.readdir(roomDir);
      const matched = files.find((f) => f.startsWith(path.basename(fileId)));
      if (matched) {
        filePath = path.resolve(roomDir, matched);
        stat = await fsPromises.stat(filePath);
      }
    } catch {}
  }

  if (!stat) {
    res.status(404).send('Видео файл не найден');
    return;
  }

  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();

  let mimeType = 'video/mp4';
  if (ext === '.webm') mimeType = 'video/webm';
  else if (ext === '.ogg') mimeType = 'video/ogg';
  else if (ext === '.mov') mimeType = 'video/quicktime';

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const rawEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const end = Math.min(isNaN(rawEnd) ? fileSize - 1 : rawEnd, fileSize - 1);

    if (isNaN(start) || start >= fileSize || end < start) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).send('Requested range not satisfiable');
      return;
    }

    const chunksize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, {
      start,
      end,
      highWaterMark: 256 * 1024, // 256 KB buffer for faster streaming with low syscalls on 0.1 vCPU
    });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400, no-transform',
      'X-Content-Type-Options': 'nosniff',
    });

    // Immediate resource cleanup hook: abort / seek / tab close
    req.on('close', () => {
      fileStream.destroy();
    });

    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400, no-transform',
    });

    const fileStream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    req.on('close', () => {
      fileStream.destroy();
    });
    fileStream.pipe(res);
  }
});

// -----------------------------------------------------------------------------
// Socket.io Real-Time Synchronizer
// -----------------------------------------------------------------------------

io.on('connection', (socket) => {
  let currentRoomId: string | null = null;

  // NTP-style clock skew measurement so PC/mobile clients with unsynced system clocks never loop-seek
  socket.on('sync:time_ping', ({ clientSentAt }) => {
    socket.emit('sync:time_pong', {
      clientSentAt,
      serverTime: Date.now(),
    });
  });

  // Join Room
  socket.on('room:join', ({ roomId, nickname, hostToken }) => {
    const cleanRoomId = typeof roomId === 'string' ? roomId.trim().toLowerCase() : '';
    if (!isValidRoomId(cleanRoomId)) {
      socket.emit('error:notification', {
        message: 'Некорректный ID комнаты (допустимы латинские буквы, цифры, _ и - от 3 до 24 символов).',
      });
      return;
    }

    currentRoomId = cleanRoomId;
    socket.join(cleanRoomId);

    let room = rooms.get(cleanRoomId);
    if (!room) {
      // Auto-create room if joining direct link
      room = {
        roomId: cleanRoomId,
        hostId: socket.id,
        hostToken: hostToken || uuidv4(),
        users: {},
        playlist: [],
        currentTrackIndex: 0,
        playbackState: {
          isPlaying: false,
          currentTime: 0,
          lastUpdatedServerTime: Date.now(),
          isSystemPausedForBuffering: false,
        },
        emptyTimeoutId: null,
        activeUpload: null,
        chatMediaFiles: [],
        chatMediaTotalBytes: 0,
        lastActivityAt: Date.now(),
      };
      rooms.set(cleanRoomId, room);
      getRoomStorageDir(cleanRoomId);
    }

    // Cancel cleanup timer if active
    if (room.emptyTimeoutId) {
      clearTimeout(room.emptyTimeoutId);
      room.emptyTimeoutId = null;
    }
    room.lastActivityAt = Date.now();

    const isFirstUser = Object.keys(room.users).length === 0;
    const isTokenMatch = Boolean(hostToken && hostToken === room.hostToken);
    const shouldBeHost = isFirstUser || isTokenMatch || room.hostId === socket.id;

    if (shouldBeHost) {
      room.hostId = socket.id;
    }

    const cleanNick = (nickname || 'Зритель').trim().slice(0, 24);

    const newUser: User = {
      id: socket.id,
      nickname: cleanNick,
      isHost: room.hostId === socket.id,
      isBuffering: false,
      joinedAt: Date.now(),
    };

    room.users[socket.id] = newUser;

    // Send state without NodeJS.Timeout handle
    socket.emit('room:init_state', { ...room, emptyTimeoutId: null });

    // Notify other users
    socket.to(cleanRoomId).emit('room:user_joined', newUser);

    io.to(cleanRoomId).emit('chat:message', {
      id: uuidv4(),
      userId: 'system',
      nickname: 'Система',
      text: `${cleanNick} присоединился к комнате`,
      timestamp: Date.now(),
      type: 'system',
    });
  });

  // Change nickname directly in lobby without leaving room
  socket.on('user:change_nickname', ({ nickname }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    if (!user) return;

    const newNick = (nickname || '').trim().slice(0, 24);
    if (!newNick || newNick === user.nickname) return;

    const oldNick = user.nickname;
    user.nickname = newNick;

    io.to(currentRoomId).emit('room:user_updated', {
      userId: socket.id,
      nickname: newNick,
    });

    io.to(currentRoomId).emit('chat:message', {
      id: uuidv4(),
      userId: 'system',
      nickname: 'Система',
      text: `${oldNick} сменил(а) ник на ${newNick}`,
      timestamp: Date.now(),
      type: 'system',
    });
  });

  // Set or clear a prefix for any participant in the room (not restricted to host)
  socket.on('user:set_prefix', ({ targetUserId, prefix }) => {
    if (!currentRoomId || !targetUserId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const actor = room.users[socket.id];
    const target = room.users[targetUserId];
    if (!actor || !target) return;

    const cleanPrefix = (prefix || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 18);
    if ((target.prefix || '') === cleanPrefix) return;

    target.prefix = cleanPrefix || undefined;

    io.to(currentRoomId).emit('room:user_prefix_updated', {
      userId: targetUserId,
      prefix: cleanPrefix,
    });

    const noticeText = cleanPrefix
      ? actor.id === target.id
        ? `🏷️ ${actor.nickname} установил(а) себе префикс [${cleanPrefix}]`
        : `🏷️ ${actor.nickname} выдал(а) префикс [${cleanPrefix}] для ${target.nickname}`
      : actor.id === target.id
      ? `🏷️ ${actor.nickname} убрал(а) свой префикс`
      : `🏷️ ${actor.nickname} убрал(а) префикс у ${target.nickname}`;

    io.to(currentRoomId).emit('chat:message', {
      id: uuidv4(),
      userId: 'system',
      nickname: 'Система',
      text: noticeText,
      timestamp: Date.now(),
      type: 'system',
    });
  });

  // Host: Play
  socket.on('host:play', ({ currentTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    room.lastActivityAt = Date.now();
    room.playbackState.isPlaying = true;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedServerTime = Date.now();
    room.playbackState.isSystemPausedForBuffering = false;

    io.to(currentRoomId).emit('sync:play', {
      currentTime,
      serverTimestamp: room.playbackState.lastUpdatedServerTime,
    });
  });

  // Host: Pause
  socket.on('host:pause', ({ currentTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    room.lastActivityAt = Date.now();
    room.playbackState.isPlaying = false;
    room.playbackState.currentTime = currentTime;
    room.playbackState.lastUpdatedServerTime = Date.now();

    io.to(currentRoomId).emit('sync:pause', {
      currentTime,
    });
  });

  // Host: Seek
  socket.on('host:seek', ({ targetTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    room.lastActivityAt = Date.now();
    room.playbackState.currentTime = targetTime;
    room.playbackState.lastUpdatedServerTime = Date.now();

    io.to(currentRoomId).emit('sync:seek', {
      targetTime,
    });
  });

  // Host: Force Play (override viewer buffering locks)
  socket.on('host:force_play', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    room.playbackState.isSystemPausedForBuffering = false;
    room.playbackState.isPlaying = true;
    room.playbackState.lastUpdatedServerTime = Date.now();

    io.to(currentRoomId).emit('sync:buffering_resolved');
    io.to(currentRoomId).emit('sync:play', {
      currentTime: room.playbackState.currentTime,
      serverTimestamp: Date.now(),
    });

    io.to(currentRoomId).emit('chat:message', {
      id: uuidv4(),
      userId: 'system',
      nickname: 'Система',
      text: '⚡ Хост запустил воспроизведение принудительно',
      timestamp: Date.now(),
      type: 'system',
    });
  });

  // Host: Change Track
  socket.on('host:change_track', ({ trackIndex }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    if (trackIndex >= 0 && trackIndex < room.playlist.length) {
      room.currentTrackIndex = trackIndex;
      room.playbackState.currentTime = 0;
      room.playbackState.isPlaying = true;
      room.playbackState.lastUpdatedServerTime = Date.now();
      room.playbackState.isSystemPausedForBuffering = false;

      io.to(currentRoomId).emit('playlist:updated', {
        playlist: room.playlist,
        currentTrackIndex: room.currentTrackIndex,
      });

      io.to(currentRoomId).emit('sync:seek', { targetTime: 0 });
      io.to(currentRoomId).emit('sync:play', {
        currentTime: 0,
        serverTimestamp: Date.now(),
      });
    }
  });

  // Host: Reorder Playlist
  socket.on('host:reorder_playlist', ({ newOrderIds }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    const currentTrack = room.playlist[room.currentTrackIndex];
    const itemMap = new Map(room.playlist.map((item) => [item.id, item]));
    const reordered: PlaylistItem[] = [];

    for (const id of newOrderIds) {
      const item = itemMap.get(id);
      if (item) {
        reordered.push(item);
      }
    }

    if (reordered.length === room.playlist.length) {
      room.playlist = reordered;
      if (currentTrack) {
        const newIndex = room.playlist.findIndex((item) => item.id === currentTrack.id);
        if (newIndex !== -1) room.currentTrackIndex = newIndex;
      }

      io.to(currentRoomId).emit('playlist:updated', {
        playlist: room.playlist,
        currentTrackIndex: room.currentTrackIndex,
      });
    }
  });

  // Host: Delete Track
  socket.on('host:delete_track', async ({ fileId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    const index = room.playlist.findIndex((item) => item.id === fileId);
    if (index === -1) return;

    const [deletedItem] = room.playlist.splice(index, 1);
    room.lastActivityAt = Date.now();

    // Asynchronously delete local file if present (non-blocking on 0.1 vCPU)
    const roomDir = getRoomStorageDir(currentRoomId);
    const filePath = path.resolve(roomDir, path.basename(deletedItem.filename));
    if (filePath.startsWith(roomDir + path.sep)) {
      await fsPromises.unlink(filePath).catch(() => {});
    }

    // Adjust track index if needed
    if (room.currentTrackIndex >= room.playlist.length) {
      room.currentTrackIndex = Math.max(0, room.playlist.length - 1);
    }

    io.to(currentRoomId).emit('playlist:updated', {
      playlist: room.playlist,
      currentTrackIndex: room.currentTrackIndex,
    });

    io.to(currentRoomId).emit('chat:message', {
      id: uuidv4(),
      userId: 'system',
      nickname: 'Система',
      text: `Трек "${deletedItem.originalName}" удален из плейлиста`,
      timestamp: Date.now(),
      type: 'system',
    });
  });

  // Host: Transfer Host
  socket.on('host:transfer_host', ({ newHostUserId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    const targetUser = room.users[newHostUserId];
    if (!targetUser) return;

    const oldHost = room.users[room.hostId];
    if (oldHost) oldHost.isHost = false;

    room.hostId = newHostUserId;
    targetUser.isHost = true;

    io.to(currentRoomId).emit('room:host_changed', { hostId: newHostUserId });
    io.to(currentRoomId).emit('chat:message', {
      id: uuidv4(),
      userId: 'system',
      nickname: 'Система',
      text: `👑 Хост передал права пользователю ${targetUser.nickname}`,
      timestamp: Date.now(),
      type: 'system',
    });
  });

  // Smart Buffer Barrier: Client Buffering Start
  socket.on('client:buffering_start', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    if (!user) return;

    user.isBuffering = true;

    if (room.playbackState.isPlaying && !room.playbackState.isSystemPausedForBuffering) {
      // Calculate current playback time
      const elapsed = (Date.now() - room.playbackState.lastUpdatedServerTime) / 1000;
      room.playbackState.currentTime += elapsed;
      room.playbackState.isPlaying = false;
      room.playbackState.isSystemPausedForBuffering = true;
      room.playbackState.lastUpdatedServerTime = Date.now();

      const waitingForUsers = Object.values(room.users)
        .filter((u) => u.isBuffering)
        .map((u) => u.nickname);

      io.to(currentRoomId).emit('sync:buffering_wait', { waitingForUsers });
      io.to(currentRoomId).emit('sync:pause', {
        currentTime: room.playbackState.currentTime,
      });
    }
  });

  // Smart Buffer Barrier: Client Buffering End
  socket.on('client:buffering_end', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    if (!user) return;

    user.isBuffering = false;

    if (room.playbackState.isSystemPausedForBuffering) {
      const stillBuffering = Object.values(room.users).some((u) => u.isBuffering);
      if (!stillBuffering) {
        room.playbackState.isSystemPausedForBuffering = false;
        room.playbackState.isPlaying = true;
        room.playbackState.lastUpdatedServerTime = Date.now();

        io.to(currentRoomId).emit('sync:buffering_resolved');
        io.to(currentRoomId).emit('sync:play', {
          currentTime: room.playbackState.currentTime,
          serverTimestamp: Date.now(),
        });
      }
    }
  });

  // Track user playback progress (what second each user is watching)
  socket.on('client:progress', ({ currentTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    if (user) {
      user.currentTime = currentTime;
      socket.to(currentRoomId).emit('users:progress', {
        userId: socket.id,
        currentTime,
      });
    }
  });

  // Host: Close Room (Immediate purge of all data and files)
  socket.on('host:close_room', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;
    console.log(`[WatchParty] Host triggered room closure: ${currentRoomId}`);
    purgeRoom(currentRoomId, 'Хост закрыл комнату. Все видеофайлы и данные удалены.');
  });

  // Chat message
  socket.on('chat:send', ({ text, replyTo, stickerId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    if (!user) return;
    room.lastActivityAt = Date.now();

    const cleanReplyTo = sanitizeReplyTo(replyTo);

    // Handle Telegram-style instant sticker message (any valid sticker across all packs)
    const stickerUrl = resolveStickerUrl(stickerId);
    if (stickerUrl && typeof stickerId === 'string') {
      const messageId = uuidv4();
      const stickerMsg: ChatMessage = {
        id: messageId,
        userId: socket.id,
        nickname: user.nickname,
        prefix: user.prefix,
        text: '',
        timestamp: Date.now(),
        type: 'message',
        stickerId,
        stickerUrl,
        replyTo: cleanReplyTo,
      };
      registerChatMessage(currentRoomId, messageId, socket.id);
      io.to(currentRoomId).emit('chat:message', stickerMsg);
      return;
    }

    const cleanText = (text || '').trim().slice(0, 500);
    if (!cleanText) return;

    const messageId = uuidv4();
    const message: ChatMessage = {
      id: messageId,
      userId: socket.id,
      nickname: user.nickname,
      prefix: user.prefix,
      text: cleanText,
      timestamp: Date.now(),
      type: 'message',
      replyTo: cleanReplyTo,
    };

    registerChatMessage(currentRoomId, messageId, socket.id);
    io.to(currentRoomId).emit('chat:message', message);

    if (cleanReplyTo) {
      const targetNick = room.users[cleanReplyTo.userId]?.nickname || cleanReplyTo.nickname;
      const actionText = buildReplyActionText(user.nickname, targetNick, cleanText);
      if (actionText) {
        io.to(currentRoomId).emit('chat:message', {
          id: uuidv4(),
          userId: 'system',
          nickname: 'Реакция',
          text: actionText,
          timestamp: Date.now(),
          type: 'action',
        });
      }
    }
  });

  // Edit own chat message
  socket.on('chat:edit', ({ messageId, text }) => {
    if (!currentRoomId || !messageId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const roomMsgs = chatMessageRegistry.get(currentRoomId);
    const entry = roomMsgs?.get(messageId);
    if (!entry || entry.userId !== socket.id) return;

    const cleanText = (typeof text === 'string' ? text : '').trim().slice(0, 500);
    if (!cleanText && !entry.mediaId) return;

    io.to(currentRoomId).emit('chat:edited', {
      messageId,
      text: cleanText,
      editedAt: Date.now(),
    });
  });

  // Delete own chat message
  socket.on('chat:delete', ({ messageId }) => {
    if (!currentRoomId || !messageId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const roomMsgs = chatMessageRegistry.get(currentRoomId);
    const entry = roomMsgs?.get(messageId);
    if (!entry || entry.userId !== socket.id) return;

    roomMsgs!.delete(messageId);

    if (entry.mediaId) {
      const mediaIdx = room.chatMediaFiles.findIndex((m) => m.id === entry.mediaId);
      if (mediaIdx !== -1) {
        const [removed] = room.chatMediaFiles.splice(mediaIdx, 1);
        room.chatMediaTotalBytes = Math.max(0, room.chatMediaTotalBytes - removed.size);
        fsPromises.unlink(removed.filePath).catch(() => {});
      }
    }

    io.to(currentRoomId).emit('chat:deleted', { messageId });
  });

  // Host upload progress broadcast (throttled on client)
  socket.on('upload:progress', ({ fileId, fileName, percent, status }) => {
    if (!currentRoomId || !fileId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    const user = room.users[socket.id];
    const validStatus =
      status === 'uploading' || status === 'retrying' || status === 'error' || status === 'completed'
        ? status
        : 'uploading';
    const clampedPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const safeName = (typeof fileName === 'string' ? fileName : 'video')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 80);

    room.activeUpload = {
      fileId: String(fileId).slice(0, 64),
      fileName: safeName || 'Видео',
      percent: clampedPercent,
      status: validStatus,
      uploaderName: user?.nickname,
    };

    io.to(currentRoomId).emit('upload:progress', room.activeUpload);
  });

  socket.on('upload:clear', ({ fileId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    if (!fileId || room.activeUpload?.fileId === fileId) {
      room.activeUpload = null;
      io.to(currentRoomId).emit('upload:progress', null);
    }
  });

  // Typing indicator broadcast (excludes sender)
  socket.on('chat:typing', ({ isTyping }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;

    socket.to(currentRoomId).emit('chat:typing', {
      userId: socket.id,
      nickname: user.nickname,
      isTyping: Boolean(isTyping),
    });
  });

  // Floating small emoji over video (max 5 active per room)
  socket.on('chat:floating_emoji', ({ emoji }) => {
    if (!currentRoomId || typeof emoji !== 'string') return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;

    const cleanEmoji = emoji.trim().slice(0, 12);
    if (!cleanEmoji) return;

    const now = Date.now();
    const active = (roomFloatingEmojis.get(currentRoomId) || []).filter((exp) => exp > now);
    if (active.length >= MAX_ROOM_FLOATING_EMOJIS) {
      roomFloatingEmojis.set(currentRoomId, active);
      return;
    }

    active.push(now + FLOATING_EMOJI_TTL_MS);
    roomFloatingEmojis.set(currentRoomId, active);

    io.to(currentRoomId).emit('chat:floating_emoji', {
      id: uuidv4(),
      emoji: cleanEmoji,
      nickname: user.nickname,
      xPercent: 72 + Math.random() * 20,
    });
  });

  // Disconnect & Auto Host Migration
  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    delete room.users[socket.id];

    const remainingUsers = Object.values(room.users);

    if (room.hostId === socket.id) {
      if (remainingUsers.length > 0) {
        // Find user with lowest joinedAt (FIFO)
        remainingUsers.sort((a, b) => a.joinedAt - b.joinedAt);
        const newHost = remainingUsers[0];
        newHost.isHost = true;
        room.hostId = newHost.id;
        if (room.activeUpload) {
          room.activeUpload = null;
          io.to(currentRoomId).emit('upload:progress', null);
        }

        io.to(currentRoomId).emit('room:host_changed', { hostId: newHost.id });
        io.to(currentRoomId).emit('chat:message', {
          id: uuidv4(),
          userId: 'system',
          nickname: 'Система',
          text: `Пользователь ${user ? user.nickname : 'Хост'} отключился. Новый хост: ${newHost.nickname}`,
          timestamp: Date.now(),
          type: 'system',
        });
        io.to(currentRoomId).emit('room:user_left', {
          userId: socket.id,
          newHostId: newHost.id,
        });
      } else {
        // Room is empty! Purge immediately (Item 4)
        purgeRoom(currentRoomId, 'Все участники вышли. Данные комнаты удалены.');
      }
    } else {
      if (user) {
        io.to(currentRoomId).emit('room:user_left', { userId: socket.id });
        io.to(currentRoomId).emit('chat:message', {
          id: uuidv4(),
          userId: 'system',
          nickname: 'Система',
          text: `${user.nickname} покинул комнату`,
          timestamp: Date.now(),
          type: 'system',
        });

        // If video was playing, pause when viewer drops connection/has network issue
        if (room.playbackState.isPlaying) {
          const elapsed = (Date.now() - room.playbackState.lastUpdatedServerTime) / 1000;
          room.playbackState.currentTime += elapsed;
          room.playbackState.isPlaying = false;
          room.playbackState.isSystemPausedForBuffering = true;
          room.playbackState.lastUpdatedServerTime = Date.now();

          io.to(currentRoomId).emit('sync:buffering_wait', {
            waitingForUsers: [`${user.nickname} (потеря связи)`],
          });
          io.to(currentRoomId).emit('sync:pause', {
            currentTime: room.playbackState.currentTime,
          });
          io.to(currentRoomId).emit('chat:message', {
            id: uuidv4(),
            userId: 'system',
            nickname: 'Система',
            text: `⚠️ Пауза: проблемы со связью у ${user.nickname}. Нажмите "Force Play", чтобы продолжить без него.`,
            timestamp: Date.now(),
            type: 'system',
          });
        }
      }

      if (remainingUsers.length === 0) {
        purgeRoom(currentRoomId, 'Все участники вышли. Данные комнаты удалены.');
      }
    }

    // Check if buffer lock can be resolved after user disconnects
    if (room.playbackState.isSystemPausedForBuffering) {
      const stillBuffering = Object.values(room.users).some((u) => u.isBuffering);
      if (!stillBuffering && remainingUsers.length > 0) {
        room.playbackState.isSystemPausedForBuffering = false;
        room.playbackState.isPlaying = true;
        room.playbackState.lastUpdatedServerTime = Date.now();

        io.to(currentRoomId).emit('sync:buffering_resolved');
        io.to(currentRoomId).emit('sync:play', {
          currentTime: room.playbackState.currentTime,
          serverTimestamp: Date.now(),
        });
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Vite Dev Server / Static Hosting Integration
// -----------------------------------------------------------------------------
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      console.error(
        `[WatchParty Server] ОШИБКА: Файл ${path.join(distPath, 'index.html')} не найден! Убедитесь, что в Build Command выполняется "npm run build".`
      );
    }
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WatchParty Server] Running on http://localhost:${PORT}`);
  });
}

startServer();
