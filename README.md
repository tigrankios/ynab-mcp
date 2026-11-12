# YNAB MCP Server

Удалённый MCP-сервер (Streamable HTTP) для анализа бюджета в [YNAB](https://api.ynab.com). Готов к деплою на Railway.

## Как это работает

- **Один запрос на синхронизацию.** У YNAB лимит 200 запросов/час, поэтому весь план (бюджет) загружается одним `GET /plans/{id}`, а дальше обновляется **delta-запросами** (`last_knowledge_of_server`). Кэш живёт в памяти; данные считаются свежими `CACHE_TTL_SECONDS` (по умолчанию 5 минут).
- **Суммы — в валюте плана**, а не в milliunits (12.5 = 12,50). Отрицательные — расходы.
- **Сплиты раскрываются** в отдельные строки, поэтому отчёты по категориям считаются корректно.
- Счета, категории и получатели принимаются **по id или по (частичному) имени**.
- **Только чтение по умолчанию.** Инструменты записи включаются переменной `YNAB_ALLOW_WRITES=true`.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `list_plans` | Список планов (бюджетов) |
| `get_budget_overview` | Сводка месяца: Ready to Assign, доход/расход, age of money, net worth, перерасходы, недофинансированные цели, неподтверждённые/некатегоризированные транзакции |
| `get_accounts` | Счета и балансы |
| `get_categories` | Категории за месяц: assigned / activity / available + прогресс целей |
| `get_month_summaries` | Помесячная динамика: доход, расходы, норма сбережений, age of money |
| `get_category_history` | История категории или группы по месяцам + статистика |
| `search_transactions` | Поиск транзакций с фильтрами (даты, счёт, категория, получатель, текст, суммы, статусы) |
| `spending_report` | Агрегация расходов/доходов по категории, группе, получателю, счёту, месяцу или неделе |
| `get_payees` | Получатели со статистикой |
| `get_scheduled_transactions` | Регулярные платежи + оценка ежемесячной нагрузки |
| `get_money_movements` | Перемещения денег между категориями за месяц |
| `sync_status` | Свежесть кэша, расход лимита API, принудительное обновление |

С `YNAB_ALLOW_WRITES=true` дополнительно: `create_transaction`, `update_transactions` (категоризация/подтверждение пачкой), `delete_transaction`, `set_category_assigned`.

## Переменные окружения

| Переменная | Обязательна | Описание |
|---|---|---|
| `YNAB_ACCESS_TOKEN` | да | Personal Access Token: YNAB → Account Settings → Developer Settings → New Token |
| `MCP_AUTH_TOKEN` | да | Секрет для доступа к MCP-эндпоинту. Сгенерировать: `openssl rand -hex 32` |
| `YNAB_PLAN_ID` | нет | План по умолчанию (по умолчанию `last-used`) |
| `CACHE_TTL_SECONDS` | нет | Время свежести кэша, сек (по умолчанию 300) |
| `YNAB_ALLOW_WRITES` | нет | `true` — включить инструменты записи |
| `PORT` | нет | Railway задаёт сам |

## Деплой на Railway

1. Railway → **New Project → Deploy from GitHub repo** → выбрать этот репозиторий. Сборка и запуск описаны в `railway.json` (`npm ci && npm run build`, `npm start`, healthcheck `/health`).
2. **Variables**: задать `YNAB_ACCESS_TOKEN` и `MCP_AUTH_TOKEN` (и при желании остальные).
3. **Settings → Networking → Generate Domain** — получить публичный адрес вида `https://ynab-mcp-production.up.railway.app`.
4. Проверить: `curl https://<домен>/health` → `{"status":"ok",...}`.

## Подключение к Claude

**Claude.ai / Claude Desktop (Settings → Connectors → Add custom connector):** указать URL с токеном в пути:

```
https://<домен>/mcp/<MCP_AUTH_TOKEN>
```

**Claude Code:**

```bash
claude mcp add --transport http ynab https://<домен>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Сервер принимает токен либо в заголовке `Authorization: Bearer …`, либо сегментом пути `/mcp/<token>`. URL с токеном — это пароль к вашим финансам, не публикуйте его.

## Локальный запуск

```bash
npm install
npm run build
YNAB_ACCESS_TOKEN=... MCP_AUTH_TOKEN=dev npm start        # HTTP на :3000
YNAB_ACCESS_TOKEN=... npm run start:stdio                 # stdio-режим для локальных клиентов
npm test                                                  # e2e-тест на моке YNAB API
```

## Примеры вопросов

- «Сделай обзор бюджета за этот месяц: где перерасход и что недофинансировано?»
- «На что я тратил больше всего за последние 3 месяца? Сравни с предыдущими тремя.»
- «Покажи динамику расходов на рестораны за год.»
- «Какая у меня норма сбережений по месяцам?»
- «Сколько в месяц уходит на подписки и регулярные платежи?»
