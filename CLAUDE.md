# SPEC.md — Student Money Manager (MVP)

## 1. Product Overview

### 1.1 Purpose
Student Money Manager is a lightweight, browser-based personal finance tracker aimed at
college students. It lets a student record income and expense transactions, tag them with a
category, see their overall balance, track monthly totals, and monitor spending against a
self-set monthly budget.

### 1.2 Target User
A single student using their own browser on their own device. No multi-user support, no
sharing, no accounts.

### 1.3 Non-Goals (explicitly out of scope for MVP)
- User authentication / login
- Multi-user accounts or data sharing
- A backend server or database
- Cloud hosting or sync across devices
- Payment processing or bank integration
- Recurring/auto-generated transactions
- Multi-currency support
- Data export/import (nice-to-have, not required)

### 1.4 Technology Constraints
- Runs entirely in the browser (HTML/CSS/JavaScript).
- No server-side component.
- All data is persisted using the browser's `localStorage` API.
- Should run as a single static page (or a small set of static files) with no build step
  required, to keep it approachable for an intro software engineering class.

---

## 2. Data Model

### 2.1 Transaction
Each recorded transaction is an object with the following fields:

| Field       | Type                    | Required | Description                                              |
|-------------|-------------------------|----------|------------------------------------------------------------|
| `id`        | string (UUID or timestamp-based) | Yes | Unique identifier for the transaction                     |
| `type`      | enum: `"income"` \| `"expense"` | Yes | Whether the transaction adds to or subtracts from balance |
| `amount`    | number (positive, > 0)  | Yes      | Transaction amount, stored as a positive number regardless of type |
| `category`  | string                  | Yes      | Category label (see 2.3)                                  |
| `description` | string                | No       | Optional free-text note (e.g., "Chipotle with roommates") |
| `date`      | string (ISO 8601, `YYYY-MM-DD`) | Yes | Date the transaction occurred                             |
| `createdAt` | string (ISO 8601 timestamp) | Yes  | When the record was created, used for tie-breaking/sort   |

**Sign convention:** `amount` is always stored as a positive number. Whether it increases or
decreases the balance is determined solely by `type`. This avoids sign-related bugs in
calculations.

### 2.2 Budget
A single object representing the student's monthly expense budget:

| Field         | Type   | Required | Description                                   |
|---------------|--------|----------|------------------------------------------------|
| `monthlyLimit`| number (>= 0) | Yes | The budgeted maximum for total monthly expenses |

The MVP supports **one active budget value** that applies to the current and future months
(no per-month or per-category budgets in the MVP).

### 2.3 Category
A fixed, predefined list is sufficient for the MVP (no user-defined categories required,
though it's an easy future enhancement):

- Food
- Transportation
- Books & Supplies
- Entertainment
- Rent/Housing
- Scholarship/Financial Aid
- Part-Time Job
- Family Support
- Other

Categories apply to both income and expense transactions (e.g., "Scholarship" and "Part-Time
Job" are typically income; "Food" and "Rent" are typically expense). The UI does not need to
restrict which categories pair with which type in the MVP.

### 2.4 localStorage Schema
All application data is stored under a small number of namespaced keys:

```json
{
  "smm.transactions": [ /* array of Transaction objects */ ],
  "smm.budget": { "monthlyLimit": 500 }
}
```

- `smm.transactions`: JSON-stringified array of Transaction objects.
- `smm.budget`: JSON-stringified Budget object. If absent, the app treats the budget as unset
  (`monthlyLimit = 0` or "no budget configured", displayed accordingly).

---

## 3. Functional Requirements

### FR-1: Add Income Transaction
The user can enter an amount, category, date, and optional description, and submit it as an
income transaction. On success, it is added to the transaction list and persisted to
localStorage immediately.

### FR-2: Add Expense Transaction
Same as FR-1, but recorded with `type = "expense"`.

### FR-3: Categorize Transactions
Every transaction (income or expense) must be assigned exactly one category from the
predefined list at creation time.

### FR-4: Display All Transactions
The app displays a list/table of all recorded transactions, showing at minimum: date, type,
category, amount, and description. Transactions are sorted by date (most recent first) by
default.

### FR-5: Calculate Current Balance
The app computes and displays:

```
balance = sum(all income amounts) - sum(all expense amounts)
```

across **all transactions ever recorded** (not just the current month).

### FR-6: Calculate Monthly Income Total
The app computes and displays the sum of all income transactions whose `date` falls within
the current calendar month (based on the device's local date).

### FR-7: Calculate Monthly Expense Total
The app computes and displays the sum of all expense transactions whose `date` falls within
the current calendar month.

### FR-8: Set Monthly Budget
The user can input a monthly expense budget amount. This value is saved and reused across
sessions until changed.

### FR-9: Show Budget Usage
The app displays:
- Total spent this month (from FR-7)
- The configured monthly budget (from FR-8)
- Percentage of budget used: `(monthlyExpenseTotal / monthlyLimit) * 100`, capped at a
  sensible display (e.g., shown as ">100%" or highlighted when exceeded)
- A clear visual/text indicator when the budget has been exceeded

If no budget has been set, the app indicates "No budget set" instead of showing a percentage.

### FR-10: Persist Data
All transactions and the budget value are saved to `localStorage` on every change (add
transaction, update budget) and reloaded automatically when the app is opened again, with no
user action required to "save."

### FR-11: Delete a Transaction (minimal editing support)
The user can delete a mistakenly entered transaction. This is included as a minimum because
without it, input errors are permanent and the app becomes frustrating to use. (Editing a
transaction is a nice-to-have, not required.)

---

## 4. Validation Rules

| Rule ID | Field       | Rule                                                                 |
|---------|-------------|-----------------------------------------------------------------------|
| V-1     | `amount`    | Required. Must be a valid number, greater than 0. Reject 0, negative, non-numeric, or blank input. |
| V-2     | `type`      | Required. Must be exactly `"income"` or `"expense"`.                 |
| V-3     | `category`  | Required. Must be one of the predefined category values.             |
| V-4     | `date`      | Required. Must be a valid calendar date. Should not be arbitrarily far in the future (recommend: warn, but do not block, if date is in the future — students may pre-log a known expense). |
| V-5     | `description` | Optional. If present, reasonable max length (e.g., 200 characters) to avoid UI breakage. |
| V-6     | `monthlyLimit` (budget) | Required to set a budget. Must be a valid number >= 0. |
| V-7     | Form submission | The "Add Transaction" action must be rejected (with a visible error message) if any required field fails validation. No partial/invalid transaction is ever written to localStorage. |

**Error handling principle:** validation errors are shown inline near the offending field(s);
the app never silently drops or "fixes" invalid input.

---

## 5. Calculations — Reference Definitions

To avoid ambiguity, calculations are defined precisely here:

- **Current month** = the calendar month and year of "today" according to the user's local
  device clock at the time the page is viewed (not the date of the oldest/newest transaction).
- **Balance** = lifetime sum of income minus lifetime sum of expenses, across all recorded
  transactions regardless of date.
- **Monthly Income Total** = sum of `amount` for all transactions where `type = "income"` and
  `date` is within the current month.
- **Monthly Expense Total** = sum of `amount` for all transactions where `type = "expense"`
  and `date` is within the current month.
- **Budget Used %** = `monthlyExpenseTotal / monthlyLimit * 100`, undefined/"N/A" if
  `monthlyLimit` is 0 or unset.

All monetary calculations should be done carefully with floating point (e.g., round to 2
decimal places for display) to avoid cent-level rounding artifacts.

---

## 6. Acceptance Criteria

The MVP is considered complete when all of the following are true:

1. **AC-1:** A user can add an income transaction with amount, category, date, and optional
   description, and it appears in the transaction list immediately.
2. **AC-2:** A user can add an expense transaction the same way, and it appears in the list.
3. **AC-3:** Every transaction shown in the list displays its assigned category.
4. **AC-4:** The transaction list shows all transactions ever added, most recent first by
   default.
5. **AC-5:** The displayed balance always equals (sum of all income) − (sum of all expenses),
   verified by manually adding a few transactions and checking the math.
6. **AC-6:** The displayed "Income this month" total only includes income transactions dated
   within the current calendar month.
7. **AC-7:** The displayed "Expenses this month" total only includes expense transactions
   dated within the current calendar month.
8. **AC-8:** A user can set a monthly budget value, and it persists after reloading the page.
9. **AC-9:** The budget usage display correctly shows amount spent vs. budget, and visually/
   textually flags when spending has exceeded the budget.
10. **AC-10:** After adding transactions and/or setting a budget, reloading the browser page
    (or closing and reopening the browser) preserves all previously entered data, with no
    server involved.
11. **AC-11:** Submitting the add-transaction form with a missing or invalid amount, missing
    category, or missing date is rejected with a visible error, and no bad data is saved.
12. **AC-12:** A user can delete a transaction, and after deletion, the balance and monthly
    totals recalculate correctly.
13. **AC-13:** The application works with no network connection after the initial page load
    (no dependency on a backend for any of the above).

---

## 7. Suggested Simple Architecture (for an intro-level implementation)

This is guidance, not a hard requirement, to keep the build approachable:

- **`index.html`** — page structure: forms for adding transactions and setting budget,
  containers for the transaction list and summary stats.
- **`app.js`** — single JavaScript file containing:
  - A `Storage` module: `loadTransactions()`, `saveTransactions()`, `loadBudget()`,
    `saveBudget()` — thin wrappers around `localStorage.getItem`/`setItem` with
    `JSON.parse`/`JSON.stringify`.
  - A `Transactions` module: `addTransaction()`, `deleteTransaction()`, `getAll()`.
  - A `Calculations` module: `getBalance()`, `getMonthlyIncome()`, `getMonthlyExpenses()`,
    `getBudgetUsage()`.
  - A `UI` module/set of functions: render the transaction list, render summary numbers,
    handle form submit events, handle validation error display.
- **`style.css`** — basic layout/styling (not a functional requirement, but improves
  usability).

No frameworks, bundlers, or build tools are required. This keeps the codebase small enough
to be read end-to-end by a student new to software engineering.

---

## 8. Open Questions / Future Enhancements (not part of MVP)
- Editing existing transactions (vs. delete + re-add).
- User-defined custom categories.
- Per-category budgets, or budgets that vary month to month.
- Charts/graphs of spending by category.
- Export to CSV.
- Multiple budget periods (weekly, semester-based).
