# Селфхост tarkov-stats со своего компьютера

Связка: **Docker** (изоляция приложения) + **Cloudflare Tunnel** (нет открытых
портов, скрыт домашний IP, бесплатный HTTPS, защита от DDoS).

## Почему так безопасно

- Приложение крутится в контейнере под непривилегированным пользователем.
  Взлом сайта ≠ доступ к твоей Windows.
- На роутере **не открывается ни одного порта**. Cloudflared сам устанавливает
  исходящее соединение к Cloudflare, а трафик к сайту идёт через него.
- Твой настоящий IP не виден посетителям — виден только Cloudflare.

---

## Шаг 1. Купить домены (reg.ru)

Купи `tarkovstats.ru` и/или `tarkovstats.online`. Больше на reg.ru ничего
настраивать не нужно — DNS переедет в Cloudflare.

## Шаг 2. Добавить домен в Cloudflare (бесплатно)

1. Зарегистрируйся на https://dash.cloudflare.com → **Add a site** → введи домен.
2. Выбери **Free** план.
3. Cloudflare покажет 2 своих nameservers (например `xxx.ns.cloudflare.com`).
4. В панели reg.ru у домена замени NS на те, что дал Cloudflare.
5. Подожди обновления (от 10 минут до пары часов). Повтори для второго домена.

> Cloudflare Tunnel умеет привязывать домен, только если домен на Cloudflare.

## Шаг 3. Установить Docker Desktop

https://www.docker.com/products/docker-desktop/ → установить → перезагрузка →
запустить Docker Desktop (значок кита должен быть зелёным).

Проверка в PowerShell:

```powershell
docker --version
```

## Шаг 4. Создать туннель в Cloudflare

1. https://one.dash.cloudflare.com → **Networks → Tunnels → Create a tunnel**.
2. Тип **Cloudflared**, имя любое (например `home-pc`).
3. На шаге установки выбери вкладку **Docker** — скопируй **только токен**
   (длинная строка после `--token`). Сам docker-run выполнять не надо.
4. Дальше **Public Hostname → Add a public hostname**:
   - Subdomain: пусто (или `www`)
   - Domain: `tarkovstats.ru`
   - Type: `HTTP`
   - URL: `web:3000`  ← имя docker-сервиса, НЕ localhost
5. Повтори Add a public hostname для `tarkovstats.online` (и при желании для
   `www.*`). Все они указывают на тот же `web:3000`.

## Шаг 5. Заполнить .env

В корне проекта скопируй пример и впиши значения:

```powershell
Copy-Item .env.selfhost.example .env
```

Открой `.env` и заполни:
- `TUNNEL_TOKEN` — токен из шага 4.
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` — твой реальный Turnstile sitekey
  (Cloudflare → Turnstile → создать виджет, добавить оба домена в allowed).

## Шаг 6. Запуск

```powershell
docker compose up -d --build
```

Через минуту-две сайт будет доступен на `https://tarkovstats.ru`.
HTTPS-сертификат Cloudflare выдаёт автоматически.

Полезные команды:

```powershell
docker compose logs -f          # смотреть логи
docker compose ps               # статус контейнеров
docker compose down             # остановить
docker compose up -d --build    # пересобрать после изменений в коде
```

## Автозапуск 24/7

- `restart: unless-stopped` в compose поднимет контейнеры после перезагрузки,
  если Docker Desktop стартует с Windows.
- В настройках Docker Desktop включи **Start Docker Desktop when you log in**.
- Чтобы комп не уходил в сон: Параметры Windows → Питание → «Сон: Никогда».

---

## Что осталось от Cloudflare Workers (можно не трогать)

Файлы `wrangler.jsonc`, `open-next.config.ts` и npm-скрипты `deploy/preview`
относятся к старому варианту деплоя на Cloudflare Workers. Для селфхоста они не
нужны, но и не мешают — оставь как есть либо удали позже.
