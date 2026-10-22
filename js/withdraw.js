// NationalRegionB — Unified Withdraw Funds module
(async function () {
  await AppShell.init({ title: 'Withdraw Funds' });
  const user = Auth.user;

  const METHODS = [
    {
      id: 'usdt', name: 'USDT (Tether)', desc: 'Send to a USDT wallet address on the network you choose.',
      labelFrom: 'address',
      fields: [
        { k: 'address', label: 'USDT wallet address', ph: 'T… (TRC20) or 0x… (ERC20/BEP20)', spell: false },
        { k: 'network', label: 'Network', type: 'select', fromNetworks: true }
      ]
    },
    {
      id: 'btc', name: 'Bitcoin (BTC)', desc: 'Send to a Bitcoin wallet address. Processed after network confirmation.',
      labelFrom: 'address',
      fields: [
        { k: 'address', label: 'Bitcoin address', ph: 'bc1… or 1…', spell: false }
      ]
    },
    {
      id: 'paypal', name: 'PayPal', desc: 'Withdraw to a PayPal email address.',
      labelFrom: 'email',
      fields: [
        { k: 'email', label: 'PayPal email', type: 'email', ph: 'name@example.com' }
      ]
    },
    {
      id: 'cashapp', name: 'Cash App', desc: 'Withdraw to a $Cashtag.',
      labelFrom: 'cashtag',
      fields: [
        { k: 'cashtag', label: 'Cash App $Cashtag', ph: '$yourcashtag' }
      ]
    },
    {
      id: 'wire', name: 'Wire Transfer', desc: 'SWIFT bank wire to a beneficiary account.',
      labelFrom: 'beneficiary_name',
      fields: [
        { k: 'beneficiary_name', label: 'Beneficiary name', ph: 'Full name on the account' },
        { k: 'bank_name', label: 'Bank name', ph: 'e.g. First National Bank' },
        { k: 'account_number', label: 'Account number / IBAN', ph: 'Account number' },
        { k: 'routing_number', label: 'Routing number / sort code', ph: 'e.g. 021000021' },
        { k: 'swift_code', label: 'SWIFT/BIC (optional)', ph: 'e.g. CHASUS33', optional: true, spell: false }
      ]
    },
    {
      id: 'wise', name: 'Wise', desc: 'Withdraw to a Wise recipient.',
      labelFrom: 'recipient_name',
      fields: [
        { k: 'recipient_name', label: 'Recipient name', ph: 'Full name' },
        { k: 'email', label: 'Recipient email', type: 'email', ph: 'name@example.com' }
      ]
    },
    {
      id: 'payoneer', name: 'Payoneer', desc: 'Withdraw to a Payoneer recipient.',
      labelFrom: 'recipient_name',
      fields: [
        { k: 'recipient_name', label: 'Recipient name', ph: 'Full name' },
        { k: 'email', label: 'Recipient email', type: 'email', ph: 'name@example.com' }
      ]
    },
    {
      id: 'skrill', name: 'Skrill', desc: 'Withdraw to a Skrill recipient.',
      labelFrom: 'recipient_name',
      fields: [
        { k: 'recipient_name', label: 'Recipient name', ph: 'Full name' },
        { k: 'email', label: 'Recipient email', type: 'email', ph: 'name@example.com' }
      ]
    },
    {
      id: 'stripe', name: 'Stripe', desc: 'Pay out to a connected Stripe account.',
      labelFrom: 'connected_account',
      fields: [
        { k: 'connected_account', label: 'Connected account', ph: 'acct_… or name@company.com', spell: false }
      ]
    }
  ];

  const LOGOS = {
    usdt: '<img src="assets/logos/usdtlogo.png" alt="">',
    btc: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#F7931A"/><text x="20" y="27" text-anchor="middle" font-size="21" font-weight="700" fill="#fff" font-family="Arial, sans-serif">&#8383;</text></svg>',
    paypal: '<img src="assets/logos/paypallogo.png" alt="">',
    cashapp: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#00D54B"/><text x="20" y="28" text-anchor="middle" font-size="22" font-weight="700" fill="#fff" font-family="Arial, sans-serif">$</text></svg>',
    wire: '<img src="assets/logos/logo.svg" alt="">',
    wise: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#9FE870"/><text x="20" y="27" text-anchor="middle" font-size="19" font-weight="800" fill="#163300" font-family="Arial, sans-serif">W</text></svg>',
    payoneer: '<img src="assets/logos/payoneer.png" alt="">',
    skrill: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#6C2B95"/><text x="20" y="27" text-anchor="middle" font-size="20" font-weight="700" fill="#fff" font-family="Arial, sans-serif">S</text></svg>',
    stripe: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#635BFF"/><text x="20" y="28" text-anchor="middle" font-size="21" font-weight="700" fill="#fff" font-family="Arial, sans-serif">S</text></svg>'
  };

  const DEFAULT_NETWORKS = { usdt: ['TRC20', 'ERC20', 'BEP20'], btc: ['Bitcoin'] };

  const state = {
    config: null,
    configOk: false,
    accounts: [],
    balances: {},
    method: null,
    requestId: null,
    submitting: false
  };

  function methodDef(id) {
    return METHODS.find(function (m) { return m.id === id; }) || null;
  }

  function defaultMethods() {
    const o = {};
    METHODS.forEach(function (m) {
      o[m.id] = { enabled: true, networks: DEFAULT_NETWORKS[m.id] || [], status: 'manual' };
    });
    return o;
  }

  function defaultConfig() {
    return { methods: defaultMethods(), fee: 0, min: 10, max: 250000, otp_required: true, currency: 'USD' };
  }

  function methodCfg(id) {
    const raw = state.config && state.config.methods ? state.config.methods[id] : null;
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  }

  function methodEnabled(id) {
    const c = methodCfg(id);
    return !!(c && (c.enabled === true || c.enabled === 'true'));
  }

  async function loadConfig() {
    try {
      const res = await UI.rpc('customer_get_withdrawal_config', { p_user_id: user.id });
      if (!res || typeof res !== 'object' || !res.methods) throw new Error('bad config');
      state.config = res;
      state.configOk = true;
      document.getElementById('wd-config-banner').classList.add('hide');
    } catch (e) {
      state.config = defaultConfig();
      state.configOk = false;
      document.getElementById('wd-config-banner').classList.remove('hide');
    }
  }

  async function loadAccounts() {
    try {
      const accRes = await SB.from('accounts').select('*').eq('user_id', user.id).eq('status', 'active');
      if (accRes.error) throw accRes.error;
      const all = accRes.data || [];
      const base = (state.config && state.config.currency) || 'USD';
      state.accounts = all.filter(function (a) { return a.currency === base; });
      const balRes = await SB.from('account_balances').select('*').in('account_id', all.map(function (a) { return a.id; }));
      if (balRes.error) throw balRes.error;
      (balRes.data || []).forEach(function (b) { state.balances[b.account_id] = b; });
    } catch (e) {
      state.accounts = [];
    }
  }

  function statusBadge(cfg, enabled) {
    if (!enabled) return '<span class="badge badge-neutral">Unavailable</span>';
    if (cfg && (cfg.status === 'auto' || cfg.status === 'automatic')) return '<span class="badge badge-success">Automatic payout</span>';
    if (cfg && cfg.status === 'disabled') return '<span class="badge badge-neutral">Unavailable</span>';
    return '<span class="badge badge-info">Manual payout</span>';
  }

  function renderMethods() {
    const el = document.getElementById('method-grid');
    el.innerHTML = METHODS.map(function (m) {
      const cfg = methodCfg(m.id) || {};
      const enabled = methodEnabled(m.id);
      const nets = Array.isArray(cfg.networks) ? cfg.networks : [];
      const chips = nets.length
        ? '<span class="method-chips">' + nets.map(function (n) {
            return '<span class="chip">' + UI.escapeHtml(n) + '</span>';
          }).join('') + '</span>'
        : '';
      return '<button type="button" class="method-card' + (enabled ? '' : ' is-disabled') + '" data-method="' + m.id + '"' +
        (enabled ? '' : ' disabled') + ' aria-pressed="false">' +
        '<span class="method-logo">' + LOGOS[m.id] + '</span>' +
        '<span class="method-body">' +
          '<span class="method-name">' + UI.escapeHtml(m.name) + '</span>' +
          '<span class="method-desc">' + UI.escapeHtml(m.desc) + '</span>' +
          chips +
        '</span>' +
        '<span class="method-status">' + statusBadge(cfg, enabled) + '</span>' +
      '</button>';
    }).join('');

    el.querySelectorAll('.method-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-method');
        if (!methodEnabled(id)) {
          UI.toast('This withdrawal method is currently unavailable.', 'warning');
          return;
        }
        selectMethod(id);
      });
    });
  }

  function fieldHTML(f, networks) {
    const esc = UI.escapeHtml;
    if (f.type === 'select') {
      const opts = (networks && networks.length ? networks : ['TRC20', 'ERC20', 'BEP20']);
      return '<div class="field"><label>' + esc(f.label) + '</label>' +
        '<select class="select" data-fk="' + f.k + '">' +
        opts.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') +
        '</select></div>';
    }
    const type = f.type === 'email' ? 'email' : 'text';
    return '<div class="field"><label>' + esc(f.label) + '</label>' +
      '<input type="' + type + '" class="input" data-fk="' + f.k + '" placeholder="' + esc(f.ph || '') + '"' +
      (f.spell === false ? ' spellcheck="false" autocapitalize="off"' : '') + '></div>';
  }

  function renderFields() {
    const def = state.method;
    const cfg = methodCfg(def.id) || {};
    const cur = (state.config && state.config.currency) || 'USD';
    const accOpts = state.accounts.length
      ? state.accounts.map(function (a) {
          return '<option value="' + a.id + '">' + UI.escapeHtml(a.account_name) + ' · ' + UI.escapeHtml(a.account_number) + ' (' + a.currency + ')</option>';
        }).join('')
      : '<option value="">No base currency account</option>';

    document.getElementById('wd-fields').innerHTML =
      '<div class="field"><label>From account</label><select class="select" id="wd-account">' + accOpts + '</select></div>' +
      '<div class="field"><label>Available balance</label><div class="input" id="wd-balance-box" disabled>—</div></div>' +
      '<div class="field"><label>Amount to withdraw</label>' +
        '<div class="amount-field"><input type="number" class="input" id="wd-amount" min="0.01" step="any" placeholder="0.00">' +
        '<span class="currency-tag" id="wd-cur-tag">' + UI.escapeHtml(cur) + '</span></div>' +
      '</div>' +
      def.fields.map(function (f) { return fieldHTML(f, cfg.networks); }).join('');

    document.getElementById('wd-form-title').textContent = def.name;
    document.getElementById('wd-form-sub').textContent = def.desc;

    document.getElementById('wd-account').addEventListener('change', function () { updateBalance(); updatePreview(); });
    document.getElementById('wd-amount').addEventListener('input', function () {
      document.getElementById('wd-error').textContent = '';
      updatePreview();
    });
    document.getElementById('wd-fields').querySelectorAll('[data-fk]').forEach(function (inp) {
      inp.addEventListener('input', function () { document.getElementById('wd-error').textContent = ''; });
    });

    updateBalance();
    updatePreview();
  }

  function selectMethod(id) {
    state.method = methodDef(id);
    if (!state.method) return;
    document.querySelectorAll('.method-card').forEach(function (c) {
      c.classList.toggle('is-selected', c.getAttribute('data-method') === id);
      c.setAttribute('aria-pressed', c.getAttribute('data-method') === id ? 'true' : 'false');
    });
    document.getElementById('wd-form-card').classList.remove('hide');
    document.getElementById('wd-error').textContent = '';
    renderFields();
    document.getElementById('wd-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function currentAccount() {
    const sel = document.getElementById('wd-account');
    if (!sel) return null;
    return state.accounts.find(function (a) { return a.id === sel.value; }) || null;
  }

  function updateBalance() {
    const acc = currentAccount();
    const b = acc ? state.balances[acc.id] : null;
    document.getElementById('wd-balance').textContent = (acc && b) ? UI.money(b.available_balance, acc.currency) : '—';
    const box = document.getElementById('wd-balance-box');
    if (box) box.textContent = (acc && b) ? UI.money(b.available_balance, acc.currency) : '—';
  }

  function feeValue() {
    const f = Number(state.config ? state.config.fee : 0);
    return isFinite(f) && f > 0 ? f : 0;
  }

  function updatePreview() {
    const acc = currentAccount();
    const cur = acc ? acc.currency : ((state.config && state.config.currency) || 'USD');
    const amount = Number(document.getElementById('wd-amount') ? document.getElementById('wd-amount').value : 0) || 0;
    const fee = feeValue();
    const min = Number(state.config ? state.config.min : 0) || 0;
    const max = Number(state.config ? state.config.max : 0) || 0;
    const bal = acc && state.balances[acc.id] ? Number(state.balances[acc.id].available_balance) : null;

    document.getElementById('wd-cur-tag').textContent = cur;
    document.getElementById('wd-fee').textContent = fee > 0 ? UI.money(fee, cur) : 'Free';
    document.getElementById('wd-limits').textContent =
      (min > 0 ? 'Min ' + UI.money(min, cur) : 'No minimum') + ' · ' +
      (max > 0 ? 'Max ' + UI.money(max, cur) : 'No maximum');
    document.getElementById('wd-balance').textContent = bal !== null ? UI.money(bal, cur) : '—';
    document.getElementById('wd-total').textContent = UI.money(amount + fee, cur);
  }

  function renderOtpHint() {
    const el = document.getElementById('wd-otp-hint');
    if (state.config && state.config.otp_required) {
      el.innerHTML = 'A one-time verification code is required. <a href="otp-purchase.html">Buy an OTP code</a>';
    } else {
      el.textContent = '';
    }
  }

  function collectDetails() {
    const details = {};
    state.method.fields.forEach(function (f) {
      const el = document.querySelector('#wd-fields [data-fk="' + f.k + '"]');
      details[f.k] = el ? (el.value || '').trim() : '';
    });
    return details;
  }

  function validate() {
    const err = document.getElementById('wd-error');
    err.textContent = '';
    const acc = currentAccount();
    if (!acc) return fail('Select an account to withdraw from.');
    const amount = Number(document.getElementById('wd-amount').value);
    if (!amount || amount <= 0) return fail('Enter a valid amount.');
    const min = Number(state.config.min) || 0;
    const max = Number(state.config.max) || 0;
    if (min > 0 && amount < min) return fail('Amount must be at least ' + UI.money(min, acc.currency) + '.');
    if (max > 0 && amount > max) return fail('Amount must not exceed ' + UI.money(max, acc.currency) + '.');
    const fee = feeValue();
    const bal = state.balances[acc.id] ? Number(state.balances[acc.id].available_balance) : 0;
    if (bal < amount + fee) return fail('Insufficient funds for the amount plus fee.');

    const details = collectDetails();
    for (let i = 0; i < state.method.fields.length; i++) {
      const f = state.method.fields[i];
      const v = (details[f.k] || '').trim();
      if (!v && !f.optional) return fail(f.label.replace(' (optional)', '') + ' is required.');
      if (!v) continue;
      if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v)) return fail('Enter a valid email address.');
      if (f.k === 'cashtag' && !/^[A-Za-z0-9_]{1,32}$/.test(v.replace(/^\$/, ''))) return fail('Enter a valid $Cashtag (letters, numbers and underscores).');
      if (f.k === 'address' && v.length < 10) return fail('Enter a valid wallet address.');
      if (f.k === 'connected_account' && v.length < 3) return fail('Enter a valid connected account.');
    }

    let label = details[state.method.labelFrom] || '';
    if (state.method.labelFrom === 'cashtag') {
      label = label.replace(/^\$/, '');
      if (label) label = '$' + label;
    }
    return { ok: true, acc: acc, amount: amount, details: details, label: label };
  }

  function fail(msg) {
    document.getElementById('wd-error').textContent = msg;
    return { ok: false };
  }

  function otpErrorText(res) {
    const left = res && res.attempts_left;
    switch (res && res.reason) {
      case 'invalid': return 'Incorrect verification code.' + (left != null ? ' ' + left + ' attempt' + (left === 1 ? '' : 's') + ' remaining.' : '');
      case 'expired': return 'This verification code has expired. Please purchase a new OTP code.';
      case 'used': return 'This verification code has already been used.';
      case 'locked': return 'Too many incorrect attempts — your code has been invalidated. Please purchase a new OTP code.';
      case 'failed': return 'This verification code is no longer active. Please contact support.';
      case 'none': return 'No valid verification code found. Please purchase an OTP code first.';
      default: return 'The verification code could not be verified.';
    }
  }

  function friendlySubmitError(e) {
    const raw = (e && e.message ? e.message : String(e || '')).split('\n')[0].trim();
    if (raw.indexOf('does not exist') !== -1) {
      return 'Withdrawals are temporarily unavailable. Please try again later or contact support.';
    }
    if (raw.indexOf('MISSING_FIELD:') === 0) {
      return 'Please fill in all required fields.';
    }
    if (raw.indexOf('FIELD_TOO_LONG:') === 0) {
      return 'One of the fields is too long.';
    }
    return UI.apiErrorMessage(e);
  }

  function openReview(v) {
    const acc = v.acc;
    const fee = feeValue();
    const cur = acc.currency;
    const otpRequired = !!(state.config && state.config.otp_required);
    state.requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('req-' + Date.now() + '-' + Math.floor(Math.random() * 1e9));

    const detailRows = state.method.fields
      .filter(function (f) { return v.details[f.k]; })
      .map(function (f) {
        return '<div class="detail-item"><div class="k">' + UI.escapeHtml(f.label.replace(' (optional)', '')) + '</div><div class="v">' + UI.escapeHtml(v.details[f.k]) + '</div></div>';
      }).join('');

    const otpBlock = otpRequired
      ? '<div class="field" style="margin-top:14px"><label>One-time verification code</label>' +
        '<input type="text" class="input" id="rv-otp" maxlength="8" autocomplete="off" spellcheck="false" autocapitalize="characters" ' +
        'style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-family:ui-monospace,monospace;font-size:18px" placeholder="••••-XXXX">' +
        '<div class="text-muted text-sm" style="margin-top:6px">Enter the 8-character code from your OTP purchase. ' +
        '<a href="otp-purchase.html">Buy an OTP code</a></div></div>'
      : '';

    const modal = UI.openModal(
      '<div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Method</div><div class="v">' + UI.escapeHtml(state.method.name) + '</div></div>' +
        '<div class="detail-item"><div class="k">From</div><div class="v">' + UI.escapeHtml(acc.account_name) + ' · ' + UI.escapeHtml(acc.account_number) + '</div></div>' +
        '<div class="detail-item"><div class="k">Recipient</div><div class="v">' + UI.escapeHtml(v.label) + '</div></div>' +
        detailRows +
        '<div class="detail-item"><div class="k">Amount</div><div class="v">' + UI.money(v.amount, cur) + '</div></div>' +
        '<div class="detail-item"><div class="k">Fee</div><div class="v">' + (fee > 0 ? UI.money(fee, cur) : 'Free') + '</div></div>' +
        '<div class="detail-item"><div class="k">Total debited</div><div class="v"><strong>' + UI.money(v.amount + fee, cur) + '</strong></div></div>' +
      '</div>' +
      otpBlock +
      '<div class="form-error" id="rv-error" style="margin-top:10px"></div>',
      {
        title: 'Review withdrawal',
        footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-submit>Confirm &amp; Submit</button>'
      }
    );

    const errEl = modal.body.querySelector('#rv-error');
    const submitBtn = modal.footer.querySelector('[data-submit]');
    modal.footer.querySelector('[data-cancel]').addEventListener('click', function () {
      if (state.submitting) return;
      modal.close();
    });

    if (otpRequired) {
      const otpInput = modal.body.querySelector('#rv-otp');
      setTimeout(function () { if (otpInput) otpInput.focus(); }, 60);
    }

    submitBtn.addEventListener('click', async function () {
      if (state.submitting) return;
      errEl.textContent = '';
      let otpCode = null;
      if (otpRequired) {
        otpCode = (modal.body.querySelector('#rv-otp').value || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{8}$/.test(otpCode)) {
          errEl.textContent = 'Enter the full 8-character verification code.';
          return;
        }
      }

      let pin;
      try {
        pin = await UI.promptPin({
          title: 'Confirm Withdrawal',
          message: 'Enter your 4-digit security PIN to authorize a withdrawal of ' + UI.money(v.amount, cur) + ' via ' + state.method.name + ' to ' + v.label + '.'
        });
      } catch (e) {
        if (e && e.message !== 'CANCELLED') errEl.textContent = UI.apiErrorMessage(e);
        return;
      }

      state.submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      try {
        const res = await UI.rpc('customer_create_withdrawal', {
          p_user_id: user.id,
          p_from_account_id: acc.id,
          p_method: state.method.id,
          p_amount: v.amount,
          p_recipient_label: v.label,
          p_recipient_details: v.details,
          p_pin: pin,
          p_otp_code: otpCode,
          p_request_id: state.requestId
        });
        state.submitting = false;
        if (res && res.result === 'OK') {
          modal.close();
          showSuccess(res, cur, v.amount);
          return;
        }
        state.submitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm & Submit';
        if (res && res.result === 'INVALID') {
          errEl.textContent = otpErrorText(res);
          const otpEl = modal.body.querySelector('#rv-otp');
          if (otpEl) { otpEl.value = ''; otpEl.focus(); }
        } else {
          errEl.textContent = 'The withdrawal could not be submitted. Please try again.';
        }
      } catch (e) {
        state.submitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm & Submit';
        errEl.textContent = friendlySubmitError(e);
      }
    });
  }

  function showSuccess(res, cur, amount) {
    state.requestId = null;
    const modal = UI.openModal(
      '<div class="text-center">' +
        '<div class="xflow-icon is-success" style="margin:0 auto">✓</div>' +
        '<h3 style="margin:10px 0 6px">Withdrawal submitted</h3>' +
        '<p class="text-muted" style="margin:0 0 12px">Your withdrawal has been received and is pending review by our team. You can track it below.</p>' +
        '<div style="margin-bottom:12px">' + UI.badge(res.status || 'pending') + '</div>' +
        '<div class="detail-grid" style="text-align:left">' +
          '<div class="detail-item"><div class="k">Reference</div><div class="v">' + UI.escapeHtml(res.reference || '—') + '</div></div>' +
          '<div class="detail-item"><div class="k">Amount</div><div class="v">' + UI.money(res.amount != null ? res.amount : amount, res.currency || cur) + '</div></div>' +
          '<div class="detail-item"><div class="k">Fee</div><div class="v">' + ((Number(res.fee) || 0) > 0 ? UI.money(res.fee, res.currency || cur) : 'Free') + '</div></div>' +
        '</div>' +
      '</div>',
      {
        title: 'Withdrawal submitted',
        footer: '<button class="btn btn-outline" data-history>View history</button><button class="btn btn-primary" data-done>Done</button>'
      }
    );
    modal.footer.querySelector('[data-done]').addEventListener('click', function () {
      modal.close();
      resetForm();
    });
    modal.footer.querySelector('[data-history]').addEventListener('click', function () {
      modal.close();
      resetForm();
      loadHistory();
      document.getElementById('wd-history').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    loadHistory();
    UI.toast('Withdrawal ' + (res.reference || '') + ' submitted for review.', 'success');
  }

  function resetForm() {
    state.method = null;
    state.requestId = null;
    document.getElementById('wd-form-card').classList.add('hide');
    document.querySelectorAll('.method-card').forEach(function (c) {
      c.classList.remove('is-selected');
      c.setAttribute('aria-pressed', 'false');
    });
  }

  async function loadHistory() {
    const el = document.getElementById('wd-history');
    try {
      const res = await SB.from('withdrawals').select('*').order('created_at', { ascending: false }).limit(50);
      if (res.error) throw res.error;
      renderHistory(res.data || []);
    } catch (e) {
      // History is best-effort: pre-migration (table missing) or transient
      // read failures degrade to a silent empty state.
      el.innerHTML = UI.emptyState('No withdrawals yet');
    }
  }

  function renderHistory(rows) {
    const el = document.getElementById('wd-history');
    if (!rows.length) {
      el.innerHTML = UI.emptyState('No withdrawals yet');
      return;
    }
    el.innerHTML = '<div class="table-wrap"><table class="table mobile-cards">' +
      '<thead><tr><th>Reference</th><th>Method</th><th>Recipient</th><th>Amount</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>' +
      rows.map(function (w) {
        const def = methodDef(w.method);
        const canCancel = w.status === 'pending' || w.status === 'processing';
        return '<tr>' +
          '<td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(w.reference) + '</span></td>' +
          '<td data-label="Method">' + UI.escapeHtml(def ? def.name : w.method) + '</td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(w.recipient_label || '—') + '</td>' +
          '<td data-label="Amount">' + UI.money(w.amount, w.currency) +
            ((Number(w.fee) || 0) > 0 ? '<div class="cell-sub">fee ' + UI.money(w.fee, w.currency) + '</div>' : '') + '</td>' +
          '<td data-label="Status">' + UI.badge(w.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(w.created_at) + '</td>' +
          '<td data-label="Actions">' + (canCancel
            ? '<button class="row-action" data-cancel-wd="' + w.id + '" title="Cancel withdrawal">' + ICONS.close + '</button>'
            : '') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

    el.querySelectorAll('[data-cancel-wd]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const row = rows.find(function (x) { return x.id === btn.getAttribute('data-cancel-wd'); });
        if (!row) return;
        UI.confirmDialog(
          'Cancel withdrawal ' + row.reference + '? ' + UI.money(row.amount + (Number(row.fee) || 0), row.currency) + ' will be returned to your account.',
          async function () {
            try {
              await UI.rpc('customer_cancel_withdrawal', { p_user_id: user.id, p_withdrawal_id: row.id });
              UI.toast('Withdrawal ' + row.reference + ' cancelled. Funds were returned to your account.', 'success');
              loadHistory();
            } catch (e) {
              UI.toast(friendlySubmitError(e), 'error');
            }
          }
        );
      });
    });
  }

  document.getElementById('wd-review').addEventListener('click', function () {
    const v = validate();
    if (v.ok) openReview(v);
  });

  document.getElementById('wd-form-close').addEventListener('click', function () {
    resetForm();
  });

  document.getElementById('wd-refresh').addEventListener('click', function () {
    loadHistory();
  });

  await loadConfig();
  await loadAccounts();
  renderMethods();
  renderOtpHint();
  loadHistory();
  PageLoader.hide();
})();
