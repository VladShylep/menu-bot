// Чиста логіка без мережі: меню -> потреби в продуктах -> прогноз нестачі -> список покупок.
// Тут немає LLM: усі розрахунки детерміновані й покриті тестами.

import { addDays } from './dates.js';
import { departmentRank, guessDepartment } from './departments.js';
import { itemKey, normName, parseIngredients } from './units.js';

/**
 * Розгортає «готування» у рядки меню.
 * cook = { date, meal, dish, days } -> days рядків; перший має cook=true і порції на всі дні.
 */
export function expandCooks(cooks, persons = 2) {
  const rows = [];
  for (const c of cooks) {
    const days = Math.max(1, Math.round(Number(c.days) || 1));
    for (let i = 0; i < days; i++) {
      rows.push({
        date: addDays(c.date, i),
        meal: c.meal,
        dish: c.dish,
        cook: i === 0,
        portions: i === 0 ? days * persons : 0,
      });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || mealRank(a.meal) - mealRank(b.meal));
}

/** Зворотне перетворення рядків меню у «готування» (для показу агенту й редагування). */
export function cooksFromRows(rows, persons = 2) {
  return rows
    .filter((r) => r.cook)
    .map((r) => ({ date: r.date, meal: r.meal, dish: r.dish, days: Math.max(1, Math.round((r.portions || persons) / persons)) }));
}

export const MEALS = ['сніданок', 'обід', 'вечеря'];
export function mealRank(meal) {
  const i = MEALS.indexOf(String(meal).toLowerCase());
  return i === -1 ? MEALS.length : i;
}

export function dishIndex(dishes) {
  const map = new Map();
  for (const d of dishes) map.set(normName(d.name), d);
  return map;
}

/** Потреби одного готування: інгредієнти на 1 порцію × кількість порцій × коефіцієнт продукту. */
export function needsForCook(row, dishesByName, coefs = new Map()) {
  const dish = dishesByName.get(normName(row.dish));
  if (!dish) return [];
  return parseIngredients(dish.ingredients)
    .filter((i) => i.qty > 0)
    .map((i) => ({
      name: i.name,
      unit: i.unit,
      qty: i.qty * (row.portions || 0) * (coefs.get(i.name) ?? 1),
    }));
}

export function stockMap(stock) {
  const map = new Map();
  for (const s of stock) {
    const key = itemKey(s.name, s.unit);
    map.set(key, (map.get(key) ?? 0) + (Number(s.qty) || 0));
  }
  return map;
}

export function coefMap(stock) {
  const map = new Map();
  for (const s of stock) if (s.coef && s.coef !== 1) map.set(normName(s.name), Number(s.coef));
  return map;
}

/**
 * Прогноз: проходимо готування за датами й віднімаємо від запасів.
 * Повертає продукти, яких забракне: скільки докупити і на яку дату вперше бракує.
 */
export function forecast({ stock, menuRows, dishes, from, to }) {
  const byName = dishIndex(dishes);
  const coefs = coefMap(stock);
  const running = stockMap(stock);
  const departments = new Map(stock.filter((s) => s.department).map((s) => [normName(s.name), s.department]));
  const shortages = new Map();

  const cooks = menuRows
    .filter((r) => r.cook && r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || mealRank(a.meal) - mealRank(b.meal));

  for (const row of cooks) {
    for (const need of needsForCook(row, byName, coefs)) {
      const key = itemKey(need.name, need.unit);
      const left = (running.get(key) ?? 0) - need.qty;
      running.set(key, left);
      if (left < -1e-9) {
        const prev = shortages.get(key);
        shortages.set(key, {
          name: need.name,
          unit: need.unit,
          missing: -left,
          firstDate: prev?.firstDate ?? row.date,
          department: departments.get(need.name) ?? guessDepartment(need.name),
        });
      }
    }
  }
  return [...shortages.values()].sort(
    (a, b) => departmentRank(a.department) - departmentRank(b.department) || a.name.localeCompare(b.name, 'uk'),
  );
}

/** Чи пора в магазин: чогось бракує на найближчі horizonDays днів (сьогодні включно). */
export function urgentShortages(shortages, today, horizonDays = 2) {
  const last = addDays(today, Math.max(1, horizonDays) - 1);
  return shortages.filter((s) => s.firstDate <= last);
}

/** Групує список покупок за відділами в порядку магазину. */
export function groupByDepartment(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.department)) groups.set(it.department, []);
    groups.get(it.department).push(it);
  }
  return [...groups.entries()].sort((a, b) => departmentRank(a[0]) - departmentRank(b[0]));
}

/** Списання: продукти зготованих страв віднімаються від запасів (не нижче нуля). */
export function deductCooked({ stock, rows, dishes }) {
  const byName = dishIndex(dishes);
  const coefs = coefMap(stock);
  const result = stock.map((s) => ({ ...s }));
  for (const row of rows) {
    for (const need of needsForCook(row, byName, coefs)) {
      const item = result.find((s) => itemKey(s.name, s.unit) === itemKey(need.name, need.unit));
      if (item) item.qty = Math.max(0, (Number(item.qty) || 0) - need.qty);
    }
  }
  return result;
}

/**
 * Продукт закінчився раніше прогнозу: якщо за обліком ще мало лишатися expectedLeft,
 * збільшуємо коефіцієнт споживання (до 2.0). Повертає новий коефіцієнт.
 */
export function adjustCoef(currentCoef, expectedLeft) {
  const coef = Number(currentCoef) || 1;
  if (!(expectedLeft > 0)) return coef;
  return Math.min(2, Math.round(coef * 1.15 * 100) / 100);
}
