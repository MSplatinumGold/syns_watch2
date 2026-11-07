import React, { useState, useRef } from 'react';
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
  X,
  Pause,
  RotateCcw,
} from 'lucide-react';
import type { PlaylistItem } from '../types/watchparty.ts';
import { formatBytes, formatTime } from '../utils/format.ts';

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

interface ActiveUpload {
  file: File;
  fileId: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  currentChunkIndex: number;
  uploadedBytes: number;
  status: 'uploading' | 'paused' | 'retrying' | 'error' | 'completed';
  speedBytesPerSec: number;
  etaSeconds: number;
  errorMessage?: string;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per slice

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
  const [activeUpload, setActiveUpload] = useState<ActiveUpload | null>(null);
  const activeUploadRef = useRef<ActiveUpload | null>(null);
  const isPausedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileQueueRef = useRef<File[]>([]);

  const [codecWarning, setCodecWarning] = useState<string | null>(null);
  const [isAddingSample, setIsAddingSample] = useState(false);

  // Process next file in queue
  const processNextFile = () => {
    if (fileQueueRef.current.length === 0) {
      setActiveUpload(null);
      activeUploadRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const file = fileQueueRef.current.shift()!;
    const fileId = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const newUpload: ActiveUpload = {
      file,
      fileId,
      fileName: file.name,
      totalSize: file.size,
      totalChunks,
      currentChunkIndex: 0,
      uploadedBytes: 0,
      status: 'uploading',
      speedBytesPerSec: 0,
      etaSeconds: 0,
    };

    isPausedRef.current = false;
    setActiveUpload(newUpload);
    activeUploadRef.current = newUpload;

    runUploadLoop(newUpload, 0);
  };

  // Run sequential chunk upload loop with pause/resume and auto-retry
  const runUploadLoop = async (uploadData: ActiveUpload, startChunk: number) => {
    let currentSpeed = uploadData.speedBytesPerSec || 0;
    const file = uploadData.file;
    const totalChunks = uploadData.totalChunks;
    const fileId = uploadData.fileId;
    const fileName = uploadData.fileName;
    const totalSize = uploadData.totalSize;

    for (let index = startChunk; index < totalChunks; index++) {
      if (isPausedRef.current) {
        setActiveUpload((prev) => (prev ? { ...prev, status: 'paused' } : null));
        return;
      }

      const startByte = index * CHUNK_SIZE;
      const endByte = Math.min(totalSize, startByte + CHUNK_SIZE);
      const chunkBlob = file.slice(startByte, endByte);

      const formData = new FormData();
      formData.append('chunk', chunkBlob, 'chunk.bin');
      formData.append('fileId', fileId);
      formData.append('fileName', fileName);
      formData.append('chunkIndex', index.toString());
      formData.append('totalChunks', totalChunks.toString());
      formData.append('startByte', startByte.toString());
      formData.append('totalSize', totalSize.toString());
      formData.append('token', hostToken);
      formData.append('socketId', socketId);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let success = false;
      let attempt = 0;
      const maxAttempts = 3;

      while (!success && attempt < maxAttempts) {
        if (isPausedRef.current) {
          setActiveUpload((prev) => (prev ? { ...prev, status: 'paused' } : null));
          return;
        }

        attempt++;
        const chunkStartTime = performance.now();

        try {
          const res = await fetch(`/api/rooms/${roomId}/upload/chunk`, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
            headers: {
              'x-host-token': hostToken,
              'x-socket-id': socketId,
            },
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || `Код ответа ${res.status}`);
          }

          const data = await res.json();
          success = true;

          // Speed & ETA calculation
          const durationSec = Math.max(0.05, (performance.now() - chunkStartTime) / 1000);
          const chunkSpeed = chunkBlob.size / durationSec;
          currentSpeed = currentSpeed > 0 ? currentSpeed * 0.7 + chunkSpeed * 0.3 : chunkSpeed;

          const uploadedSoFar = endByte;
          const remainingBytes = Math.max(0, totalSize - uploadedSoFar);
          const eta = currentSpeed > 0 ? Math.round(remainingBytes / currentSpeed) : 0;

          const updated: ActiveUpload = {
            ...uploadData,
            currentChunkIndex: index + 1,
            uploadedBytes: uploadedSoFar,
            speedBytesPerSec: Math.round(currentSpeed),
            etaSeconds: eta,
            status: data.isCompleted ? 'completed' : 'uploading',
          };

          activeUploadRef.current = updated;
          setActiveUpload(updated);

          if (data.isCompleted) {
            setTimeout(() => {
              processNextFile();
            }, 600);
            return;
          }
        } catch (err: any) {
          if (err.name === 'AbortError') {
            return;
          }

          console.warn(`[Upload] Сбой чанка ${index}, попытка ${attempt}/${maxAttempts}:`, err);
          if (attempt < maxAttempts) {
            setActiveUpload((prev) => (prev ? { ...prev, status: 'retrying' } : null));
            await new Promise((r) => setTimeout(r, 1200));
          } else {
            setActiveUpload((prev) =>
              prev ? { ...prev, status: 'error', errorMessage: err?.message || 'Сбой соединения' } : null
            );
            return;
          }
        }
      }
    }
  };

  // Pause in-flight upload
  const handlePauseUpload = () => {
    isPausedRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setActiveUpload((prev) => (prev ? { ...prev, status: 'paused' } : null));
  };

  // Resume paused upload
  const handleResumeUpload = async () => {
    const cur = activeUploadRef.current;
    if (!cur) return;

    isPausedRef.current = false;
    setActiveUpload((prev) => (prev ? { ...prev, status: 'uploading', errorMessage: undefined } : null));

    try {
      const res = await fetch(`/api/rooms/${roomId}/upload/status/${cur.fileId}`);
      if (res.ok) {
        const data = await res.json();
        const uploadedBytes = data.uploadedBytes || 0;
        const resumeChunk = Math.floor(uploadedBytes / CHUNK_SIZE);
        const updated = {
          ...cur,
          currentChunkIndex: resumeChunk,
          uploadedBytes: resumeChunk * CHUNK_SIZE,
          status: 'uploading' as const,
        };
        activeUploadRef.current = updated;
        setActiveUpload(updated);
        runUploadLoop(updated, resumeChunk);
        return;
      }
    } catch (e) {
      console.warn('Не удалось запросить статус с сервера, продолжаем локально:', e);
    }

    runUploadLoop(cur, cur.currentChunkIndex);
  };

  // Cancel in-flight upload and remove temporary file from server
  const handleCancelUpload = async () => {
    const cur = activeUploadRef.current;
    isPausedRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (cur) {
      try {
        await fetch(`/api/rooms/${roomId}/upload/cancel/${cur.fileId}`, {
          method: 'POST',
        });
      } catch (e) {
        // ignore
      }
    }

    setActiveUpload(null);
    activeUploadRef.current = null;
    fileQueueRef.current = [];
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // File selection entry point
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || !isHost) return;

    let hasCodecWarn = false;
    for (let i = 0; i < files.length; i++) {
      const ext = files[i].name.split('.').pop()?.toLowerCase();
      if (ext === 'mkv' || ext === 'avi' || ext === 'wmv') {
        hasCodecWarn = true;
      }
    }

    setCodecWarning(
      hasCodecWarn
        ? 'Внимание: Браузеры могут не поддерживать кодеки .mkv или .avi. Рекомендуется MP4 (H.264/AAC).'
        : null
    );

    const fileList = Array.from(files);
    fileQueueRef.current = fileList;
    processNextFile();
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
            disabled={Boolean(activeUpload && activeUpload.status === 'uploading')}
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

      {/* Resumable Chunked Upload Status Card */}
      {activeUpload && (
        <div className="p-3 bg-neutral-950/90 border-b border-neutral-800">
          <div className="flex items-center justify-between text-xs text-neutral-200 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              {activeUpload.status === 'uploading' && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500 shrink-0" />
              )}
              {activeUpload.status === 'paused' && (
                <Pause className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              {activeUpload.status === 'retrying' && (
                <RotateCcw className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
              )}
              {activeUpload.status === 'error' && (
                <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
              )}
              {activeUpload.status === 'completed' && (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              )}

              <span className="font-medium truncate max-w-[130px] md:max-w-[170px]" title={activeUpload.fileName}>
                {activeUpload.fileName}
              </span>
            </div>

            {/* Action Buttons: Pause, Resume, Retry, Cancel */}
            <div className="flex items-center gap-1.5 shrink-0">
              {activeUpload.status === 'uploading' && (
                <button
                  type="button"
                  onClick={handlePauseUpload}
                  className="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[11px] font-medium border border-neutral-700 transition flex items-center gap-1 cursor-pointer"
                  title="Поставить загрузку на паузу"
                >
                  <Pause className="w-3 h-3 text-amber-400" />
                  <span>Пауза</span>
                </button>
              )}

              {activeUpload.status === 'paused' && (
                <button
                  type="button"
                  onClick={handleResumeUpload}
                  className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[11px] font-medium border border-amber-500/40 transition flex items-center gap-1 cursor-pointer"
                  title="Возобновить передачу файла"
                >
                  <Play className="w-3 h-3 fill-amber-300" />
                  <span>Продолжить</span>
                </button>
              )}

              {activeUpload.status === 'error' && (
                <button
                  type="button"
                  onClick={handleResumeUpload}
                  className="px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[11px] font-medium border border-rose-500/40 transition flex items-center gap-1 cursor-pointer"
                  title="Повторить загрузку"
                >
                  <RotateCcw className="w-3 h-3 text-rose-400" />
                  <span>Повторить</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleCancelUpload}
                className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-rose-950/60 text-neutral-400 hover:text-rose-300 text-[11px] font-medium border border-neutral-700 transition cursor-pointer"
                title="Отменить загрузку"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Progress Bar */}
          {(() => {
            const percent =
              activeUpload.totalSize > 0
                ? Math.min(100, Math.round((activeUpload.uploadedBytes / activeUpload.totalSize) * 100))
                : 0;
            return (
              <>
                <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden mb-1.5">
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${
                      activeUpload.status === 'paused'
                        ? 'bg-amber-500'
                        : activeUpload.status === 'error'
                        ? 'bg-rose-600'
                        : 'bg-gradient-to-r from-rose-600 via-amber-500 to-emerald-400'
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                {/* Metrics Row */}
                <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono">
                  <span>
                    {formatBytes(activeUpload.uploadedBytes)} / {formatBytes(activeUpload.totalSize)} ({percent}%)
                  </span>

                  {activeUpload.status === 'uploading' && (
                    <span className="text-neutral-300">
                      {(activeUpload.speedBytesPerSec / (1024 * 1024)).toFixed(1)} МБ/с
                      {activeUpload.etaSeconds > 0 && ` • ~${formatTime(activeUpload.etaSeconds)}`}
                    </span>
                  )}
                  {activeUpload.status === 'paused' && (
                    <span className="text-amber-400">
                      Пауза ({activeUpload.currentChunkIndex}/{activeUpload.totalChunks})
                    </span>
                  )}
                  {activeUpload.status === 'retrying' && (
                    <span className="text-amber-400">Повтор соединения...</span>
                  )}
                  {activeUpload.status === 'error' && (
                    <span className="text-rose-400">Сбой передачи</span>
                  )}
                </div>
              </>
            );
          })()}
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
