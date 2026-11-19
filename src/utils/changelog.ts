export const APP_VERSION = '1.0.0 Release';

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  tag: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.0.0 Release',
    date: '19.11.2026',
    title: 'Первый релиз и оптимизация трафика',
    tag: 'Release',
    changes: [
      'Локальное воспроизведение видео у хоста прямо с устройства (0 байт входящего видеотрафика).',
      'Кэширование истории чата в sessionStorage и медиафайлов до конца сеанса.',
      'Сжатие фотографий в чате на клиенте перед отправкой и локальный предпросмотр у отправителя.',
      'Экономия трафика плеера (preload="metadata" до старта, удаление лишней выкачки) и троттлинг прогресса.',
      'Предсжатие статики в Brotli/Gzip, кэширование стикеров и очистка служебных полей состояния комнаты.',
      'Базовый функционал: синхронный просмотр (Time Drift + Smart Buffer), плейлист с чанковой загрузкой, чат со стикерами, Danmaku и RP-ответами.',
    ],
  },
];
