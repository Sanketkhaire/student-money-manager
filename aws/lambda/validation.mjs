// Server-side validation for Student Money Manager (spec rules V-1 to V-6).
// The browser has its own checks, but this module is the security boundary:
// nothing reaches DynamoDB unless it passes here (checklist.md §4).

export const TYPES = Object.freeze(["income", "expense"]);

export const CATEGORIES = Object.freeze([
  "Food",
  "Transportation",
  "Books & Supplies",
  "Entertainment",
  "Rent/Housing",
  "Scholarship/Financial Aid",
  "Part-Time Job",
  "Family Support",
  "Other",
]);

export const MAX_AMOUNT = 1_000_000;
export const MAX_BUDGET = 10_000_000;
export const MAX_DESCRIPTION = 200;

const TXN_FIELDS = new Set(["type", "amount", "category", "description", "date"]);
const BUDGET_FIELDS = new Set(["monthlyLimit"]);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasAtMostTwoDecimals(n) {
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

function unexpectedFields(obj, allowed) {
  return Object.keys(obj).filter(k => !allowed.has(k));
}

export function isValidIsoDate(value) {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isValidId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Validates a create-transaction body.
 * Returns { ok: true, value } with ONLY the allowlisted, normalised fields,
 * or { ok: false, errors } describing every problem.
 */
export function validateTransaction(body) {
  if (!isPlainObject(body)) return { ok: false, errors: { body: "Body must be a JSON object." } };

  const errors = {};
  const extra = unexpectedFields(body, TXN_FIELDS);
  if (extra.length) errors.fields = `Unexpected field(s): ${extra.join(", ")}`;

  const { type, amount, category, description, date } = body;

  if (!TYPES.includes(type)) errors.type = "type must be 'income' or 'expense'.";

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    errors.amount = "amount must be a number.";
  } else if (amount <= 0) {
    errors.amount = "amount must be greater than 0.";
  } else if (amount > MAX_AMOUNT) {
    errors.amount = `amount must be at most ${MAX_AMOUNT}.`;
  } else if (!hasAtMostTwoDecimals(amount)) {
    errors.amount = "amount must have at most 2 decimal places.";
  }

  if (!CATEGORIES.includes(category)) errors.category = "category must be one of the predefined categories.";

  if (!isValidIsoDate(date)) errors.date = "date must be a real calendar date in YYYY-MM-DD format.";

  let cleanDescription = "";
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") {
      errors.description = "description must be a string.";
    } else {
      cleanDescription = description.trim();
      if (cleanDescription.length > MAX_DESCRIPTION) {
        errors.description = `description must be ${MAX_DESCRIPTION} characters or fewer.`;
      } else if (CONTROL_CHARS_RE.test(cleanDescription)) {
        errors.description = "description contains invalid characters.";
      }
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      type,
      amount: Math.round(amount * 100) / 100,
      category,
      description: cleanDescription,
      date,
    },
  };
}

export function validateBudget(body) {
  if (!isPlainObject(body)) return { ok: false, errors: { body: "Body must be a JSON object." } };

  const errors = {};
  const extra = unexpectedFields(body, BUDGET_FIELDS);
  if (extra.length) errors.fields = `Unexpected field(s): ${extra.join(", ")}`;

  const { monthlyLimit } = body;
  if (typeof monthlyLimit !== "number" || !Number.isFinite(monthlyLimit)) {
    errors.monthlyLimit = "monthlyLimit must be a number.";
  } else if (monthlyLimit < 0) {
    errors.monthlyLimit = "monthlyLimit must be 0 or more.";
  } else if (monthlyLimit > MAX_BUDGET) {
    errors.monthlyLimit = `monthlyLimit must be at most ${MAX_BUDGET}.`;
  } else if (!hasAtMostTwoDecimals(monthlyLimit)) {
    errors.monthlyLimit = "monthlyLimit must have at most 2 decimal places.";
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { monthlyLimit: Math.round(monthlyLimit * 100) / 100 } };
}
