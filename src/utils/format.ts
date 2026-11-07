/**
 * Formats seconds into HH:MM:SS or MM:SS
 */
export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Parses user input like "01:24:10", "84:10", or "125" into seconds
 */
export function parseTime(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If pure number (seconds)
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // If format HH:MM:SS or MM:SS
  const parts = trimmed.split(':').map((p) => p.trim());
  if (parts.some((p) => isNaN(Number(p)) || Number(p) < 0)) {
    return null;
  }

  if (parts.length === 3) {
    const [h, m, s] = parts.map(Number);
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }

  if (parts.length === 2) {
    const [m, s] = parts.map(Number);
    if (s >= 60) return null;
    return m * 60 + s;
  }

  return null;
}

/**
 * Formats bytes to human-readable size
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Formats transfer speed (e.g. 12.4 МБ/с)
 */
export function formatSpeed(bytesPerSec: number): string {
  if (isNaN(bytesPerSec) || bytesPerSec <= 0) return '0 КБ/с';
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} КБ/с`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} МБ/с`;
}

/**
 * Formats estimated time remaining (e.g. ~01:15 мин)
 */
export function formatEta(seconds: number): string {
  if (isNaN(seconds) || seconds <= 0) return '~00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `~${hrs} ч ${pad(remMins)} мин`;
  }
  return `~${pad(mins)}:${pad(secs)} мин`;
}
