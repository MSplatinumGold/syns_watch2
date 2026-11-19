---
title: SyncWatch Party
emoji: 🎬
colorFrom: red
colorTo: amber
sdk: docker
app_port: 7860
pinned: false
---

# SyncWatch Party

Совместный просмотр видео с синхронизацией, чатом, стикерами и локальным воспроизведением для загрузившего файл.

## Вариант 1: Локальный запуск + Cloudflare Tunnel (без лимитов слабого хоста)

1. Установите зависимости и соберите проект:
   ```bash
   npm install
   npm run build
   ```
2. Запустите сервер (в первом окне терминала):
   ```bash
   npm start
   ```
3. В другом окне терминала запустите Cloudflare Quick Tunnel (нужен установленный [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)):
   ```bash
   npm run tunnel
   ```
   Выдаст ссылку вида `https://....trycloudflare.com` — её можно сразу отправлять друзьям.

## Вариант 2: Запасной хостинг на Hugging Face Spaces (Docker)

1. Создайте новый Space на [huggingface.co/new-space](https://huggingface.co/new-space) и выберите **Docker** SDK (шаблон Blank).
2. Загрузите файлы репозитория в Space (через `git push` или веб-интерфейс).
3. Space автоматически соберёт `Dockerfile` и запустит приложение на порту `7860`.
