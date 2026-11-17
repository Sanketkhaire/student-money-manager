'use strict';

/* ============================================================
   Student Money Manager — app.js
   Modules: Storage, Transactions, Calculations, UI
   Backend: AWS API Gateway (Cognito JWT) -> Lambda -> DynamoDB

   Security notes (see checklist.md):
   - Data from the server is NEVER inserted as an HTML string. All dynamic
     content is built with createElement/textContent (§3).
   - Server records are shape-checked before use, so one malformed record
     can't break rendering for the rest (§4).
   - Every API call carries the user's Cognito access token (§1).
   ============================================================ */

const CONFIG = window.SMM_CONFIG || {};
const MAX_PAGES = 50;

const CATEGORIES = [
  { name: 'Food', icon: '🍔' },
  { name: 'Transportation', icon: '🚌' },
  { name: 'Books & Supplies', icon: '📚' },
  { name: 'Entertainment', icon: '🎬' },
  { name: 'Rent/Housing', icon: '🏠' },
  { name: 'Scholarship/Financial Aid', icon: '🎓' },
  { name: 'Part-Time Job', icon: '💼' },
  { name: 'Family Support', icon: '👪' },
  { name: 'Other', icon: '🗂️' },
];

const CATEGORY_ICON = new Map(CATEGORIES.map(c => [c.name, c.icon]));
const TYPES = ['income', 'expense'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function iconFor(category) {
  return CATEGORY_ICON.get(category) || '🗂️';
}

function todayISO() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatMoney(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(round2(n)).toFixed(2)}`;
}

function formatDate(isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DATE_RE.test(isoDate)) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Defensive shape check on records coming back from the server. */
function isWellFormedTxn(t) {
  return t !== null && typeof t === 'object'
    && typeof t.id === 'string'
    && TYPES.includes(t.type)
    && typeof t.amount === 'number' && Number.isFinite(t.amount) && t.amount > 0
    && typeof t.category === 'string'
    && typeof t.date === 'string' && ISO_DATE_RE.test(t.date)
    && (t.description === undefined || typeof t.description === 'string');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class AuthError extends Error {}

/* ----------------------- Storage module ----------------------- */
/* Thin wrapper around the AWS API (API Gateway -> Lambda -> DynamoDB). */
const Storage = (() => {
  async function request(path, options = {}) {
    const token = Auth.getAccessToken();
    if (!token) throw new AuthError('Not signed in.');

    const res = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (res.status === 401) {
      Auth.clearSession();
      throw new AuthError('Your session has expired.');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.message === 'string' ? body.message : `Request failed (${res.status})`);
    }
    return res.json();
  }

  async function loadTransactions() {
    const all = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const data = await request(`/transactions${qs}`);
      if (Array.isArray(data.items)) all.push(...data.items);
      cursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      if (!cursor) break;
    }
    return all;
  }

  function createTransaction(txn) {
    return request('/transactions', { method: 'POST', body: JSON.stringify(txn) });
  }

  function removeTransaction(id) {
    return request(`/transactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  function loadBudget() {
    return request('/budget');
  }

  function saveBudget(budget) {
    return request('/budget', { method: 'PUT', body: JSON.stringify(budget) });
  }

  return { loadTransactions, createTransaction, removeTransaction, loadBudget, saveBudget };
})();

/* --------------------- Transactions module --------------------- */
const Transactions = (() => {
  let cache = [];

  function sortAll(list) {
    return [...list].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return String(a.createdAt) < String(b.createdAt) ? 1 : -1;
    });
  }

  async function init() {
    const items = await Storage.loadTransactions();
    cache = items.filter(isWellFormedTxn);
    const skipped = items.length - cache.length;
    if (skipped > 0) console.warn(`Skipped ${skipped} malformed transaction record(s).`);
  }

  function getAll() {
    return sortAll(cache);
  }

  // id and createdAt are assigned by the server.
  async function addTransaction(data) {
    const saved = await Storage.createTransaction({
      type: data.type,
      amount: round2(data.amount),
      category: data.category,
      description: (data.description || '').trim(),
      date: data.date,
    });
    if (!isWellFormedTxn(saved)) throw new Error('Unexpected response from server.');
    cache.push(saved);
    return saved;
  }

  async function deleteTransaction(id) {
    const idx = cache.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const txn = cache[idx];
    await Storage.removeTransaction(id);
    cache.splice(idx, 1);
    return txn;
  }

  // Undo re-creates the transaction (the server issues a fresh id).
  function restoreTransaction(txn) {
    return addTransaction(txn);
  }

  return { init, getAll, addTransaction, deleteTransaction, restoreTransaction };
})();

/* -------------------- Calculations module ---------------------- */
const Calculations = (() => {
  function isCurrentMonth(isoDate, ref = new Date()) {
    if (typeof isoDate !== 'string' || !ISO_DATE_RE.test(isoDate)) return false;
    const [y, m] = isoDate.split('-').map(Number);
    return y === ref.getFullYear() && m === ref.getMonth() + 1;
  }

  function getBalance(transactions) {
    const total = transactions.reduce((sum, t) => {
      return sum + (t.type === 'income' ? t.amount : -t.amount);
    }, 0);
    return round2(total);
  }

  function getMonthlyIncome(transactions, ref = new Date()) {
    const total = transactions
      .filter(t => t.type === 'income' && isCurrentMonth(t.date, ref))
      .reduce((sum, t) => sum + t.amount, 0);
    return round2(total);
  }

  function getMonthlyExpenses(transactions, ref = new Date()) {
    const total = transactions
      .filter(t => t.type === 'expense' && isCurrentMonth(t.date, ref))
      .reduce((sum, t) => sum + t.amount, 0);
    return round2(total);
  }

  function getBudgetUsage(monthlyExpenseTotal, budget) {
    const limit = budget && typeof budget.monthlyLimit === 'number' ? budget.monthlyLimit : 0;
    if (!limit || limit <= 0) {
      return { hasBudget: false, percent: null, limit: 0, spent: round2(monthlyExpenseTotal) };
    }
    const percent = round2((monthlyExpenseTotal / limit) * 100);
    return { hasBudget: true, percent, limit, spent: round2(monthlyExpenseTotal) };
  }

  function getCategoryBreakdown(transactions, ref = new Date()) {
    const totals = new Map();
    transactions
      .filter(t => t.type === 'expense' && isCurrentMonth(t.date, ref))
      .forEach(t => totals.set(t.category, (totals.get(t.category) || 0) + t.amount));
    const arr = [...totals.entries()].map(([category, amount]) => ({ category, amount: round2(amount) }));
    arr.sort((a, b) => b.amount - a.amount);
    return arr;
  }

  return { getBalance, getMonthlyIncome, getMonthlyExpenses, getBudgetUsage, getCategoryBreakdown, isCurrentMonth };
})();

/* ------------------------- UI module ---------------------------- */
const UI = (() => {
  const els = {};
  let lastDeleted = null;
  let currentBudget = { monthlyLimit: 0 };

  function cacheEls() {
    els.appContent = document.getElementById('app-content');
    els.gate = document.getElementById('auth-gate');
    els.gateTitle = document.getElementById('gate-title');
    els.gateText = document.getElementById('gate-text');
    els.signinBtn = document.getElementById('signin-btn');
    els.authBar = document.getElementById('auth-bar');
    els.userEmail = document.getElementById('user-email');
    els.signoutBtn = document.getElementById('signout-btn');

    els.form = document.getElementById('txn-form');
    els.typeToggle = document.getElementById('type-toggle');
    els.amount = document.getElementById('field-amount');
    els.category = document.getElementById('field-category');
    els.date = document.getElementById('field-date');
    els.description = document.getElementById('field-description');
    els.descCount = document.getElementById('desc-count');

    els.balance = document.getElementById('stat-balance');
    els.monthIncome = document.getElementById('stat-income');
    els.monthExpense = document.getElementById('stat-expense');
    els.budgetStatValue = document.getElementById('stat-budget-value');
    els.budgetStatBar = document.getElementById('stat-budget-bar');
    els.budgetStatLabel = document.getElementById('stat-budget-label');

    els.budgetForm = document.getElementById('budget-form');
    els.budgetInput = document.getElementById('field-budget');
    els.budgetCurrent = document.getElementById('budget-current');

    els.txList = document.getElementById('txn-list');
    els.txEmpty = document.getElementById('txn-empty');
    els.txCount = document.getElementById('txn-count');

    els.chart = document.getElementById('category-chart');
    els.chartEmpty = document.getElementById('category-empty');

    els.toasts = document.getElementById('toast-region');
  }

  function showGate(title, text, { showSignIn }) {
    els.appContent.hidden = true;
    els.authBar.hidden = true;
    els.gate.hidden = false;
    els.gateTitle.textContent = title;
    els.gateText.textContent = text;
    els.signinBtn.hidden = !showSignIn;
  }

  function showApp() {
    els.gate.hidden = true;
    els.appContent.hidden = false;
    els.authBar.hidden = false;
    els.userEmail.textContent = Auth.getUserEmail();
  }

  function showSignedOut(reason) {
    showGate(
      'Sign in to continue',
      reason || 'Your transactions are private to your account. Sign in or create an account to get started.',
      { showSignIn: true }
    );
  }

  function populateCategories() {
    els.category.replaceChildren();
    const placeholder = el('option', '', 'Choose a category…');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    els.category.appendChild(placeholder);
    CATEGORIES.forEach(c => {
      const opt = el('option', '', `${c.icon} ${c.name}`);
      opt.value = c.name;
      els.category.appendChild(opt);
    });
  }

  function setActiveType(type) {
    els.typeToggle.querySelectorAll('.seg-btn').forEach(btn => {
      const active = btn.dataset.type === type;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    els.form.dataset.type = type;
  }

  function getActiveType() {
    return els.form.dataset.type || 'expense';
  }

  const FIELD_NAMES = ['type', 'amount', 'category', 'date', 'description'];

  function clearFieldErrors() {
    els.form.querySelectorAll('.field-error').forEach(n => (n.textContent = ''));
    els.form.querySelectorAll('.field-warning').forEach(n => (n.textContent = ''));
    els.form.querySelectorAll('.has-error').forEach(n => n.classList.remove('has-error'));
  }

  function setFieldError(fieldName, message) {
    if (!FIELD_NAMES.includes(fieldName)) return;
    const errEl = els.form.querySelector(`.field-error[data-for="${fieldName}"]`);
    const inputEl = els.form.querySelector(`[name="${fieldName}"]`);
    if (errEl) errEl.textContent = message;
    if (inputEl) inputEl.classList.add('has-error');
  }

  function setFieldWarning(fieldName, message) {
    if (!FIELD_NAMES.includes(fieldName)) return;
    const warnEl = els.form.querySelector(`.field-warning[data-for="${fieldName}"]`);
    if (warnEl) warnEl.textContent = message;
  }

  function showToast(message, opts = {}) {
    const { type = 'success', actionLabel, onAction, duration = 4200 } = opts;
    const toast = el('div', `toast toast-${type}`);
    toast.appendChild(el('span', 'toast-text', message));

    if (actionLabel && onAction) {
      const btn = el('button', 'toast-action', actionLabel);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        onAction();
        dismiss();
      });
      toast.appendChild(btn);
    }

    const closeBtn = el('button', 'toast-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', () => dismiss());
    toast.appendChild(closeBtn);

    els.toasts.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const timer = setTimeout(dismiss, duration);

    function dismiss() {
      clearTimeout(timer);
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 250);
    }
  }

  function handleApiError(err, fallbackMessage) {
    console.error(err);
    if (err instanceof AuthError) {
      showSignedOut('Your session has expired. Please sign in again.');
      return;
    }
    showToast(fallbackMessage, { type: 'error' });
  }

  function renderStats() {
    const all = Transactions.getAll();
    const balance = Calculations.getBalance(all);
    const monthIncome = Calculations.getMonthlyIncome(all);
    const monthExpense = Calculations.getMonthlyExpenses(all);
    const usage = Calculations.getBudgetUsage(monthExpense, currentBudget);

    els.balance.textContent = formatMoney(balance);
    els.balance.classList.toggle('negative', balance < 0);
    els.monthIncome.textContent = formatMoney(monthIncome);
    els.monthExpense.textContent = formatMoney(monthExpense);

    if (!usage.hasBudget) {
      els.budgetStatValue.textContent = 'No budget set';
      els.budgetStatLabel.textContent = `${formatMoney(monthExpense)} spent this month`;
      els.budgetStatBar.style.width = '0%';
      els.budgetStatBar.classList.remove('warn', 'over');
    } else {
      const pctDisplay = usage.percent > 999 ? '>999' : Math.round(usage.percent);
      els.budgetStatValue.textContent = `${pctDisplay}% used`;
      els.budgetStatLabel.textContent = `${formatMoney(usage.spent)} of ${formatMoney(usage.limit)}`;
      const clampedWidth = Math.min(100, Math.max(0, usage.percent));
      els.budgetStatBar.style.width = `${clampedWidth}%`;
      els.budgetStatBar.classList.toggle('warn', usage.percent >= 80 && usage.percent < 100);
      els.budgetStatBar.classList.toggle('over', usage.percent >= 100);
    }

    const budgetCard = els.budgetStatValue.closest('.stat-card');
    if (budgetCard) budgetCard.classList.toggle('over-budget', usage.hasBudget && usage.percent >= 100);

    renderCategoryChart(all);
  }

  function renderBudgetSection() {
    if (currentBudget && currentBudget.monthlyLimit > 0) {
      els.budgetCurrent.textContent = `Current budget: ${formatMoney(currentBudget.monthlyLimit)} / month`;
      els.budgetInput.value = currentBudget.monthlyLimit;
    } else {
      els.budgetCurrent.textContent = 'No budget configured yet.';
      els.budgetInput.value = '';
    }
  }

  function renderCategoryChart(all) {
    const breakdown = Calculations.getCategoryBreakdown(all);
    els.chart.replaceChildren();
    if (breakdown.length === 0) {
      els.chartEmpty.hidden = false;
      return;
    }
    els.chartEmpty.hidden = true;
    const max = breakdown[0].amount || 1;
    breakdown.forEach(({ category, amount }) => {
      const pct = Math.max(4, Math.round((amount / max) * 100));

      const label = el('div', 'chart-label');
      label.append(el('span', 'chart-icon', iconFor(category)), el('span', 'chart-name', category));

      const track = el('div', 'chart-track');
      const fill = el('div', 'chart-fill');
      fill.style.width = `${pct}%`;
      track.appendChild(fill);

      const row = el('div', 'chart-row');
      row.append(label, track, el('div', 'chart-amount', formatMoney(amount)));
      els.chart.appendChild(row);
    });
  }

  function buildTransactionRow(t) {
    const isIncome = t.type === 'income';

    const catText = el('div', 'txn-cat-text');
    catText.appendChild(el('span', 'cat-name', t.category));
    if (t.description) catText.appendChild(el('span', 'txn-desc', t.description));
    const catCell = el('div', 'txn-cell txn-cat');
    catCell.append(el('span', 'cat-icon', iconFor(t.category)), catText);

    const typeCell = el('div', 'txn-cell txn-type');
    typeCell.appendChild(el('span', `pill ${isIncome ? 'pill-income' : 'pill-expense'}`, isIncome ? 'Income' : 'Expense'));

    const amountCell = el(
      'div',
      `txn-cell txn-amount ${isIncome ? 'positive' : 'negative'}`,
      `${isIncome ? '+' : '−'}${formatMoney(t.amount)}`
    );

    const delBtn = el('button', 'icon-btn delete-btn', '🗑️');
    delBtn.type = 'button';
    delBtn.title = 'Delete transaction';
    delBtn.setAttribute('aria-label', 'Delete transaction');
    delBtn.dataset.id = t.id;
    const actionsCell = el('div', 'txn-cell txn-actions');
    actionsCell.appendChild(delBtn);

    const row = el('div', 'txn-row');
    row.dataset.id = t.id;
    row.append(catCell, el('div', 'txn-cell txn-date', formatDate(t.date)), typeCell, amountCell, actionsCell);
    return row;
  }

  function renderTransactions() {
    const all = Transactions.getAll();
    els.txCount.textContent = all.length === 1 ? '1 transaction' : `${all.length} transactions`;

    if (all.length === 0) {
      els.txList.replaceChildren();
      els.txEmpty.hidden = false;
      return;
    }
    els.txEmpty.hidden = true;
    els.txList.replaceChildren(...all.map(buildTransactionRow));
  }

  function refreshAll() {
    renderStats();
    renderTransactions();
    renderBudgetSection();
  }

  function validateTransactionInput({ type, amount, category, date, description }) {
    const errors = {};
    const warnings = {};

    if (!TYPES.includes(type)) {
      errors.type = 'Select a transaction type.';
    }

    if (amount === '' || amount === null || amount === undefined) {
      errors.amount = 'Amount is required.';
    } else {
      const num = Number(amount);
      if (!Number.isFinite(num)) errors.amount = 'Enter a valid number.';
      else if (num <= 0) errors.amount = 'Amount must be greater than 0.';
      else if (num > 1000000) errors.amount = 'Amount must be at most 1,000,000.';
    }

    if (!category) {
      errors.category = 'Choose a category.';
    } else if (!CATEGORY_ICON.has(category)) {
      errors.category = 'Choose a valid category.';
    }

    if (!date) {
      errors.date = 'Date is required.';
    } else if (!ISO_DATE_RE.test(date) || Number.isNaN(new Date(date).getTime())) {
      errors.date = 'Enter a valid date.';
    } else if (date > todayISO()) {
      warnings.date = 'This date is in the future.';
    }

    if (description && description.length > 200) {
      errors.description = 'Description must be 200 characters or fewer.';
    }

    return { errors, warnings };
  }

  function bindEvents() {
    els.signinBtn.addEventListener('click', () => {
      Auth.login().catch(err => {
        console.error(err);
        showToast('Could not start sign-in.', { type: 'error' });
      });
    });
    els.signoutBtn.addEventListener('click', () => Auth.logout());

    els.typeToggle.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => setActiveType(btn.dataset.type));
    });

    els.description.addEventListener('input', () => {
      els.descCount.textContent = `${els.description.value.length}/200`;
    });

    els.form.addEventListener('submit', async e => {
      e.preventDefault();
      clearFieldErrors();

      const input = {
        type: getActiveType(),
        amount: els.amount.value.trim(),
        category: els.category.value,
        date: els.date.value,
        description: els.description.value,
      };

      const { errors, warnings } = validateTransactionInput(input);

      if (Object.keys(errors).length > 0) {
        Object.entries(errors).forEach(([field, msg]) => setFieldError(field, msg));
        showToast('Please fix the highlighted fields.', { type: 'error' });
        return;
      }

      Object.entries(warnings).forEach(([field, msg]) => setFieldWarning(field, msg));

      const submitBtn = els.form.querySelector('.btn-primary');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding…';

      try {
        await Transactions.addTransaction({
          type: input.type,
          amount: Number(input.amount),
          category: input.category,
          date: input.date,
          description: input.description,
        });

        els.form.reset();
        els.date.value = todayISO();
        els.descCount.textContent = '0/200';
        setActiveType(input.type);

        refreshAll();
        showToast(
          `${input.type === 'income' ? 'Income' : 'Expense'} of ${formatMoney(Number(input.amount))} added.`,
          { type: 'success' }
        );
      } catch (err) {
        handleApiError(err, 'Could not save transaction. Check your connection and try again.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Transaction';
      }
    });

    els.budgetForm.addEventListener('submit', async e => {
      e.preventDefault();
      const raw = els.budgetInput.value.trim();
      const errEl = els.budgetForm.querySelector('.field-error[data-for="monthlyLimit"]');
      if (errEl) errEl.textContent = '';
      els.budgetInput.classList.remove('has-error');

      const num = Number(raw);
      if (raw === '' || !Number.isFinite(num) || num < 0) {
        if (errEl) errEl.textContent = 'Enter a valid budget amount (0 or more).';
        els.budgetInput.classList.add('has-error');
        showToast('Please enter a valid budget.', { type: 'error' });
        return;
      }

      const submitBtn = els.budgetForm.querySelector('.btn-secondary');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';

      try {
        currentBudget = await Storage.saveBudget({ monthlyLimit: round2(num) });
        refreshAll();
        showToast('Monthly budget saved.', { type: 'success' });
      } catch (err) {
        handleApiError(err, 'Could not save budget. Check your connection and try again.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Budget';
      }
    });

    els.txList.addEventListener('click', async e => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      const row = btn.closest('.txn-row');
      btn.disabled = true;

      try {
        const removed = await Transactions.deleteTransaction(id);
        if (!removed) return;
        lastDeleted = removed;

        if (row) row.classList.add('removing');
        refreshAll();

        showToast('Transaction deleted.', {
          type: 'info',
          actionLabel: 'Undo',
          onAction: async () => {
            if (!lastDeleted) return;
            try {
              await Transactions.restoreTransaction(lastDeleted);
              lastDeleted = null;
              refreshAll();
              showToast('Transaction restored.', { type: 'success' });
            } catch (err) {
              handleApiError(err, 'Could not restore transaction.');
            }
          },
        });
      } catch (err) {
        handleApiError(err, 'Could not delete transaction. Check your connection and try again.');
        btn.disabled = false;
      }
    });
  }

  async function loadData() {
    els.txEmpty.hidden = true;
    els.txList.replaceChildren(el('p', 'empty-note', 'Loading your transactions…'));

    const [budget] = await Promise.all([Storage.loadBudget(), Transactions.init()]);
    currentBudget = { monthlyLimit: typeof budget?.monthlyLimit === 'number' ? budget.monthlyLimit : 0 };
    refreshAll();
  }

  async function init() {
    cacheEls();
    populateCategories();
    setActiveType('expense');
    els.date.value = todayISO();
    bindEvents();

    if (!Auth.isConfigured()) {
      showGate(
        'Setup required',
        'This deployment is not connected to its secure backend yet. An administrator needs to fill in config.js (see aws/README.md).',
        { showSignIn: false }
      );
      return;
    }

    try {
      await Auth.handleRedirect();
    } catch (err) {
      console.error(err);
      showSignedOut(err.message);
      return;
    }

    if (!Auth.isSignedIn()) {
      showSignedOut();
      return;
    }

    showApp();
    try {
      await loadData();
    } catch (err) {
      els.txList.replaceChildren();
      handleApiError(err, 'Could not load your data from the server. Check your connection and try again.');
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', UI.init);
