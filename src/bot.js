// Telegram-бот на grammY: команди, кнопки й вільний текст через LLM-агента.

import { Bot, InlineKeyboard } from 'grammy';
import { Agent } from './agent.js';
import { Service } from './service.js';

const HELP = `Я веду меню, запаси й покупки 🍲

/menu — скласти меню на 7 днів
/showmenu — показати поточне меню
/buy — список покупок за відділами Biedronka
/stock — що є вдома
/setup — підготувати таблицю (перший запуск)
/chatid — показати id цього чату

А ще можна писати просто так:
• «купив 1 кг гречки і десяток яєць»
• «закінчився рис»
• «що приготувати на вечерю?»
• «заміни борщ у четвер на плов»
• «додай страву: сирний суп»`;

export const menuKeyboard = () => new InlineKeyboard().text('✅ Затвердити', 'menu:approve').text('🔄 Інше меню', 'menu:redo');
export const shopKeyboard = () => new InlineKeyboard().text('🛒 Так, йдемо', 'shop:go').text('Не сьогодні', 'shop:no');

const whoOf = (ctx) => ctx.from?.first_name || ctx.from?.username || 'хтось';

export async function createBot(env) {
  const botInfo = env.BOT_INFO ? JSON.parse(env.BOT_INFO) : undefined;
  // Явно використовуємо глобальний fetch (у Workers він вбудований).
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo, client: { fetch: (...args) => globalThis.fetch(...args) } });
  if (!botInfo) await bot.init();

  const service = new Service(env);
  const groupId = env.GROUP_CHAT_ID ? String(env.GROUP_CHAT_ID) : null;

  // /chatid працює будь-де, щоб дізнатися id групи для налаштування.
  bot.command('chatid', (ctx) => ctx.reply(`id цього чату: ${ctx.chat.id}`));

  // Далі — лише в «своїй» групі, щоб чужі чати не витрачали ліміти Claude API.
  bot.use(async (ctx, next) => {
    if (groupId && String(ctx.chat?.id) !== groupId) {
      if (ctx.chat?.type === 'private' && ctx.message?.text?.startsWith('/start')) {
        await ctx.reply('Привіт! Я працюю тільки у своїй групі. Додай мене туди.');
      }
      return;
    }
    await next();
  });

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));

  bot.command('setup', async (ctx) => {
    const { created, seeded } = await service.setup();
    const parts = [];
    parts.push(created.length ? `Створив вкладки: ${created.join(', ')}.` : 'Усі вкладки вже є.');
    if (seeded) parts.push(`Додав стартову базу з ${seeded} страв у вкладку «Страви». Правте її прямо в таблиці або пишіть мені: «прибери голубці», «додай страву …», «плов — улюблена».`);
    parts.push('Далі напишіть, що є вдома (наприклад: «вдома є 2 кг картоплі, 1 кг рису, 10 яєць»), і зробіть /menu.');
    await ctx.reply(parts.join('\n\n'));
  });

  bot.command('stock', async (ctx) => {
    await ctx.reply(service.formatStock(await service.getStock()));
  });

  bot.command('showmenu', async (ctx) => {
    const text = await service.formatMenu();
    const { status } = await service.getUpcomingCooks();
    await ctx.reply(text, status === 'чернетка' ? { reply_markup: menuKeyboard() } : {});
  });

  bot.command('buy', async (ctx) => {
    const { items, hasMenu } = await service.shortages(7);
    if (!hasMenu) return ctx.reply('Затвердженого меню ще немає. Зробіть /menu і натисніть «Затвердити».');
    await ctx.reply(service.formatShoppingList(items));
  });

  const makeMenu = async (ctx, extra = '') => {
    await ctx.reply('Складаю меню на тиждень, хвилинку… 👩‍🍳');
    await ctx.replyWithChatAction('typing');
    const agent = new Agent(env, service);
    const res = await agent.handle({
      text: `Склади нове меню на 7 днів, починаючи з сьогодні. ${extra}`.trim(),
      who: whoOf(ctx),
      effort: 'medium',
    });
    if (res?.text) await ctx.reply(res.text);
    if (res?.menuSaved) await ctx.reply(await service.formatMenu(), { reply_markup: menuKeyboard() });
  };

  bot.command('menu', (ctx) => makeMenu(ctx, ctx.match ? `Побажання: ${ctx.match}` : ''));

  // ---------- Кнопки ----------

  bot.callbackQuery('menu:approve', async (ctx) => {
    const n = await service.approveMenu();
    await ctx.answerCallbackQuery(n ? 'Затверджено ✅' : 'Вже затверджено');
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (n) {
      await ctx.reply(`✅ ${whoOf(ctx)} затвердив(ла) меню.`);
      const { items } = await service.shortages(7);
      await ctx.reply(service.formatShoppingList(items, '🛒 Щоб приготувати все за меню, треба докупити:'));
    }
  });

  bot.callbackQuery('menu:redo', async (ctx) => {
    await ctx.answerCallbackQuery('Складаю інше меню…');
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await makeMenu(ctx, 'Попередня чернетка не сподобалась: зроби помітно інше меню.');
  });

  bot.callbackQuery('shop:go', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const { items } = await service.shortages(7);
    await ctx.reply(service.formatShoppingList(items));
    await ctx.reply('Як купите, просто напишіть «купили все по списку» або що саме купили — я оновлю запаси.');
  });

  bot.callbackQuery('shop:no', async (ctx) => {
    await ctx.answerCallbackQuery('Ок, нагадаю завтра');
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // ---------- Вільний текст ----------

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    const agent = new Agent(env, service);
    const res = await agent.handle({
      text,
      who: whoOf(ctx),
      replyTo: ctx.message.reply_to_message?.text,
    });
    if (!res) return; // не про їжу — мовчимо
    if (res.text) await ctx.reply(res.text, { reply_parameters: { message_id: ctx.message.message_id } });
    if (res.menuSaved === 'чернетка') await ctx.reply(await service.formatMenu(), { reply_markup: menuKeyboard() });
  });

  bot.catch(async (err) => {
    console.error('bot error', err.error ?? err);
    await err.ctx?.reply('😵 Щось пішло не так. Спробуйте ще раз трохи пізніше.').catch(() => {});
  });

  return { bot, service };
}
