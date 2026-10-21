// NationalRegionB — OTP Purchase page module (otp-purchase.html)
// Buy a $100 Bitcoin-funded OTP code. Payment is verified by staff on-chain
// BEFORE any code is issued; MoonPay (if configured) only initiates the BTC
// purchase to the designated wallet — its redirect is never treated as proof.
(async function () {
  const profile = await AppShell.init({ title: 'OTP Purchase' });
  if (!profile) return;
  const user = Auth.user;
  const root = document.getElementById('otp-purchase');
  if (!root) { PageLoader.hide(); return; }

  const state = { settings: null, purchases: [], active: null, latest: null };

  const ACTIVE_STATUSES = ['pending', 'awaiting_verification'];

  async function refresh() {
    root.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading OTP purchase...</span></div>';
    try {
      const results = await Promise.all([
        UI.rpc('customer_get_otp_purchase_settings', {}),
        UI.rpc('customer_list_otp_purchases', { p_user_id: user.id })
      ]);
      state.settings = results[0] || {};
      state.purchases = Array.isArray(results[1]) ? results[1] : [];
      state.active = state.purchases.find(function (p) { return ACTIVE_STATUSES.indexOf(p.status) !== -1; }) || null;
      state.latest = state.purchases[0] || null;
      render();
    } catch (e) {
      root.innerHTML =
        '<p class="text-muted">OTP purchase is not available right now. Please try again later.</p>' +
        '<p class="text-sm text-muted">' + UI.escapeHtml(UI.apiErrorMessage(e)) + '</p>';
    }
  }

  // ---------------------------------------------------------------- render
  function render() {
    const s = state.settings || {};
    const fee = UI.money(s.price_usd != null ? s.price_usd : 100, 'USD');
    let html = '';

    html +=
      '<div class="otp-intro">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:8px">' +
          '<div><div class="text-sm text-muted">OTP fee</div>' +
          '<div style="font-size:22px;font-weight:800;color:var(--primary)">' + fee + ' <span class="text-sm text-muted" style="font-weight:600">per code</span></div></div>' +
          '<div style="text-align:right"><div class="text-sm text-muted">BTC reference rate</div>' +
          '<div class="font-bold">' + (s.btc_rate_usd > 0 ? UI.money(s.btc_rate_usd, 'USD') + ' / BTC' : 'Not configured') + '</div></div>' +
        '</div>' +
        '<p class="text-sm text-muted" style="margin:0">Use a purchased OTP code when an eligible international transfer, crypto withdrawal, or authorized brand-partnership transaction asks for a one-time verification code. Codes are single-use and issued only after your Bitcoin payment is independently verified.</p>' +
      '</div>';

    if (state.active && state.active.status === 'pending') {
      html += pendingPanel(state.active, s);
    } else if (state.active && state.active.status === 'awaiting_verification') {
      html += awaitingPanel(state.active);
    } else if (state.latest && state.latest.status === 'confirmed' && !state.latest.otp_used_at && state.latest.otp_expires_at && new Date(state.latest.otp_expires_at) > new Date()) {
      html += codePanel(state.latest);
    } else {
      html += buyPanel(s, fee);
    }

    html += instructionsPanel();
    html += termsPanel();
    html += historyPanel();

    root.innerHTML = html;
    bind();
  }

  function buyPanel(s, fee) {
    const moonpay = !!(s.moonpay_enabled && s.moonpay_public_key);
    return (
      '<div class="otp-actions mb-3">' +
        '<button class="btn btn-primary btn-lg" id="otp-buy-btn" style="border-radius:12px;font-weight:700">Buy OTP Code — ' + fee + '</button>' +
        (moonpay
          ? '<p class="text-sm text-muted" style="margin:8px 0 0">Payment options: MoonPay (card/bank — BTC delivered to our wallet) or direct Bitcoin transfer.</p>'
          : '<p class="text-sm text-muted" style="margin:8px 0 0">Pay in Bitcoin (BTC) to the designated wallet. MoonPay online checkout is not configured on this platform yet — a direct BTC payment is the supported method.</p>') +
      '</div>'
    );
  }

  function pendingPanel(p, s) {
    const expired = p.created_at && s.quote_ttl_minutes
      ? (Date.now() - new Date(p.created_at).getTime()) > s.quote_ttl_minutes * 60000 * 2
      : false;
    const moonpay = !!(s.moonpay_enabled && s.moonpay_public_key);
    return (
      '<div class="otp-panel mb-3">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:6px">' +
          '<span class="font-bold">Payment pending — ' + UI.escapeHtml(p.reference) + '</span>' + UI.badge('pending') +
        '</div>' +
        (expired ? '<p class="text-sm" style="color:var(--warning,#b7791f)">This quote is past its window. Cancel it and start a fresh purchase if the rate no longer suits you.</p>' : '') +
        '<div class="detail-grid mb-2">' +
          '<div class="detail-item"><div class="k">Send exactly</div><div class="v font-bold">' + p.btc_amount + ' BTC</div></div>' +
          '<div class="detail-item"><div class="k">Network</div><div class="v">Bitcoin (BTC) — mainnet only</div></div>' +
          '<div class="detail-item"><div class="k">Fee</div><div class="v">' + UI.money(p.amount_usd, 'USD') + '</div></div>' +
          '<div class="detail-item"><div class="k">Rate used</div><div class="v">' + UI.money(p.btc_rate_usd, 'USD') + '/BTC</div></div>' +
        '</div>' +
        '<div class="text-sm text-muted mb-1">Designated wallet address (Bitcoin network)</div>' +
        '<div class="otp-wallet mono mb-2">' + UI.escapeHtml(p.wallet_address) + '</div>' +
        '<div class="flex gap-2 mb-3" style="flex-wrap:wrap">' +
          '<button class="btn btn-outline btn-sm" id="otp-copy-wallet">' + icon('copy') + ' Copy Wallet Address</button>' +
          '<button class="btn btn-outline btn-sm" id="otp-copy-amount">Copy BTC Amount</button>' +
        '</div>' +
        (moonpay
          ? '<button class="btn btn-primary mb-2" id="otp-moonpay-btn" style="border-radius:12px">Pay ' + UI.money(p.amount_usd, 'USD') + ' with MoonPay</button>' +
            '<p class="text-sm text-muted" style="margin:0 0 10px">MoonPay sells BTC with your card or bank and delivers it to the wallet address above. Return here after paying and submit the Bitcoin transaction ID below. MoonPay checkout itself is never accepted as proof — our team still verifies the on-chain payment.</p>'
          : '') +
        '<div class="field mb-2">' +
          '<label>Bitcoin transaction ID (txid) after you pay</label>' +
          '<input type="text" class="input mono" id="otp-txid" placeholder="64-character transaction hash" spellcheck="false" autocomplete="off">' +
        '</div>' +
        '<div class="form-error" id="otp-txid-error"></div>' +
        '<div class="flex gap-2 mt-2" style="flex-wrap:wrap">' +
          '<button class="btn btn-primary" id="otp-submit-txid">Submit Transaction ID</button>' +
          '<button class="btn btn-outline" id="otp-cancel-purchase">Cancel Quote</button>' +
        '</div>' +
        '<p class="text-sm text-muted mt-2" style="margin-bottom:0">Submitting the txid does not confirm payment. Our team verifies the transaction on the Bitcoin network before your OTP code is issued.</p>' +
      '</div>'
    );
  }

  function awaitingPanel(p) {
    return (
      '<div class="otp-panel mb-3">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:6px">' +
          '<span class="font-bold">Verifying payment — ' + UI.escapeHtml(p.reference) + '</span>' + UI.badge('awaiting_verification') +
        '</div>' +
        '<p class="text-sm" style="margin:0 0 8px">We received your transaction reference and are verifying the Bitcoin payment on-chain. Your OTP code will appear here once verification completes. This usually takes a few minutes after the transaction confirms on the network.</p>' +
        '<div class="detail-grid">' +
          '<div class="detail-item"><div class="k">Amount due</div><div class="v">' + p.btc_amount + ' BTC</div></div>' +
          '<div class="detail-item"><div class="k">Transaction ID</div><div class="v mono text-sm">' + UI.escapeHtml((p.btc_txid || '').slice(0, 18) + '…') + '</div></div>' +
          '<div class="detail-item"><div class="k">Submitted</div><div class="v">' + UI.formatDateTime(p.submitted_at || p.created_at) + '</div></div>' +
        '</div>' +
        '<button class="btn btn-outline btn-sm mt-3" id="otp-refresh">Check Status</button>' +
      '</div>'
    );
  }

  function codePanel(p) {
    return (
      '<div class="otp-panel mb-3">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:6px">' +
          '<span class="font-bold">Your OTP code — ' + UI.escapeHtml(p.reference) + '</span>' + UI.badge('confirmed') +
        '</div>' +
        '<div class="text-center" style="padding:8px 0 4px">' +
          '<div class="otp-code-display" id="otp-code-display">' + UI.escapeHtml(p.otp_code || '') + '</div>' +
          '<div class="text-sm text-muted" style="margin:6px 0 12px">Valid until ' + UI.formatDateTime(p.otp_expires_at) + ' · single use</div>' +
          '<button class="btn btn-primary" id="otp-copy-code">' + icon('copy') + ' Copy Code</button>' +
        '</div>' +
        '<p class="text-sm text-muted" style="margin:12px 0 0">Enter this code when an eligible transfer or withdrawal asks for a one-time verification code. It works once and then expires. Purchasing a code does not by itself approve any transaction — standard checks still apply.</p>' +
      '</div>'
    );
  }

  function instructionsPanel() {
    return (
      '<details class="otp-instructions mb-3">' +
        '<summary>How payment works (step by step)</summary>' +
        '<ol class="text-sm" style="margin:10px 0 0;padding-left:18px">' +
          '<li>Open this OTP Purchase section from your dashboard.</li>' +
          '<li>Review the OTP fee (' + UI.money((state.settings && state.settings.price_usd) || 100, 'USD') + ') and any Bitcoin network (miner) fees your wallet or payment provider charges.</li>' +
          '<li>Select the available Bitcoin payment option — MoonPay checkout if enabled, otherwise send BTC directly to the designated wallet.</li>' +
          '<li>Review the payment details: destination wallet address, Bitcoin (BTC) network, exact amount and any fees.</li>' +
          '<li>Confirm the destination address, network, amount and fees in your wallet or provider before authorizing the payment. BTC only — other assets sent to this address may be unrecoverable.</li>' +
          '<li>Submit the transaction reference (txid) so the payment can be tracked and verified.</li>' +
          '<li>Once the payment is independently verified on-chain, the status changes to Confirmed and your OTP code appears above.</li>' +
        '</ol>' +
        (state.settings && state.settings.quote_ttl_minutes
          ? '<p class="text-sm text-muted mt-2" style="margin-bottom:0">Quotes expire after ' + state.settings.quote_ttl_minutes + ' minutes if unpaid. Codes remain valid for ' + (state.settings.code_validity_days || 30) + ' days after issuance.</p>'
          : '') +
      '</details>'
    );
  }

  function termsPanel() {
    return (
      '<div class="otp-terms text-sm text-muted mb-3">' +
        '<strong>Terms &amp; eligibility.</strong> An OTP code is required for eligible cross-border transfers, crypto withdrawals, and authorized brand-partnership activities. Purchasing an OTP does <strong>not</strong> guarantee approval of a transfer, partnership application, or any financial transaction — standard KYC, eligibility, fraud, and compliance checks always apply, and the OTP never replaces your login PIN or other security controls. ' +
        '<strong>Refund policy.</strong> Payments verified as not received (or underpaid) before the quote expires are voided at no charge. Once a code is issued the purchase is non-refundable.' +
      '</div>'
    );
  }

  function historyPanel() {
    const rows = state.purchases || [];
    if (!rows.length) {
      return '<div class="text-sm text-muted">No OTP purchases yet.</div>';
    }
    return (
      '<div class="table-wrap"><table class="table mobile-cards"><thead><tr>' +
        '<th>Date</th><th>Reference</th><th>Amount</th><th>BTC</th><th>Status</th><th>Code</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (p) {
        let codeCell = '<span class="text-muted">—</span>';
        if (p.status === 'confirmed' && p.otp_code) {
          codeCell = p.otp_used_at
            ? '<span class="text-muted">Used</span>'
            : '<span class="mono">' + UI.escapeHtml(p.otp_code) + '</span>';
        }
        return '<tr>' +
          '<td data-label="Date">' + UI.formatDateTime(p.created_at) + '</td>' +
          '<td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(p.reference) + '</span></td>' +
          '<td data-label="Amount">' + UI.money(p.amount_usd, 'USD') + '</td>' +
          '<td data-label="BTC">' + p.btc_amount + '</td>' +
          '<td data-label="Status">' + UI.badge(p.status) + (p.failure_reason ? '<div class="text-sm text-muted">' + UI.escapeHtml(p.failure_reason) + '</div>' : '') + '</td>' +
          '<td data-label="Code">' + codeCell + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>'
    );
  }

  // ---------------------------------------------------------------- actions
  function bind() {
    const buyBtn = document.getElementById('otp-buy-btn');
    if (buyBtn) buyBtn.addEventListener('click', onBuy);

    const copyWallet = document.getElementById('otp-copy-wallet');
    if (copyWallet) copyWallet.addEventListener('click', function () {
      copy(state.active ? state.active.wallet_address : '', 'Wallet address copied.');
    });

    const copyAmount = document.getElementById('otp-copy-amount');
    if (copyAmount) copyAmount.addEventListener('click', function () {
      copy(state.active ? String(state.active.btc_amount) : '', 'BTC amount copied.');
    });

    const moonpayBtn = document.getElementById('otp-moonpay-btn');
    if (moonpayBtn) moonpayBtn.addEventListener('click', onMoonpay);

    const submitTxid = document.getElementById('otp-submit-txid');
    if (submitTxid) submitTxid.addEventListener('click', onSubmitTxid);

    const cancelBtn = document.getElementById('otp-cancel-purchase');
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);

    const refreshBtn = document.getElementById('otp-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      UI.toast('Checking payment status...', 'info');
      refresh();
    });

    const copyCode = document.getElementById('otp-copy-code');
    if (copyCode) copyCode.addEventListener('click', function () {
      copy(state.latest ? state.latest.otp_code : '', 'OTP code copied.');
    });
  }

  async function copy(text, okMsg) {
    if (!text) return;
    const ok = await UI.copyText(text);
    if (ok) UI.toast(okMsg, 'success');
    else UI.toast('Could not copy automatically — select and copy manually.', 'error');
  }

  function onBuy() {
    const fee = UI.money((state.settings && state.settings.price_usd) || 100, 'USD');
    UI.confirmDialog(
      'Buy one OTP code for ' + fee + '? You will pay in Bitcoin (BTC) to the designated wallet (or via MoonPay if enabled). Bitcoin network fees may apply in addition. Purchasing a code does not guarantee approval of any transfer or application. Proceed?',
      startPurchase
    );
  }

  async function startPurchase() {
    try {
      const purchase = await UI.rpc('customer_create_otp_purchase', {
        p_user_id: user.id,
        p_payment_method: 'manual_btc'
      });
      state.active = purchase;
      state.purchases.unshift(purchase);
      UI.toast('Quote created — pay exactly ' + purchase.btc_amount + ' BTC before it expires.', 'success');
      render();
    } catch (e) {
      const msg = UI.apiErrorMessage(e);
      if (String(e.message).indexOf('ACTIVE_PURCHASE_EXISTS') !== -1) {
        UI.toast('You already have an active OTP purchase. Complete or cancel it first.', 'warning');
        refresh();
      } else {
        UI.toast(msg, 'error');
      }
    }
  }

  function onMoonpay() {
    const s = state.settings || {};
    const p = state.active;
    if (!p || !s.moonpay_public_key) {
      UI.toast('MoonPay is not available right now.', 'error');
      return;
    }
    const params = new URLSearchParams({
      apiKey: s.moonpay_public_key,
      currencyCode: 'btc',
      baseCurrencyAmount: String(p.amount_usd),
      walletAddress: p.wallet_address,
      email: (profile && profile.email) || '',
      redirectURL: window.location.origin + '/otp-purchase.html?moonpay=return'
    });
    window.open('https://buy.moonpay.com/?' + params.toString(), '_blank', 'noopener');
    UI.toast('MoonPay opened in a new tab. After paying, return here and submit the Bitcoin txid.', 'info');
  }

  async function onSubmitTxid() {
    const errEl = document.getElementById('otp-txid-error');
    const input = document.getElementById('otp-txid');
    const btn = document.getElementById('otp-submit-txid');
    errEl.textContent = '';
    const txid = (input.value || '').trim();
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) {
      errEl.textContent = 'Enter the full 64-character Bitcoin transaction ID (hex).';
      return;
    }
    if (!state.active) return;
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    try {
      await UI.rpc('customer_submit_otp_payment', {
        p_purchase_id: state.active.id,
        p_txid: txid
      });
      UI.toast('Transaction reference submitted. Our team will verify the payment on-chain.', 'success');
      await refresh();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Submit Transaction ID';
      const msg = String(e.message || '');
      if (msg.indexOf('TXID_ALREADY_SUBMITTED') !== -1) {
        errEl.textContent = 'This transaction ID was already submitted for another purchase.';
      } else if (msg.indexOf('INVALID_TXID') !== -1) {
        errEl.textContent = 'That does not look like a valid Bitcoin transaction ID.';
      } else if (msg.indexOf('PURCHASE_NOT_PENDING') !== -1) {
        errEl.textContent = 'This purchase is no longer pending.';
        refresh();
      } else {
        errEl.textContent = UI.apiErrorMessage(e);
      }
    }
  }

  function onCancel() {
    if (!state.active) return;
    UI.confirmDialog('Cancel this OTP purchase quote? No payment was verified, so nothing will be charged.', async function () {
      try {
        await UI.rpc('customer_cancel_otp_purchase', { p_purchase_id: state.active.id });
        UI.toast('Quote cancelled.', 'success');
        await refresh();
      } catch (e) {
        UI.toast(UI.apiErrorMessage(e), 'error');
      }
    }, 'Cancel Quote');
  }

  function handleMoonpayReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('moonpay') === 'return') {
      UI.toast('Returned from MoonPay. If you completed payment, submit the Bitcoin txid on your pending purchase so we can verify it.', 'info');
      const url = new URL(window.location.href);
      url.searchParams.delete('moonpay');
      window.history.replaceState({}, '', url.toString());
    }
  }

  try {
    await refresh();
    handleMoonpayReturn();
  } catch (e) {
    console.error('OTP purchase page failed', e);
  }
  PageLoader.hide();
})();
