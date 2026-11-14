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
}

const MAX_CHAT_MEDIA_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_CHAT_MEDIA_ROOM_TOTAL = 100 * 1024 * 1024; // 100 MB total per room

// In-memory room store
const rooms = new Map<string, ServerRoomState>();

// Helper to get or create room storage directory
function getRoomStorageDir(roomId: string): string {
  const dir = path.join(STORAGE_BASE_DIR, roomId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getRoomChatMediaDir(roomId: string): string {
  const dir = path.join(getRoomStorageDir(roomId), 'chat_media');
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
  };
}

const REPLY_ACTION_TEMPLATES: Record<string, (actor: string, target: string) => string> = {
  поцеловать: (a, t) => `💋 ${a} поцеловал ${t}`,
  поцелуй: (a, t) => `💋 ${a} поцеловал ${t}`,
  чмок: (a, t) => `💋 ${a} чмокнул ${t}`,
  чмокнуть: (a, t) => `💋 ${a} чмокнул ${t}`,
  обнять: (a, t) => `🫂 ${a} обнял ${t}`,
  обними: (a, t) => `🫂 ${a} обнял ${t}`,
  обнимаю: (a, t) => `🫂 ${a} обнял ${t}`,
  обнимашки: (a, t) => `🫂 ${a} крепко обнял ${t}`,
  погладить: (a, t) => `🥹 ${a} погладил по голове ${t}`,
  погладь: (a, t) => `🥹 ${a} погладил по голове ${t}`,
  глажу: (a, t) => `🥹 ${a} погладил по голове ${t}`,
  ударить: (a, t) => `💥 ${a} ударил ${t}`,
  стукнуть: (a, t) => `💥 ${a} стукнул ${t}`,
  треснуть: (a, t) => `💥 ${a} треснул ${t}`,
  бонк: (a, t) => `🔨 ${a} бонкнул ${t}`,
  пнуть: (a, t) => `🦶 ${a} пнул ${t}`,
  пинок: (a, t) => `🦶 ${a} пнул ${t}`,
  шлепнуть: (a, t) => `👋 ${a} шлёпнул ${t}`,
  укусить: (a, t) => `🦷 ${a} укусил ${t}`,
  кусь: (a, t) => `🦷 ${a} сделал кусь ${t}`,
  куснуть: (a, t) => `🦷 ${a} укусил ${t}`,
  лизнуть: (a, t) => `👅 ${a} лизнул ${t}`,
  лизь: (a, t) => `👅 ${a} лизнул ${t}`,
  покормить: (a, t) => `🍿 ${a} покормил ${t}`,
  покорми: (a, t) => `🍿 ${a} покормил ${t}`,
  'дать пять': (a, t) => `🙌 ${a} дал пять ${t}`,
  'дай пять': (a, t) => `🙌 ${a} дал пять ${t}`,
  пятюня: (a, t) => `🙌 ${a} дал пять ${t}`,
  'пожать руку': (a, t) => `🤝 ${a} пожал руку ${t}`,
  'жму руку': (a, t) => `🤝 ${a} пожал руку ${t}`,
  подмигнуть: (a, t) => `😉 ${a} подмигнул ${t}`,
  улыбнуться: (a, t) => `😊 ${a} улыбнулся ${t}`,
  похлопать: (a, t) => `👏 ${a} похлопал ${t}`,
  аплодисменты: (a, t) => `👏 ${a} поаплодировал ${t}`,
  похвалить: (a, t) => `🌟 ${a} похвалил ${t}`,
  молодец: (a, t) => `🌟 ${a} похвалил ${t}`,
  утешить: (a, t) => `❤️‍🩹 ${a} утешил ${t}`,
  пожалеть: (a, t) => `❤️‍🩹 ${a} пожалел ${t}`,
  поблагодарить: (a, t) => `🙏 ${a} поблагодарил ${t}`,
  спасибо: (a, t) => `🙏 ${a} поблагодарил ${t}`,
  извиниться: (a, t) => `🙇 ${a} извинился перед ${t}`,
  прости: (a, t) => `🙇 ${a} попросил прощения у ${t}`,
  извини: (a, t) => `🙇 ${a} извинился перед ${t}`,
  'подарить цветы': (a, t) => `💐 ${a} подарил цветы ${t}`,
  цветы: (a, t) => `💐 ${a} подарил цветы ${t}`,
  чокнуться: (a, t) => `🥂 ${a} чокнулся с ${t}`,
  выпить: (a, t) => `🥂 ${a} выпил с ${t}`,
  разбудить: (a, t) => `⏰ ${a} разбудил ${t}`,
  проснись: (a, t) => `⏰ ${a} разбудил ${t}`,
  люблю: (a, t) => `❤️ ${a} признался в любви ${t}`,
};

function buildReplyActionText(actorNick: string, targetNick: string, text: string): string | null {
  const norm = text
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

  const words = norm.split(' ');
  if (words.length <= 5) {
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      const bigramBuilder = REPLY_ACTION_TEMPLATES[bigram];
      if (bigramBuilder) return bigramBuilder(actorNick, targetNick);
    }
    for (const w of words) {
      const wordBuilder = REPLY_ACTION_TEMPLATES[w];
      if (wordBuilder) return wordBuilder(actorNick, targetNick);
    }
  }

  return null;
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const roomId = req.params.roomId;
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
    fileSize: 2 * 1024 * 1024 * 1024, // 2 GB limit per file
  },
});

const chatMediaStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const roomId = req.params.roomId;
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
  const roomDir = path.join(STORAGE_BASE_DIR, roomId);
  fsPromises
    .rm(roomDir, { recursive: true, force: true })
    .then(() => {
      console.log(`[WatchParty] Хранилище очищено для комнаты ${roomId}`);
    })
    .catch((err) => {
      console.error(`Ошибка при удалении хранилища комнаты ${roomId}:`, err);
    });

  chatMessageRegistry.delete(roomId);
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

      const roomDir = getRoomStorageDir(session.roomId);
      const partPath = path.join(roomDir, `${fileId}.part`);

      try {
        await fsPromises.unlink(partPath).catch(() => {});
      } catch (err) {
        console.error(`[Auto-Cleanup] Ошибка удаления файлов для ${fileId}:`, err);
      }
    }
  }
}, 15000);

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
    chatMediaFiles: [],
    chatMediaTotalBytes: 0,
  };

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
app.post('/api/rooms/:roomId/upload', upload.array('videos', 10), (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const token = req.headers['x-host-token'] || req.query.token || req.body.token;
  const socketId = req.headers['x-socket-id'] || req.query.socketId || req.body.socketId;

  // Verify host permissions
  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId) ||
    Object.keys(room.users).length === 0;

  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может загружать видео' });
    return;
  }

  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) {
    res.status(400).json({ error: 'Файлы не были переданы' });
    return;
  }

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
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const token = (req.headers['x-host-token'] as string) || (req.query.token as string);
  const socketId = (req.headers['x-socket-id'] as string) || (req.query.socketId as string);

  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId) ||
    Object.keys(room.users).length === 0;

  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может загружать видео' });
    return;
  }

  const fileId = req.headers['x-file-id'] as string;
  if (!fileId) {
    res.status(400).json({ error: 'Missing x-file-id' });
    return;
  }

  const rawFileName = (req.headers['x-file-name'] as string) || 'video.mp4';
  const fileName = decodeURIComponent(rawFileName);
  const totalSize = parseInt((req.headers['x-file-size'] as string) || '0', 10);
  const chunkOffset = parseInt((req.headers['x-chunk-offset'] as string) || '0', 10);
  const chunkIndex = parseInt((req.headers['x-chunk-index'] as string) || '0', 10);
  const totalChunks = parseInt((req.headers['x-total-chunks'] as string) || '1', 10);

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
      if (!session) return;
      session.completedChunks.add(chunkIndex);
      session.lastActivity = Date.now();

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

        // Broadcast playlist update
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
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const token = (req.headers['x-host-token'] as string) || (req.query.token as string);
  const socketId = (req.headers['x-socket-id'] as string) || (req.query.socketId as string);

  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId) ||
    Object.keys(room.users).length === 0;

  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может отменять загрузку' });
    return;
  }

  uploadSessions.delete(fileId);

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
    currentRoomId = roomId;
    socket.join(roomId);

    let room = rooms.get(roomId);
    if (!room) {
      // Auto-create room if joining direct link
      room = {
        roomId,
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
        chatMediaFiles: [],
        chatMediaTotalBytes: 0,
      };
      rooms.set(roomId, room);
      getRoomStorageDir(roomId);
    }

    // Cancel cleanup timer if active
    if (room.emptyTimeoutId) {
      clearTimeout(room.emptyTimeoutId);
      room.emptyTimeoutId = null;
    }

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

    // Send full state to the joined user
    socket.emit('room:init_state', room);

    // Notify other users
    socket.to(roomId).emit('room:user_joined', newUser);

    io.to(roomId).emit('chat:message', {
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

  // Host: Play
  socket.on('host:play', ({ currentTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

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
  socket.on('host:delete_track', ({ fileId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.hostId !== socket.id) return;

    const index = room.playlist.findIndex((item) => item.id === fileId);
    if (index === -1) return;

    const [deletedItem] = room.playlist.splice(index, 1);

    // Delete local file if present
    const roomDir = path.join(STORAGE_BASE_DIR, currentRoomId);
    const filePath = path.join(roomDir, deletedItem.filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error('Error deleting file:', err);
      }
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
  socket.on('chat:send', ({ text, replyTo }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    const cleanText = (text || '').trim().slice(0, 500);
    if (!cleanText || !user) return;

    const cleanReplyTo = sanitizeReplyTo(replyTo);
    const messageId = uuidv4();
    const message: ChatMessage = {
      id: messageId,
      userId: socket.id,
      nickname: user.nickname,
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
