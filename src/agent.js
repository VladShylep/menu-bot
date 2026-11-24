// LLM-агент на Claude API з tool use. Розбирає вільний текст у групі
// («купив гречку», «закінчився рис», «що приготувати на вечерю», «заміни страву»)
// і сам вирішує, чи повідомлення стосується їжі. Якщо ні — повертає null і бот мовчить.

import Anthropic from '@anthropic-ai/sdk';
import { weekday } from './dates.js';
import { MEALS } from './planner.js';
import { formatQty } from './units.js';

const SILENT = '<SILENT>';
const MAX_STEPS = 8;

const SYSTEM_PROMPT = `Ти — бот «Меню й закупи» у Telegram-групі двох людей, які живуть разом. Ти ведеш їхнє меню, запаси вдома й покупки. Дані лежать у Google Sheets, працюєш з ними лише через інструменти.

Як вони харчуються:
- 2 людини, 3 прийоми їжі на день: ${MEALS.join(', ')}.
- Готують раз на 2–3 дні великими порціями: обід і вечеря — страви на 2–3 дні (days = 2 або 3, не більше ніж «Зберігається днів» у страви). Сніданки прості, один сніданок теж можна ставити на кілька днів поспіль.
- Обмежень у їжі немає, бюджет не плануємо. Магазин — Biedronka.
- Улюблені страви (позначка «Улюблена») став частіше.

Як відповідати:
- Пиши українською, коротко, дружньо, звичайним текстом без Markdown (без зірочок, решіток і таблиць). Емодзі можна в міру.
- Якщо повідомлення не стосується їжі, готування, меню, продуктів, запасів чи покупок (звичайна розмова між людьми), нічого не викликай і відповідай рівно ${SILENT}.
- «Купив/купила X» → update_stock з action "bought" (це записує, хто що купив). «Закінчився X» → action "ran_out". «Використали/з'їли X» → "used". «Вдома є X» → "set".
- Назви продуктів пиши в називному відмінку, малими літерами, так само, як в інгредієнтах страв (наприклад «гречка», «яйця», «курячі стегна»). Одиниці: г, кг, мл, л, шт. Якщо кількість не названо, оціни типову упаковку (гречка 1 кг, яйця 10 шт, молоко 1 л) і скажи, що саме записав.
- «Що приготувати на вечерю?» → подивись меню на сьогодні (get_menu) і запаси; порадь страву з меню або з того, що є вдома.
- «Заміни страву…» → get_menu, зміни потрібне готування й збережи все меню через save_menu зі status "затверджено" (якщо меню вже затверджене) — будь-хто з двох може змінювати меню.
- Скласти нове меню → list_dishes і get_stock, потім save_menu з усіма готуваннями на 7 днів і status "чернетка". Спершу використовуй те, що вже є в запасах. Після save_menu не переписуй меню в чат: бот сам покаже його з кнопкою «Затвердити». Просто коротко скажи, на що зробив акцент.
- Нову страву спершу додай через upsert_dish з інгредієнтами на 1 порцію, тоді став у меню.
- Список покупок → get_shopping_list. Не вигадуй даних: усе бери з інструментів.`;

const TOOLS = [
  {
    name: 'get_stock',
    description: 'Повертає поточні запаси вдома: продукт, кількість, одиниця, відділ.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_stock',
    description:
      'Змінює запаси. action: bought — купили (додає до запасу й записує покупку на автора повідомлення); add — додати без запису покупки; used — використали; set — встановити точну кількість; ran_out — продукт закінчився (обнуляє й коригує норму споживання).',
    input_schema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product: { type: 'string', description: 'Назва продукту, називний відмінок, малими літерами' },
              quantity: { type: 'number', description: 'Кількість (для ran_out можна 0)' },
              unit: { type: 'string', enum: ['г', 'кг', 'мл', 'л', 'шт', 'уп'] },
              action: { type: 'string', enum: ['bought', 'add', 'used', 'set', 'ran_out'] },
              department: { type: 'string', description: 'Необов’язково: відділ магазину, якщо відомо' },
            },
            required: ['product', 'quantity', 'unit', 'action'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dishes',
    description: 'Повертає базу страв: назва, прийом, інгредієнти на 1 порцію, скільки днів зберігається, чи улюблена.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'upsert_dish',
    description: 'Додає нову страву або оновлює наявну (за назвою).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        meal: { type: 'string', enum: ['сніданок', 'обід', 'вечеря', 'будь-який'] },
        ingredients: { type: 'string', description: 'На 1 порцію, через крапку з комою: "гречка 80 г; цибуля 0.3 шт; сіль"' },
        keepsDays: { type: 'integer', minimum: 1, maximum: 5 },
        favorite: { type: 'boolean' },
      },
      required: ['name', 'meal', 'ingredients', 'keepsDays', 'favorite'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_dish',
    description: 'Видаляє страву з бази.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'get_menu',
    description: 'Повертає меню від сьогодні як список готувань {date, meal, dish, days} і статус (чернетка/затверджено/немає).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'save_menu',
    description:
      'Зберігає меню. Передавай ПОВНИЙ список готувань від першої дати: усі майбутні рядки меню від цієї дати буде замінено. Кожне готування — страва, яку готують у date і їдять days днів поспіль на цей прийом.',
    input_schema: {
      type: 'object',
      properties: {
        cooks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD' },
              meal: { type: 'string', enum: MEALS },
              dish: { type: 'string', description: 'Точна назва з бази страв' },
              days: { type: 'integer', minimum: 1, maximum: 4 },
            },
            required: ['date', 'meal', 'dish', 'days'],
            additionalProperties: false,
          },
        },
        status: { type: 'string', enum: ['чернетка', 'затверджено'] },
      },
      required: ['cooks', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_shopping_list',
    description: 'Рахує (кодом), чого бракує: меню мінус запаси на N днів вперед, за відділами Biedronka.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 14 } },
      required: ['days'],
      additionalProperties: false,
    },
  },
];

// Моделі, для яких API підтримує серверний fallback при відмові (refusal).
const SUPPORTS_FALLBACK = /^claude-(opus-5|fable-5|sonnet-5-5)/;

export class Agent {
  constructor(env, service) {
    this.env = env;
    this.service = service;
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    this.model = env.CLAUDE_MODEL || 'claude-opus-5-5';
    this.menuSaved = false;
  }

  async runTool(name, input, who) {
    const s = this.service;
    switch (name) {
      case 'get_stock': {
        const stock = await s.getStock();
        return stock.length
          ? stock.map((i) => `${i.name}: ${formatQty(i.qty, i.unit)} (${i.qty} ${i.unit})`).join('\n')
          : 'Запаси порожні.';
      }
      case 'update_stock':
        return s.updateStock(input.changes ?? [], who);
      case 'list_dishes': {
        const dishes = await s.getDishes();
        return dishes
          .map((d) => `${d.name} | ${d.meal || 'будь-який'} | ${d.ingredients} | зберігається ${d.keepsDays} дн.${d.favorite ? ' | ⭐ улюблена' : ''}`)
          .join('\n') || 'База страв порожня.';
      }
      case 'upsert_dish':
        return s.upsertDish(input);
      case 'remove_dish':
        return s.removeDish(input.name);
      case 'get_menu':
        return JSON.stringify(await s.getUpcomingCooks());
      case 'save_menu': {
        const res = await s.saveMenu(input.cooks ?? [], input.status ?? 'чернетка');
        if (res.ok) this.menuSaved = input.status ?? 'чернетка';
        return res.message;
      }
      case 'get_shopping_list': {
        const { items, hasMenu } = await s.shortages(input.days ?? 7);
        if (!hasMenu) return 'Затвердженого меню немає, тож рахувати нічого. Запропонуй скласти меню.';
        return s.formatShoppingList(items);
      }
      default:
        throw new Error(`Невідомий інструмент ${name}`);
    }
  }

  /**
   * Обробляє одне повідомлення. Повертає { text, menuSaved } або null, якщо бот має мовчати.
   * effort: 'low' для звичайних повідомлень, 'medium' для складання меню.
   */
  async handle({ text, who, replyTo, effort = 'low' }) {
    const today = this.service.today();
    const context = [
      `Сьогодні ${today} (${weekday(today)}).`,
      `Повідомлення від: ${who}.`,
      replyTo ? `Це відповідь на повідомлення: «${replyTo.slice(0, 500)}»` : '',
      '',
      text,
    ].filter((l) => l !== '').join('\n');

    const messages = [{ role: 'user', content: context }];

    for (let step = 0; step < MAX_STEPS; step++) {
      const params = {
        model: this.model,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort },
      };
      let response;
      if (SUPPORTS_FALLBACK.test(this.model)) {
        response = await this.client.beta.messages.create({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } else {
        response = await this.client.messages.create(params);
      }

      if (response.stop_reason === 'refusal') {
        return { text: 'Вибач, з цим я допомогти не можу 🙏', menuSaved: this.menuSaved };
      }

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const out = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!out || out.includes(SILENT)) return this.menuSaved ? { text: '', menuSaved: this.menuSaved } : null;
        return { text: out, menuSaved: this.menuSaved };
      }

      // Усі результати інструментів — в одному повідомленні user.
      const results = [];
      for (const tu of toolUses) {
        try {
          const content = await this.runTool(tu.name, tu.input ?? {}, who);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(content) });
        } catch (err) {
          console.error('tool error', tu.name, err);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Помилка: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: 'Щось я заплутався. Спробуйте сформулювати простіше 🙂', menuSaved: this.menuSaved };
  }
}
