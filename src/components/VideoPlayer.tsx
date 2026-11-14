import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Zap,
  Clock,
  MessageSquare,
  Loader2,
  Film,
  AlertCircle,
  RotateCcw,
  Gauge,
  UploadCloud,
  PanelRightClose,
  PanelRightOpen,
  Download,
  CheckCircle2,
} from 'lucide-react';
import type {
  PlaylistItem,
  RoomPlaybackState,
  DanmakuItem,
  FloatingEmojiItem,
} from '../types/watchparty.ts';
import { formatTime, parseTime } from '../utils/format.ts';
import { DanmakuOverlay, FloatingEmojisOverlay } from './DanmakuOverlay.tsx';

interface VideoPlayerProps {
  currentTrack: PlaylistItem | undefined;
  playlist: PlaylistItem[];
  currentTrackIndex: number;
  isHost: boolean;
  playbackState: RoomPlaybackState;
  bufferingUsers: string[];
  danmakuItems: DanmakuItem[];
  floatingEmojis?: FloatingEmojiItem[];
  isTheaterMode?: boolean;
  clockOffsetMs?: number;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
  onSeek: (targetTime: number) => void;
  onForcePlay: () => void;
  onBufferingStart: () => void;
  onBufferingEnd: () => void;
  onTrackEnded: () => void;
  onProgressReport?: (currentTime: number) => void;
  onTriggerUpload?: () => void;
  onToggleTheater?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  currentTrack,
  playlist,
  currentTrackIndex,
  isHost,
  playbackState,
  bufferingUsers,
  danmakuItems,
  floatingEmojis = [],
  isTheaterMode,
  clockOffsetMs = 0,
  onPlay,
  onPause,
  onSeek,
  onForcePlay,
  onBufferingStart,
  onBufferingEnd,
  onTrackEnded,
  onProgressReport,
  onTriggerUpload,
  onToggleTheater,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekbarRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isDraggingSeekRef = useRef(false);
  const lastProgressReportRef = useRef<number>(0);

  // Sync reference anchor: { currentTime, serverTimestamp }
  const syncAnchorRef = useRef<{ currentTime: number; serverTimestamp: number }>({
    currentTime: playbackState.currentTime,
    serverTimestamp: playbackState.lastUpdatedServerTime,
  });

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [danmakuEnabled, setDanmakuEnabled] = useState(true);
  const [exactTimeInput, setExactTimeInput] = useState('');
  const [timeInputError, setTimeInputError] = useState('');
  const [hoverSeekTime, setHoverSeekTime] = useState<number | null>(null);
  const [hoverSeekPos, setHoverSeekPos] = useState(0);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [scrubbingTime, setScrubbingTime] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageDimensions, setStageDimensions] = useState<{ width: number; height: number } | null>(null);

  // Item 2: Preload entire video in advance into browser memory / blob
  const [preloadProgress, setPreloadProgress] = useState<number | null>(null);
  const [isFullyPreloaded, setIsFullyPreloaded] = useState(false);
  const [preloadedBlobUrl, setPreloadedBlobUrl] = useState<string | null>(null);
  const [bufferAheadSeconds, setBufferAheadSeconds] = useState(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const preloadControllerRef = useRef<AbortController | null>(null);
  const clockOffsetRef = useRef(clockOffsetMs);
  clockOffsetRef.current = clockOffsetMs;
  const lastHardSeekAtRef = useRef(0);

  const getServerNow = useCallback(() => Date.now() + clockOffsetRef.current, []);

  const safePlay = useCallback((video: HTMLVideoElement) => {
    video
      .play()
      .then(() => {
        setAutoplayBlocked(false);
      })
      .catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          setAutoplayBlocked(true);
        }
      });
  }, []);

  // Compute maximum 16:9 viewport fit to eliminate dead black space on large screens (WQHD/4K/PC)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const targetRatio = 16 / 9;
        const currentRatio = rect.width / rect.height;
        if (currentRatio > targetRatio) {
          // Stage is wider than 16:9 -> player fills 100% of available height
          const h = Math.floor(rect.height);
          const w = Math.floor(h * targetRatio);
          setStageDimensions({ width: w, height: h });
        } else {
          // Stage is narrower than 16:9 -> player fills 100% of available width
          const w = Math.floor(rect.width);
          const h = Math.floor(w / targetRatio);
          setStageDimensions({ width: w, height: h });
        }
      }
    };

    updateSize();
    const ro = new ResizeObserver(() => updateSize());
    ro.observe(el);
    window.addEventListener('resize', updateSize);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  // Keep sync anchor updated when playbackState changes from server
  useEffect(() => {
    syncAnchorRef.current = {
      currentTime: playbackState.currentTime,
      serverTimestamp: playbackState.lastUpdatedServerTime,
    };
  }, [playbackState.currentTime, playbackState.lastUpdatedServerTime]);

  // Video source handling: prioritizes local preloaded blob if available, else network stream URL
  const videoSourceUrl = preloadedBlobUrl || currentTrack?.url;

  // Track changed -> Immediately reset timecode, buffer, and cached blob
  useEffect(() => {
    setCurrentTime(0);
    setBufferedPercent(0);
    setBufferAheadSeconds(0);
    setScrubbingTime(null);
    setIsFullyPreloaded(false);
    setPreloadProgress(null);
    if (preloadedBlobUrl) {
      URL.revokeObjectURL(preloadedBlobUrl);
      setPreloadedBlobUrl(null);
    }
    if (preloadControllerRef.current) {
      preloadControllerRef.current.abort();
      preloadControllerRef.current = null;
    }
    setAutoplayBlocked(false);
    syncAnchorRef.current = {
      currentTime: 0,
      serverTimestamp: getServerNow(),
    };
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
    }
  }, [currentTrack?.id, currentTrackIndex, getServerNow]);

  // Handler to preload full video in advance into browser memory (Item 2)
  const handlePreloadFullVideo = async () => {
    const rawUrl = currentTrack?.url;
    if (!rawUrl || preloadProgress !== null || isFullyPreloaded) return;

    setPreloadProgress(0);
    const controller = new AbortController();
    preloadControllerRef.current = controller;

    try {
      const res = await fetch(rawUrl, {
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const total = parseInt(
        res.headers.get('content-length') || `${currentTrack?.size || 0}`,
        10
      );
      const reader = res.body?.getReader();
      if (!reader) throw new Error('ReadableStream not supported');

      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.length;
          if (total > 0) {
            const pct = Math.min(100, Math.round((loaded / total) * 100));
            setPreloadProgress(pct);
          }
        }
      }

      const mime = currentTrack?.mimeType || 'video/mp4';
      const blob = new Blob(chunks as unknown as BlobPart[], { type: mime });
      const blobUrl = URL.createObjectURL(blob);

      setPreloadedBlobUrl(blobUrl);
      setIsFullyPreloaded(true);
      setPreloadProgress(null);

      // Seamlessly switch video source without losing playback position
      if (videoRef.current) {
        const curTime = videoRef.current.currentTime;
        const wasPlaying = !videoRef.current.paused;
        videoRef.current.src = blobUrl;
        videoRef.current.currentTime = curTime;
        if (wasPlaying) {
          videoRef.current.play().catch(() => {});
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Full video preload error:', err);
      }
      setPreloadProgress(null);
    }
  };

  // Monitor native browser video buffer without any phantom network requests (Option 1)
  useEffect(() => {
    if (!videoSourceUrl) return;

    const bufferCheckInterval = setInterval(() => {
      const video = videoRef.current;
      if (!video || !duration || duration <= 0) return;

      if (isFullyPreloaded) {
        setBufferAheadSeconds(duration);
        return;
      }

      // Read native HTMLMediaElement buffer ahead of current playhead
      let ahead = 0;
      const cur = video.currentTime;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= cur && cur <= video.buffered.end(i)) {
          ahead = Math.max(0, video.buffered.end(i) - cur);
          break;
        }
      }
      setBufferAheadSeconds(ahead);
    }, 1000);

    return () => clearInterval(bufferCheckInterval);
  }, [videoSourceUrl, duration, isFullyPreloaded]);

  // Track Ended -> Host trigger auto next or pause if last track (Item 1)
  const handleEnded = useCallback(() => {
    if (isHost) {
      if (currentTrackIndex < playlist.length - 1) {
        onTrackEnded();
      } else {
        // Last video in playlist ended! Pause and wait for new video
        if (duration > 0) {
          onPause(duration);
        }
      }
    }
  }, [isHost, currentTrackIndex, playlist.length, duration, onTrackEnded, onPause]);

  // Smart buffer margin check (Item 2: avoid micro-stalls if healthy buffer margin is present)
  const handleBufferingCheck = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    let bufferAhead = 0;
    const cur = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= cur && cur <= video.buffered.end(i)) {
        bufferAhead = video.buffered.end(i) - cur;
        break;
      }
    }
    // Only pause if buffer ahead is genuinely starved (< 0.5s)
    if (bufferAhead < 0.5) {
      onBufferingStart();
    }
  }, [onBufferingStart]);

  // Sync bus drift correction loop (spec 4.1 & item 7: 1.05x / 0.95x smooth adjustment)
  useEffect(() => {
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video || !videoSourceUrl || video.readyState < 2) return;
      if (isDraggingSeekRef.current || video.seeking) return; // Never fight host drag or active keyframe seek

      const { isPlaying, isSystemPausedForBuffering } = playbackState;

      // If video should be paused
      if (!isPlaying || isSystemPausedForBuffering) {
        if (!video.paused) {
          video.pause();
        }
        setAutoplayBlocked(false);
        if (playbackRate !== 1.0) setPlaybackRate(1.0);
        return;
      }

      // Video should be playing
      if (video.paused && !autoplayBlocked) {
        safePlay(video);
      }

      // Calculate expected time using clock-offset-corrected server time (fixes PC clock skew 0.0-1.0s loop)
      const elapsedSinceServerUpdate = Math.max(
        0,
        (getServerNow() - syncAnchorRef.current.serverTimestamp) / 1000
      );
      const expectedTime = Math.max(0, syncAnchorRef.current.currentTime + elapsedSinceServerUpdate);
      const delta = Math.abs(video.currentTime - expectedTime);

      // Hard jump if lag/drift is high (> 1.5s) with 1.2s cooldown so slow decoders don't stutter-loop
      if (delta > 1.5) {
        const now = Date.now();
        if (now - lastHardSeekAtRef.current > 1200) {
          lastHardSeekAtRef.current = now;
          video.currentTime = expectedTime;
        }
        video.playbackRate = 1.0;
        setPlaybackRate(1.0);
      }
      // Smooth catch-up / slow-down if slightly drifted (0.15s - 1.5s)
      else if (delta > 0.15) {
        const rate = video.currentTime < expectedTime ? 1.05 : 0.95;
        video.playbackRate = rate;
        setPlaybackRate(rate);
      }
      // Perfectly in sync (<= 0.15s)
      else {
        if (video.playbackRate !== 1.0) {
          video.playbackRate = 1.0;
          setPlaybackRate(1.0);
        }
      }
    }, 350);

    return () => clearInterval(interval);
  }, [playbackState, videoSourceUrl, playbackRate, autoplayBlocked, getServerNow, safePlay]);

  // Direct sync action on playbackState change (immediate pause/play/seek)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSourceUrl || isDraggingSeekRef.current) return;

    if (!playbackState.isPlaying || playbackState.isSystemPausedForBuffering) {
      if (!video.paused) {
        video.pause();
      }
      setAutoplayBlocked(false);
      if (Math.abs(video.currentTime - playbackState.currentTime) > 0.5 && video.readyState >= 1) {
        lastHardSeekAtRef.current = Date.now();
        video.currentTime = playbackState.currentTime;
        setCurrentTime(playbackState.currentTime);
      }
    } else {
      const elapsed = Math.max(0, (getServerNow() - syncAnchorRef.current.serverTimestamp) / 1000);
      const target = Math.max(0, syncAnchorRef.current.currentTime + elapsed);
      if (video.paused) {
        if (Math.abs(video.currentTime - target) > 0.5) {
          lastHardSeekAtRef.current = Date.now();
          video.currentTime = target;
        }
        safePlay(video);
      } else if (Math.abs(video.currentTime - target) > 1.5 && video.readyState >= 1) {
        lastHardSeekAtRef.current = Date.now();
        video.currentTime = target;
      }
    }
  }, [
    playbackState.isPlaying,
    playbackState.isSystemPausedForBuffering,
    playbackState.currentTime,
    playbackState.lastUpdatedServerTime,
    videoSourceUrl,
    getServerNow,
    safePlay,
  ]);

  // Buffer calculation
  const updateBuffer = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;

    const current = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= current && current <= video.buffered.end(i)) {
        setBufferedPercent((video.buffered.end(i) / video.duration) * 100);
        return;
      }
    }
  }, []);

  // Update current time display and report progress to server
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    if (!isDraggingSeekRef.current) {
      setCurrentTime(video.currentTime);
    }
    updateBuffer();

    // Report progress to other users every ~2 seconds to save WebSocket traffic
    const now = Date.now();
    if (now - lastProgressReportRef.current > 2000 && onProgressReport) {
      lastProgressReportRef.current = now;
      onProgressReport(video.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setVideoError(null);

    // Apply volume
    video.volume = volume;
    video.muted = isMuted;

    // Apply target start time corrected for server elapsed time
    const elapsed =
      playbackState.isPlaying && !playbackState.isSystemPausedForBuffering
        ? Math.max(0, (getServerNow() - syncAnchorRef.current.serverTimestamp) / 1000)
        : 0;
    const initialTarget = Math.max(0, syncAnchorRef.current.currentTime + elapsed);

    if (initialTarget > 0) {
      lastHardSeekAtRef.current = Date.now();
      video.currentTime = initialTarget;
      setCurrentTime(initialTarget);
    } else {
      video.currentTime = 0;
      setCurrentTime(0);
    }

    if (playbackState.isPlaying && !playbackState.isSystemPausedForBuffering) {
      safePlay(video);
    }
  };

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch((err) => {
        console.error('Fullscreen error:', err);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Controls auto-hide on idle
  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (playbackState.isPlaying && !playbackState.isSystemPausedForBuffering && !isDraggingSeekRef.current) {
        setShowControls(false);
      }
    }, 3500);
  };

  // Volume change
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
    }
    setIsMuted(val === 0);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    video.muted = nextMuted;
    if (!nextMuted && volume === 0) {
      setVolume(0.5);
      video.volume = 0.5;
    }
  };

  // Host Play/Pause toggle
  const handleTogglePlay = () => {
    if (!isHost) return;
    const video = videoRef.current;
    const current = video ? video.currentTime : currentTime;

    if (playbackState.isPlaying) {
      onPause(current);
    } else {
      onPlay(current);
    }
  };

  // ---------------------------------------------------------------------------
  // Smooth Scrubbing / Dragging on Seekbar (Item 5)
  // ---------------------------------------------------------------------------
  const calculateTargetTimeFromEvent = (e: MouseEvent | React.MouseEvent) => {
    if (!seekbarRef.current || !duration) return 0;
    const rect = seekbarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percent = x / rect.width;
    return percent * duration;
  };

  const handleSeekbarMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isHost || !duration) return;
    isDraggingSeekRef.current = true;
    const target = calculateTargetTimeFromEvent(e);
    setScrubbingTime(target);
    setCurrentTime(target);
    setHoverSeekTime(target);

    const rect = seekbarRef.current?.getBoundingClientRect();
    if (rect) {
      setHoverSeekPos(Math.max(0, Math.min(e.clientX - rect.left, rect.width)));
    }

    if (videoRef.current) {
      videoRef.current.currentTime = target;
    }
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDraggingSeekRef.current || !duration || !seekbarRef.current) return;
      const rect = seekbarRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const target = (x / rect.width) * duration;

      setScrubbingTime(target);
      setCurrentTime(target);
      setHoverSeekTime(target);
      setHoverSeekPos(x);

      if (videoRef.current) {
        videoRef.current.currentTime = target;
      }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (isDraggingSeekRef.current) {
        isDraggingSeekRef.current = false;
        if (duration && seekbarRef.current) {
          const rect = seekbarRef.current.getBoundingClientRect();
          const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
          const finalTarget = (x / rect.width) * duration;

          if (videoRef.current) {
            videoRef.current.currentTime = finalTarget;
          }
          setCurrentTime(finalTarget);
          onSeek(finalTarget);
        }
        setScrubbingTime(null);
        setHoverSeekTime(null);
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [duration, onSeek]);

  const handleSeekbarHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || !seekbarRef.current) return;
    const rect = seekbarRef.current.getBoundingClientRect();
    const hoverX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percent = hoverX / rect.width;
    setHoverSeekTime(percent * duration);
    setHoverSeekPos(hoverX);
  };

  // Host Exact Time Input Apply
  const handleApplyExactTime = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isHost) return;

    setTimeInputError('');
    const parsed = parseTime(exactTimeInput);

    if (parsed === null) {
      setTimeInputError('Формат: ЧЧ:ММ:СС или ММ:СС (например 01:24:10 или 12:30)');
      return;
    }

    if (duration > 0 && parsed > duration) {
      setTimeInputError(`Время превышает длительность (${formatTime(duration)})`);
      return;
    }

    if (videoRef.current) {
      videoRef.current.currentTime = parsed;
    }
    setCurrentTime(parsed);
    onSeek(parsed);
    setExactTimeInput('');
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (isHost) handleTogglePlay();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        toggleMute();
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === 'ArrowLeft' && isHost) {
        e.preventDefault();
        const target = Math.max(0, currentTime - 5);
        if (videoRef.current) videoRef.current.currentTime = target;
        setCurrentTime(target);
        onSeek(target);
      } else if (e.code === 'ArrowRight' && isHost) {
        e.preventDefault();
        const target = Math.min(duration, currentTime + 5);
        if (videoRef.current) videoRef.current.currentTime = target;
        setCurrentTime(target);
        onSeek(target);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHost, playbackState.isPlaying, currentTime, duration]);

  const displayTime = scrubbingTime !== null ? scrubbingTime : currentTime;
  const progressPercent = duration > 0 ? (displayTime / duration) * 100 : 0;

  return (
    <div
      ref={stageRef}
      className="w-full h-full flex items-center justify-center overflow-hidden min-h-0 min-w-0"
    >
      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        className="relative bg-neutral-950 rounded-2xl overflow-hidden shadow-2xl flex flex-col justify-center items-center select-none group border border-neutral-800 shrink-0 transition-[width,height] duration-150"
        style={
          isFullscreen
            ? { width: '100vw', height: '100vh', borderRadius: 0 }
            : stageDimensions
            ? {
                width: `${stageDimensions.width}px`,
                height: `${stageDimensions.height}px`,
                aspectRatio: '16/9',
              }
            : {
                width: '100%',
                maxHeight: '100%',
                aspectRatio: '16/9',
              }
        }
      >
      {/* Video Element or Empty State */}
      {videoSourceUrl ? (
        <video
          ref={videoRef}
          src={videoSourceUrl}
          preload="auto"
          playsInline
          className="w-full h-full object-contain"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onWaiting={handleBufferingCheck}
          onStalled={handleBufferingCheck}
          onCanPlay={onBufferingEnd}
          onPlaying={onBufferingEnd}
          onEnded={handleEnded}
          onError={() => {
            setVideoError(
              'Не удалось загрузить видео. Браузер может не поддерживать кодек или файл поврежден.'
            );
          }}
        />
      ) : (
        <div className="flex flex-col items-center justify-center p-2 sm:p-6 md:p-10 text-center max-w-xl">
          <div className="w-8 h-8 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-2xl sm:rounded-3xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-rose-500 shadow-xl mb-1 sm:mb-4">
            <Film className="w-4 h-4 sm:w-7 sm:h-7 md:w-8 md:h-8" />
          </div>
          <h3 className="text-xs sm:text-xl md:text-2xl font-bold text-white tracking-tight">
            Кинозал готов к просмотру
          </h3>
          <p className="hidden sm:block text-xs sm:text-sm text-neutral-400 mt-1.5 mb-5 max-w-md">
            {isHost
              ? 'Загрузите видеофайл с устройства, чтобы начать совместный просмотр'
              : 'Ожидание, пока хост запустит видеофайл или добавит фильм в плейлист...'}
          </p>

          {isHost && onTriggerUpload && (
            <div className="mt-2 sm:mt-0 flex flex-wrap items-center justify-center gap-2.5 w-full">
              <button
                onClick={onTriggerUpload}
                className="px-3 py-1.5 sm:px-4 sm:py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs md:text-sm font-semibold flex items-center gap-1.5 sm:gap-2 shadow-lg shadow-rose-600/30 transition transform active:scale-95 cursor-pointer"
              >
                <UploadCloud className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span>Выбрать видеофайл</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Autoplay Blocked Fallback Overlay */}
      {autoplayBlocked && videoSourceUrl && playbackState.isPlaying && !playbackState.isSystemPausedForBuffering && (
        <div className="absolute inset-0 bg-black/75 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center z-30">
          <button
            type="button"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              const elapsed = Math.max(0, (getServerNow() - syncAnchorRef.current.serverTimestamp) / 1000);
              video.currentTime = Math.max(0, syncAnchorRef.current.currentTime + elapsed);
              safePlay(video);
            }}
            className="px-4 py-2.5 sm:px-5 sm:py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs sm:text-sm shadow-2xl shadow-rose-600/40 flex items-center gap-2 cursor-pointer animate-pulse"
          >
            <Volume2 className="w-4 h-4 sm:w-5 sm:h-5" />
            <span>Нажмите, чтобы включить звук и синхронизироваться</span>
          </button>
        </div>
      )}

      {/* Danmaku & Floating Emojis Overlays */}
      <DanmakuOverlay items={danmakuItems} enabled={danmakuEnabled} />
      <FloatingEmojisOverlay items={floatingEmojis} />

      {/* Error state */}
      {videoError && (
        <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-6 text-center z-30">
          <AlertCircle className="w-12 h-12 text-rose-500 mb-2" />
          <h4 className="text-base font-semibold text-white">Ошибка воспроизведения</h4>
          <p className="text-sm text-neutral-400 max-w-md mt-1">{videoError}</p>
          <button
            onClick={() => {
              setVideoError(null);
              videoRef.current?.load();
            }}
            className="mt-4 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Попробовать снова
          </button>
        </div>
      )}

      {/* Buffering Barrier State Banner */}
      {playbackState.isSystemPausedForBuffering && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-amber-500/95 backdrop-blur-md text-neutral-950 font-semibold px-4 py-2 rounded-full shadow-2xl flex items-center gap-2.5 z-30 animate-pulse text-xs md:text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-neutral-950" />
          <span>
            Пауза: ожидание ({bufferingUsers.join(', ') || 'загрузка зрителей...'})
          </span>
          {isHost && (
            <button
              onClick={onForcePlay}
              className="ml-2 px-2.5 py-0.5 bg-neutral-950 text-amber-400 hover:bg-neutral-900 rounded-full text-xs font-bold transition flex items-center gap-1 cursor-pointer"
              title="Запустить немедленно для всех, отставшие подтянутся по дрифту"
            >
              <Zap className="w-3 h-3 fill-amber-400" /> Старт
            </button>
          )}
        </div>
      )}

      {/* Status Pill for Viewer */}
      {!isHost && videoSourceUrl && (
        <div className="absolute top-4 left-4 z-20 pointer-events-none flex items-center gap-2">
          <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-xs font-medium text-neutral-300 border border-white/10 shadow-lg">
            {playbackState.isSystemPausedForBuffering ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                <span className="text-amber-300">Буферизация...</span>
              </>
            ) : playbackState.isPlaying ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-300">В синхроне</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-neutral-400" />
                <span>Пауза</span>
              </>
            )}
          </div>

          {/* Smooth drift speed adjustment pill (Item 7) */}
          {playbackRate !== 1.0 && playbackState.isPlaying && (
            <div className="flex items-center gap-1 bg-amber-500/20 backdrop-blur-md border border-amber-500/40 text-amber-300 px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold animate-pulse">
              <Gauge className="w-3 h-3" />
              <span>{playbackRate === 1.05 ? '⚡ 1.05x догонка' : '🐢 0.95x подгонка'}</span>
            </div>
          )}
        </div>
      )}

      {/* Top Header Overlay with Title & Danmaku Toggle */}
      <div
        className={`absolute top-0 left-0 right-0 p-2 sm:p-4 bg-gradient-to-b from-black/80 via-black/30 to-transparent flex items-center justify-between z-20 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-2 overflow-hidden mr-4">
          <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse shrink-0" />
          <span className="text-xs md:text-sm font-medium text-white truncate drop-shadow">
            {currentTrack
              ? `${currentTrackIndex + 1}/${playlist.length}: ${currentTrack.originalName}`
              : 'SyncWatch Party'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setDanmakuEnabled(!danmakuEnabled)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition ${
              danmakuEnabled
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'bg-neutral-800/80 text-neutral-400 border border-neutral-700/50'
            }`}
            title="Отображение комментариев чата снизу экрана"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Экранный чат (снизу)</span>
          </button>
        </div>
      </div>

      {/* Main Bottom Controls (only when a video is loaded) */}
      {videoSourceUrl && (
      <div
        className={`absolute bottom-0 left-0 right-0 p-3 md:p-4 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-20 flex flex-col gap-2 transition-opacity duration-300 ${
          showControls || !playbackState.isPlaying || isDraggingSeekRef.current
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Smooth Seekbar Container with Drag Support (Item 5) */}
        <div
          ref={seekbarRef}
          onMouseDown={handleSeekbarMouseDown}
          onMouseMove={handleSeekbarHover}
          onMouseLeave={() => {
            if (!isDraggingSeekRef.current) setHoverSeekTime(null);
          }}
          className={`relative w-full h-3 group/seek flex items-center ${
            isHost ? 'cursor-pointer py-2' : 'cursor-default pointer-events-none'
          }`}
        >
          {/* Hover / Drag tooltip with timecode */}
          {isHost && hoverSeekTime !== null && (
            <div
              className="absolute -top-7 px-2 py-0.5 rounded bg-black/95 text-[11px] font-mono text-white shadow-xl border border-neutral-700 pointer-events-none -translate-x-1/2"
              style={{ left: `${hoverSeekPos}px` }}
            >
              {formatTime(hoverSeekTime)}
            </div>
          )}

          {/* Background track */}
          <div className="w-full h-1.5 group-hover/seek:h-2.5 bg-neutral-800 rounded-full overflow-hidden transition-all relative">
            {/* Buffered bar */}
            <div
              className="absolute top-0 bottom-0 left-0 bg-neutral-600/70 rounded-full transition-all duration-200"
              style={{ width: `${bufferedPercent}%` }}
            />
            {/* Current progress bar */}
            <div
              className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-rose-600 to-amber-500 rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Seek thumb (host only) */}
          {isHost && (
            <div
              className={`absolute w-4 h-4 bg-white rounded-full shadow-lg transform -translate-x-1/2 transition-transform pointer-events-none border border-neutral-300 ${
                isDraggingSeekRef.current ? 'scale-125' : 'scale-0 group-hover/seek:scale-100'
              }`}
              style={{ left: `${progressPercent}%` }}
            />
          )}
        </div>

        {/* Buttons and tools row */}
        <div className="flex items-center justify-between gap-3 text-white text-xs md:text-sm">
          {/* Left: Play/Pause, Time input, Volume */}
          <div className="flex items-center gap-3">
            {/* Play/Pause Button */}
            {isHost ? (
              <button
                onClick={handleTogglePlay}
                disabled={!videoSourceUrl}
                className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-white text-black flex items-center justify-center hover:bg-neutral-200 active:scale-95 transition shadow disabled:opacity-50 cursor-pointer"
                title={playbackState.isPlaying ? 'Пауза (Пробел)' : 'Воспроизведение (Пробел)'}
              >
                {playbackState.isPlaying ? (
                  <Pause className="w-4 h-4 fill-black" />
                ) : (
                  <Play className="w-4 h-4 fill-black ml-0.5" />
                )}
              </button>
            ) : (
              <div
                className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-neutral-800/80 text-neutral-400 flex items-center justify-center border border-neutral-700/60"
                title="Управление воспроизведением только у хоста"
              >
                {playbackState.isPlaying ? (
                  <Play className="w-3.5 h-3.5" />
                ) : (
                  <Pause className="w-3.5 h-3.5" />
                )}
              </div>
            )}

            {/* Time Display */}
            <div className="font-mono text-neutral-300 text-xs tracking-tight">
              <span className="text-white font-medium">{formatTime(displayTime)}</span>
              <span className="text-neutral-500 mx-1">/</span>
              <span>{formatTime(duration)}</span>
            </div>

            {/* Native Buffer / Cache Indicator */}
            {videoSourceUrl && duration > 0 && (
              <div
                className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-900/90 border border-neutral-700/60 text-[11px] font-mono"
                title={
                  isFullyPreloaded
                    ? 'Видео полностью сохранено в памяти браузера (0 сетевых запросов при просмотре)'
                    : bufferAheadSeconds > 0
                    ? `Нативный буфер браузера: +${Math.round(bufferAheadSeconds)} сек запаса (HTTP 206 стриминг)`
                    : 'Потоковое воспроизведение (HTTP 206)'
                }
              >
                <span className={isFullyPreloaded || bufferAheadSeconds >= 10 ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                  ⚡
                </span>
                <span className="text-neutral-400">
                  {isFullyPreloaded ? 'Кэш:' : 'Буфер:'}
                </span>
                <span className={isFullyPreloaded || bufferAheadSeconds >= 10 ? 'text-emerald-300 font-semibold' : 'text-amber-300 font-semibold'}>
                  {isFullyPreloaded
                    ? '100%'
                    : bufferAheadSeconds >= 60
                    ? `+${Math.floor(bufferAheadSeconds / 60)}:${Math.floor(bufferAheadSeconds % 60).toString().padStart(2, '0')}`
                    : `+${Math.round(bufferAheadSeconds)}с`}
                </span>
              </div>
            )}

            {/* Volume Control (hidden on mobile phones to preserve space for controls) */}
            <div className="hidden sm:flex items-center gap-1.5 group/vol">
              <button
                onClick={toggleMute}
                className="p-1.5 rounded-lg hover:bg-white/10 text-neutral-300 hover:text-white transition cursor-pointer"
                title={isMuted ? 'Включить звук (M)' : 'Выключить звук (M)'}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-rose-400" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-16 md:w-20 accent-rose-500 h-1 bg-neutral-700 rounded-lg cursor-pointer"
              />
            </div>
          </div>

          {/* Right: Force Play, Precise Timing block, Fullscreen */}
          <div className="flex items-center gap-2">
            {/* Host: Force Play override */}
            {isHost && (
              <button
                onClick={onForcePlay}
                className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                title="Снять буферную паузу и запустить принудительно для всех"
              >
                <Zap className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span className="hidden sm:inline">Force Play</span>
              </button>
            )}

            {/* Host: Exact Time Jump Input Form */}
            {isHost && (
              <form onSubmit={handleApplyExactTime} className="hidden md:flex items-center gap-1">
                <div className="relative">
                  <input
                    type="text"
                    placeholder="ЧЧ:ММ:СС"
                    value={exactTimeInput}
                    onChange={(e) => {
                      setExactTimeInput(e.target.value);
                      setTimeInputError('');
                    }}
                    className="w-24 bg-neutral-900/90 border border-neutral-700 focus:border-amber-500 text-neutral-200 text-xs rounded-lg px-2 py-1 font-mono outline-none transition"
                  />
                  {timeInputError && (
                    <div className="absolute bottom-full mb-1 left-0 bg-rose-900/95 border border-rose-700 text-rose-200 text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap z-50">
                      {timeInputError}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg text-xs font-medium border border-neutral-700 transition cursor-pointer"
                  title="Перейти к указанному таймкоду (Enter)"
                >
                  <Clock className="w-3 h-3" />
                </button>
              </form>
            )}

            {/* Full Video Preload Button (Item 2: Загрузить всё видео сразу в память) */}
            {videoSourceUrl && (
              <>
                {isFullyPreloaded ? (
                  <div
                    className="px-2 py-1 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-xs font-medium flex items-center gap-1.5"
                    title="Видео загружено целиком в локальную память браузера. Поток не докачивается при просмотре."
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="hidden md:inline">В кэше 100%</span>
                  </div>
                ) : preloadProgress !== null ? (
                  <div
                    className="px-2.5 py-1 rounded-lg bg-neutral-900 border border-neutral-700 text-xs font-mono text-amber-300 flex items-center gap-1.5"
                    title="Идет полная предзагрузка видео в кэш браузера..."
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                    <span>{preloadProgress}%</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handlePreloadFullVideo}
                    className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white border border-neutral-700 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
                    title="Загрузить видео целиком в память браузера сразу, чтобы не докачивать поток во время просмотра"
                  >
                    <Download className="w-3.5 h-3.5 text-rose-400" />
                    <span className="hidden md:inline">Предзагрузить всё</span>
                  </button>
                )}
              </>
            )}

            {/* Theater Mode Toggle (Hide/Show sidebar on PC) */}
            {onToggleTheater && (
              <button
                type="button"
                onClick={onToggleTheater}
                className="p-1.5 rounded-lg hover:bg-white/10 text-neutral-300 hover:text-white transition cursor-pointer hidden md:flex"
                title={isTheaterMode ? 'Свернуть театр (показать панель)' : 'Широкий экран (скрыть панель)'}
              >
                {isTheaterMode ? (
                  <PanelRightOpen className="w-4 h-4 text-amber-400" />
                ) : (
                  <PanelRightClose className="w-4 h-4" />
                )}
              </button>
            )}

            {/* Fullscreen Toggle */}
            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg hover:bg-white/10 text-neutral-300 hover:text-white transition cursor-pointer"
              title="Полноэкранный режим (F)"
            >
              {isFullscreen ? (
                <Minimize className="w-4 h-4" />
              ) : (
                <Maximize className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
    </div>
  );
};
