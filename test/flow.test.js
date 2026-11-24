// Наскрізний тест Worker'а без мережі: Telegram, Google Sheets і Claude API підмінено в fetch.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

// ---------- Підробні сервіси ----------

const tabs = new Map(); // назва вкладки -> 2D-масив
const sent = []; // повідомлення, які бот надіслав у Telegram
const claudeQueue = []; // заготовлені відповіді Claude
const claudeRequests = [];

function parseRange(encoded) {
  const r = decodeURIComponent(encoded);
  const m = r.match(/^'(.+)'!([A-Z]+)(\d+)(?::[A-Z]+(\d*))?$/);
  return { tab: m[1].replace(/''/g, "'"), row: Number(m[3]) };
}

const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method ?? (typeof input === 'string' ? 'GET' : input.method);
  const bodyText = init.body ?? (typeof input === 'string' ? undefined : await input.text());
  const body = bodyText && typeof bodyText === 'string' && bodyText.startsWith('{') ? JSON.parse(bodyText) : bodyText;

  if (url.host === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });

  if (url.host === 'sheets.googleapis.com') {
    const path = url.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, '');
    if (path === '' && method === 'GET') return json({ sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) });
    if (path === ':batchUpdate') {
      for (const r of body.requests) tabs.set(r.addSheet.properties.title, []);
      return json({});
    }
    const m = path.match(/^\/values\/([^:]+)(?::(append|clear))?$/);
    const { tab, row } = parseRange(m[1]);
    const data = tabs.get(tab);
    if (m[2] === 'clear') { data.length = Math.min(data.length, row - 1); return json({}); }
    if (m[2] === 'append') { data.push(...body.values); return json({}); }
    if (method === 'PUT') { body.values.forEach((v, i) => { data[row - 1 + i] = v; }); return json({}); }
    const headerOnly = decodeURIComponent(m[1]).endsWith(':Z1');
    return json({ values: headerOnly ? data.slice(0, 1) : data.slice(row - 1) });
  }

  if (url.host === 'api.telegram.org') {
    const apiMethod = url.pathname.split('/').pop();
    const payload = typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : body ?? {};
    if (apiMethod === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'menu_bot' } });
    sent.push({ method: apiMethod, ...payload });
    return json({ ok: true, result: apiMethod === 'sendMessage' ? { message_id: sent.length, chat: { id: payload.chat_id }, date: 0 } : true });
  }

  if (url.host === 'api.anthropic.com') {
    claudeRequests.push(body);
    const next = claudeQueue.shift();
    assert.ok(next, 'неочікуваний запит до Claude');
    return json({ id: 'msg', type: 'message', role: 'assistant', model: body.model, usage: { input_tokens: 1, output_tokens: 1 }, ...next });
  }

  throw new Error(`Неочікуваний fetch ${url}`);
};

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  TELEGRAM_BOT_TOKEN: '1:abc',
  TELEGRAM_WEBHOOK_SECRET: 'secret',
  GROUP_CHAT_ID: '-100',
  ANTHROPIC_API_KEY: 'sk-test',
  SPREADSHEET_ID: 'sheet',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'bot@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
  TIMEZONE: 'Europe/Warsaw',
  PERSONS: '2',
  FORECAST_DAYS: '2',
  CLAUDE_MODEL: 'claude-opus-5-5',
};

const worker = (await import('../src/index.js')).default;
const { morning } = await import('../src/index.js');
const { todayISO, addDays } = await import('../src/dates.js');
const today = todayISO('Europe/Warsaw');

let updateId = 1;
const msg = (text, extra = {}) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 0, chat: { id: -100, type: 'group' }, from: { id: 7, is_bot: false, first_name: 'Maks' }, text, ...extra },
});
const post = (update, secret = 'secret') =>
  worker.fetch(new Request('https://w.dev/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), env);

const texts = () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.text);
const tab = (name) => tabs.get(name);

test('без секретного токена вебхук відхиляється', async () => {
  const res = await post(msg('hi'), 'wrong');
  assert.equal(res.status, 403);
});

test('/setup створює вкладки й стартову базу страв', async () => {
  await post({ ...msg('/setup'), message: { ...msg('/setup').message, entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  assert.deepEqual([...tabs.keys()].sort(), ['Запаси', 'Меню', 'Покупки', 'Страви'].sort());
  assert.ok(tab('Страви').length > 10);
  assert.match(texts().at(-1), /стартову базу/);
});

test('чужий чат ігнорується', async () => {
  const before = sent.length;
  await post({ update_id: updateId++, message: { message_id: 1, date: 0, chat: { id: 555, type: 'group' }, from: { id: 9, first_name: 'X' }, text: 'купив гречку' } });
  assert.equal(sent.length, before);
});

test('повідомлення не про їжу — бот мовчить', async () => {
  const before = sent.length;
  claudeQueue.push({ content: [{ type: 'text', text: '<SILENT>' }], stop_reason: 'end_turn' });
  await post(msg('ти бачив новий фільм?'));
  assert.equal(sent.length, before);
  assert.equal(claudeRequests.at(-1).model, 'claude-opus-5-5');
  assert.equal(claudeRequests.at(-1).fallbacks, 'default');
});

test('«купив гречку» оновлює запаси й записує покупку через інструмент', async () => {
  claudeQueue.push({
    content: [{ type: 'tool_use', id: 'tu1', name: 'update_stock', input: { changes: [
      { product: 'гречка', quantity: 1, unit: 'кг', action: 'bought' },
      { product: 'курячі стегна', quantity: 600, unit: 'г', action: 'bought' },
    ] } }],
    stop_reason: 'tool_use',
  });
  claudeQueue.push({ content: [{ type: 'text', text: 'Записав: гречка 1 кг, стегна 600 г 👍' }], stop_reason: 'end_turn' });
  await post(msg('купив кіло гречки і стегна'));

  const toolResult = claudeRequests.at(-1).messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.match(toolResult.content, /гречка: тепер 1 кг/);
  assert.deepEqual(tab('Запаси')[1].slice(0, 4), ['гречка', 1000, 'г', 'Бакалія']);
  assert.equal(tab('Покупки').length, 3);
  assert.equal(tab('Покупки')[1][1], 'Maks');
  assert.match(texts().at(-1), /Записав/);
});

test('агент складає меню-чернетку, бот показує його з кнопкою, а затвердження дає список покупок', async () => {
  claudeQueue.push({
    content: [{ type: 'tool_use', id: 'tu2', name: 'save_menu', input: { status: 'чернетка', cooks: [
      { date: today, meal: 'сніданок', dish: 'Вівсянка з бананом', days: 3 },
      { date: today, meal: 'обід', dish: 'Гречка з курячими стегнами', days: 3 },
      { date: today, meal: 'вечеря', dish: 'Плов з куркою', days: 3 },
    ] } }],
    stop_reason: 'tool_use',
  });
  claudeQueue.push({ content: [{ type: 'text', text: 'Зробив меню, спершу використав гречку.' }], stop_reason: 'end_turn' });
  await post({ ...msg('/menu'), message: { ...msg('/menu').message, entities: [{ type: 'bot_command', offset: 0, length: 5 }] } });

  assert.equal(claudeRequests.at(-1).output_config.effort, 'medium');
  const draft = sent.filter((s) => s.method === 'sendMessage').at(-1);
  assert.match(draft.text, /Чернетка меню/);
  assert.match(JSON.stringify(draft.reply_markup), /menu:approve/);
  assert.equal(tab('Меню').length, 1 + 9);

  await post({ update_id: updateId++, callback_query: { id: 'cb', from: { id: 7, first_name: 'Maks' }, chat_instance: 'x', data: 'menu:approve', message: { message_id: 5, date: 0, chat: { id: -100, type: 'group' } } } });
  assert.ok(tab('Меню').slice(1).every((r) => r[5] === 'затверджено'));
  const list = texts().at(-1);
  assert.match(list, /докупити/);
  assert.match(list, /Овочі та фрукти[\s\S]*Бакалія/); // порядок відділів
  assert.doesNotMatch(list, /гречка/); // 6 порцій × 80 г = 480 г, а вдома 1 кг
  assert.match(list, /курячі стегна — 600 г/); // 6 × 200 = 1200 г, є 600 г
  assert.match(list, /рис — 540 г/); // плов: 6 × 90 г
});

test('ранковий Cron пропонує скупитись і списує вчорашнє готування', async () => {
  // Переносимо одне готування на вчора, щоб перевірити списання.
  const rows = tab('Меню');
  rows.push([addDays(today, -1), 'обід', 'Гречка з курячими стегнами', 'так', 2, 'затверджено', '']);
  await morning(env);
  const last = sent.filter((s) => s.method === 'sendMessage').at(-1);
  assert.match(last.text, /варто скупитись/);
  assert.match(JSON.stringify(last.reply_markup), /shop:go/);
  assert.equal(rows.at(-1)[6], 'так');
});
