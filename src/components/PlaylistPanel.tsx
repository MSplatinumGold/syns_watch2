import React, { useState, useRef, useEffect } from 'react';
import {
  UploadCloud,
  Play,
  Pause,
  Trash2,
  ChevronUp,
  ChevronDown,
  Film,
  Sparkles,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  X,
  Zap,
  Clock,
  RotateCcw,
} from 'lucide-react';
import type { PlaylistItem } from '../types/watchparty.ts';
import { formatBytes, formatSpeed, formatEta } from '../utils/format.ts';

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

interface UploadTask {
  file: File;
  fileId: string;
  bytesUploaded: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number;
  isPaused: boolean;
  statusText: string;
  retryCount: number;
  error: string | null;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks

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
  const abortControllerRef = useRef<AbortController | null>(null);
  const isPausedRef = useRef<boolean>(false);
  const isCancelledRef = useRef<boolean>(false);
  const activeUploadRef = useRef<UploadTask | null>(null);

  const [uploadTask, setUploadTask] = useState<UploadTask | null>(null);
  const [codecWarning, setCodecWarning] = useState<string | null>(null);
  const [isAddingSample, setIsAddingSample] = useState(false);

  // Sync ref with state
  useEffect(() => {
    activeUploadRef.current = uploadTask;
  }, [uploadTask]);

  // Main chunk upload loop with auto-retry and pause/resume support
  const runChunkUploadLoop = async (task: UploadTask, startFromByte: number) => {
    const { file, fileId, totalBytes } = task;
    let offset = startFromByte;
    let lastSpeed = task.speedBps || 0;

    isPausedRef.current = false;
    isCancelledRef.current = false;

    while (offset < totalBytes) {
      if (isPausedRef.current || isCancelledRef.current) {
        return;
      }

      const chunkEnd = Math.min(offset + CHUNK_SIZE, totalBytes);
      const chunkBlob = file.slice(offset, chunkEnd);
      const chunkIndex = Math.floor(offset / CHUNK_SIZE);
      const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
      const chunkSize = chunkEnd - offset;

      let chunkSuccess = false;
      let attempt = 0;

      while (attempt < 3 && !chunkSuccess) {
        if (isPausedRef.current || isCancelledRef.current) {
          return;
        }

        attempt++;
        if (attempt > 1) {
          setUploadTask((prev) =>
            prev
              ? {
                  ...prev,
                  retryCount: attempt - 1,
                  statusText: `Повтор попытки связи (${attempt - 1}/3)...`,
                }
              : null
          );
          // Exponential backoff: 1s, 2s, 3s
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
          if (isPausedRef.current || isCancelledRef.current) return;
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;
        const chunkStartTime = Date.now();

        try {
          const response = await fetch(`/api/rooms/${roomId}/upload/chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-host-token': hostToken,
              'x-socket-id': socketId,
              'x-file-id': fileId,
              'x-file-name': encodeURIComponent(file.name),
              'x-file-size': totalBytes.toString(),
              'x-chunk-offset': offset.toString(),
              'x-chunk-index': chunkIndex.toString(),
              'x-total-chunks': totalChunks.toString(),
              'x-chunk-size': chunkSize.toString(),
            },
            body: chunkBlob,
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          chunkSuccess = true;

          const durationSec = Math.max(0.05, (Date.now() - chunkStartTime) / 1000);
          const currentSpeed = chunkSize / durationSec;
          lastSpeed = lastSpeed > 0 ? lastSpeed * 0.7 + currentSpeed * 0.3 : currentSpeed;

          offset = chunkEnd;
          const remainingBytes = Math.max(0, totalBytes - offset);
          const eta = lastSpeed > 0 ? Math.round(remainingBytes / lastSpeed) : 0;

          setUploadTask((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              bytesUploaded: offset,
              speedBps: lastSpeed,
              etaSeconds: eta,
              retryCount: 0,
              error: null,
              statusText: data.isCompleted ? 'Готово!' : 'Загрузка чанками (5 МБ)...',
            };
          });

          if (data.isCompleted) {
            // Upload complete: clear card after brief success confirmation
            setTimeout(() => {
              setUploadTask(null);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }, 1200);
            return;
          }
        } catch (err: any) {
          if (controller.signal.aborted) {
            return; // Normal pause or cancellation
          }
          console.warn(`Chunk ${chunkIndex} attempt ${attempt} failed:`, err);
          if (attempt >= 3) {
            setUploadTask((prev) =>
              prev
                ? {
                    ...prev,
                    error: 'Сбой сети после 3 попыток. Нажмите «Продолжить» для повтора.',
                    isPaused: true,
                    statusText: 'Ошибка связи',
                  }
                : null
            );
            return;
          }
        }
      }
    }
  };

  // Pause Upload
  const handlePauseUpload = () => {
    isPausedRef.current = true;
    abortControllerRef.current?.abort();
    setUploadTask((prev) =>
      prev
        ? {
            ...prev,
            isPaused: true,
            speedBps: 0,
            etaSeconds: 0,
            statusText: 'Загрузка приостановлена',
          }
        : null
    );
  };

  // Resume Upload
  const handleResumeUpload = async () => {
    if (!uploadTask) return;
    const task = uploadTask;
    isPausedRef.current = false;
    isCancelledRef.current = false;

    setUploadTask((prev) =>
      prev
        ? {
            ...prev,
            isPaused: false,
            error: null,
            statusText: 'Сверка прогресса с сервером...',
          }
        : null
    );

    try {
      const res = await fetch(`/api/rooms/${roomId}/upload/status/${task.fileId}`);
      if (res.ok) {
        const statusData = await res.json();
        const serverBytes = statusData.bytesUploaded || 0;
        setUploadTask((prev) =>
          prev
            ? {
                ...prev,
                bytesUploaded: serverBytes,
                statusText: 'Возобновление загрузки...',
              }
            : null
        );
        runChunkUploadLoop(task, serverBytes);
      } else {
        runChunkUploadLoop(task, task.bytesUploaded);
      }
    } catch {
      runChunkUploadLoop(task, task.bytesUploaded);
    }
  };

  // Cancel Upload and purge .part file from server disk
  const handleCancelUpload = async () => {
    isCancelledRef.current = true;
    abortControllerRef.current?.abort();
    const fileId = uploadTask?.fileId;

    setUploadTask(null);
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (fileId) {
      try {
        await fetch(`/api/rooms/${roomId}/upload/cancel/${fileId}`, {
          method: 'POST',
        });
      } catch (e) {
        console.error('Failed to cancel upload on server:', e);
      }
    }
  };

  // File Upload Handler (initiates 5MB Resumable Chunked Upload)
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || !isHost) return;
    const file = files[0];

    // Check for mkv/avi warnings
    const ext = file.name.split('.').pop()?.toLowerCase();
    const hasCodecWarn = ext === 'mkv' || ext === 'avi' || ext === 'wmv';

    if (hasCodecWarn) {
      setCodecWarning(
        'Внимание: Браузеры могут не поддерживать кодеки .mkv или .avi. Рекомендуется MP4 (H.264/AAC).'
      );
    } else {
      setCodecWarning(null);
    }

    const fileId = 'vid_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    const newTask: UploadTask = {
      file,
      fileId,
      bytesUploaded: 0,
      totalBytes: file.size,
      speedBps: 0,
      etaSeconds: 0,
      isPaused: false,
      statusText: 'Инициализация чанковой загрузки (5 МБ)...',
      retryCount: 0,
      error: null,
    };

    setUploadTask(newTask);
    runChunkUploadLoop(newTask, 0);
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

  const uploadPercent = uploadTask
    ? Math.min(100, Math.round((uploadTask.bytesUploaded / (uploadTask.totalBytes || 1)) * 100))
    : 0;

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
            disabled={Boolean(uploadTask)}
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

      {/* Resumable Chunked Upload Informative Card */}
      {uploadTask && (
        <div className="p-3 bg-neutral-950/95 border-b border-neutral-800 space-y-2.5 shadow-inner">
          {/* Top Row: File Name, Size progress, and Percentage */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="w-8 h-8 rounded-lg bg-neutral-900 border border-neutral-800 flex items-center justify-center text-rose-500 shrink-0">
                <Film className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="text-xs font-semibold text-neutral-200 truncate"
                  title={uploadTask.file.name}
                >
                  {uploadTask.file.name}
                </div>
                <div className="text-[11px] text-neutral-400 font-mono">
                  {formatBytes(uploadTask.bytesUploaded)} / {formatBytes(uploadTask.totalBytes)}
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <span className="font-mono font-bold text-sm text-rose-400">
                {uploadPercent}%
              </span>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="w-full h-2 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-200 ${
                uploadTask.isPaused
                  ? 'bg-amber-500'
                  : 'bg-gradient-to-r from-rose-600 via-amber-500 to-emerald-400'
              }`}
              style={{ width: `${uploadPercent}%` }}
            />
          </div>

          {/* Metrics & Actions Row: Speed, ETA, Status, Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              {/* Speed Badge */}
              <span className="px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-amber-300 font-mono flex items-center gap-1">
                <Zap className="w-3 h-3 text-amber-400" />
                {uploadTask.isPaused ? '0 КБ/с' : formatSpeed(uploadTask.speedBps)}
              </span>

              {/* ETA Badge */}
              <span className="px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-300 font-mono flex items-center gap-1">
                <Clock className="w-3 h-3 text-neutral-400" />
                {uploadTask.isPaused ? 'Пауза' : formatEta(uploadTask.etaSeconds)}
              </span>

              {/* Status text */}
              <span className="text-neutral-400 text-[11px] truncate max-w-[120px] hidden sm:inline">
                {uploadTask.statusText}
              </span>
            </div>

            {/* Action Buttons: Pause / Resume & Cancel */}
            <div className="flex items-center gap-1.5 ml-auto">
              <button
                type="button"
                onClick={uploadTask.isPaused ? handleResumeUpload : handlePauseUpload}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow cursor-pointer ${
                  uploadTask.isPaused
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
                }`}
                title={uploadTask.isPaused ? 'Продолжить загрузку' : 'Приостановить загрузку'}
              >
                {uploadTask.isPaused ? (
                  <>
                    <Play className="w-3 h-3 text-emerald-200 fill-emerald-200" />
                    <span>Продолжить</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3 h-3 text-amber-300 fill-amber-300" />
                    <span>Пауза</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleCancelUpload}
                className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-rose-950/60 text-neutral-300 hover:text-rose-200 text-xs font-medium border border-neutral-700 hover:border-rose-800/80 transition flex items-center gap-1 cursor-pointer"
                title="Отменить загрузку и удалить временный файл"
              >
                <X className="w-3 h-3 text-rose-400" />
                <span>Отмена</span>
              </button>
            </div>
          </div>

          {/* Error notification if retries failed */}
          {uploadTask.error && (
            <div className="text-[11px] text-rose-400 bg-rose-950/40 border border-rose-900/60 p-1.5 rounded-lg">
              {uploadTask.error}
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
