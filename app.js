'use strict';

/* ============================================================
   Student Money Manager — app.js
   Modules: Storage, Transactions, Calculations, UI
   ============================================================ */

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

const CATEGORY_ICON = Object.fromEntries(CATEGORIES.map(c => [c.name, c.icon]));

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `txn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ----------------------- Storage module ----------------------- */
const Storage = (() => {
  const TX_KEY = 'smm.transactions';
  const BUDGET_KEY = 'smm.budget';

  function loadTransactions() {
    try {
      const raw = localStorage.getItem(TX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('Failed to load transactions', e);
      return [];
    }
  }

  function saveTransactions(transactions) {
    localStorage.setItem(TX_KEY, JSON.stringify(transactions));
  }

  function loadBudget() {
    try {
      const raw = localStorage.getItem(BUDGET_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed.monthlyLimit === 'number') return parsed;
      return { monthlyLimit: 0 };
    } catch (e) {
      console.error('Failed to load budget', e);
      return { monthlyLimit: 0 };
    }
  }

  function saveBudget(budget) {
    localStorage.setItem(BUDGET_KEY, JSON.stringify(budget));
  }

  return { loadTransactions, saveTransactions, loadBudget, saveBudget };
})();

/* --------------------- Transactions module --------------------- */
const Transactions = (() => {
  let cache = Storage.loadTransactions();

  function sortAll(list) {
    return [...list].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  function getAll() {
    return sortAll(cache);
  }

  function addTransaction(data) {
    const txn = {
      id: generateId(),
      type: data.type,
      amount: round2(data.amount),
      category: data.category,
      description: (data.description || '').trim(),
      date: data.date,
      createdAt: new Date().toISOString(),
    };
    cache.push(txn);
    Storage.saveTransactions(cache);
    return txn;
  }

  function deleteTransaction(id) {
    const idx = cache.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const [removed] = cache.splice(idx, 1);
    Storage.saveTransactions(cache);
    return removed;
  }

  function restoreTransaction(txn) {
    cache.push(txn);
    Storage.saveTransactions(cache);
  }

  return { getAll, addTransaction, deleteTransaction, restoreTransaction };
})();

/* -------------------- Calculations module ---------------------- */
const Calculations = (() => {
  function isCurrentMonth(isoDate, ref = new Date()) {
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
  let undoTimer = null;

  function cacheEls() {
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

  function populateCategories() {
    els.category.innerHTML = '<option value="" disabled selected>Choose a category…</option>' +
      CATEGORIES.map(c => `<option value="${c.name}">${c.icon} ${c.name}</option>`).join('');
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

  function clearFieldErrors() {
    els.form.querySelectorAll('.field-error').forEach(el => (el.textContent = ''));
    els.form.querySelectorAll('.field-warning').forEach(el => (el.textContent = ''));
    els.form.querySelectorAll('.has-error').forEach(el => el.classList.remove('has-error'));
  }

  function setFieldError(fieldName, message) {
    const errEl = els.form.querySelector(`.field-error[data-for="${fieldName}"]`);
    const inputEl = els.form.querySelector(`[name="${fieldName}"]`);
    if (errEl) errEl.textContent = message;
    if (inputEl) inputEl.classList.add('has-error');
  }

  function setFieldWarning(fieldName, message) {
    const warnEl = els.form.querySelector(`.field-warning[data-for="${fieldName}"]`);
    if (warnEl) warnEl.textContent = message;
  }

  function showToast(message, opts = {}) {
    const { type = 'success', actionLabel, onAction, duration = 4200 } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toast.appendChild(text);

    if (actionLabel && onAction) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.type = 'button';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        onAction();
        dismiss();
      });
      toast.appendChild(btn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => dismiss());
    toast.appendChild(closeBtn);

    els.toasts.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    let timer = setTimeout(dismiss, duration);

    function dismiss() {
      clearTimeout(timer);
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 250);
    }
  }

  function renderStats() {
    const all = Transactions.getAll();
    const balance = Calculations.getBalance(all);
    const monthIncome = Calculations.getMonthlyIncome(all);
    const monthExpense = Calculations.getMonthlyExpenses(all);
    const budget = Storage.loadBudget();
    const usage = Calculations.getBudgetUsage(monthExpense, budget);

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
    const budget = Storage.loadBudget();
    if (budget && budget.monthlyLimit > 0) {
      els.budgetCurrent.textContent = `Current budget: ${formatMoney(budget.monthlyLimit)} / month`;
      els.budgetInput.value = budget.monthlyLimit;
    } else {
      els.budgetCurrent.textContent = 'No budget configured yet.';
      els.budgetInput.value = '';
    }
  }

  function renderCategoryChart(all) {
    const breakdown = Calculations.getCategoryBreakdown(all);
    els.chart.innerHTML = '';
    if (breakdown.length === 0) {
      els.chartEmpty.hidden = false;
      return;
    }
    els.chartEmpty.hidden = true;
    const max = breakdown[0].amount || 1;
    breakdown.forEach(({ category, amount }) => {
      const row = document.createElement('div');
      row.className = 'chart-row';
      const pct = Math.max(4, Math.round((amount / max) * 100));
      row.innerHTML = `
        <div class="chart-label">
          <span class="chart-icon">${CATEGORY_ICON[category] || '🗂️'}</span>
          <span class="chart-name">${category}</span>
        </div>
        <div class="chart-track">
          <div class="chart-fill" style="width:${pct}%"></div>
        </div>
        <div class="chart-amount">${formatMoney(amount)}</div>
      `;
      els.chart.appendChild(row);
    });
  }

  function renderTransactions() {
    const all = Transactions.getAll();
    els.txCount.textContent = all.length === 1 ? '1 transaction' : `${all.length} transactions`;

    if (all.length === 0) {
      els.txList.innerHTML = '';
      els.txEmpty.hidden = false;
      return;
    }
    els.txEmpty.hidden = true;

    els.txList.innerHTML = all.map(t => `
      <div class="txn-row" data-id="${t.id}">
        <div class="txn-cell txn-cat">
          <span class="cat-icon">${CATEGORY_ICON[t.category] || '🗂️'}</span>
          <div class="txn-cat-text">
            <span class="cat-name">${escapeHtml(t.category)}</span>
            ${t.description ? `<span class="txn-desc">${escapeHtml(t.description)}</span>` : ''}
          </div>
        </div>
        <div class="txn-cell txn-date">${formatDate(t.date)}</div>
        <div class="txn-cell txn-type">
          <span class="pill pill-${t.type}">${t.type === 'income' ? 'Income' : 'Expense'}</span>
        </div>
        <div class="txn-cell txn-amount ${t.type === 'income' ? 'positive' : 'negative'}">
          ${t.type === 'income' ? '+' : '−'}${formatMoney(t.amount)}
        </div>
        <div class="txn-cell txn-actions">
          <button class="icon-btn delete-btn" title="Delete transaction" aria-label="Delete transaction" data-id="${t.id}">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function refreshAll() {
    renderStats();
    renderTransactions();
    renderBudgetSection();
  }

  function validateTransactionInput({ type, amount, category, date, description }) {
    const errors = {};
    const warnings = {};

    if (!type || (type !== 'income' && type !== 'expense')) {
      errors.type = 'Select a transaction type.';
    }

    if (amount === '' || amount === null || amount === undefined) {
      errors.amount = 'Amount is required.';
    } else {
      const num = Number(amount);
      if (Number.isNaN(num)) errors.amount = 'Enter a valid number.';
      else if (num <= 0) errors.amount = 'Amount must be greater than 0.';
    }

    if (!category) {
      errors.category = 'Choose a category.';
    } else if (!CATEGORIES.some(c => c.name === category)) {
      errors.category = 'Choose a valid category.';
    }

    if (!date) {
      errors.date = 'Date is required.';
    } else if (Number.isNaN(new Date(date).getTime())) {
      errors.date = 'Enter a valid date.';
    } else {
      const today = todayISO();
      if (date > today) warnings.date = 'This date is in the future.';
    }

    if (description && description.length > 200) {
      errors.description = 'Description must be 200 characters or fewer.';
    }

    return { errors, warnings };
  }

  function bindEvents() {
    els.typeToggle.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => setActiveType(btn.dataset.type));
    });

    els.description.addEventListener('input', () => {
      els.descCount.textContent = `${els.description.value.length}/200`;
    });

    els.form.addEventListener('submit', e => {
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

      Transactions.addTransaction({
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
    });

    els.budgetForm.addEventListener('submit', e => {
      e.preventDefault();
      const raw = els.budgetInput.value.trim();
      const errEl = els.budgetForm.querySelector('.field-error[data-for="monthlyLimit"]');
      if (errEl) errEl.textContent = '';
      els.budgetInput.classList.remove('has-error');

      const num = Number(raw);
      if (raw === '' || Number.isNaN(num) || num < 0) {
        if (errEl) errEl.textContent = 'Enter a valid budget amount (0 or more).';
        els.budgetInput.classList.add('has-error');
        showToast('Please enter a valid budget.', { type: 'error' });
        return;
      }

      Storage.saveBudget({ monthlyLimit: round2(num) });
      refreshAll();
      showToast('Monthly budget saved.', { type: 'success' });
    });

    els.txList.addEventListener('click', e => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      const row = btn.closest('.txn-row');

      const removed = Transactions.deleteTransaction(id);
      if (!removed) return;
      lastDeleted = removed;

      if (row) {
        row.classList.add('removing');
      }
      refreshAll();

      showToast('Transaction deleted.', {
        type: 'info',
        actionLabel: 'Undo',
        onAction: () => {
          if (lastDeleted) {
            Transactions.restoreTransaction(lastDeleted);
            lastDeleted = null;
            refreshAll();
            showToast('Transaction restored.', { type: 'success' });
          }
        },
      });
    });
  }

  function init() {
    cacheEls();
    populateCategories();
    setActiveType('expense');
    els.date.value = todayISO();
    els.date.max = '';
    bindEvents();
    refreshAll();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', UI.init);
