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

  const STRING_KEYS = ['bank_name', 'currency', 'otp_btc_wallet_address', 'moonpay_public_key', 'moonpay_secret_key'];
  const NUMERIC_KEYS = ['local_transfer_fee', 'intl_transfer_fee', 'swap_fee_percent', 'otp_purchase_price_usd', 'otp_btc_usd_rate'];

  function renderSettings(settings) {
    const el = document.getElementById('settings-form');
    const keys = ['bank_name', 'currency', 'local_transfer_fee', 'intl_transfer_fee', 'swap_fee_percent', 'maintenance_mode',
                  'otp_purchase_price_usd', 'otp_btc_usd_rate', 'otp_btc_wallet_address', 'moonpay_public_key', 'moonpay_secret_key'];
    const labels = {
      bank_name: 'Bank name', currency: 'Default currency',
      local_transfer_fee: 'Local transfer fee (flat)', intl_transfer_fee: 'International transfer fee (flat)',
      swap_fee_percent: 'Currency swap fee %', maintenance_mode: 'Maintenance mode',
      otp_purchase_price_usd: 'OTP purchase price (USD)', otp_btc_usd_rate: 'BTC/USD reference rate',
      otp_btc_wallet_address: 'OTP Bitcoin wallet address', moonpay_public_key: 'MoonPay publishable API key',
      moonpay_secret_key: 'MoonPay secret API key (server-side)'
    };
    el.innerHTML = keys.map(function (k) {
      const val = settings[k];
      const v = val === undefined || val === null ? '' : val;
      if (k === 'maintenance_mode') {
        return '<div class="field"><label>' + labels[k] + '</label><select class="select" data-key="' + k + '"><option value="true"' + (String(v) === 'true' ? ' selected' : '') + '>On</option><option value="false"' + (String(v) === 'false' ? ' selected' : '') + '>Off</option></select></div>';
      }
      let extra = k === 'otp_btc_usd_rate' ? '<div class="form-note">Used to quote OTP purchases. Refresh it from OTP Verification Settings using the live market rate.</div>' : '';
      if (k === 'moonpay_public_key') {
        extra = '<div class="form-note">Publishable (pk_...) key from your MoonPay dashboard (dashboard.moonpay.com \u2192 Customers \u2192 API keys). Required to activate the “Pay with MoonPay” checkout buttons. Safe to expose in the browser \u2014 never enter your secret (sk_) key here.</div>';
      }
      if (k === 'moonpay_secret_key') {
        extra = '<div class="form-note">Server-side signing key (sk_...) from your MoonPay dashboard. Required by MoonPay to pre-fill the destination wallet address in checkout URLs. Stored securely and never sent to customers. Leave empty for an unsigned checkout (customers paste the wallet address themselves).</div>';
      }
      const inputType = k === 'moonpay_secret_key' ? 'password' : 'text';
      return '<div class="field"><label>' + labels[k] + '</label><input type="' + inputType + '" class="input" data-key="' + k + '" value="' + UI.escapeHtml(typeof v === 'string' ? v.replace(/"/g, '') : v) + '">' + extra + '</div>';
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
          '<div class="text-sm text-muted">Require OTP for Transfers</div>' +
          '<div style="margin:6px 0"><span class="badge ' + (enabled ? 'badge-success' : 'badge-neutral') + '" id="otp-toggle-indicator">' +
            (notConfigured ? 'Not configured — OTP required (default)' : (enabled ? 'Enabled — OTP required' : 'Disabled — OTP not required')) +
          '</span></div>' +
          '<div class="text-sm text-muted" style="margin:0">' +
            (enabled
              ? 'International transfers and crypto withdrawals are held for one-time verification until a code is entered.'
              : 'Eligible transfers proceed without the extra OTP step after PIN, balance, fraud, and compliance checks.') +
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
          ? 'Require OTP verification for eligible transfers? New international transfers and crypto withdrawals will be held until a one-time code is entered.'
          : 'Disable OTP verification for eligible transfers? New transfers will be released after PIN, balance, fraud, and compliance checks without the extra OTP step. This change is recorded in the audit log.',
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

  async function loadSettings() {
    const el = document.getElementById('settings-form');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading settings...</span></div>';
    try {
      const settings = await adminApi('admin_get_settings');
      renderSettings(settings || {});
      renderOtpToggle(settings || {});
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load settings');
      document.getElementById('otp-settings-body').innerHTML = UI.emptyState('Could not load OTP settings');
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
      const pk = values.moonpay_public_key || '';
      const sk = values.moonpay_secret_key || '';
      if (pk && !/^pk_[A-Za-z0-9]+$/.test(pk)) {
        err.textContent = 'MoonPay publishable API key must start with "pk_" — copy it from dashboard.moonpay.com (Customers → API keys). Settings were not saved.';
        return;
      }
      if (sk && !/^sk_[A-Za-z0-9]+$/.test(sk)) {
        err.textContent = 'MoonPay secret API key must start with "sk_" — copy it from dashboard.moonpay.com (Customers → API keys). Settings were not saved.';
        return;
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