// Реєструє вебхук у Telegram: node scripts/set-webhook.mjs https://menu-bot.<твій-субдомен>.workers.dev
// Токен і секрет бере зі змінних середовища або з файлу .dev.vars (він не комітиться).

import { existsSync, readFileSync } from 'node:fs';

function loadDevVars() {
  if (!existsSync('.dev.vars')) return {};
  const vars = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return vars;
}

const env = { ...loadDevVars(), ...process.env };
const token = env.TELEGRAM_BOT_TOKEN;
const secret = env.TELEGRAM_WEBHOOK_SECRET;
const base = (process.argv[2] || env.WORKER_URL || '').replace(/\/$/, '');

if (!token || !secret || !base) {
  console.error('Потрібні TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET і адреса Worker:\n  node scripts/set-webhook.mjs https://menu-bot.<субдомен>.workers.dev');
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const set = await api('setWebhook', {
  url: `${base}/webhook`,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
console.log('setWebhook:', set);

const info = await api('getWebhookInfo');
console.log('getWebhookInfo:', info.result);

const me = await api('getMe');
if (me.ok) {
  console.log('\nНеобов’язково: щоб бот не робив getMe на кожен запит, збережи це як секрет BOT_INFO:');
  console.log(JSON.stringify(me.result));
  if (me.result.can_read_all_group_messages === false) {
    console.warn('\n⚠️ Privacy Mode увімкнений: бот не бачитиме звичайні повідомлення в групі. Вимкни його в @BotFather → /setprivacy → Disable, потім видали й знову додай бота в групу.');
  }
}
