// NationalRegionB — Local transfer module
(async function () {
  await AppShell.init({ title: 'Local Transfer' });
  const user = Auth.user;

  const state = { step: 1, accounts: [], balances: {}, beneficiaries: [], recipient: null, otpRequired: false };

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

  function toggleOtpField() {
    document.getElementById('lt-otp-wrap').classList.toggle('hide', !state.otpRequired);
  }

  async function loadOtpSetting() {
    try {
      const cfg = await UI.rpc('customer_get_withdrawal_config', { p_user_id: user.id });
      state.otpRequired = !!(cfg && cfg.otp_required);
    } catch (e) {
      state.otpRequired = false;
    }
    toggleOtpField();
  }

  function showStep(n) {
    state.step = n;
    [1, 2, 3, 4].forEach(function (s) {
      const el = document.getElementById('step-' + s);
      el.classList.toggle('hide', s !== n);
      document.querySelectorAll('.step-pill[data-step="' + s + '"]').forEach(function (p) {
        p.classList.toggle('active', s === n);
        p.classList.toggle('done', s < n);
      });
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function load() {
    try {
      const [accRes, benRes, curRes] = await Promise.all([
        SB.from('accounts').select('*').eq('user_id', user.id).eq('status', 'active'),
        SB.from('beneficiaries').select('*').eq('user_id', user.id).eq('is_international', false),
        SB.from('currencies').select('code, symbol').order('code')
      ]);
      if (accRes.error) throw accRes.error;
      if (benRes.error) throw benRes.error;
      if (curRes.error) throw curRes.error;

      state.accounts = accRes.data || [];
      state.beneficiaries = benRes.data || [];
      const currencies = curRes.data || [];

      const balRes = await SB.from('account_balances').select('*').in('account_id', state.accounts.map(function (a) { return a.id; }));
      if (balRes.error) throw balRes.error;
      (balRes.data || []).forEach(function (b) { state.balances[b.account_id] = b; });

      // beneficiary select
      const sel = document.getElementById('beneficiary-select');
      sel.innerHTML = '<option value="">Select a saved beneficiary...</option>' + state.beneficiaries.map(function (b) {
        return '<option value="' + b.id + '">' + UI.escapeHtml(b.name) + ' · ' + UI.escapeHtml(b.account_number) + '</option>';
      }).join('');

      // from account select
      const fromSel = document.getElementById('t-from');
      fromSel.innerHTML = state.accounts.map(function (a) {
        return '<option value="' + a.id + '">' + UI.escapeHtml(a.account_name) + ' · ' + UI.escapeHtml(a.account_number) + ' (' + UI.escapeHtml(a.currency) + ')</option>';
      }).join('');

      // currency select
      const curSel = document.getElementById('r-currency');
      curSel.innerHTML = currencies.map(function (c) {
        return '<option value="' + c.code + '">' + c.code + ' (' + c.symbol + ')</option>';
      }).join('');
      curSel.value = 'USD';

      updateBalance();
      // load transfer history into recent tab? kept simple: no
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function updateBalance() {
    const fromId = document.getElementById('t-from').value;
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    const b = state.balances[fromId];
    if (acc && b) {
      document.getElementById('t-balance').textContent = UI.money(b.available_balance, acc.currency);
      document.getElementById('t-currency-tag').textContent = (APP_CONFIG.currencySymbols[acc.currency] || acc.currency);
      document.getElementById('t-currency-tag').dataset.cur = acc.currency;
    } else {
      document.getElementById('t-balance').textContent = '—';
    }
  }

  // --- Step 1: recipient ---
  document.getElementById('step1-next').addEventListener('click', async function () {
    const err = document.getElementById('step1-error');
    err.textContent = '';
    const benId = document.getElementById('beneficiary-select').value;
    if (benId) {
      const b = state.beneficiaries.find(function (x) { return x.id === benId; });
      state.recipient = { name: b.name, account: b.account_number, bank: b.bank_name || 'NationalRegionB', currency: b.currency || 'USD' };
    } else {
      const name = document.getElementById('r-name').value.trim();
      const account = document.getElementById('r-account').value.trim();
      const bank = document.getElementById('r-bank').value.trim() || 'NationalRegionB';
      const currency = document.getElementById('r-currency').value;
      if (!name || !account) { err.textContent = 'Enter the recipient name and account number.'; return; }
      if (!/^\d+$/.test(account) || account.length < 6) { err.textContent = 'Enter a valid account number.'; return; }
      state.recipient = { name: name, account: account, bank: bank, currency: currency };
    }
    document.getElementById('rv-name').textContent = state.recipient.name;
    document.getElementById('rv-account').textContent = state.recipient.account;
    document.getElementById('rv-bank').textContent = state.recipient.bank;
    showStep(2);
  });

  document.getElementById('btn-new-benef').addEventListener('click', function () {
    document.getElementById('benef-form').classList.toggle('hide');
  });

  document.getElementById('btn-save-benef').addEventListener('click', async function () {
    const name = document.getElementById('r-name').value.trim();
    const account = document.getElementById('r-account').value.trim();
    const bank = document.getElementById('r-bank').value.trim() || 'NationalRegionB';
    if (!name || !account) { UI.toast('Enter name and account number.', 'warning'); return; }
    const { error } = await SB.from('beneficiaries').insert({
      user_id: user.id, name: name, account_number: account, bank_name: bank,
      currency: document.getElementById('r-currency').value, is_international: false
    });
    if (error) { UI.toast(UI.apiErrorMessage(error), 'error'); return; }
    UI.toast('Beneficiary saved.', 'success');
    document.getElementById('benef-form').classList.add('hide');
    await load();
  });

  document.getElementById('t-from').addEventListener('change', updateBalance);
  document.getElementById('t-amount').addEventListener('input', function () {
    const amt = Number(this.value) || 0;
    const cur = document.getElementById('t-currency-tag').dataset.cur || 'USD';
    document.getElementById('t-total').textContent = UI.money(amt, cur);
  });

  // --- Step 2 ---
  document.getElementById('step2-next').addEventListener('click', function () {
    const err = document.getElementById('step2-error');
    err.textContent = '';
    const fromId = document.getElementById('t-from').value;
    const amount = Number(document.getElementById('t-amount').value);
    if (!fromId) { err.textContent = 'Select an account to transfer from.'; return; }
    if (!amount || amount <= 0) { err.textContent = 'Enter a valid amount.'; return; }
    const b = state.balances[fromId];
    if (b && amount > Number(b.available_balance)) { err.textContent = 'Insufficient funds for this transfer.'; return; }
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    document.getElementById('rv-from').textContent = acc.account_name + ' · ' + acc.account_number;
    document.getElementById('rv-amount').textContent = UI.money(amount, acc.currency);
    document.getElementById('rv-desc').textContent = document.getElementById('t-desc').value.trim() || '—';
    showStep(3);
  });

  document.getElementById('step2-back').addEventListener('click', function () { showStep(1); });

  // --- Step 3 ---
  document.getElementById('step3-next').addEventListener('click', async function () {
    const btn = this;
    const err = document.getElementById('step3-error');
    err.textContent = '';
    const fromId = document.getElementById('t-from').value;
    const amount = Number(document.getElementById('t-amount').value);
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    const desc = document.getElementById('t-desc').value.trim();

    let otpCode = null;
    if (state.otpRequired) {
      otpCode = (document.getElementById('lt-otp').value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{8}$/.test(otpCode)) {
        err.textContent = 'Enter the full 8-character verification code.';
        return;
      }
    }

    // try to resolve internal recipient
    let internalRecipient = null;
    const lookup = await SB.from('accounts').select('user_id').eq('account_number', state.recipient.account);
    if (!lookup.error && lookup.data && lookup.data.length) internalRecipient = lookup.data[0].user_id;

    try {
      const pin = await UI.promptPin({
        title: 'Confirm Transfer',
        message: 'Enter your 4-digit security PIN to authorize this transfer of ' + UI.money(amount, acc.currency) + ' to ' + state.recipient.name + '.'
      });
      btn.disabled = true;
      btn.textContent = 'Processing...';
      const transfer = await UI.rpc('create_local_transfer', {
        p_user_id: user.id,
        p_from_account_id: fromId,
        p_recipient_name: state.recipient.name,
        p_recipient_account_number: state.recipient.account,
        p_recipient_bank: state.recipient.bank,
        p_amount: amount,
        p_currency: acc.currency,
        p_description: desc || null,
        p_internal_recipient: internalRecipient || null,
        p_pin: pin,
        p_otp_code: otpCode
      });
      if (transfer && transfer.result === 'INVALID') {
        btn.disabled = false;
        btn.textContent = 'Confirm & Send';
        state.otpRequired = true;
        toggleOtpField();
        err.textContent = otpErrorText(transfer);
        const otpInput = document.getElementById('lt-otp');
        otpInput.value = '';
        otpInput.focus();
        return;
      }
      document.getElementById('done-ref').textContent = transfer.reference;
      document.getElementById('done-amount').textContent = UI.money(amount, acc.currency);
      document.getElementById('done-name').textContent = state.recipient.name;
      showStep(4);
      UI.toast('Transfer completed successfully.', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Confirm & Send';
      if (e && e.message !== 'CANCELLED') {
        if ((e.message || '').split('\n')[0].trim() === 'OTP_REQUIRED') {
          state.otpRequired = true;
          toggleOtpField();
          err.textContent = 'A one-time verification code is required for this transfer. Please purchase an OTP code and enter it above.';
        } else {
          err.textContent = UI.apiErrorMessage(e);
        }
      }
    }
  });

  document.getElementById('step3-back').addEventListener('click', function () {
    document.getElementById('step3-error').textContent = '';
    showStep(2);
  });

  await load();
  await loadOtpSetting();
  PageLoader.hide();
})();