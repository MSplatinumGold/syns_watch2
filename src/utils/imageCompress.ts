export interface CompressedImageResult {
  file: File;
  wasCompressed: boolean;
  originalSize: number;
  compressedSize: number;
}

const SKIP_COMPRESSION_TYPES = new Set(['image/gif', 'image/svg+xml']);
const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_QUALITY = 0.8;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

async function decodeImageDimensionsAndDraw(
  file: File,
  maxDimension: number
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const srcW = bitmap.width;
        const srcH = bitmap.height;
        if (srcW <= 0 || srcH <= 0) return null;

        const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
        const targetW = Math.max(1, Math.round(srcW * scale));
        const targetH = Math.max(1, Math.round(srcH * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        return { canvas, width: srcW, height: srcH };
      } finally {
        bitmap.close();
      }
    } catch {
      // Fallback to HTMLImageElement below
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image decode failed'));
      el.src = objectUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (srcW <= 0 || srcH <= 0) return null;

    const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, targetW, targetH);
    return { canvas, width: srcW, height: srcH };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function compressChatImage(
  file: File,
  options?: { maxDimension?: number; quality?: number }
): Promise<CompressedImageResult> {
  const maxDimension = options?.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = options?.quality ?? DEFAULT_QUALITY;

  if (!file.type.startsWith('image/') || SKIP_COMPRESSION_TYPES.has(file.type)) {
    return {
      file,
      wasCompressed: false,
      originalSize: file.size,
      compressedSize: file.size,
    };
  }

  // Skip already-tiny files (< 60 KB) unless they might be oversized resolution
  const decoded = await decodeImageDimensionsAndDraw(file, maxDimension);
  if (!decoded) {
    return {
      file,
      wasCompressed: false,
      originalSize: file.size,
      compressedSize: file.size,
    };
  }

  const { canvas, width, height } = decoded;
  const needsResize = Math.max(width, height) > maxDimension;

  if (!needsResize && file.size <= 60 * 1024) {
    return {
      file,
      wasCompressed: false,
      originalSize: file.size,
      compressedSize: file.size,
    };
  }

  // Prefer WebP (smaller and preserves transparency), fallback to JPEG
  let outBlob = await canvasToBlob(canvas, 'image/webp', quality);
  let outMime = 'image/webp';
  let outExt = '.webp';

  if (!outBlob || outBlob.type !== 'image/webp') {
    outMime = 'image/jpeg';
    outExt = '.jpg';
    outBlob = await canvasToBlob(canvas, outMime, quality);
  }

  // Release canvas backing store promptly
  canvas.width = 0;
  canvas.height = 0;

  if (!outBlob || (!needsResize && outBlob.size >= file.size)) {
    return {
      file,
      wasCompressed: false,
      originalSize: file.size,
      compressedSize: file.size,
    };
  }

  const baseName = file.name.replace(/\.[^/.]+$/, '') || 'image';
  const compressedFile = new File([outBlob], `${baseName}${outExt}`, {
    type: outMime,
    lastModified: file.lastModified || Date.now(),
  });

  return {
    file: compressedFile,
    wasCompressed: true,
    originalSize: file.size,
    compressedSize: compressedFile.size,
  };
}
