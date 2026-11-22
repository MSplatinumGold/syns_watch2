const MAX_CACHED_REMOTE_IMAGES = 60;

// In-memory map of local or fetched media URL -> Blob URL (valid for current tab session)
const mediaBlobUrlMap = new Map<string, string>();
// Track only remote-fetched keys separately for FIFO eviction (never evict user's own local files prematurely)
const remoteCacheKeysOrder: string[] = [];
const inFlightImageFetches = new Map<string, Promise<string | null>>();

// Local video files selected by the host: trackId -> Blob URL
const localTrackUrlMap = new Map<string, string>();

/**
 * Registers a locally selected video File for zero-traffic playback on the host device.
 */
export function registerLocalTrackFile(trackId: string, file: File): string {
  const existing = localTrackUrlMap.get(trackId);
  if (existing) return existing;
  const blobUrl = URL.createObjectURL(file);
  localTrackUrlMap.set(trackId, blobUrl);
  return blobUrl;
}

export function getLocalTrackUrl(trackId?: string): string | undefined {
  if (!trackId) return undefined;
  return localTrackUrlMap.get(trackId);
}

export function revokeLocalTrackUrl(trackId: string): void {
  const url = localTrackUrlMap.get(trackId);
  if (url) {
    URL.revokeObjectURL(url);
    localTrackUrlMap.delete(trackId);
  }
}

/**
 * Registers a local chat media File/Blob sent by the current user so they don't re-download it.
 */
export function registerLocalChatMedia(remoteUrl: string, file: Blob): string {
  const existing = mediaBlobUrlMap.get(remoteUrl);
  if (existing) return existing;
  const blobUrl = URL.createObjectURL(file);
  mediaBlobUrlMap.set(remoteUrl, blobUrl);
  return blobUrl;
}

export function getCachedChatMediaUrl(remoteUrl?: string): string | undefined {
  if (!remoteUrl) return undefined;
  return mediaBlobUrlMap.get(remoteUrl);
}

/**
 * Fetches and caches a remote chat image as a Blob URL for the rest of the session.
 */
export function fetchAndCacheChatImage(remoteUrl: string): Promise<string | null> {
  const existing = mediaBlobUrlMap.get(remoteUrl);
  if (existing) return Promise.resolve(existing);

  const inFlight = inFlightImageFetches.get(remoteUrl);
  if (inFlight) return inFlight;

  const promise = fetch(remoteUrl, { cache: 'force-cache' })
    .then(async (res) => {
      if (!res.ok) return null;
      const blob = await res.blob();
      // Re-check in case another call resolved first
      const already = mediaBlobUrlMap.get(remoteUrl);
      if (already) return already;

      const blobUrl = URL.createObjectURL(blob);
      mediaBlobUrlMap.set(remoteUrl, blobUrl);
      remoteCacheKeysOrder.push(remoteUrl);

      // Evict oldest remote cached images if over cap
      while (remoteCacheKeysOrder.length > MAX_CACHED_REMOTE_IMAGES) {
        const oldestKey = remoteCacheKeysOrder.shift();
        if (oldestKey) {
          const oldUrl = mediaBlobUrlMap.get(oldestKey);
          if (oldUrl) {
            URL.revokeObjectURL(oldUrl);
            mediaBlobUrlMap.delete(oldestKey);
          }
        }
      }

      return blobUrl;
    })
    .catch(() => null)
    .finally(() => {
      inFlightImageFetches.delete(remoteUrl);
    });

  inFlightImageFetches.set(remoteUrl, promise);
  return promise;
}

/**
 * Clears all session Blob URLs (called when leaving or closing a room).
 */
export function clearAllSessionMediaCaches(): void {
  mediaBlobUrlMap.forEach((blobUrl) => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
  });
  mediaBlobUrlMap.clear();
  remoteCacheKeysOrder.length = 0;
  inFlightImageFetches.clear();

  localTrackUrlMap.forEach((blobUrl) => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
  });
  localTrackUrlMap.clear();
}

/**
 * Compresses static chat images on the client (max 1600px, WebP/JPEG ~0.82)
 * before uploading. Skips GIFs, SVGs, and already compact images (<= 220 KB).
 */
export async function compressImageForChat(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  if (file.size <= 220 * 1024) return file;

  const MAX_SIDE = 1600;
  let bitmap: ImageBitmap | null = null;
  let fallbackUrl: string | null = null;

  try {
    let srcWidth = 0;
    let srcHeight = 0;
    let drawSource: CanvasImageSource;

    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
      srcWidth = bitmap.width;
      srcHeight = bitmap.height;
      drawSource = bitmap;
    } else {
      fallbackUrl = URL.createObjectURL(file);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = fallbackUrl!;
      });
      srcWidth = img.naturalWidth;
      srcHeight = img.naturalHeight;
      drawSource = img;
    }

    if (srcWidth <= 0 || srcHeight <= 0) return file;

    const scale = Math.min(1, MAX_SIDE / Math.max(srcWidth, srcHeight));
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(drawSource, 0, 0, targetWidth, targetHeight);

    const encodeBlob = (mime: string, quality: number) =>
      new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), mime, quality);
      });

    let compressed = await encodeBlob('image/webp', 0.82);
    let outMime = 'image/webp';
    let outExt = '.webp';

    if (!compressed || compressed.type !== 'image/webp') {
      compressed = await encodeBlob('image/jpeg', 0.84);
      outMime = 'image/jpeg';
      outExt = '.jpg';
    }

    if (!compressed || compressed.size >= file.size * 0.92) {
      return file;
    }

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([compressed], `${baseName}${outExt}`, {
      type: outMime,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  } finally {
    if (bitmap) {
      try {
        bitmap.close();
      } catch {}
    }
    if (fallbackUrl) {
      URL.revokeObjectURL(fallbackUrl);
    }
  }
}
