import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, normalizeDate, shortDate } from '../src/dates.js';
import { departmentRank, guessDepartment } from '../src/departments.js';
import {
  adjustCoef, cooksFromRows, deductCooked, expandCooks, forecast, groupByDepartment, urgentShortages,
} from '../src/planner.js';
import { STARTER_DISHES } from '../src/seed.js';
import { formatQty, normalize, parseIngredients } from '../src/units.js';

const dishes = [
  { name: 'Гречка з курячими стегнами', ingredients: 'гречка 80 г; курячі стегна 200 г; цибуля 0,5 шт; сіль' },
  { name: 'Вівсянка', ingredients: 'вівсяні пластівці 60 г; молоко 200 мл' },
];

test('normalize зводить кг і л до г і мл', () => {
  assert.deepEqual(normalize('1,5', 'кг'), { qty: 1500, unit: 'г' });
  assert.deepEqual(normalize(2, 'л'), { qty: 2000, unit: 'мл' });
  assert.deepEqual(normalize(10, ''), { qty: 10, unit: 'шт' });
});

test('parseIngredients розбирає кількості, кому й інгредієнти без кількості', () => {
  const list = parseIngredients('Гречка 80 г; цибуля 0,5 шт; сіль');
  assert.deepEqual(list, [
    { name: 'гречка', qty: 80, unit: 'г' },
    { name: 'цибуля', qty: 0.5, unit: 'шт' },
    { name: 'сіль', qty: 0, unit: '' },
  ]);
});

test('formatQty показує кг і округлює штуки вгору', () => {
  assert.equal(formatQty(1500, 'г'), '1.5 кг');
  assert.equal(formatQty(2.3, 'шт'), '3 шт');
  assert.equal(formatQty(250, 'мл'), '250 мл');
});

test('expandCooks розгортає готування на кілька днів і cooksFromRows повертає назад', () => {
  const cooks = [{ date: '2026-11-25', meal: 'обід', dish: 'Гречка з курячими стегнами', days: 3 }];
  const rows = expandCooks(cooks, 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-25', '2026-11-26', '2026-11-27']);
  assert.equal(rows[0].cook, true);
  assert.equal(rows[0].portions, 6);
  assert.equal(rows[1].cook, false);
  assert.deepEqual(cooksFromRows(rows, 2), cooks);
});

test('forecast рахує нестачу з урахуванням запасів і дати', () => {
  const menuRows = expandCooks([
    { date: '2026-11-25', meal: 'обід', dish: 'Гречка з курячими стегнами', days: 2 }, // 4 порції
    { date: '2026-11-27', meal: 'обід', dish: 'Гречка з курячими стегнами', days: 2 }, // ще 4
  ]);
  const stock = [
    { name: 'гречка', qty: 500, unit: 'г' },
    { name: 'курячі стегна', qty: 800, unit: 'г' },
  ];
  const items = forecast({ stock, menuRows, dishes, from: '2026-11-25', to: '2026-12-01' });
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  // гречка: 8 × 80 = 640, є 500 → бракує 140 на 27-ме
  assert.equal(byName['гречка'].missing, 140);
  assert.equal(byName['гречка'].firstDate, '2026-11-27');
  // стегна: 8 × 200 = 1600, є 800 → бракує 800 на 27-ме
  assert.equal(byName['курячі стегна'].missing, 800);
  // цибулі немає зовсім → бракує 4 шт з 25-го
  assert.equal(byName['цибуля'].missing, 4);
  assert.equal(byName['цибуля'].firstDate, '2026-11-25');
  assert.equal(byName['сіль'], undefined);
});

test('forecast враховує коефіцієнт споживання', () => {
  const menuRows = expandCooks([{ date: '2026-11-25', meal: 'сніданок', dish: 'Вівсянка', days: 1 }]);
  const stock = [{ name: 'молоко', qty: 400, unit: 'мл', coef: 1.5 }];
  const items = forecast({ stock, menuRows, dishes, from: '2026-11-25', to: '2026-11-25' });
  const milk = items.find((i) => i.name === 'молоко');
  assert.equal(milk.missing, 200); // 2 × 200 × 1.5 = 600 − 400
});

test('urgentShortages бере лише нестачу на найближчі дні', () => {
  const items = [
    { name: 'a', firstDate: '2026-11-25' },
    { name: 'b', firstDate: '2026-11-26' },
    { name: 'c', firstDate: '2026-11-28' },
  ];
  assert.deepEqual(urgentShortages(items, '2026-11-25', 2).map((i) => i.name), ['a', 'b']);
});

test('deductCooked списує продукти, але не нижче нуля', () => {
  const rows = expandCooks([{ date: '2026-11-24', meal: 'обід', dish: 'Гречка з курячими стегнами', days: 2 }]);
  const stock = [
    { name: 'гречка', qty: 1000, unit: 'г' },
    { name: 'курячі стегна', qty: 300, unit: 'г' },
  ];
  const after = deductCooked({ stock, rows: rows.filter((r) => r.cook), dishes });
  assert.equal(after.find((s) => s.name === 'гречка').qty, 680);
  assert.equal(after.find((s) => s.name === 'курячі стегна').qty, 0);
  assert.equal(stock[0].qty, 1000, 'вхідні дані не змінюються');
});

test('adjustCoef збільшує норму, лише якщо продукт закінчився раніше прогнозу', () => {
  assert.equal(adjustCoef(1, 0), 1);
  assert.equal(adjustCoef(1, 200), 1.15);
  assert.equal(adjustCoef(1.9, 50), 2);
});

test('відділи Biedronka: найдовший збіг і порядок', () => {
  assert.equal(guessDepartment('томатна паста'), 'Консерви, соуси, спеції');
  assert.equal(guessDepartment('паста'), 'Бакалія');
  assert.equal(guessDepartment('курячі стегна'), "М'ясо та риба");
  assert.equal(guessDepartment('цибуля'), 'Овочі та фрукти');
  assert.equal(guessDepartment('щось дивне'), 'Інше');
  const groups = groupByDepartment([
    { name: 'рис', department: 'Бакалія' },
    { name: 'цибуля', department: 'Овочі та фрукти' },
  ]);
  assert.deepEqual(groups.map(([d]) => d), ['Овочі та фрукти', 'Бакалія']);
  assert.ok(departmentRank('Овочі та фрукти') < departmentRank('Інше'));
});

test('стартова база: у кожної страви розбираються інгредієнти', () => {
  for (const d of STARTER_DISHES) {
    const list = parseIngredients(d.ingredients);
    assert.ok(list.length >= 2, d.name);
    assert.ok(list.every((i) => i.qty > 0 && ['г', 'мл', 'шт'].includes(i.unit)), `${d.name}: ${JSON.stringify(list)}`);
  }
});

test('дати', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(normalizeDate('25.11.2026'), '2026-11-25');
  assert.equal(normalizeDate(46351), '2026-11-25');
  assert.equal(shortDate('2026-11-25'), 'Ср 25.11');
});
