// NationalRegionB — Admin settings module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Settings');

  const ROLES = ['super_admin', 'admin', 'support', 'auditor'];

  async function loadAdmins() {
    const el = document.getElementById('admins-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading administrators...</span></div>';
    try {
      const admins = await adminApi('admin_list_admins');
      if (!admins.length) { el.innerHTML = UI.emptyState('No administrators'); return; }
      el.innerHTML = '<table class="table mobile-cards">' +
        '<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
        admins.map(function (a) {
          return '<tr><td data-label="Name"><span class="cell-main">' + UI.escapeHtml(a.full_name || '—') + '</span></td>' +
            '<td data-label="Email">' + UI.escapeHtml(a.email) + '</td>' +
            '<td data-label="Role"><span class="badge badge-gold">' + UI.escapeHtml(a.role) + '</span></td>' +
            '<td data-label="Status">' + (a.status === 'active' ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-failed">Suspended</span>') + '</td>' +
            '<td data-label="Actions"><button class="row-action" data-edit="' + a.id + '" title="Edit">' + ICONS.edit + '</button></td></tr>';
        }).join('') +
        '</tbody></table>';

      el.querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
          const a = admins.find(function (x) { return x.id === b.getAttribute('data-edit'); });
          const modal = UI.openModal(
            '<div class="field"><label>Full name</label><input type="text" class="input" id="e-name" value="' + UI.escapeHtml(a.full_name || '') + '"></div>' +
            '<div class="field"><label>Role</label><select class="select" id="e-role">' + ROLES.map(function (r) { return '<option value="' + r + '"' + (r === a.role ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></div>' +
            '<div class="field"><label>Status</label><select class="select" id="e-status"><option value="active"' + (a.status === 'active' ? ' selected' : '') + '>Active</option><option value="suspended"' + (a.status === 'suspended' ? ' selected' : '') + '>Suspended</option></select></div>' +
            '<div class="field"><label>New password (leave blank to keep)</label><input type="password" class="input" id="e-pass"></div>' +
            '<div class="form-note">You are editing <b>' + UI.escapeHtml(a.email) + '</b>. Changing your own role or status may revoke access immediately.</div>' +
            '<div class="form-error" id="e-error"></div>',
            { title: 'Edit Administrator', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
          );
          modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
          modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
            try {
              await adminApi('admin_update_admin', {
                p_admin_id: a.id,
                p_full_name: document.getElementById('e-name').value.trim(),
                p_role_name: document.getElementById('e-role').value,
                p_status: document.getElementById('e-status').value,
                p_password: document.getElementById('e-pass').value
              });
              UI.toast('Administrator updated.', 'success');
              modal.close();
              loadAdmins();
            } catch (e) { document.getElementById('e-error').textContent = UI.apiErrorMessage(e); }
          });
        });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load administrators');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  const STRING_KEYS = ['bank_name', 'currency', 'otp_btc_wallet_address'];
  const NUMERIC_KEYS = ['local_transfer_fee', 'intl_transfer_fee', 'swap_fee_percent', 'otp_purchase_price_usd', 'otp_btc_usd_rate',
                        'withdrawal_fee', 'withdrawal_min_amount', 'withdrawal_max_amount'];

  function renderSettings(settings) {
    const el = document.getElementById('settings-form');
    const keys = ['bank_name', 'currency', 'local_transfer_fee', 'intl_transfer_fee', 'swap_fee_percent', 'maintenance_mode',
                  'otp_purchase_price_usd', 'otp_btc_usd_rate', 'otp_btc_wallet_address',
                  'withdrawal_fee', 'withdrawal_min_amount', 'withdrawal_max_amount'];
    const labels = {
      bank_name: 'Bank name', currency: 'Default currency',
      local_transfer_fee: 'Local transfer fee (flat)', intl_transfer_fee: 'International transfer fee (flat)',
      swap_fee_percent: 'Currency swap fee %', maintenance_mode: 'Maintenance mode',
      otp_purchase_price_usd: 'OTP purchase price (USD)', otp_btc_usd_rate: 'BTC/USD reference rate',
      otp_btc_wallet_address: 'OTP Bitcoin wallet address',
      withdrawal_fee: 'Withdrawal fee (flat)', withdrawal_min_amount: 'Withdrawal minimum amount',
      withdrawal_max_amount: 'Withdrawal maximum amount'
    };
    el.innerHTML = keys.map(function (k) {
      const val = settings[k];
      const v = val === undefined || val === null ? '' : val;
      if (k === 'maintenance_mode') {
        return '<div class="field"><label>' + labels[k] + '</label><select class="select" data-key="' + k + '"><option value="true"' + (String(v) === 'true' ? ' selected' : '') + '>On</option><option value="false"' + (String(v) === 'false' ? ' selected' : '') + '>Off</option></select></div>';
      }
      let extra = k === 'otp_btc_usd_rate' ? '<div class="form-note">Used to quote OTP purchases. Refresh it from OTP Verification Settings using the live market rate.</div>' : '';
      if (k === 'otp_btc_wallet_address') {
        extra += '<div class="form-note">Bitcoin address where customers pay the OTP fee. Customers buy Bitcoin elsewhere (e.g. MoonPay) and pay this address directly — no payment API keys are required.</div>';
      }
      if (k === 'withdrawal_fee') {
        extra += '<div class="form-note">Flat fee charged on top of every withdrawal amount. Set 0 for free withdrawals.</div>';
      }
      if (k === 'withdrawal_min_amount' || k === 'withdrawal_max_amount') {
        extra += '<div class="form-note">Set 0 to disable this ' + (k === 'withdrawal_min_amount' ? 'minimum' : 'maximum') + ' limit.</div>';
      }
      return '<div class="field"><label>' + labels[k] + '</label><input type="text" class="input" data-key="' + k + '" value="' + UI.escapeHtml(typeof v === 'string' ? v.replace(/"/g, '') : v) + '">' + extra + '</div>';
    }).join('');
  }

  function isSettingEnabled(settings, key) {
    const v = settings[key];
    if (v === undefined || v === null) return true; // backend fails closed: missing = OTP required
    if (v === true || v === false) return v;
    return String(v).toLowerCase() === 'true';
  }

  function renderOtpToggle(settings) {
    const el = document.getElementById('otp-settings-body');
    const errEl = document.getElementById('otp-settings-error');
    const raw = settings['otp_required_for_transfers'];
    const notConfigured = raw === undefined || raw === null;
    const enabled = isSettingEnabled(settings, 'otp_required_for_transfers');
    el.innerHTML =
      '<div class="flex-between" style="flex-wrap:wrap;gap:12px">' +
        '<div style="min-width:220px">' +
          '<div class="text-sm text-muted">Require OTP for Withdrawals &amp; Transfers</div>' +
          '<div style="margin:6px 0"><span class="badge ' + (enabled ? 'badge-success' : 'badge-neutral') + '" id="otp-toggle-indicator">' +
            (notConfigured ? 'Not configured — OTP required (default)' : (enabled ? 'Enabled — OTP required' : 'Disabled — OTP not required')) +
          '</span></div>' +
          '<div class="text-sm text-muted" style="margin:0">' +
            (enabled
              ? 'All withdrawals, eligible international transfers, and crypto withdrawals are held for one-time verification until a code is entered.'
              : 'Eligible transfers and withdrawals proceed without the extra OTP step after PIN, balance, fraud, and compliance checks.') +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start">' +
          '<label class="switch"><input type="checkbox" id="otp-require-toggle"' + (enabled ? ' checked' : '') + '><span class="track"></span></label>' +
          '<button class="btn btn-primary btn-sm" id="btn-save-otp-toggle">Save OTP Setting</button>' +
        '</div>' +
      '</div>' +
      '<div class="mt-3" style="border-top:1px solid var(--border);padding-top:12px">' +
        '<div class="flex-between" style="flex-wrap:wrap;gap:8px">' +
          '<div><div class="text-sm font-bold">Bitcoin rate for OTP quotes</div>' +
          '<div class="text-sm text-muted">Current: <span id="otp-btc-rate-label">' + (Number(settings.otp_btc_usd_rate) > 0 ? UI.money(settings.otp_btc_usd_rate, 'USD') : 'not set') + '</span> / BTC</div></div>' +
          '<button class="btn btn-outline btn-sm" id="btn-refresh-btc-rate">Refresh BTC rate</button>' +
        '</div>' +
        '<div class="form-error" id="btc-rate-error"></div>' +
      '</div>';

    document.getElementById('btn-save-otp-toggle').addEventListener('click', function () {
      const next = document.getElementById('otp-require-toggle').checked;
      if (next === enabled) {
        UI.toast('No change to save.', 'info');
        return;
      }
      UI.confirmDialog(
        next
          ? 'Require OTP verification for withdrawals and eligible transfers? New withdrawals, international transfers, and crypto withdrawals will be held until a one-time code is entered.'
          : 'Disable OTP verification for withdrawals and eligible transfers? New transfers and withdrawals will be released after PIN, balance, fraud, and compliance checks without the extra OTP step. This change is recorded in the audit log.',
        async function () {
          errEl.textContent = '';
          try {
            await adminApi('admin_update_setting', { p_key: 'otp_required_for_transfers', p_value: next });
            UI.toast('OTP verification setting updated to "' + (next ? 'Enabled' : 'Disabled') + '".', 'success');
            loadSettings();
          } catch (e) {
            errEl.textContent = UI.apiErrorMessage(e);
          }
        }
      );
    });

    document.getElementById('btn-refresh-btc-rate').addEventListener('click', async function () {
      const btn = this;
      const rateErr = document.getElementById('btc-rate-error');
      rateErr.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Fetching rate...';
      try {
        const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
        if (!res.ok) throw new Error('Rate service unavailable');
        const data = await res.json();
        const rate = Number(data && data.data && data.data.amount);
        if (!rate || rate <= 0) throw new Error('Invalid rate returned');
        await adminApi('admin_update_setting', { p_key: 'otp_btc_usd_rate', p_value: rate });
        UI.toast('BTC rate updated to ' + UI.money(rate, 'USD') + '/BTC.', 'success');
        loadSettings();
      } catch (e) {
        rateErr.textContent = 'Could not refresh the BTC rate: ' + UI.apiErrorMessage(e) + '. You can set it manually in System settings.';
        btn.disabled = false;
        btn.textContent = 'Refresh BTC rate';
      }
    });
  }

  const WD_METHODS = [
    { id: 'usdt', name: 'USDT (Tether)' },
    { id: 'btc', name: 'Bitcoin (BTC)' },
    { id: 'paypal', name: 'PayPal' },
    { id: 'cashapp', name: 'Cash App' },
    { id: 'wire', name: 'Wire Transfer' },
    { id: 'wise', name: 'Wise' },
    { id: 'payoneer', name: 'Payoneer' },
    { id: 'skrill', name: 'Skrill' },
    { id: 'stripe', name: 'Stripe' }
  ];

  function parseMethodsSetting(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { obj: raw, present: true };
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return { obj: parsed, present: true };
      } catch (e) { /* fall through */ }
    }
    const defaults = {};
    const defaultNetworks = { usdt: ['TRC20', 'ERC20', 'BEP20'], btc: ['Bitcoin'] };
    WD_METHODS.forEach(function (m) {
      defaults[m.id] = { enabled: true, networks: defaultNetworks[m.id] || [], status: 'manual' };
    });
    return { obj: defaults, present: false };
  }

  function renderWithdrawalMethods(settings) {
    const el = document.getElementById('withdrawal-methods-body');
    const parsed = parseMethodsSetting(settings['withdrawal_methods']);
    const cfg = parsed.obj;

    const rows = WD_METHODS.map(function (m, i) {
      const c = cfg[m.id] && typeof cfg[m.id] === 'object' ? cfg[m.id] : {};
      const enabled = c.enabled === true || c.enabled === 'true';
      const status = c.status === 'auto' || c.status === 'automatic' ? 'auto' : 'manual';
      const nets = Array.isArray(c.networks) ? c.networks : [];
      const netChips = nets.length
        ? '<div class="text-muted text-sm">' + nets.map(function (n) {
            return '<span class="badge badge-neutral" style="margin-right:4px;font-size:10px">' + UI.escapeHtml(n) + '</span>';
          }).join('') + '</div>'
        : '';
      return '<div class="wd-method-row"' + (i === 0 ? ' style="border-top:none;padding-top:0"' : '') + ' data-m="' + m.id + '">' +
        '<div><strong style="font-size:14px">' + UI.escapeHtml(m.name) + '</strong>' + netChips + '</div>' +
        '<div><select class="select" data-status style="min-width:150px">' +
          '<option value="manual"' + (status === 'manual' ? ' selected' : '') + '>Manual review</option>' +
          '<option value="auto"' + (status === 'auto' ? ' selected' : '') + '>Automatic payout</option>' +
        '</select></div>' +
        '<label class="switch" title="Enable or disable"><input type="checkbox" data-enabled' + (enabled ? ' checked' : '') + '><span class="track"></span></label>' +
      '</div>';
    }).join('');

    el.innerHTML =
      (parsed.present ? '' :
        '<div class="form-note" style="margin-bottom:10px;background:var(--warning-soft);border:1px solid var(--warning);color:var(--warning);padding:8px 12px;border-radius:8px">' +
        'Withdrawal methods are not configured yet — built-in defaults are shown. Saving here writes the setting.</div>') +
      '<div class="wd-method-row" style="border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:2px">' +
        '<div class="text-sm text-muted" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700">Method</div>' +
        '<div class="text-sm text-muted" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700">Processing</div>' +
        '<div class="text-sm text-muted" style="text-transform:uppercase;letter-spacing:.04em;font-weight:700">Enabled</div>' +
      '</div>' + rows;
  }

  document.getElementById('btn-save-withdrawal-methods').addEventListener('click', function () {
    const err = document.getElementById('withdrawal-methods-error');
    err.textContent = '';
    const rows = document.querySelectorAll('#withdrawal-methods-body [data-m]');
    if (!rows.length) { err.textContent = 'Nothing to save.'; return; }
    const settings = window.__adminSettingsCache || {};
    const parsed = parseMethodsSetting(settings['withdrawal_methods']);
    const obj = parsed.obj;
    rows.forEach(function (row) {
      const id = row.getAttribute('data-m');
      const prev = obj[id] && typeof obj[id] === 'object' ? obj[id] : {};
      obj[id] = {
        enabled: row.querySelector('[data-enabled]').checked,
        status: row.querySelector('[data-status]').value,
        networks: Array.isArray(prev.networks) ? prev.networks : []
      };
    });
    UI.confirmDialog('Save withdrawal method settings? Customers will see these methods on the Withdraw Funds page immediately.', async function () {
      try {
        await adminApi('admin_update_setting', { p_key: 'withdrawal_methods', p_value: obj });
        UI.toast('Withdrawal settings saved.', 'success');
        loadSettings();
      } catch (e) {
        err.textContent = UI.apiErrorMessage(e);
      }
    });
  });

  async function loadSettings() {
    const el = document.getElementById('settings-form');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading settings...</span></div>';
    try {
      const settings = await adminApi('admin_get_settings');
      window.__adminSettingsCache = settings || {};
      renderSettings(settings || {});
      renderOtpToggle(settings || {});
      renderWithdrawalMethods(settings || {});
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load settings');
      document.getElementById('otp-settings-body').innerHTML = UI.emptyState('Could not load OTP settings');
      document.getElementById('withdrawal-methods-body').innerHTML = UI.emptyState('Could not load withdrawal methods');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  document.getElementById('btn-add-admin').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Full name</label><input type="text" class="input" id="a-name"></div>' +
      '<div class="field"><label>Email</label><input type="email" class="input" id="a-email"></div>' +
      '<div class="field"><label>Role</label><select class="select" id="a-role">' + ROLES.map(function (r) { return '<option value="' + r + '">' + r + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Password</label><input type="password" class="input" id="a-pass"></div>' +
      '<div class="form-error" id="a-error"></div>',
      { title: 'Add Administrator', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('a-error');
      err.textContent = '';
      try {
        await adminApi('admin_create_admin', {
          p_email: document.getElementById('a-email').value.trim(),
          p_password: document.getElementById('a-pass').value,
          p_full_name: document.getElementById('a-name').value.trim(),
          p_role_name: document.getElementById('a-role').value,
          p_status: 'active'
        });
        UI.toast('Administrator added.', 'success');
        modal.close();
        loadAdmins();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  document.getElementById('btn-save-settings').addEventListener('click', async function () {
    const err = document.getElementById('settings-error');
    err.textContent = '';
    try {
      const inputs = document.querySelectorAll('#settings-form [data-key]');
      const values = {};
      for (const el of inputs) {
        values[el.getAttribute('data-key')] = el.value.trim();
      }
      const failed = [];
      for (const key in values) {
        let val = values[key];
        if (STRING_KEYS.indexOf(key) !== -1) val = '"' + val.replace(/"/g, '') + '"';
        if (NUMERIC_KEYS.indexOf(key) !== -1) val = String(Number(val) || 0);
        try {
          await adminApi('admin_update_setting', { p_key: key, p_value: JSON.parse(val) });
        } catch (e) {
          failed.push(key);
        }
      }
      if (failed.length) {
        err.textContent = 'Could not save: ' + failed.join(', ') + '. All other settings were saved — please try again.';
        UI.toast('Some settings could not be saved.', 'error');
      } else {
        UI.toast('Settings saved.', 'success');
      }
      loadSettings();
    } catch (e) { err.textContent = UI.apiErrorMessage(e); }
  });

  await loadAdmins();
  await loadSettings();
  PageLoader.hide();
})();