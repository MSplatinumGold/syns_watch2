import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import type {
  RoomState,
  User,
  PlaylistItem,
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
} from './src/types/watchparty.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const STORAGE_BASE_DIR = path.join(process.cwd(), 'storage', 'rooms');

// Ensure base storage directory exists
if (!fs.existsSync(STORAGE_BASE_DIR)) {
  fs.mkdirSync(STORAGE_BASE_DIR, { recursive: true });
}

interface ServerRoomState extends RoomState {
  hostToken: string;
}

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

const app = express();
const server = http.createServer(app);

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

app.use(express.json());

// -----------------------------------------------------------------------------
// REST API Endpoints
// -----------------------------------------------------------------------------

// Create a new room
app.post('/api/rooms/create', (req, res) => {
  const { nickname } = req.body;
  const rawNick = (nickname || 'Хост').toString().trim().slice(0, 30);
  const roomId = Math.random().toString(36).substring(2, 8).toLowerCase();
  const hostToken = uuidv4();

  const newRoom: ServerRoomState = {
    roomId,
    hostId: '',
    hostToken,
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
  };

  rooms.set(roomId, newRoom);
  getRoomStorageDir(roomId);

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
    const ext = path.extname(file.originalname).toLowerCase();
    const isSupported = ['.mp4', '.webm', '.ogg', '.mov'].includes(ext);

    const item: PlaylistItem = {
      id: path.basename(file.filename, ext),
      originalName: file.originalname,
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

// Check upload status of a file for resumable chunked upload
app.get('/api/rooms/:roomId/upload/status/:fileId', (req, res) => {
  const { roomId, fileId } = req.params;
  const room = rooms.get(roomId);
  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const roomDir = getRoomStorageDir(roomId);
  const partPath = path.join(roomDir, `${fileId}.part`);
  const metaPath = path.join(roomDir, `${fileId}.info`);

  // Check if in-progress .part file exists
  if (fs.existsSync(partPath)) {
    const stat = fs.statSync(partPath);
    let verifiedBytes = stat.size;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (typeof meta.verifiedBytes === 'number') {
          verifiedBytes = meta.verifiedBytes;
        }
      } catch {}
    }
    res.json({
      exists: true,
      completed: false,
      uploadedBytes: verifiedBytes,
    });
    return;
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
  if (fs.existsSync(roomDir)) {
    const files = fs.readdirSync(roomDir);
    const matched = files.find((f) => f.startsWith(fileId) && !f.endsWith('.part') && !f.endsWith('.info'));
    if (matched) {
      const stat = fs.statSync(path.join(roomDir, matched));
      res.json({
        exists: true,
        completed: true,
        uploadedBytes: stat.size,
      });
      return;
    }
  }

  res.json({
    exists: false,
    completed: false,
    uploadedBytes: 0,
  });
});

// Resumable Chunked Upload (5MB slices with Zero-Copy streaming disk I/O, near-zero RAM footprint)
app.post('/api/rooms/:roomId/upload/chunk', (req, res) => {
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
  const metaPath = path.join(roomDir, `${fileId}.info`);

  const fileExists = fs.existsSync(partPath);
  // Direct file stream write at chunk offset: zero memory accumulation in Node.js heap
  const writeStream = fs.createWriteStream(partPath, {
    flags: !fileExists || chunkOffset === 0 ? 'w' : 'r+',
    start: chunkOffset,
  });

  let bytesReceivedThisChunk = 0;
  req.on('data', (chunk: Buffer) => {
    bytesReceivedThisChunk += chunk.length;
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

  writeStream.on('finish', () => {
    try {
      const verifiedBytes = chunkOffset + bytesReceivedThisChunk;

      // Update meta info for resumable state tracking
      try {
        fs.writeFileSync(
          metaPath,
          JSON.stringify({
            fileId,
            fileName,
            totalSize,
            verifiedBytes,
            lastChunkIndex: chunkIndex,
            totalChunks,
            updatedAt: Date.now(),
          })
        );
      } catch {}

      const isLast = chunkIndex >= totalChunks - 1 || (totalSize > 0 && verifiedBytes >= totalSize);

      if (isLast) {
        // Truncate to exact total size if needed
        if (totalSize > 0) {
          try {
            fs.truncateSync(partPath, totalSize);
          } catch {}
        }

        const ext = path.extname(fileName).toLowerCase() || '.mp4';
        const finalFilename = `${fileId}${ext}`;
        const finalPath = path.join(roomDir, finalFilename);

        // Atomic rename .part -> permanent file
        fs.renameSync(partPath, finalPath);

        if (fs.existsSync(metaPath)) {
          try {
            fs.unlinkSync(metaPath);
          } catch {}
        }

        const finalStat = fs.statSync(finalPath);
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

        res.json({
          success: true,
          completed: true,
          uploadedBytes: item.size,
          chunkIndex,
          totalChunks,
          item,
          playlist: room.playlist,
        });
      } else {
        res.json({
          success: true,
          completed: false,
          uploadedBytes: verifiedBytes,
          chunkIndex,
          totalChunks,
        });
      }
    } catch (err) {
      console.error('Error finalizing chunk write:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Ошибка финализации чанка' });
      }
    }
  });
});

// Cancel in-flight chunked upload and immediately delete .part files from disk
app.post('/api/rooms/:roomId/upload/cancel/:fileId', (req, res) => {
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

  const roomDir = getRoomStorageDir(roomId);
  const partPath = path.join(roomDir, `${fileId}.part`);
  const metaPath = path.join(roomDir, `${fileId}.info`);

  try {
    if (fs.existsSync(partPath)) {
      fs.unlinkSync(partPath);
    }
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
  } catch (err) {
    console.error('Error removing .part on cancel:', err);
  }

  res.json({ success: true, cancelled: true });
});

// Seed or add public sample video for instant testing
app.post('/api/rooms/:roomId/add-sample', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    res.status(404).json({ error: 'Комната не найдена' });
    return;
  }

  const token = req.headers['x-host-token'] || req.query.token;
  const socketId = req.headers['x-socket-id'] || req.query.socketId;
  const isAuthorized =
    (token && token === room.hostToken) ||
    (socketId && socketId === room.hostId) ||
    Object.keys(room.users).length === 0;

  if (!isAuthorized) {
    res.status(403).json({ error: 'Только хост может добавлять образцы' });
    return;
  }

  const sampleName = req.body.sampleName || 'Big Buck Bunny (Тестовое видео)';
  const sampleUrl = req.body.sampleUrl || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

  const item: PlaylistItem = {
    id: uuidv4(),
    originalName: sampleName,
    filename: 'sample.mp4',
    size: 158008374,
    mimeType: 'video/mp4',
    url: sampleUrl,
  };

  room.playlist.push(item);

  io.to(roomId).emit('playlist:updated', {
    playlist: room.playlist,
    currentTrackIndex: room.currentTrackIndex,
  });

  io.to(roomId).emit('chat:message', {
    id: uuidv4(),
    userId: 'system',
    nickname: 'Система',
    text: `Добавлено демо-видео: "${sampleName}"`,
    timestamp: Date.now(),
    type: 'system',
  });

  res.json({ success: true, item, playlist: room.playlist });
});

// Stream video via HTTP 206 Partial Content
app.get('/api/rooms/:roomId/stream/:fileId', (req, res) => {
  const { roomId, fileId } = req.params;
  const roomDir = path.join(STORAGE_BASE_DIR, roomId);

  let filePath = path.join(roomDir, fileId);

  // If file doesn't exist with exact name, check if fileId is base name without extension
  if (!fs.existsSync(filePath)) {
    const matched = fs.existsSync(roomDir)
      ? fs.readdirSync(roomDir).find((f) => f.startsWith(fileId))
      : null;
    if (matched) {
      filePath = path.join(roomDir, matched);
    } else {
      res.status(404).send('Видео файл не найден');
      return;
    }
  }

  const stat = fs.statSync(filePath);
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
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).send('Requested range not satisfiable');
      return;
    }

    const chunksize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, {
      start,
      end,
      highWaterMark: 128 * 1024, // 128 KB buffer to prevent memory spikes
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

    const fileStream = fs.createReadStream(filePath, { highWaterMark: 128 * 1024 });
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

  // Immediate Room Purge (Item 4: delete all files and room records on close or when empty)
  function purgeRoom(roomId: string, reason = 'Комната закрыта. Все файлы и данные удалены.') {
    const room = rooms.get(roomId);
    if (room && room.emptyTimeoutId) {
      clearTimeout(room.emptyTimeoutId);
      room.emptyTimeoutId = null;
    }

    io.to(roomId).emit('room:closed', { reason });

    const roomDir = path.join(STORAGE_BASE_DIR, roomId);
    if (fs.existsSync(roomDir)) {
      try {
        fs.rmSync(roomDir, { recursive: true, force: true });
        console.log(`[WatchParty] Storage cleared for room ${roomId}`);
      } catch (err) {
        console.error(`Error deleting storage for room ${roomId}:`, err);
      }
    }
    rooms.delete(roomId);
  }

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
  socket.on('chat:send', ({ text }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users[socket.id];
    const cleanText = (text || '').trim();
    if (!cleanText || !user) return;

    const message: ChatMessage = {
      id: uuidv4(),
      userId: socket.id,
      nickname: user.nickname,
      text: cleanText.slice(0, 500),
      timestamp: Date.now(),
      type: 'message',
    };

    io.to(currentRoomId).emit('chat:message', message);
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
