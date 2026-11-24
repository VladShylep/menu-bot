// Розбір і нормалізація кількостей: усе зводимо до базових одиниць (г, мл, шт),
// щоб можна було віднімати рецепти від запасів.

const UNIT_ALIASES = {
  г: ['г', 1], гр: ['г', 1], грам: ['г', 1], g: ['г', 1],
  кг: ['г', 1000], kg: ['г', 1000],
  мл: ['мл', 1], ml: ['мл', 1],
  л: ['мл', 1000], l: ['мл', 1000],
  шт: ['шт', 1], штук: ['шт', 1], штуки: ['шт', 1], pcs: ['шт', 1], szt: ['шт', 1],
  уп: ['уп', 1], упак: ['уп', 1], пачка: ['уп', 1], пачки: ['уп', 1],
  'ст.л': ['ст.л', 1], 'ч.л': ['ч.л', 1],
};

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === undefined || value === null) return 0;
  const n = parseFloat(String(value).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Нормалізує кількість до базової одиниці: (1.5, "кг") -> { qty: 1500, unit: "г" } */
export function normalize(qty, unit) {
  const raw = String(unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  const alias = UNIT_ALIASES[raw];
  const q = toNumber(qty);
  if (!raw) return { qty: q, unit: 'шт' };
  if (!alias) return { qty: q, unit: raw };
  return { qty: q * alias[1], unit: alias[0] };
}

export function normName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/ʼ|’/g, "'");
}

export function itemKey(name, unit) {
  return `${normName(name)}|${unit}`;
}

/**
 * Розбирає рядок інгредієнтів страви:
 * "гречка 150 г; курка 200 г; цибуля 0,5 шт; сіль" -> [{name, qty, unit}]
 * Інгредієнти без кількості (сіль, спеції) отримують qty 0 і не враховуються в закупах.
 */
export function parseIngredients(text) {
  return String(text ?? '')
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*([^\d\s]*)$/u);
      if (!m) return { name: normName(part), qty: 0, unit: '' };
      const { qty, unit } = normalize(m[2], m[3]);
      return { name: normName(m[1]), qty, unit };
    });
}

export function formatIngredients(list) {
  return list.map((i) => (i.qty ? `${i.name} ${round(i.qty)} ${i.unit}` : i.name)).join('; ');
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Людський вигляд: 1500 г -> "1.5 кг", 2 шт -> "2 шт" */
export function formatQty(qty, unit) {
  if (unit === 'г' && qty >= 1000) return `${round(qty / 1000, 2)} кг`;
  if (unit === 'мл' && qty >= 1000) return `${round(qty / 1000, 2)} л`;
  if (unit === 'шт' || unit === 'уп') return `${Math.ceil(round(qty, 2))} ${unit}`;
  return `${Math.ceil(qty)} ${unit}`;
}
