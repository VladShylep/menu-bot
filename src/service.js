// Операції над даними, спільні для команд бота, LLM-агента й ранкового Cron.

import { addDays, shortDate, todayISO } from './dates.js';
import { guessDepartment } from './departments.js';
import {
  adjustCoef, cooksFromRows, deductCooked, expandCooks, forecast, groupByDepartment, mealRank, urgentShortages,
} from './planner.js';
import { STARTER_DISHES } from './seed.js';
import { Store } from './store.js';
import { formatQty, normalize, normName, round } from './units.js';

export class Service {
  constructor(env) {
    this.env = env;
    this.store = new Store(env);
    this.tz = env.TIMEZONE || 'Europe/Warsaw';
    this.persons = Number(env.PERSONS) || 2;
    this.horizon = Number(env.FORECAST_DAYS) || 2;
  }

  today() {
    return todayISO(this.tz);
  }

  // ---------- Налаштування ----------

  async setup() {
    const created = await this.store.ensureTabs();
    const dishes = await this.store.read('dishes');
    let seeded = 0;
    if (dishes.length === 0) {
      await this.store.write('dishes', STARTER_DISHES);
      seeded = STARTER_DISHES.length;
    }
    return { created, seeded };
  }

  // ---------- Запаси ----------

  async getStock() {
    return (await this.store.read('stock')).filter((s) => s.name);
  }

  /**
   * changes: [{ product, quantity, unit, action: 'bought'|'add'|'used'|'set'|'ran_out', department? }]
   * Повертає людський звіт для агента.
   */
  async updateStock(changes, who) {
    const stock = await this.getStock();
    const today = this.today();
    const purchases = [];
    const report = [];

    for (const ch of changes) {
      const name = normName(ch.product);
      if (!name) continue;
      const { qty, unit } = normalize(ch.quantity ?? 0, ch.unit || '');
      let item = stock.find((s) => s.name === name && (ch.action === 'ran_out' || !ch.unit || s.unit === unit));
      if (!item && ch.action !== 'ran_out') {
        const other = stock.find((s) => s.name === name);
        if (other && other.unit !== unit) {
          report.push(`⚠️ «${name}» у запасах ведеться в «${other.unit}», а прийшло «${unit}». Перерахуй у ${other.unit} і повтори.`);
          continue;
        }
      }
      if (!item) {
        item = { name, qty: 0, unit: ch.action === 'ran_out' ? 'шт' : unit, department: ch.department || guessDepartment(name), coef: 1 };
        stock.push(item);
      }
      if (ch.department) item.department = ch.department;

      switch (ch.action) {
        case 'bought':
        case 'add':
          item.qty = round(item.qty + qty);
          if (ch.action === 'bought') purchases.push({ date: today, who, name, qty: round(qty), unit: item.unit });
          report.push(`+ ${name}: тепер ${formatQty(item.qty, item.unit)}`);
          break;
        case 'used':
          item.qty = round(Math.max(0, item.qty - qty));
          report.push(`− ${name}: лишилось ${formatQty(item.qty, item.unit)}`);
          break;
        case 'set':
          item.qty = round(qty);
          report.push(`= ${name}: ${formatQty(item.qty, item.unit)}`);
          break;
        case 'ran_out': {
          const newCoef = adjustCoef(item.coef, item.qty);
          const note = newCoef !== item.coef ? ` (закінчилось раніше прогнозу, норму збільшено: ×${newCoef})` : '';
          item.coef = newCoef;
          item.qty = 0;
          report.push(`✗ ${name}: закінчився${note}`);
          break;
        }
        default:
          report.push(`? невідома дія «${ch.action}» для ${name}`);
          continue;
      }
      item.updatedAt = today;
      item.updatedBy = who;
    }

    await this.store.write('stock', stock.sort((a, b) => a.name.localeCompare(b.name, 'uk')));
    await this.store.append('purchases', purchases);
    return report.join('\n') || 'Нічого не змінено.';
  }

  formatStock(stock) {
    const items = stock.filter((s) => s.qty > 0);
    if (!items.length) return 'Запаси порожні. Напишіть у групу, що купили, наприклад: «купив 1 кг гречки і 10 яєць».';
    return groupByDepartment(items.map((s) => ({ ...s, department: s.department || guessDepartment(s.name) })))
      .map(([dept, list]) => `${dept}:\n${list.map((s) => `  • ${s.name} — ${formatQty(s.qty, s.unit)}`).join('\n')}`)
      .join('\n\n');
  }

  // ---------- Страви ----------

  async getDishes() {
    return (await this.store.read('dishes')).filter((d) => d.name);
  }

  async upsertDish(dish) {
    const dishes = await this.getDishes();
    const i = dishes.findIndex((d) => normName(d.name) === normName(dish.name));
    const merged = { ...(i >= 0 ? dishes[i] : {}), ...dish };
    if (i >= 0) dishes[i] = merged;
    else dishes.push(merged);
    await this.store.write('dishes', dishes);
    return i >= 0 ? `Страву «${dish.name}» оновлено.` : `Страву «${dish.name}» додано.`;
  }

  async removeDish(name) {
    const dishes = await this.getDishes();
    const left = dishes.filter((d) => normName(d.name) !== normName(name));
    if (left.length === dishes.length) return `Страви «${name}» немає в базі.`;
    await this.store.write('dishes', left);
    return `Страву «${name}» видалено.`;
  }

  // ---------- Меню ----------

  async getMenuRows() {
    return (await this.store.read('menu')).filter((r) => r.date && r.dish);
  }

  /** Меню від сьогодні у вигляді «готувань» (зручно для агента). */
  async getUpcomingCooks() {
    const today = this.today();
    const rows = await this.getMenuRows();
    const upcoming = rows.filter((r) => r.date >= today);
    return {
      today,
      status: upcoming.some((r) => r.status === 'чернетка') ? 'чернетка' : upcoming.length ? 'затверджено' : 'немає',
      cooks: cooksFromRows(upcoming, this.persons),
    };
  }

  /**
   * Зберігає меню: усі майбутні рядки від найранішої дати нового меню замінюються.
   * status: 'чернетка' (нове меню, чекає затвердження) або 'затверджено' (правка затвердженого).
   */
  async saveMenu(cooks, status = 'чернетка') {
    const dishes = await this.getDishes();
    const known = new Set(dishes.map((d) => normName(d.name)));
    const unknown = [...new Set(cooks.map((c) => c.dish).filter((d) => !known.has(normName(d))))];
    if (unknown.length) {
      return { ok: false, message: `Цих страв немає в базі: ${unknown.join(', ')}. Спершу додай їх через upsert_dish з інгредієнтами.` };
    }
    const newRows = expandCooks(cooks, this.persons).map((r) => ({ ...r, status }));
    if (!newRows.length) return { ok: false, message: 'Порожнє меню.' };
    const start = newRows[0].date;
    const old = await this.getMenuRows();
    const keep = old.filter((r) => r.date < start && r.date >= addDays(this.today(), -14)); // історія за 2 тижні
    await this.store.write('menu', [...keep, ...newRows]);
    return { ok: true, message: `Меню збережено (${status}), ${newRows.length} рядків від ${start}.` };
  }

  async approveMenu() {
    const rows = await this.getMenuRows();
    let changed = 0;
    for (const r of rows) {
      if (r.status === 'чернетка') {
        r.status = 'затверджено';
        changed++;
      }
    }
    if (changed) await this.store.write('menu', rows);
    return changed;
  }

  async formatMenu() {
    const today = this.today();
    const rows = (await this.getMenuRows()).filter((r) => r.date >= today);
    if (!rows.length) return 'Меню ще немає. Напишіть /menu, і я складу його на тиждень.';
    const byDate = new Map();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const lines = [];
    for (const [date, list] of [...byDate.entries()].sort()) {
      lines.push(`📅 ${shortDate(date)}`);
      for (const r of list.sort((a, b) => mealRank(a.meal) - mealRank(b.meal))) {
        const cook = r.cook ? ` 🍳 готуємо на ${Math.round(r.portions / this.persons)} дн.` : '';
        lines.push(`  ${r.meal}: ${r.dish}${cook}`);
      }
    }
    const draft = rows.some((r) => r.status === 'чернетка');
    return `${draft ? '📝 Чернетка меню' : '✅ Меню'}\n\n${lines.join('\n')}`;
  }

  // ---------- Покупки й прогноз ----------

  async shortages(days = 7) {
    const today = this.today();
    const [stock, menuRows, dishes] = await Promise.all([this.getStock(), this.getMenuRows(), this.getDishes()]);
    const approved = menuRows.filter((r) => r.status !== 'чернетка');
    return {
      today,
      hasMenu: approved.some((r) => r.date >= today),
      items: forecast({ stock, menuRows: approved, dishes, from: today, to: addDays(today, days - 1) }),
    };
  }

  formatShoppingList(items, title = '🛒 Список покупок (Biedronka)') {
    if (!items.length) return 'Усе є, докуповувати нічого не треба 👌';
    const body = groupByDepartment(items)
      .map(([dept, list]) => `${dept}:\n${list.map((i) => `  ☐ ${i.name} — ${formatQty(i.missing, i.unit)}`).join('\n')}`)
      .join('\n\n');
    return `${title}\n\n${body}`;
  }

  /**
   * Ранкова перевірка (Cron): списати продукти вчорашніх готувань, порахувати прогноз
   * і повернути текст для групи (або null, якщо писати нічого не треба).
   */
  async morningCheck() {
    const today = this.today();
    const [stock, menuRows, dishes] = await Promise.all([this.getStock(), this.getMenuRows(), this.getDishes()]);

    // 1. Списання: готування з минулих днів, які ще не списані.
    const toDeduct = menuRows.filter((r) => r.cook && r.date < today && r.status !== 'чернетка' && !r.deducted);
    let currentStock = stock;
    if (toDeduct.length) {
      currentStock = deductCooked({ stock, rows: toDeduct, dishes });
      for (const r of toDeduct) r.deducted = true;
      await this.store.write('stock', currentStock);
      await this.store.write('menu', menuRows);
    }

    // 2. Прогноз.
    const approved = menuRows.filter((r) => r.status !== 'чернетка');
    const lastMenuDate = approved.map((r) => r.date).sort().at(-1);
    const messages = [];
    if (!lastMenuDate || lastMenuDate <= addDays(today, 1)) {
      messages.push({ text: '📋 Меню закінчується. Скласти нове на тиждень? Напишіть /menu', ask: false });
    }
    const items = forecast({ stock: currentStock, menuRows: approved, dishes, from: today, to: addDays(today, 6) });
    const urgent = urgentShortages(items, today, this.horizon);
    if (urgent.length) {
      const soon = urgent.map((i) => `• ${i.name} — ${formatQty(i.missing, i.unit)} (на ${shortDate(i.firstDate)})`).join('\n');
      messages.push({
        text: `🛒 Сьогодні варто скупитись: на найближчі дні бракує\n${soon}\n\nПовний список на тиждень — ${items.length} позицій. Йдете?`,
        ask: true,
      });
    }
    return messages;
  }
}
