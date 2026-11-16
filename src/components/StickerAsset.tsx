import React, { useEffect, useRef, useState } from 'react';
import type { AnimationItem } from 'lottie-web';

interface StickerAssetProps {
  src: string;
  alt: string;
  className?: string;
}

const tgsDataCache = new Map<string, Promise<object>>();

async function loadTgsDeps() {
  const [{ default: lottie }, { gunzipSync }] = await Promise.all([
    import('lottie-web/build/player/lottie_light'),
    import('fflate'),
  ]);
  return { lottie, gunzipSync };
}

function loadTgsAnimationData(url: string): Promise<object> {
  const existing = tgsDataCache.get(url);
  if (existing) return existing;

  const promise = Promise.all([
    fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Failed to load sticker: ${res.status}`);
      return res.arrayBuffer();
    }),
    loadTgsDeps(),
  ])
    .then(([buf, { gunzipSync }]) => {
      const decompressed = gunzipSync(new Uint8Array(buf));
      const jsonStr = new TextDecoder('utf-8').decode(decompressed);
      return JSON.parse(jsonStr) as object;
    })
    .catch((err) => {
      tgsDataCache.delete(url);
      throw err;
    });

  tgsDataCache.set(url, promise);
  return promise;
}

export const StickerAsset: React.FC<StickerAssetProps> = ({ src, alt, className = '' }) => {
  const isTgs = src.toLowerCase().endsWith('.tgs');
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(!isTgs);

  useEffect(() => {
    if (!isTgs) return;

    let cancelled = false;
    let anim: AnimationItem | null = null;
    setLoaded(false);

    Promise.all([loadTgsAnimationData(src), loadTgsDeps()])
      .then(([animationData, { lottie }]) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData,
          rendererSettings: {
            preserveAspectRatio: 'xMidYMid meet',
          },
        });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
      if (anim) {
        anim.destroy();
        anim = null;
      }
    };
  }, [src, isTgs]);

  if (!isTgs) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        draggable={false}
        className={className}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={alt}
      className={`${className} flex items-center justify-center [&>svg]:!w-full [&>svg]:!h-full ${
        loaded ? '' : 'bg-neutral-800/40 rounded-xl animate-pulse'
      }`}
    />
  );
};
