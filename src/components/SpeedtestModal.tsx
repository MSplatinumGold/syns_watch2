import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  X,
  Gauge,
  Play,
  Square,
  ArrowDown,
  ArrowUp,
  Activity,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Clock,
} from 'lucide-react';

interface SpeedtestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TestPhase = 'idle' | 'ping' | 'download' | 'upload' | 'done' | 'error';

interface SpeedtestResult {
  pingMs: number | null;
  jitterMs: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
}

function formatUploadEstimate(uploadMbps: number | null, sizeMb = 500): string {
  if (!uploadMbps || uploadMbps <= 0) return '—';
  const totalBits = sizeMb * 8;
  const seconds = Math.round(totalBits / uploadMbps);
  if (seconds < 60) return `~${seconds} сек`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `~${mins} мин ${rem} с` : `~${mins} мин`;
}

export const SpeedtestModal: React.FC<SpeedtestModalProps> = ({ isOpen, onClose }) => {
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [liveMbps, setLiveMbps] = useState<number | null>(null);
  const [result, setResult] = useState<SpeedtestResult>({
    pingMs: null,
    jitterMs: null,
    downloadMbps: null,
    uploadMbps: null,
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const cancelledRef = useRef(false);

  const cancelActiveTest = useCallback(() => {
    cancelledRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (uploadXhrRef.current) {
      uploadXhrRef.current.abort();
      uploadXhrRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      cancelActiveTest();
      setPhase((prev) => (prev === 'done' ? 'done' : 'idle'));
      setProgress(0);
      setLiveMbps(null);
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelActiveTest();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, cancelActiveTest]);

  useEffect(() => {
    return () => cancelActiveTest();
  }, [cancelActiveTest]);

  const runSpeedtest = async () => {
    cancelActiveTest();
    cancelledRef.current = false;
    setErrorMsg(null);
    setLiveMbps(null);
    setResult({ pingMs: null, jitterMs: null, downloadMbps: null, uploadMbps: null });

    const ac = new AbortController();
    abortControllerRef.current = ac;

    try {
      // 1. Ping & Jitter (5 probes, first probe warms TLS/route)
      setPhase('ping');
      setProgress(0);
      const rtts: number[] = [];
      for (let i = 0; i < 5; i++) {
        if (cancelledRef.current) return;
        const t0 = performance.now();
        const res = await fetch(`/api/speedtest/ping?i=${i}&t=${Date.now()}`, {
          cache: 'no-store',
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
        const rtt = Math.max(1, performance.now() - t0);
        if (i > 0) {
          rtts.push(rtt);
        }
        setProgress(Math.round(((i + 1) / 5) * 100));
      }

      const avgPing = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
      let jitter = 0;
      if (rtts.length > 1) {
        let diffSum = 0;
        for (let i = 1; i < rtts.length; i++) {
          diffSum += Math.abs(rtts[i] - rtts[i - 1]);
        }
        jitter = diffSum / (rtts.length - 1);
      }

      setResult((prev) => ({
        ...prev,
        pingMs: Math.round(avgPing),
        jitterMs: Math.round(jitter),
      }));

      // 2. Download Speed (6 MB stream)
      if (cancelledRef.current) return;
      setPhase('download');
      setProgress(0);
      setLiveMbps(0);

      const dlTargetBytes = 6 * 1024 * 1024;
      const dlStartAt = performance.now();
      const dlRes = await fetch(`/api/speedtest/download?size=${dlTargetBytes}&t=${Date.now()}`, {
        cache: 'no-store',
        signal: ac.signal,
      });
      if (!dlRes.ok || !dlRes.body) {
        throw new Error(`Ошибка скачивания (HTTP ${dlRes.status})`);
      }

      const reader = dlRes.body.getReader();
      let dlLoaded = 0;
      let dlMeasureStart = 0;
      let dlMeasureStartBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (cancelledRef.current) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (value) {
          dlLoaded += value.byteLength;
          const now = performance.now();
          if (dlMeasureStart === 0) {
            dlMeasureStart = now;
            dlMeasureStartBytes = dlLoaded;
          }
          const elapsedSec = (now - dlStartAt) / 1000;
          const streamElapsedSec = (now - dlMeasureStart) / 1000;
          const speedMbps =
            streamElapsedSec > 0.15 && dlLoaded > dlMeasureStartBytes
              ? ((dlLoaded - dlMeasureStartBytes) * 8) / (streamElapsedSec * 1_000_000)
              : elapsedSec > 0
              ? (dlLoaded * 8) / (elapsedSec * 1_000_000)
              : 0;
          setLiveMbps(Number(speedMbps.toFixed(1)));
          setProgress(Math.min(100, Math.round((dlLoaded / dlTargetBytes) * 100)));
        }
      }

      const dlTotalSec = Math.max(0.05, (performance.now() - dlStartAt) / 1000);
      const finalDownloadMbps = Number(((dlLoaded * 8) / (dlTotalSec * 1_000_000)).toFixed(1));
      setResult((prev) => ({ ...prev, downloadMbps: finalDownloadMbps }));

      // 3. Upload Speed (4 MB payload via XHR so we get real browser upload progress)
      if (cancelledRef.current) return;
      setPhase('upload');
      setProgress(0);
      setLiveMbps(0);

      const ulSize = 4 * 1024 * 1024;
      const payload = new Uint8Array(ulSize);
      payload.fill(0x61);

      const finalUploadMbps = await new Promise<number>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        uploadXhrRef.current = xhr;
        const ulStartAt = performance.now();
        let ulTrimStart = 0;
        let ulTrimBytes = 0;

        xhr.open('POST', `/api/speedtest/upload?t=${Date.now()}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        xhr.upload.onprogress = (ev) => {
          if (cancelledRef.current) return;
          const loaded = ev.loaded;
          const now = performance.now();
          if (ulTrimStart === 0 && loaded >= ulSize * 0.15) {
            ulTrimStart = now;
            ulTrimBytes = loaded;
          }
          const elapsed = (now - ulStartAt) / 1000;
          const trimmedElapsed = ulTrimStart > 0 ? (now - ulTrimStart) / 1000 : 0;
          const mbps =
            trimmedElapsed > 0.15 && loaded > ulTrimBytes
              ? ((loaded - ulTrimBytes) * 8) / (trimmedElapsed * 1_000_000)
              : elapsed > 0
              ? (loaded * 8) / (elapsed * 1_000_000)
              : 0;
          setLiveMbps(Number(mbps.toFixed(1)));
          setProgress(Math.min(100, Math.round((loaded / ulSize) * 100)));
        };

        xhr.onload = () => {
          uploadXhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            const totalSec = Math.max(0.05, (performance.now() - ulStartAt) / 1000);
            const mbps = Number(((ulSize * 8) / (totalSec * 1_000_000)).toFixed(1));
            resolve(mbps);
          } else {
            reject(new Error(`Ошибка отдачи (HTTP ${xhr.status})`));
          }
        };

        xhr.onerror = () => {
          uploadXhrRef.current = null;
          reject(new Error('Сетевой сбой при тесте отдачи'));
        };

        xhr.onabort = () => {
          uploadXhrRef.current = null;
          reject(new Error('ABORTED'));
        };

        xhr.send(payload);
      });

      if (cancelledRef.current) return;
      setResult((prev) => ({ ...prev, uploadMbps: finalUploadMbps }));
      setLiveMbps(null);
      setProgress(100);
      setPhase('done');
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'ABORTED')) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : 'Не удалось выполнить спидтест');
      setPhase('error');
    }
  };

  if (!isOpen) return null;

  const isRunning = phase === 'ping' || phase === 'download' || phase === 'upload';

  const diagnosticSummary = (() => {
    if (phase !== 'done') return null;
    const { pingMs, downloadMbps, uploadMbps } = result;
    const issues: string[] = [];

    if (uploadMbps !== null && uploadMbps < 10) {
      issues.push(
        `Низкая скорость загрузки видео на сервер (${uploadMbps} Мбит/с) — файл 400 МБ загрузится ${formatUploadEstimate(
          uploadMbps,
          400
        )}.`
      );
    }
    if (downloadMbps !== null && downloadMbps < 12) {
      issues.push(
        `Ограниченная скорость отдачи с сервера зрителям (${downloadMbps} Мбит/с) — тяжёлые видео могут буферизоваться.`
      );
    }
    if (pingMs !== null && pingMs > 160) {
      issues.push(`Высокий пинг (${pingMs} мс) — сервер удалён географически или трафик идёт через медленный прокси.`);
    }

    if (issues.length === 0) {
      return {
        tone: 'good' as const,
        title: 'Канал до сервера в норме',
        text: `Соединение стабильное. Видео 400 МБ загрузится примерно за ${formatUploadEstimate(
          uploadMbps,
          400
        )}.`,
      };
    }

    return {
      tone: 'warn' as const,
      title: 'Обнаружено узкое место канала',
      text: issues.join(' '),
    };
  })();

  const phaseLabel =
    phase === 'ping'
      ? 'Измерение пинга и джиттера...'
      : phase === 'download'
      ? 'Тест скачивания с сервера (6 МБ)...'
      : phase === 'upload'
      ? 'Тест загрузки на сервер (4 МБ)...'
      : phase === 'done'
      ? 'Замер завершён'
      : phase === 'error'
      ? 'Ошибка замера'
      : 'Готов к проверке канала';

  return (
    <div
      onClick={() => {
        cancelActiveTest();
        onClose();
      }}
      className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="px-4 py-3 bg-neutral-950/90 border-b border-neutral-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center shrink-0">
              <Gauge className="w-4 h-4 text-sky-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white truncate">
                Спидтест до сервера
              </h2>
              <p className="text-[11px] text-neutral-400 truncate">
                Реальная скорость между вашим браузером и хостом
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              cancelActiveTest();
              onClose();
            }}
            className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition cursor-pointer shrink-0"
            title="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Metrics Grid */}
          <div className="grid grid-cols-3 gap-2">
            {/* Ping */}
            <div className="p-3 rounded-xl bg-neutral-950 border border-neutral-800 flex flex-col justify-between">
              <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                <Activity className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Пинг</span>
              </div>
              <div className="mt-1.5">
                <span className="text-lg font-bold font-mono tabular-nums text-white">
                  {result.pingMs !== null ? result.pingMs : '—'}
                </span>
                <span className="text-[10px] text-neutral-500 ml-1">мс</span>
              </div>
              <div className="text-[10px] text-neutral-500 font-mono tabular-nums mt-0.5">
                ± {result.jitterMs !== null ? `${result.jitterMs} мс` : '—'}
              </div>
            </div>

            {/* Download */}
            <div className="p-3 rounded-xl bg-neutral-950 border border-neutral-800 flex flex-col justify-between">
              <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                <ArrowDown className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Скачивание</span>
              </div>
              <div className="mt-1.5">
                <span className="text-lg font-bold font-mono tabular-nums text-white">
                  {phase === 'download' && liveMbps !== null
                    ? liveMbps
                    : result.downloadMbps !== null
                    ? result.downloadMbps
                    : '—'}
                </span>
                <span className="text-[10px] text-neutral-500 ml-1">Мбит/с</span>
              </div>
              <div className="text-[10px] text-neutral-500 font-mono tabular-nums mt-0.5">
                {result.downloadMbps !== null
                  ? `${(result.downloadMbps / 8).toFixed(1)} МБ/с`
                  : 'просмотр'}
              </div>
            </div>

            {/* Upload */}
            <div className="p-3 rounded-xl bg-neutral-950 border border-neutral-800 flex flex-col justify-between">
              <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                <ArrowUp className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span>Загрузка</span>
              </div>
              <div className="mt-1.5">
                <span className="text-lg font-bold font-mono tabular-nums text-white">
                  {phase === 'upload' && liveMbps !== null
                    ? liveMbps
                    : result.uploadMbps !== null
                    ? result.uploadMbps
                    : '—'}
                </span>
                <span className="text-[10px] text-neutral-500 ml-1">Мбит/с</span>
              </div>
              <div className="text-[10px] text-neutral-500 font-mono tabular-nums mt-0.5">
                {result.uploadMbps !== null
                  ? `${(result.uploadMbps / 8).toFixed(1)} МБ/с`
                  : 'выгрузка'}
              </div>
            </div>
          </div>

          {/* Progress bar & Status */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-neutral-300 font-medium">{phaseLabel}</span>
              {isRunning && (
                <span className="font-mono tabular-nums text-sky-400 font-semibold">
                  {progress}%
                </span>
              )}
            </div>
            <div className="w-full h-2 bg-neutral-950 border border-neutral-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-200 ${
                  phase === 'error'
                    ? 'bg-rose-500'
                    : phase === 'done'
                    ? 'bg-emerald-500'
                    : phase === 'upload'
                    ? 'bg-gradient-to-r from-rose-500 to-amber-400'
                    : 'bg-gradient-to-r from-sky-500 to-emerald-400'
                }`}
                style={{ width: `${phase === 'idle' ? 0 : progress}%` }}
              />
            </div>
          </div>

          {/* Error Banner */}
          {errorMsg && (
            <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Diagnostic Summary */}
          {diagnosticSummary && (
            <div
              className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                diagnosticSummary.tone === 'good'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-100'
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold">
                {diagnosticSummary.tone === 'good' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                )}
                <span>{diagnosticSummary.title}</span>
              </div>
              <p className="text-[11px] leading-relaxed opacity-90">{diagnosticSummary.text}</p>
              {result.uploadMbps !== null && (
                <div className="pt-1 border-t border-white/10 flex items-center justify-between text-[11px] font-mono tabular-nums opacity-85">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Оценка для файла 400 МБ / 1 ГБ:
                  </span>
                  <span>
                    {formatUploadEstimate(result.uploadMbps, 400)} /{' '}
                    {formatUploadEstimate(result.uploadMbps, 1024)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {isRunning ? (
              <button
                type="button"
                onClick={() => {
                  cancelActiveTest();
                  setPhase('idle');
                  setProgress(0);
                  setLiveMbps(null);
                }}
                className="w-full py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-semibold flex items-center justify-center gap-2 border border-neutral-700 transition cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-white" />
                <span>Остановить тест</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={runSpeedtest}
                className="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center justify-center gap-2 shadow-lg shadow-rose-600/25 transition active:scale-[0.99] cursor-pointer"
              >
                {phase === 'done' || phase === 'error' ? (
                  <>
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Повторить замер</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-white" />
                    <span>Запустить спидтест</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
