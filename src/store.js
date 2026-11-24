// Доступ до даних у Google Sheets. Кожна вкладка = таблиця з заголовками в першому рядку.
// Даних мало (десятки рядків), тому читаємо/пишемо вкладку цілком — так простіше й надійніше.

import { normalizeDate } from './dates.js';
import { Sheets } from './sheets.js';
import { normName, toNumber } from './units.js';

export const TABS = {
  stock: {
    title: 'Запаси',
    columns: [
      ['name', 'Продукт'],
      ['qty', 'Кількість'],
      ['unit', 'Одиниця'],
      ['department', 'Відділ'],
      ['coef', 'Коефіцієнт'],
      ['updatedAt', 'Оновлено'],
      ['updatedBy', 'Хто'],
    ],
  },
  dishes: {
    title: 'Страви',
    columns: [
      ['name', 'Назва'],
      ['meal', 'Прийом'],
      ['ingredients', 'Інгредієнти на 1 порцію'],
      ['keepsDays', 'Зберігається днів'],
      ['favorite', 'Улюблена'],
    ],
  },
  menu: {
    title: 'Меню',
    columns: [
      ['date', 'Дата'],
      ['meal', 'Прийом'],
      ['dish', 'Страва'],
      ['cook', 'Готувати'],
      ['portions', 'Порцій'],
      ['status', 'Статус'],
      ['deducted', 'Списано'],
    ],
  },
  purchases: {
    title: 'Покупки',
    columns: [
      ['date', 'Дата'],
      ['who', 'Хто'],
      ['name', 'Продукт'],
      ['qty', 'Кількість'],
      ['unit', 'Одиниця'],
    ],
  },
};

const yes = (v) => v === true || /^(так|true|1|yes|y|\+)$/i.test(String(v ?? '').trim());

const PARSERS = {
  stock: (r) => ({ ...r, name: normName(r.name), qty: toNumber(r.qty), unit: String(r.unit || 'шт'), coef: toNumber(r.coef) || 1 }),
  dishes: (r) => ({ ...r, name: String(r.name).trim(), meal: String(r.meal || '').toLowerCase(), keepsDays: toNumber(r.keepsDays) || 2, favorite: yes(r.favorite) }),
  menu: (r) => ({ ...r, date: normalizeDate(r.date), meal: String(r.meal).toLowerCase(), cook: yes(r.cook), portions: toNumber(r.portions), deducted: yes(r.deducted) }),
  purchases: (r) => r,
};

const FORMATTERS = {
  cook: (v) => (v ? 'так' : ''),
  deducted: (v) => (v ? 'так' : ''),
  favorite: (v) => (v ? 'так' : ''),
};

export class Store {
  constructor(env) {
    this.sheets = new Sheets({ spreadsheetId: env.SPREADSHEET_ID, serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON });
  }

  async read(kind) {
    const tab = TABS[kind];
    const values = await this.sheets.getValues(tab.title, 'A1:Z');
    if (values.length === 0) return [];
    const header = values[0].map((h) => String(h).trim());
    const idx = tab.columns.map(([, label]) => header.indexOf(label));
    return values
      .slice(1)
      .filter((row) => row.some((c) => String(c ?? '').trim() !== ''))
      .map((row) => {
        const obj = {};
        tab.columns.forEach(([key], i) => {
          obj[key] = idx[i] >= 0 ? (row[idx[i]] ?? '') : '';
        });
        return PARSERS[kind](obj);
      });
  }

  toRow(kind, obj) {
    return TABS[kind].columns.map(([key]) => {
      const v = obj[key];
      if (FORMATTERS[key]) return FORMATTERS[key](v);
      return v ?? '';
    });
  }

  async write(kind, rows) {
    const tab = TABS[kind];
    const header = tab.columns.map(([, label]) => label);
    await this.sheets.clear(tab.title, 'A2:Z');
    await this.sheets.updateValues(tab.title, 'A1', [header, ...rows.map((r) => this.toRow(kind, r))]);
  }

  async append(kind, rows) {
    if (!rows.length) return;
    await this.sheets.appendValues(TABS[kind].title, rows.map((r) => this.toRow(kind, r)));
  }

  /** Створює відсутні вкладки й заголовки. Повертає список створених вкладок. */
  async ensureTabs() {
    const existing = await this.sheets.sheetTitles();
    const missing = Object.values(TABS).filter((t) => !existing.includes(t.title));
    await this.sheets.addSheets(missing.map((t) => t.title));
    for (const tab of Object.values(TABS)) {
      const head = await this.sheets.getValues(tab.title, 'A1:Z1');
      if (!head.length || !head[0].length) {
        await this.sheets.updateValues(tab.title, 'A1', [tab.columns.map(([, label]) => label)]);
      }
    }
    return missing.map((t) => t.title);
  }
}
