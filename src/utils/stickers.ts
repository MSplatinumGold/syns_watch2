export interface StickerItem {
  id: string;
  url: string;
  animated?: boolean;
}

export interface StickerPack {
  id: string;
  name: string;
  count: number;
  stickers: StickerItem[];
}

function makePack(
  id: string,
  name: string,
  count: number,
  tgsStartIndex?: number
): StickerPack {
  const stickers: StickerItem[] = Array.from({ length: count }, (_, i) => {
    const num = i + 1;
    const stickerId = `${id}_${String(num).padStart(2, '0')}`;
    const isTgs = tgsStartIndex !== undefined && num >= tgsStartIndex;
    const ext = isTgs ? 'tgs' : 'webp';
    return {
      id: stickerId,
      url: `/stickers/${id}/${stickerId}.${ext}`,
      animated: isTgs,
    };
  });
  return { id, name, count, stickers };
}

export const STICKER_PACKS: StickerPack[] = [
  makePack('persik', 'Персик', 11),
  makePack('nutri1', 'Нутри', 13),
  makePack('nutri2', 'Нутри 2', 8),
  makePack('spotti', 'Спотти', 6, 3),
  makePack('gelya', 'Геля', 5),
  makePack('tenerezze', 'Нежность', 2),
  makePack('hamster', 'Хомяк', 2),
];

const STICKER_URL_MAP = new Map<string, string>();
for (const pack of STICKER_PACKS) {
  for (const st of pack.stickers) {
    STICKER_URL_MAP.set(st.id, st.url);
  }
}

export function resolveStickerUrl(stickerId: unknown): string | null {
  if (typeof stickerId !== 'string') return null;
  return STICKER_URL_MAP.get(stickerId) || null;
}
