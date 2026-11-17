import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTransaction, validateBudget, isValidIsoDate } from "../validation.mjs";

const good = { type: "expense", amount: 12.5, category: "Food", date: "2026-11-01", description: "Lunch" };

test("accepts a valid transaction and returns only allowlisted fields", () => {
  const r = validateTransaction({ ...good, description: "  Lunch  " });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { ...good, description: "Lunch" });
});

test("description is optional", () => {
  const { description, ...rest } = good;
  assert.equal(validateTransaction(rest).ok, true);
});

const badCases = [
  ["negative amount", { amount: -5 }, "amount"],
  ["zero amount", { amount: 0 }, "amount"],
  ["string amount", { amount: "12" }, "amount"],
  ["non-numeric amount", { amount: "abc" }, "amount"],
  ["infinite amount", { amount: Infinity }, "amount"],
  ["missing amount", { amount: undefined }, "amount"],
  ["3-decimal amount", { amount: 1.234 }, "amount"],
  ["huge amount", { amount: 1e12 }, "amount"],
  ["unknown category", { category: "Hacking" }, "category"],
  ["XSS category", { category: "<img src=x onerror=alert(1)>" }, "category"],
  ["bad type", { type: "refund" }, "type"],
  ["XSS type", { type: '"><svg onload=alert(1)>' }, "type"],
  ["numeric date", { date: 123 }, "date"],
  ["impossible date", { date: "2026-13-45" }, "date"],
  ["Feb 30", { date: "2026-02-30" }, "date"],
  ["long description", { description: "x".repeat(201) }, "description"],
  ["non-string description", { description: { a: 1 } }, "description"],
  ["control chars in description", { description: "a\u0000b" }, "description"],
  ["client-supplied id", { id: "abc" }, "fields"],
  ["client-supplied userId", { userId: "someone-else" }, "fields"],
  ["extra field", { isAdmin: true }, "fields"],
];

for (const [name, patch, field] of badCases) {
  test(`rejects ${name}`, () => {
    const r = validateTransaction({ ...good, ...patch });
    assert.equal(r.ok, false);
    assert.ok(r.errors[field], `expected error on ${field}, got ${JSON.stringify(r.errors)}`);
  });
}

test("rejects non-object bodies", () => {
  for (const b of [null, [], "x", 5]) assert.equal(validateTransaction(b).ok, false);
});

test("budget validation", () => {
  assert.deepEqual(validateBudget({ monthlyLimit: 500 }), { ok: true, value: { monthlyLimit: 500 } });
  assert.equal(validateBudget({ monthlyLimit: 0 }).ok, true);
  assert.equal(validateBudget({ monthlyLimit: -1 }).ok, false);
  assert.equal(validateBudget({ monthlyLimit: "500" }).ok, false);
  assert.equal(validateBudget({ monthlyLimit: NaN }).ok, false);
  assert.equal(validateBudget({ monthlyLimit: 5, id: "budget" }).ok, false);
  assert.equal(validateBudget({}).ok, false);
});

test("isValidIsoDate", () => {
  assert.equal(isValidIsoDate("2024-02-29"), true);
  assert.equal(isValidIsoDate("2025-02-29"), false);
  assert.equal(isValidIsoDate("2026-1-1"), false);
});
