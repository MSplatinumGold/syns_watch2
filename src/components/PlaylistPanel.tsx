import React, { useState, useRef, useCallback } from 'react';
import {
  UploadCloud,
  Play,
  Trash2,
  ChevronUp,
  ChevronDown,
  Film,
  Sparkles,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  RotateCcw,
  X,
} from 'lucide-react';
import type { PlaylistItem } from '../types/watchparty.ts';
import { formatBytes } from '../utils/format.ts';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks

function formatRemainingTime(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '< 1 сек';
  if (seconds < 60) return `< 1 мин`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')} мин`;
}

interface ResumableUploadState {
  file: File;
  fileId: string;
  status: 'uploading' | 'retrying' | 'error' | 'completed';
  uploadedBytes: number;
  totalBytes: number;
  currentChunkIndex: number;
  totalChunks: number;
  speed: number; // bytes per second
  remainingSeconds: number;
  retryAttempt: number;
  errorMessage?: string | null;
}

interface PlaylistPanelProps {
  playlist: PlaylistItem[];
  currentTrackIndex: number;
  isHost: boolean;
  roomId: string;
  hostToken: string;
  socketId: string;
  onChangeTrack: (index: number) => void;
  onReorder: (newOrderIds: string[]) => void;
  onDeleteTrack: (fileId: string) => void;
}

export const PlaylistPanel: React.FC<PlaylistPanelProps> = ({
  playlist,
  currentTrackIndex,
  isHost,
  roomId,
  hostToken,
  socketId,
  onChangeTrack,
  onReorder,
  onDeleteTrack,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeXhrsRef = useRef<Set<XMLHttpRequest>>(new Set());
  const chunkLoadedMapRef = useRef<Map<number, number>>(new Map());
  const completedChunksSetRef = useRef<Set<number>>(new Set());
  const isCancelledRef = useRef(false);

  const [upload, setUpload] = useState<ResumableUploadState | null>(null);
  const [codecWarning, setCodecWarning] = useState<string | null>(null);
  const [isAddingSample, setIsAddingSample] = useState(false);

  const speedTrackerRef = useRef<{ lastTime: number; lastTotalBytes: number }>({
    lastTime: Date.now(),
    lastTotalBytes: 0,
  });

  // Upload a single 5MB chunk with real-time byte progress
  const uploadChunkWithProgress = useCallback(
    (
      file: File,
      fileId: string,
      chunkIndex: number,
      start: number,
      end: number,
      chunkBlob: Blob,
      totalChunks: number
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeXhrsRef.current.add(xhr);

        xhr.open('POST', `/api/rooms/${roomId}/upload/chunk`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('x-host-token', hostToken);
        xhr.setRequestHeader('x-socket-id', socketId);
        xhr.setRequestHeader('x-file-id', fileId);
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.setRequestHeader('x-file-size', file.size.toString());
        xhr.setRequestHeader('x-chunk-offset', start.toString());
        xhr.setRequestHeader('x-chunk-index', chunkIndex.toString());
        xhr.setRequestHeader('x-total-chunks', totalChunks.toString());

        xhr.upload.onprogress = (e) => {
          if (isCancelledRef.current) return;
          chunkLoadedMapRef.current.set(chunkIndex, e.loaded);

          // Aggregate uploaded bytes across all completed and concurrent in-flight chunks
          const completedBytes = completedChunksSetRef.current.size * CHUNK_SIZE;
          let inFlightBytes = 0;
          chunkLoadedMapRef.current.forEach((bytes) => {
            inFlightBytes += bytes;
          });
          const totalUploadedSoFar = Math.min(completedBytes + inFlightBytes, file.size);

          const now = Date.now();
          const dt = (now - speedTrackerRef.current.lastTime) / 1000;
          if (dt >= 0.25) {
            const dLoaded = totalUploadedSoFar - speedTrackerRef.current.lastTotalBytes;
            speedTrackerRef.current.lastTime = now;
            speedTrackerRef.current.lastTotalBytes = totalUploadedSoFar;

            const instantSpeed = dLoaded > 0 && dt > 0 ? dLoaded / dt : 0;
            const remainingBytes = Math.max(0, file.size - totalUploadedSoFar);

            setUpload((prev) => {
              if (!prev || prev.status !== 'uploading') return prev;
              const smoothedSpeed =
                prev.speed > 0 ? prev.speed * 0.65 + instantSpeed * 0.35 : instantSpeed;
              const remainingSec =
                smoothedSpeed > 0 ? Math.ceil(remainingBytes / smoothedSpeed) : 0;
              return {
                ...prev,
                uploadedBytes: totalUploadedSoFar,
                currentChunkIndex: completedChunksSetRef.current.size,
                speed: smoothedSpeed,
                remainingSeconds: remainingSec,
              };
            });
          } else {
            setUpload((prev) => {
              if (!prev || prev.status !== 'uploading') return prev;
              return {
                ...prev,
                uploadedBytes: totalUploadedSoFar,
                currentChunkIndex: completedChunksSetRef.current.size,
              };
            });
          }
        };

        xhr.onload = () => {
          activeXhrsRef.current.delete(xhr);
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const resp = JSON.parse(xhr.responseText);
              if (resp.completed) {
                setUpload((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: 'completed',
                        uploadedBytes: file.size,
                        speed: 0,
                        remainingSeconds: 0,
                      }
                    : null
                );
                setTimeout(() => {
                  setUpload(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }, 2000);
              }
              resolve();
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
          }
        };

        xhr.onerror = () => {
          activeXhrsRef.current.delete(xhr);
          reject(new Error('Сетевой сбой при передаче чанка'));
        };

        xhr.onabort = () => {
          activeXhrsRef.current.delete(xhr);
          reject(new Error('Загрузка чанка отменена'));
        };

        xhr.send(chunkBlob);
      });
    },
    [roomId, hostToken, socketId]
  );

  // Concurrent (попутная) chunk upload loop with concurrency pool
  const uploadChunkLoop = useCallback(
    async (file: File, fileId: string, initialPendingChunks: number[]) => {
      const queue = [...initialPendingChunks];
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const CONCURRENCY = 3; // 3 concurrent chunks uploaded in parallel

      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          if (isCancelledRef.current) return;
          const chunkIndex = queue.shift();
          if (chunkIndex === undefined) return;

          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunkBlob = file.slice(start, end);

          let success = false;
          let attempt = 0;

          while (!success && attempt <= 3) {
            if (isCancelledRef.current) return;
            try {
              if (attempt > 0) {
                setUpload((prev) =>
                  prev ? { ...prev, status: 'retrying', retryAttempt: attempt } : null
                );
                await new Promise((r) => setTimeout(r, 1200));
                if (isCancelledRef.current) return;
              }

              await uploadChunkWithProgress(
                file,
                fileId,
                chunkIndex,
                start,
                end,
                chunkBlob,
                totalChunks
              );

              success = true;
              completedChunksSetRef.current.add(chunkIndex);
              chunkLoadedMapRef.current.delete(chunkIndex);
            } catch (err) {
              if (isCancelledRef.current) return;
              attempt++;
              if (attempt > 3) {
                setUpload((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: 'error',
                        retryAttempt: 3,
                        errorMessage: 'Сбой сети при передаче чанка. Нажмите "Повторить".',
                      }
                    : null
                );
                return;
              }
            }
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(CONCURRENCY, queue.length) },
        () => worker()
      );
      await Promise.all(workers);
    },
    [uploadChunkWithProgress]
  );

  // File Picker Handler (Concurrent Chunked Upload initialization)
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || !isHost) return;

    const file = files[0];
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'mkv' || ext === 'avi' || ext === 'wmv') {
      setCodecWarning(
        'Внимание: Браузеры могут не поддерживать кодеки .mkv или .avi. Рекомендуется MP4 (H.264/AAC).'
      );
    } else {
      setCodecWarning(null);
    }

    const fileId = Math.random().toString(36).substring(2, 10) + '_' + Date.now();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    isCancelledRef.current = false;
    completedChunksSetRef.current.clear();
    chunkLoadedMapRef.current.clear();
    speedTrackerRef.current = { lastTime: Date.now(), lastTotalBytes: 0 };

    setUpload({
      file,
      fileId,
      status: 'uploading',
      uploadedBytes: 0,
      totalBytes: file.size,
      currentChunkIndex: 0,
      totalChunks,
      speed: 0,
      remainingSeconds: 0,
      retryAttempt: 0,
    });

    const allChunks = Array.from({ length: totalChunks }, (_, i) => i);
    uploadChunkLoop(file, fileId, allChunks);
  };

  // Retry failed upload
  const handleRetryUpload = () => {
    if (!upload) return;
    isCancelledRef.current = false;
    setUpload((prev) =>
      prev ? { ...prev, status: 'uploading', errorMessage: null } : null
    );

    const totalChunks = Math.ceil(upload.file.size / CHUNK_SIZE);
    const pendingChunks: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!completedChunksSetRef.current.has(i)) {
        pendingChunks.push(i);
      }
    }

    speedTrackerRef.current = {
      lastTime: Date.now(),
      lastTotalBytes: completedChunksSetRef.current.size * CHUNK_SIZE,
    };

    uploadChunkLoop(upload.file, upload.fileId, pendingChunks);
  };

  // Cancel in-flight upload and purge .part file from server disk
  const handleCancelUpload = async () => {
    isCancelledRef.current = true;
    activeXhrsRef.current.forEach((xhr) => xhr.abort());
    activeXhrsRef.current.clear();
    completedChunksSetRef.current.clear();
    chunkLoadedMapRef.current.clear();

    const currentFileId = upload?.fileId;
    setUpload(null);
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (currentFileId) {
      try {
        await fetch(`/api/rooms/${roomId}/upload/cancel/${currentFileId}`, {
          method: 'POST',
          headers: {
            'x-host-token': hostToken,
            'x-socket-id': socketId,
          },
        });
      } catch {}
    }
  };

  // Add instant demo sample
  const handleAddSample = async (sampleName: string, sampleUrl: string) => {
    if (!isHost || isAddingSample) return;
    setIsAddingSample(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/add-sample`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-host-token': hostToken,
          'x-socket-id': socketId,
        },
        body: JSON.stringify({ sampleName, sampleUrl }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
    } catch (err) {
      console.error('Failed to add sample:', err);
    } finally {
      setIsAddingSample(false);
    }
  };

  // Move item up
  const handleMoveUp = (index: number) => {
    if (index <= 0 || !isHost) return;
    const newItems = [...playlist];
    const temp = newItems[index];
    newItems[index] = newItems[index - 1];
    newItems[index - 1] = temp;
    onReorder(newItems.map((i) => i.id));
  };

  // Move item down
  const handleMoveDown = (index: number) => {
    if (index >= playlist.length - 1 || !isHost) return;
    const newItems = [...playlist];
    const temp = newItems[index];
    newItems[index] = newItems[index + 1];
    newItems[index + 1] = temp;
    onReorder(newItems.map((i) => i.id));
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl">
      {/* Header */}
      <div className="p-3.5 bg-neutral-950/60 border-b border-neutral-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-rose-500" />
          <h3 className="text-xs md:text-sm font-semibold text-white">Плейлист</h3>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 font-mono">
            {playlist.length}
          </span>
        </div>

        {isHost && (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={upload !== null && (upload.status === 'uploading' || upload.status === 'retrying')}
            className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow disabled:opacity-50 cursor-pointer"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            <span>Загрузить</span>
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,.mp4,.webm,.ogg,.mov,.mkv,.avi"
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />

      {/* Codec Warning Banner */}
      {codecWarning && (
        <div className="p-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{codecWarning}</p>
            <button
              onClick={() => setCodecWarning(null)}
              className="mt-1 text-[11px] underline text-amber-200 cursor-pointer"
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Resumable Upload Informative Card */}
      {upload && (
        <div className="p-3 bg-neutral-950/90 border-b border-neutral-800">
          {/* Row 1: File name & Control buttons */}
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <Film className="w-4 h-4 text-rose-500 shrink-0" />
              <span className="text-xs font-semibold text-neutral-200 truncate" title={upload.file.name}>
                {upload.file.name}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">

              {upload.status === 'retrying' && (
                <span className="text-[11px] text-amber-400 font-medium flex items-center gap-1 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Повтор {upload.retryAttempt}/3
                </span>
              )}

              {upload.status === 'error' && (
                <button
                  type="button"
                  onClick={handleRetryUpload}
                  className="px-2 py-0.5 rounded-lg bg-rose-600/30 hover:bg-rose-600/50 text-rose-300 text-xs font-medium flex items-center gap-1 border border-rose-500/40 transition cursor-pointer"
                  title="Повторить попытку"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Повторить</span>
                </button>
              )}

              {upload.status === 'completed' && (
                <span className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Готово
                </span>
              )}

              {upload.status !== 'completed' && (
                <button
                  type="button"
                  onClick={handleCancelUpload}
                  className="p-1 rounded-lg bg-neutral-800 hover:bg-rose-950/60 text-neutral-400 hover:text-rose-300 border border-neutral-700 transition cursor-pointer"
                  title="Отменить загрузку файла"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Row 2: Progress bar */}
          <div className="relative w-full h-2 bg-neutral-800 rounded-full overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-all duration-150 ${
                upload.status === 'error'
                  ? 'bg-rose-600'
                  : upload.status === 'retrying'
                  ? 'bg-amber-500'
                  : 'bg-gradient-to-r from-rose-600 via-rose-500 to-amber-500'
              }`}
              style={{
                width: `${Math.min(
                  100,
                  Math.round((upload.uploadedBytes / upload.totalBytes) * 100) || 0
                )}%`,
              }}
            />
          </div>

          {/* Row 3: Metrics (Transferred volume, Speed, ETA) */}
          <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono">
            <span>
              {formatBytes(upload.uploadedBytes)} / {formatBytes(upload.totalBytes)} (
              {Math.min(
                100,
                Math.round((upload.uploadedBytes / upload.totalBytes) * 100) || 0
              )}
              %)
            </span>

            <div className="flex items-center gap-2.5">
              {upload.status === 'uploading' && upload.speed > 0 && (
                <span className="text-amber-300">
                  {formatBytes(upload.speed)}/с
                </span>
              )}

              {upload.status === 'uploading' && upload.remainingSeconds > 0 && (
                <span className="text-neutral-400">
                  ~{formatRemainingTime(upload.remainingSeconds)}
                </span>
              )}
            </div>
          </div>

          {upload.errorMessage && (
            <div className="mt-2 p-1.5 rounded bg-rose-500/10 border border-rose-500/20 text-[11px] text-rose-300 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span>{upload.errorMessage}</span>
            </div>
          )}
        </div>
      )}

      {/* Tracks List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {playlist.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-400">
            <div className="w-12 h-12 rounded-xl bg-neutral-800/80 border border-neutral-700/50 flex items-center justify-center mb-3 text-neutral-500">
              <UploadCloud className="w-6 h-6" />
            </div>
            <p className="text-sm font-medium text-neutral-200">Файлов пока нет</p>
            <p className="text-xs text-neutral-500 mt-1 max-w-xs">
              {isHost
                ? 'Загрузите собственное видео или добавьте демо-видео для быстрой проверки.'
                : 'Ожидайте, пока хост добавит видео в очередь.'}
            </p>

            {isHost && (
              <div className="mt-4 flex flex-col gap-2 w-full max-w-xs">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2 px-3 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition shadow cursor-pointer"
                >
                  <UploadCloud className="w-4 h-4" /> Выбрать локальный файл
                </button>
                <button
                  onClick={() =>
                    handleAddSample(
                      'Big Buck Bunny (HD Demo)',
                      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'
                    )
                  }
                  disabled={isAddingSample}
                  className="w-full py-2 px-3 bg-neutral-800 hover:bg-neutral-700 text-amber-300 border border-amber-500/30 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  {isAddingSample ? 'Добавление...' : 'Добавить демо: Big Buck Bunny'}
                </button>
              </div>
            )}
          </div>
        ) : (
          playlist.map((item, index) => {
            const isPlayingThis = index === currentTrackIndex;

            return (
              <div
                key={item.id}
                className={`p-2.5 rounded-xl border transition-all flex items-center justify-between gap-2 group ${
                  isPlayingThis
                    ? 'bg-neutral-800/90 border-rose-500/50 shadow-md ring-1 ring-rose-500/30'
                    : 'bg-neutral-800/40 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/70'
                }`}
              >
                {/* Left: Track Index & Play indicator */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div
                    onClick={() => isHost && onChangeTrack(index)}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-mono font-medium transition ${
                      isPlayingThis
                        ? 'bg-rose-600 text-white shadow-sm'
                        : isHost
                        ? 'bg-neutral-800 text-neutral-400 group-hover:bg-neutral-700 group-hover:text-white cursor-pointer'
                        : 'bg-neutral-800 text-neutral-500'
                    }`}
                    title={isHost ? 'Включить этот трек' : undefined}
                  >
                    {isPlayingThis ? <Play className="w-3.5 h-3.5 fill-white" /> : index + 1}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      onClick={() => isHost && onChangeTrack(index)}
                      className={`text-xs font-medium truncate ${
                        isPlayingThis
                          ? 'text-white font-semibold'
                          : isHost
                          ? 'text-neutral-300 hover:text-white cursor-pointer'
                          : 'text-neutral-400'
                      }`}
                      title={item.originalName}
                    >
                      {item.originalName}
                    </p>
                    <p className="text-[10px] text-neutral-500 font-mono mt-0.5">
                      {formatBytes(item.size)}
                    </p>
                  </div>
                </div>

                {/* Right: Actions for host */}
                {isHost && (
                  <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0}
                      className="p-1 rounded hover:bg-neutral-700 disabled:opacity-30 text-neutral-400 hover:text-white transition cursor-pointer"
                      title="Поднять выше"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === playlist.length - 1}
                      className="p-1 rounded hover:bg-neutral-700 disabled:opacity-30 text-neutral-400 hover:text-white transition cursor-pointer"
                      title="Опустить ниже"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDeleteTrack(item.id)}
                      className="p-1 rounded hover:bg-rose-900/50 text-neutral-400 hover:text-rose-400 transition cursor-pointer ml-1"
                      title="Удалить из плейлиста"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer Add Sample Shortcut (Host only, when playlist already has items) */}
      {isHost && playlist.length > 0 && (
        <div className="p-2.5 bg-neutral-950/80 border-t border-neutral-800 flex items-center justify-between text-xs">
          <span className="text-[11px] text-neutral-500">Добавить еще:</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                handleAddSample(
                  'Tears of Steel (Sci-Fi Demo)',
                  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4'
                )
              }
              disabled={isAddingSample}
              className="text-[11px] text-amber-400 hover:text-amber-300 font-medium transition cursor-pointer"
            >
              + Демо: Tears of Steel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
