// NationalRegionB — Admin currencies & user currency management module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Currencies');

  const MAJOR_CURRENCIES = [
    { code: 'USD', name: 'US Dollar', symbol: '$', label: 'USD — US Dollar ($)' },
    { code: 'EUR', name: 'Euro', symbol: '€', label: 'EUR — Euro (€)' },
    { code: 'GBP', name: 'British Pound', symbol: '£', label: 'GBP — British Pound (£)' },
    { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', label: 'NGN — Nigerian Naira (₦)' },
    { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', label: 'CAD — Canadian Dollar (C$)' }
  ];

  const CURRENCY_SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', NGN: '₦', CAD: 'C$'
  };

  let allUsers = [];
  let userPage = 1;
  const USER_PAGE_SIZE = 10;
  let userSearchTerm = '';
  let userFilterCurrency = '';

  // ---------------------------------------------------------------------------
  // Load Everything
  // ---------------------------------------------------------------------------
  async function load() {
    await Promise.all([
      loadPlatformCurrencies(),
      loadUserCurrencies()
    ]);
  }

  // ---------------------------------------------------------------------------
  // 1. User Currency Management
  // ---------------------------------------------------------------------------
  async function loadUserCurrencies() {
    const el = document.getElementById('user-currencies-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading user currencies...</span></div>';
    try {
      const res = await adminApi('admin_list_users', {
        p_search: '',
        p_status: null,
        p_limit: 500,
        p_offset: 0
      });
      allUsers = res.rows || [];
      populateUserDropdown();
      renderUserCurrencies();
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load user currencies');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function populateUserDropdown() {
    const sel = document.getElementById('uc-user-select');
    if (!sel) return;
    const currentVal = sel.value;
    const opts = ['<option value="">Choose a customer...</option>'].concat(
      allUsers.map(function (u) {
        const cur = (u.display_currency || 'USD').toUpperCase();
        const sym = CURRENCY_SYMBOLS[cur] || '$';
        const name = UI.escapeHtml(u.full_name || 'Customer');
        const email = UI.escapeHtml(u.email || '');
        return '<option value="' + u.id + '">' + name + ' (' + email + ') — Current: ' + cur + ' (' + sym + ')</option>';
      })
    );
    sel.innerHTML = opts.join('');
    if (currentVal && allUsers.some(function (u) { return u.id === currentVal; })) {
      sel.value = currentVal;
    }
  }

  function filteredUsers() {
    let list = allUsers.slice();
    if (userSearchTerm) {
      const term = userSearchTerm.toLowerCase();
      list = list.filter(function (u) {
        return (u.full_name && u.full_name.toLowerCase().indexOf(term) !== -1) ||
               (u.email && u.email.toLowerCase().indexOf(term) !== -1);
      });
    }
    if (userFilterCurrency) {
      list = list.filter(function (u) {
        const cur = (u.display_currency || 'USD').toUpperCase();
        return cur === userFilterCurrency;
      });
    }
    return list;
  }

  function renderUserCurrencies() {
    const el = document.getElementById('user-currencies-table');
    const list = filteredUsers();
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
    if (userPage > totalPages) userPage = totalPages;

    const start = (userPage - 1) * USER_PAGE_SIZE;
    const paged = list.slice(start, start + USER_PAGE_SIZE);

    if (!paged.length) {
      el.innerHTML = UI.emptyState('No users found matching filter');
      renderUserPagination(0);
      return;
    }

    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Customer</th><th>Assigned Currency</th><th>Accounts</th><th>Total Balance</th><th>Joined</th><th>Actions</th></tr></thead><tbody>' +
      paged.map(function (u) {
        const cur = (u.display_currency || 'USD').toUpperCase();
        const sym = CURRENCY_SYMBOLS[cur] || '$';
        const isDefault = !u.display_currency || u.display_currency === 'USD';
        const badgeCls = cur === 'USD' ? 'badge-info' : cur === 'EUR' ? 'badge-primary' : cur === 'GBP' ? 'badge-purple' : cur === 'NGN' ? 'badge-gold' : 'badge-cyan';
        return '<tr data-uid="' + u.id + '">' +
          '<td data-label="Customer"><div class="flex gap-1">' + UI.avatar(u) +
            '<div><div class="cell-main">' + UI.escapeHtml(u.full_name || '—') + '</div>' +
            '<div class="cell-sub">' + UI.escapeHtml(u.email) + '</div></div></div></td>' +
          '<td data-label="Assigned Currency">' +
            '<span class="badge ' + badgeCls + '" style="font-weight:700;font-size:12px">' + cur + ' (' + sym + ')</span>' +
            (isDefault ? '<div class="cell-sub">Platform Default</div>' : '<div class="cell-sub" style="color:var(--success)">Custom assigned</div>') +
          '</td>' +
          '<td data-label="Accounts">' + (u.account_count || 0) + '</td>' +
          '<td data-label="Total Balance">' + UI.money(u.total_balance || 0, cur) + '</td>' +
          '<td data-label="Joined">' + UI.formatDate(u.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="btn btn-outline btn-xs" data-change-uc="' + u.id + '">Change Currency</button>' +
          '</div></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-change-uc]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const uid = btn.getAttribute('data-change-uc');
        const userObj = allUsers.find(function (x) { return x.id === uid; });
        if (userObj) openChangeUserCurrencyModal(userObj);
      });
    });

    renderUserPagination(total);
  }

  function renderUserPagination(total) {
    const pages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
    const el = document.getElementById('uc-pagination');
    if (!el) return;
    if (pages <= 1) { el.innerHTML = ''; return; }
    let html = '<button data-p="' + (userPage - 1) + '" ' + (userPage <= 1 ? 'disabled' : '') + '>‹</button>';
    for (let i = 1; i <= pages; i++) {
      html += '<button data-p="' + i + '" class="' + (i === userPage ? 'active' : '') + '">' + i + '</button>';
    }
    html += '<button data-p="' + (userPage + 1) + '" ' + (userPage >= pages ? 'disabled' : '') + '>›</button>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () {
        userPage = Number(b.getAttribute('data-p'));
        renderUserCurrencies();
      });
    });
  }

  function openChangeUserCurrencyModal(u) {
    const currentCur = (u.display_currency || 'USD').toUpperCase();
    const optionsHtml = MAJOR_CURRENCIES.map(function (c) {
      return '<option value="' + c.code + '"' + (c.code === currentCur ? ' selected' : '') + '>' +
        c.label + (c.code === 'USD' ? ' [Platform Default]' : '') +
      '</option>';
    }).join('');

    const modal = UI.openModal(
      '<div style="margin-bottom:12px">' +
        '<div style="font-weight:600;font-size:15px;color:var(--text)">' + UI.escapeHtml(u.full_name || 'Customer') + '</div>' +
        '<div class="text-sm text-muted">' + UI.escapeHtml(u.email) + '</div>' +
      '</div>' +
      '<div class="field">' +
        '<label>Preferred Display Currency</label>' +
        '<select class="select" id="modal-uc-select">' + optionsHtml + '</select>' +
        '<div class="hint" style="margin-top:6px;font-size:12px;color:var(--text-muted)">' +
          'All account balances, transaction records, deposits, and transfers will be calculated and displayed in this currency exclusively for this user.' +
        '</div>' +
      '</div>' +
      '<div class="form-error" id="modal-uc-error"></div>',
      {
        title: 'Assign User Currency',
        footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save Currency</button>'
      }
    );

    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('modal-uc-error');
      err.textContent = '';
      const btn = this;
      const newCur = document.getElementById('modal-uc-select').value;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        await adminApi('admin_set_user_currency', {
          p_user_id: u.id,
          p_currency: newCur
        });
        u.display_currency = newCur;
        UI.toast('Display currency for ' + (u.full_name || u.email) + ' set to ' + newCur + '.', 'success');
        modal.close();
        populateUserDropdown();
        renderUserCurrencies();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Save Currency';
        err.textContent = UI.apiErrorMessage(e);
      }
    });
  }

  // Quick Assign Button Listener
  document.getElementById('btn-assign-currency').addEventListener('click', async function () {
    const userSelect = document.getElementById('uc-user-select');
    const currencySelect = document.getElementById('uc-currency-select');
    const userId = userSelect.value;
    const currency = currencySelect.value;

    if (!userId) {
      UI.toast('Please select a customer to assign a currency.', 'warning');
      userSelect.focus();
      return;
    }

    const userObj = allUsers.find(function (x) { return x.id === userId; });
    const btn = this;
    btn.disabled = true;
    btn.textContent = 'Assigning...';

    try {
      await adminApi('admin_set_user_currency', {
        p_user_id: userId,
        p_currency: currency
      });
      if (userObj) userObj.display_currency = currency;
      UI.toast('Display currency for ' + (userObj ? (userObj.full_name || userObj.email) : 'user') + ' updated to ' + currency + '.', 'success');
      populateUserDropdown();
      renderUserCurrencies();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Assign Currency';
    }
  });

  // User search & filter listeners
  document.getElementById('uc-search').addEventListener('input', function () {
    userSearchTerm = this.value.trim();
    userPage = 1;
    renderUserCurrencies();
  });

  document.getElementById('uc-filter-currency').addEventListener('change', function () {
    userFilterCurrency = this.value;
    userPage = 1;
    renderUserCurrencies();
  });

  // ---------------------------------------------------------------------------
  // 2. Platform Currencies & Exchange Rates
  // ---------------------------------------------------------------------------
  async function loadPlatformCurrencies() {
    try {
      const data = await adminApi('admin_list_currencies');
      renderCurrencies(data);
      renderRates(data);
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function renderCurrencies(list) {
    const el = document.getElementById('currencies-table');
    if (!list.length) { el.innerHTML = UI.emptyState('No currencies'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Code</th><th>Name</th><th>Symbol</th><th>Base</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>' +
      list.map(function (c) {
        const cur = c.currency;
        return '<tr><td data-label="Code"><span class="cell-main">' + UI.escapeHtml(cur.code) + '</span></td>' +
          '<td data-label="Name">' + UI.escapeHtml(cur.name) + '</td>' +
          '<td data-label="Symbol">' + UI.escapeHtml(cur.symbol) + '</td>' +
          '<td data-label="Base">' + (cur.is_base ? '<span class="badge badge-gold">Base</span>' : '—') + '</td>' +
          '<td data-label="Enabled">' + (cur.enabled ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-failed">No</span>') + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-edit-cur="' + cur.code + '" title="Edit">' + ICONS.edit + '</button>' +
            '<button class="row-action danger" data-del-cur="' + cur.code + '" title="Delete">' + ICONS.trash + '</button>' +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-edit-cur]').forEach(function (b) {
      b.addEventListener('click', function () {
        const c = list.find(function (x) { return x.currency.code === b.getAttribute('data-edit-cur'); }).currency;
        const modal = UI.openModal(
          '<div class="field"><label>Name</label><input type="text" class="input" id="e-name" value="' + UI.escapeHtml(c.name) + '"></div>' +
          '<div class="field"><label>Symbol</label><input type="text" class="input" id="e-symbol" value="' + UI.escapeHtml(c.symbol) + '"></div>' +
          '<div class="field"><label>Enabled</label><select class="select" id="e-enabled"><option value="true"' + (c.enabled ? ' selected' : '') + '>Yes</option><option value="false"' + (!c.enabled ? ' selected' : '') + '>No</option></select></div>' +
          '<div class="form-error" id="e-error"></div>',
          { title: 'Edit Currency', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
        );
        modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
        modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
          try {
            await adminApi('admin_update_currency', {
              p_code: c.code,
              p_name: document.getElementById('e-name').value.trim() || null,
              p_symbol: document.getElementById('e-symbol').value.trim() || null,
              p_enabled: document.getElementById('e-enabled').value === 'true'
            });
            UI.toast('Currency updated.', 'success');
            modal.close();
            loadPlatformCurrencies();
          } catch (e) { document.getElementById('e-error').textContent = UI.apiErrorMessage(e); }
        });
      });
    });
    el.querySelectorAll('[data-del-cur]').forEach(function (b) {
      b.addEventListener('click', function () {
        const code = b.getAttribute('data-del-cur');
        UI.confirmDialog('Delete currency ' + code + '?', async function () {
          try {
            await adminApi('admin_delete_currency', { p_code: code });
            UI.toast('Currency deleted.', 'success');
            loadPlatformCurrencies();
          } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
        }, 'Delete');
      });
    });
  }

  function renderRates(list) {
    const el = document.getElementById('rates-table');
    let rows = [];
    list.forEach(function (c) {
      (c.rates || []).forEach(function (r) {
        rows.push({ base: c.currency.code, quote: r.quote_currency, rate: r.rate, fee: r.fee_percent });
      });
    });
    if (!rows.length) { el.innerHTML = UI.emptyState('No exchange rates configured'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Pair</th><th>Rate</th><th>Fee %</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td data-label="Pair"><span class="cell-main">' + r.base + ' / ' + r.quote + '</span></td>' +
          '<td data-label="Rate">' + r.rate + '</td>' +
          '<td data-label="Fee %">' + r.fee + '%</td>' +
          '<td data-label="Actions"><button class="row-action" data-edit-rate="' + r.base + '" data-quote="' + r.quote + '" title="Edit">' + ICONS.edit + '</button></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-edit-rate]').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = rows.find(function (x) { return x.base === b.getAttribute('data-edit-rate') && x.quote === b.getAttribute('data-quote'); });
        const modal = UI.openModal(
          '<div class="field"><label>Rate (1 ' + r.base + ' = ? ' + r.quote + ')</label><input type="number" class="input" id="r-rate" step="0.00000001" value="' + r.rate + '"></div>' +
          '<div class="field"><label>Fee percent</label><input type="number" class="input" id="r-fee" step="0.01" value="' + r.fee + '"></div>' +
          '<div class="form-error" id="r-error"></div>',
          { title: 'Edit Rate — ' + r.base + '/' + r.quote, footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
        );
        modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
        modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
          try {
            await adminApi('admin_set_exchange_rate', {
              p_base: r.base, p_quote: r.quote,
              p_rate: Number(document.getElementById('r-rate').value),
              p_fee_percent: Number(document.getElementById('r-fee').value) || 0
            });
            UI.toast('Exchange rate updated.', 'success');
            modal.close();
            loadPlatformCurrencies();
          } catch (e) { document.getElementById('r-error').textContent = UI.apiErrorMessage(e); }
        });
      });
    });
  }

  document.getElementById('btn-add-cur').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Code</label><input type="text" class="input" id="c-code" placeholder="e.g. JPY" maxlength="3"></div>' +
      '<div class="field"><label>Name</label><input type="text" class="input" id="c-name"></div>' +
      '<div class="field"><label>Symbol</label><input type="text" class="input" id="c-symbol"></div>' +
      '<div class="field"><label>Enabled</label><select class="select" id="c-enabled"><option value="true">Yes</option><option value="false">No</option></select></div>' +
      '<div class="form-error" id="c-error"></div>',
      { title: 'Add Currency', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('c-error');
      err.textContent = '';
      try {
        await adminApi('admin_create_currency', {
          p_code: document.getElementById('c-code').value.trim(),
          p_name: document.getElementById('c-name').value.trim(),
          p_symbol: document.getElementById('c-symbol').value.trim() || '$',
          p_enabled: document.getElementById('c-enabled').value === 'true'
        });
        UI.toast('Currency added.', 'success');
        modal.close();
        loadPlatformCurrencies();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  await load();
  PageLoader.hide();
})();
