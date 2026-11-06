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
} from 'lucide-react';
import type { PlaylistItem } from '../types/watchparty.ts';
import { formatBytes } from '../utils/format.ts';

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
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [codecWarning, setCodecWarning] = useState<string | null>(null);
  const [isAddingSample, setIsAddingSample] = useState(false);

  // Cancel in-flight upload
  const handleCancelUpload = () => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    setIsUploading(false);
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // File Upload Handler with XMLHttpRequest for real progress bar
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || !isHost) return;

    // Check for mkv/avi warnings
    let hasCodecWarn = false;
    for (let i = 0; i < files.length; i++) {
      const ext = files[i].name.split('.').pop()?.toLowerCase();
      if (ext === 'mkv' || ext === 'avi' || ext === 'wmv') {
        hasCodecWarn = true;
      }
    }

    if (hasCodecWarn) {
      setCodecWarning(
        'Внимание: Браузеры могут не поддерживать кодеки .mkv или .avi. Рекомендуется MP4 (H.264/AAC).'
      );
    } else {
      setCodecWarning(null);
    }

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('videos', files[i]);
    }
    formData.append('token', hostToken);
    formData.append('socketId', socketId);

    setIsUploading(true);
    setUploadProgress(0);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', `/api/rooms/${roomId}/upload`);
    xhr.setRequestHeader('x-host-token', hostToken);
    xhr.setRequestHeader('x-socket-id', socketId);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(percent);
      }
    };

    xhr.onload = () => {
      setIsUploading(false);
      setUploadProgress(0);
      xhrRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (xhr.status >= 200 && xhr.status < 300) {
        // Successful upload, socket event will update playlist
      } else {
        alert('Ошибка при загрузке: ' + xhr.responseText);
      }
    };

    xhr.onabort = () => {
      setIsUploading(false);
      setUploadProgress(0);
      xhrRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    };

    xhr.onerror = () => {
      setIsUploading(false);
      setUploadProgress(0);
      xhrRef.current = null;
      alert('Сетевая ошибка при загрузке файла');
    };

    xhr.send(formData);
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
            disabled={isUploading}
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

      {/* Upload Progress Bar */}
      {isUploading && (
        <div className="p-3 bg-neutral-950/80 border-b border-neutral-800">
          <div className="flex items-center justify-between text-xs text-neutral-300 mb-1.5">
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500" />
              Загрузка на сервер...
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-rose-400">{uploadProgress}%</span>
              <button
                type="button"
                onClick={handleCancelUpload}
                className="px-2 py-0.5 rounded bg-neutral-800 hover:bg-rose-900/60 text-neutral-300 hover:text-rose-200 text-[11px] font-medium border border-neutral-700 transition flex items-center gap-1 cursor-pointer"
                title="Отменить загрузку файла"
              >
                <X className="w-3 h-3 text-rose-400" />
                <span>Отменить</span>
              </button>
            </div>
          </div>
          <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-rose-600 to-amber-500 rounded-full transition-all duration-150"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
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
