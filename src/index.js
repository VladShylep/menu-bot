// Точка входу Cloudflare Worker:
//  - fetch: вебхук Telegram (POST /webhook) з перевіркою секретного токена;
//  - scheduled: щоранковий Cron — списання, прогноз закупів, повідомлення в групу.

import { createBot, shopKeyboard } from './bot.js';

// Telegram повторює вебхук, якщо відповідь затрималась. Пам'ятаємо оброблені update_id
// в межах ізоляту, щоб не записати «купив гречку» двічі.
const seen = new Set();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('menu-bot працює 🍲');
    }
    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const update = await request.json();
    if (seen.has(update.update_id)) return new Response('ok');
    seen.add(update.update_id);
    if (seen.size > 500) seen.delete(seen.values().next().value);

    try {
      const { bot } = await createBot(env);
      // Обробляємо синхронно: Workers не обмежують час очікування мережі (Claude, Sheets),
      // а відповідь 200 після обробки гарантує, що Telegram не повторить апдейт.
      await bot.handleUpdate(update);
    } catch (err) {
      console.error('update failed', err);
    }
    return new Response('ok');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(morning(env));
  },
};

export async function morning(env) {
  const { bot, service } = await createBot(env);
  const messages = await service.morningCheck();
  for (const m of messages) {
    await bot.api.sendMessage(env.GROUP_CHAT_ID, m.text, m.ask ? { reply_markup: shopKeyboard() } : {});
  }
}
