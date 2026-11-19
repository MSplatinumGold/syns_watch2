export type UiThemeId = 'default' | 'nordic' | 'velvet' | 'sakura';

export interface UiThemeMeta {
  id: UiThemeId;
  name: string;
  description: string;
  swatches: [string, string, string];
}

export const UI_THEMES: UiThemeMeta[] = [
  {
    id: 'default',
    name: 'Кинозал',
    description: 'Классический тёмный (по умолчанию)',
    swatches: ['#0a0a0a', '#e11d48', '#f59e0b'],
  },
  {
    id: 'nordic',
    name: 'Полярная ночь',
    description: 'Холодный сланец и ледяной циан',
    swatches: ['#070b14', '#0284c7', '#2dd4bf'],
  },
  {
    id: 'velvet',
    name: 'Эспрессо',
    description: 'Тёплый винил, терракота и золото',
    swatches: ['#0f0b09', '#d95f3b', '#eab308'],
  },
  {
    id: 'sakura',
    name: 'Сумерки Токио',
    description: 'Глубокий индиго и неоновая сакура',
    swatches: ['#0b0713', '#c026d3', '#fb7185'],
  },
];

const THEME_STORAGE_KEY = 'watchparty_ui_theme';
const VALID_THEME_IDS = new Set<UiThemeId>(UI_THEMES.map((t) => t.id));

export function getSavedUiTheme(): UiThemeId {
  if (typeof window === 'undefined') return 'default';
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY) as UiThemeId | null;
    if (raw && VALID_THEME_IDS.has(raw)) {
      return raw;
    }
  } catch {}
  return 'default';
}

export function applyUiTheme(themeId: UiThemeId): void {
  if (typeof document === 'undefined') return;
  const safeTheme: UiThemeId = VALID_THEME_IDS.has(themeId) ? themeId : 'default';

  if (safeTheme === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', safeTheme);
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, safeTheme);
  } catch {}
}
