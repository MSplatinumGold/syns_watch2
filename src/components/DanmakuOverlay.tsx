import React from 'react';
import type { DanmakuItem } from '../types/watchparty.ts';

interface DanmakuOverlayProps {
  items: DanmakuItem[];
  enabled: boolean;
}

export const DanmakuOverlay: React.FC<DanmakuOverlayProps> = ({ items, enabled }) => {
  if (!enabled || items.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
      {items.map((item) => (
        <div
          key={item.id}
          className="absolute left-full animate-danmaku whitespace-nowrap flex items-center gap-2 bg-black/85 backdrop-blur-md text-white text-xs md:text-sm font-medium px-3.5 py-1 rounded-full shadow-2xl border border-white/20"
          style={{
            top: `${item.topPercent}%`,
          }}
        >
          <span className="text-amber-400 font-semibold">{item.nickname}:</span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
};
