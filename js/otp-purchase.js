// NationalRegionB — OTP Purchase page module (otp-purchase.html)
// Buy a $100 Bitcoin-funded OTP code. Payment goes through MoonPay's hosted
// checkout (primary) or a direct Bitcoin transfer; staff verify the on-chain
// payment BEFORE any code is issued. MoonPay redirects, receipts and the
// "Buy Bitcoin" click are NEVER treated as proof of payment.
(async function () {
  const profile = await AppShell.init({ title: 'OTP Purchase' });
  if (!profile) return;
  const user = Auth.user;
  const root = document.getElementById('otp-purchase');
  if (!root) { PageLoader.hide(); return; }

  const state = {
    settings: null,
    purchases: [],
    active: null,
    latest: null,
    moonpayReturn: null,
    redirecting: false
  };

  const ACTIVE_STATUSES = ['pending', 'awaiting_verification'];
  let redirectTimer = null;

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

  // ------------------------------------------------------------ view state
  function moonpayEnabled() {
    const s = state.settings || {};
    return !!(s.moonpay_enabled && s.moonpay_public_key);
  }

  function hasIssuedCode() {
    const p = state.latest;
    return !!(p && p.status === 'confirmed' && p.otp_code && !p.otp_used_at &&
      p.otp_expires_at && new Date(p.otp_expires_at) > new Date());
  }

  function currentStep() {
    if (state.active && state.active.status === 'pending') return 2;
    if (state.active && state.active.status === 'awaiting_verification') return 3;
    if (hasIssuedCode()) return 4;
    return 1;
  }

  function stepperHtml(step) {
    const labels = ['Review', 'Pay', 'Verify', 'Get code'];
    let html = '<div class="otp-steps" aria-label="Purchase progress">';
    labels.forEach(function (label, i) {
      const n = i + 1;
      if (i > 0) html += '<span class="otp-step-sep" aria-hidden="true">&#8594;</span>';
      html += '<span class="otp-step' + (n === step ? ' on' : n < step ? ' done' : '') + '">' +
        '<b>' + (n < step ? '&#10003;' : n) + '</b> ' + label + '</span>';
    });
    return html + '</div>';
  }

  function instrBtn() {
    return '<button type="button" class="btn btn-outline btn-sm" data-instr>Payment instructions</button>';
  }

  function btcAmountText(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return String(v == null ? '' : v);
    return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  }

  // ---------------------------------------------------------------- render
  function render() {
    const s = state.settings || {};
    const fee = UI.money(s.price_usd != null ? s.price_usd : 100, 'USD');
    const mp = moonpayEnabled();
    const step = currentStep();
    let html = '';

    html +=
      '<div class="otp-intro">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:8px">' +
          '<div><div class="text-sm text-muted">OTP fee</div>' +
          '<div style="font-size:22px;font-weight:800;color:var(--primary)">' + fee + ' <span class="text-sm text-muted" style="font-weight:600">per code</span></div></div>' +
          '<div style="text-align:right"><div class="text-sm text-muted">BTC reference rate</div>' +
          '<div class="font-bold">' + (s.btc_rate_usd > 0 ? UI.money(s.btc_rate_usd, 'USD') + ' / BTC' : 'Not configured') + '</div>' +
          (mp ? '<span class="badge badge-info" style="margin-top:4px">Pay with MoonPay</span>' : '') +
          '</div>' +
        '</div>' +
        (mp
          ? '<p class="text-sm text-muted" style="margin:0">Pay the ' + fee + ' fee through <strong>MoonPay</strong> (card or bank — MoonPay buys Bitcoin and delivers it to our designated wallet) or directly in Bitcoin. Codes are single-use and issued only after your payment is independently verified on-chain.</p>'
          : '<p class="text-sm text-muted" style="margin:0">Pay in Bitcoin (BTC) to the designated wallet. Codes are single-use and issued only after your payment is independently verified on-chain.</p>') +
        stepperHtml(step) +
        '<div class="mt-2">' + instrBtn() + '</div>' +
      '</div>';

    html += returnBanner();

    if (state.active && state.active.status === 'pending') {
      html += pendingPanel(state.active, s, fee, mp);
    } else if (state.active && state.active.status === 'awaiting_verification') {
      html += awaitingPanel(state.active, fee, mp);
    } else if (step === 4) {
      html += codePanel(state.latest);
    } else {
      html += buyPanel(fee, mp);
    }

    html += instructionsPanel(fee);
    html += termsPanel();
    html += historyPanel();

    root.innerHTML = html;
    bind();
  }

  function buyPanel(fee, mp) {
    return (
      '<div class="otp-actions mb-3">' +
        '<button class="btn btn-primary btn-lg" id="otp-buy-btn" style="border-radius:12px;font-weight:700">Buy OTP Code — ' + fee + '</button>' +
        (mp
          ? '<p class="text-sm text-muted" style="margin:8px 0 0">After confirming, you continue straight to <strong>MoonPay\u2019s secure checkout</strong> to pay the ' + fee + ' by card or bank. MoonPay buys the Bitcoin and sends it to our wallet. Prefer Bitcoin? A manual pay option is shown after confirming.</p>'
          : '<p class="text-sm text-muted" style="margin:8px 0 0">After confirming you will see the exact Bitcoin amount and the designated wallet address to pay.</p>') +
        '<div class="mt-2">' + instrBtn() + '</div>' +
      '</div>'
    );
  }

  function pendingPanel(p, s, fee, mp) {
    const expired = p.created_at && s.quote_ttl_minutes
      ? (Date.now() - new Date(p.created_at).getTime()) > s.quote_ttl_minutes * 60000 * 2
      : false;
    return (
      '<div class="otp-panel mb-3">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:6px">' +
          '<span class="font-bold">Payment pending — ' + UI.escapeHtml(p.reference) + '</span>' + UI.badge('pending') +
        '</div>' +
        (expired ? '<p class="text-sm" style="color:var(--warning)">This quote is past its window. Cancel it and start a fresh purchase if the rate no longer suits you.</p>' : '') +

        '<div class="otp-cta mb-3">' +
          '<div class="text-sm font-bold mb-1">' + (mp ? 'Continue to MoonPay (recommended)' : 'Pay with MoonPay or Bitcoin') + '</div>' +
          '<button class="btn btn-primary btn-lg" id="otp-moonpay-btn" style="border-radius:12px;font-weight:700">Continue to MoonPay — ' + fee + '</button>' +
          (mp
            ? '<p class="text-sm text-muted" style="margin:8px 0 0">You will be redirected to <strong>MoonPay\u2019s official checkout</strong> to pay the ' + fee + ' OTP fee with your card or bank. MoonPay buys the Bitcoin and delivers it to the designated wallet. Come back here afterwards and submit the transaction ID below — the redirect itself never counts as proof of payment.</p>'
            : '<p class="text-sm text-muted" style="margin:8px 0 0">MoonPay online checkout is not configured on this platform yet — clicking the button shows what to do instead. You can also pay directly in Bitcoin now: send exactly <strong>' + UI.escapeHtml(p.btc_amount) + ' BTC</strong> to the wallet address below.</p>') +
        '</div>' +

        '<div class="detail-grid mb-2">' +
          '<div class="detail-item"><div class="k">Send exactly</div><div class="v font-bold">' + UI.escapeHtml(p.btc_amount) + ' BTC</div></div>' +
          '<div class="detail-item"><div class="k">Network</div><div class="v">Bitcoin (BTC) — mainnet only</div></div>' +
          '<div class="detail-item"><div class="k">OTP fee</div><div class="v">' + UI.money(p.amount_usd, 'USD') + '</div></div>' +
          '<div class="detail-item"><div class="k">Rate used</div><div class="v">' + UI.money(p.btc_rate_usd, 'USD') + '/BTC</div></div>' +
        '</div>' +
        '<div class="text-sm text-muted mb-1">Designated wallet address (Bitcoin network) — extra Bitcoin network fees may be added by your wallet or payment provider</div>' +
        '<div class="otp-wallet mono mb-2">' + UI.escapeHtml(p.wallet_address) + '</div>' +
        '<div class="flex gap-2 mb-3" style="flex-wrap:wrap">' +
          '<button class="btn btn-outline btn-sm" id="otp-copy-wallet">' + icon('copy') + ' Copy Wallet Address</button>' +
          '<button class="btn btn-outline btn-sm" id="otp-copy-amount">Copy BTC Amount</button>' +
        '</div>' +

        '<div class="field mb-2">' +
          '<label>Bitcoin transaction ID (txid) after you pay</label>' +
          '<input type="text" class="input mono" id="otp-txid" placeholder="64-character transaction hash" spellcheck="false" autocomplete="off">' +
        '</div>' +
        '<div class="form-error" id="otp-txid-error"></div>' +
        '<div class="flex gap-2 mt-2" style="flex-wrap:wrap">' +
          '<button class="btn btn-primary" id="otp-submit-txid">Submit Transaction ID</button>' +
          '<button class="btn btn-outline" id="otp-cancel-purchase">Cancel Quote</button>' +
        '</div>' +
        '<p class="text-sm text-muted mt-2">Submitting the txid does not confirm payment. Our team verifies the transaction on the Bitcoin network before your OTP code is issued.</p>' +

        '<div class="otp-cta mt-3">' +
          '<button class="btn btn-outline btn-lg" id="otp-buy-btc-btn" style="border-radius:12px;font-weight:700">Buy Bitcoin with MoonPay</button>' +
          '<p class="text-sm text-muted" style="margin:8px 0 0">Opens MoonPay\u2019s official Bitcoin purchase page with the quoted amount (' + UI.escapeHtml(p.btc_amount) + ' BTC) and the designated wallet pre-filled where supported. You will be redirected to MoonPay to complete the payment' + (mp ? ', then return here to submit the transaction ID.' : '.') + '</p>' +
          (mp ? '' : '<p class="text-sm text-muted" style="margin:6px 0 0"><em>MoonPay checkout is currently unavailable on this platform — click the button for details, or pay by Bitcoin directly using the address above.</em></p>') +
        '</div>' +
        '<div class="form-error" id="otp-moonpay-error"></div>' +

        '<div class="mt-3">' + instrBtn() + '</div>' +
      '</div>'
    );
  }

  function awaitingPanel(p, fee, mp) {
    return (
      '<div class="otp-panel mb-3">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:6px">' +
          '<span class="font-bold">Verifying payment — ' + UI.escapeHtml(p.reference) + '</span>' + UI.badge('awaiting_verification') +
        '</div>' +
        '<p class="text-sm" style="margin:0 0 8px">We received your transaction reference and are verifying the Bitcoin payment on-chain. Your OTP code will appear here once verification completes. This usually takes a few minutes after the transaction confirms on the network.</p>' +
        '<div class="detail-grid">' +
          '<div class="detail-item"><div class="k">Amount due</div><div class="v">' + UI.escapeHtml(p.btc_amount) + ' BTC</div></div>' +
          '<div class="detail-item"><div class="k">OTP fee</div><div class="v">' + UI.money(p.amount_usd, 'USD') + '</div></div>' +
          '<div class="detail-item"><div class="k">Transaction ID</div><div class="v mono text-sm">' + UI.escapeHtml((p.btc_txid || '').slice(0, 18) + '…') + '</div></div>' +
          '<div class="detail-item"><div class="k">Submitted</div><div class="v">' + UI.formatDateTime(p.submitted_at || p.created_at) + '</div></div>' +
        '</div>' +
        '<div class="text-sm text-muted mt-2">Designated wallet: <span class="mono">' + UI.escapeHtml(p.wallet_address) + '</span></div>' +
        '<div class="flex gap-2 mt-3" style="flex-wrap:wrap">' +
          '<button class="btn btn-outline btn-sm" id="otp-refresh">Check Status</button>' +
          instrBtn() +
        '</div>' +
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
          '<div class="text-sm text-muted" style="margin:6px 0 12px">Valid until ' + UI.formatDateTime(p.otp_expires_at) + ' · single use · paid ' + UI.money(p.amount_usd, 'USD') + '</div>' +
          '<button class="btn btn-primary" id="otp-copy-code">' + icon('copy') + ' Copy Code</button>' +
        '</div>' +
        '<p class="text-sm text-muted" style="margin:12px 0 0">Enter this code when an eligible transfer or withdrawal asks for a one-time verification code. It works once and then expires. Purchasing a code does not by itself approve any transaction — standard checks still apply.</p>' +
        '<div class="mt-3">' + instrBtn() + '</div>' +
      '</div>'
    );
  }

  // ------------------------------------------------- MoonPay return banner
  function readMoonpayReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('moonpay') !== 'return') return false;
    state.moonpayReturn = {
      ref: params.get('ref') || '',
      transactionId: params.get('transactionId') || '',
      transactionStatus: params.get('transactionStatus') || ''
    };
    const url = new URL(window.location.href);
    ['moonpay', 'ref', 'transactionId', 'transactionStatus'].forEach(function (k) {
      url.searchParams.delete(k);
    });
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return true;
  }

  function returnBanner() {
    const r = state.moonpayReturn;
    if (!r) return '';
    const status = r.transactionStatus ? String(r.transactionStatus).replace(/[^\w-]/g, '') : '';
    const activePending = !!(state.active && state.active.status === 'pending');
    let body;
    if (status === 'failed') {
      body = '<strong>MoonPay reported the payment attempt did not complete.</strong> Nothing has changed on your purchase — try MoonPay again or pay by Bitcoin directly using the details below.';
    } else if (activePending) {
      body = 'You returned from MoonPay' + (status ? ' (transaction status reported: <strong>' + UI.escapeHtml(status) + '</strong>)' : '') +
        '. A MoonPay redirect or receipt is <strong>not</strong> treated as payment proof — our team verifies the Bitcoin payment on-chain before your OTP code is issued. Paste the transaction ID below to start verification.';
    } else {
      body = 'You returned from MoonPay' + (status ? ' (transaction status reported: <strong>' + UI.escapeHtml(status) + '</strong>)' : '') +
        '. Any payment must still be verified on-chain before an OTP code is issued. If you have an active purchase it appears below.';
    }
    return '<div class="otp-return-banner mb-3" id="otp-return-banner" role="status">' +
      '<div class="flex-between" style="flex-wrap:wrap;gap:8px">' +
        '<span class="font-bold">Returned from MoonPay</span>' +
        '<span class="badge badge-info">Redirect is not proof</span>' +
      '</div>' +
      '<p class="text-sm" style="margin:6px 0 0">' + body + '</p>' +
    '</div>';
  }

  // ------------------------------------------------------- instructions
  function instructionsPanel(fee) {
    const s = state.settings || {};
    const mp = moonpayEnabled();
    const wallet = (state.active && state.active.wallet_address) || s.wallet_address || '—';
    const btc = (state.active && state.active.btc_amount) || btcAmountText(s.btc_amount) || '—';
    const openAttr = currentStep() === 1 ? ' open' : '';

    const steps = [];
    steps.push('<strong>Confirm your purchase.</strong> Click “Buy OTP Code — ' + fee + '” and confirm. We create a payment quote showing the exact Bitcoin amount (' + UI.escapeHtml(btc) + ' BTC), the OTP fee (' + fee + ') and the designated wallet address.');
    if (mp) {
      steps.push('<strong>Continue to MoonPay (recommended).</strong> You are redirected to MoonPay\u2019s secure checkout to pay the ' + fee + ' with your card or bank. MoonPay buys the Bitcoin and delivers it to our designated wallet — MoonPay shows its own service fee at checkout, on top of the ' + fee + ' OTP fee.');
      steps.push('<strong>Prefer Bitcoin directly?</strong> After confirming, send exactly ' + UI.escapeHtml(btc) + ' BTC to the designated wallet address shown on this page (use the Copy button). Bitcoin network miner fees may be added by your wallet. BTC only — other coins sent here may be unrecoverable.');
    } else {
      steps.push('<strong>Pay in Bitcoin.</strong> Send exactly ' + UI.escapeHtml(btc) + ' BTC to the designated wallet address shown on this page (use the Copy button). Bitcoin network miner fees may be added by your wallet. BTC only — other coins sent here may be unrecoverable.');
    }
    steps.push('<strong>Submit the transaction ID (txid).</strong> After paying, copy the 64-character Bitcoin transaction ID — from your wallet\u2019s transaction history, or from the transaction confirmation MoonPay shows or emails you — and paste it into the field on this page.');
    steps.push('<strong>We verify on-chain.</strong> Our team checks the transaction directly on the Bitcoin network. MoonPay receipts, screenshots, or the redirect back to this site are never accepted as proof. The status stays “Awaiting verification” until staff confirm it.');
    steps.push('<strong>Get your code.</strong> Once payment is verified the status changes to Confirmed and your one-time code appears on this page. It is single-use and valid for ' + (s.code_validity_days || 30) + ' days.');

    return (
      '<details class="otp-instructions mb-3" id="otp-instructions"' + openAttr + '>' +
        '<summary>Payment instructions — how to pay your ' + fee + ' OTP fee</summary>' +
        '<div class="text-sm" style="margin-top:10px">' +
          '<div class="otp-fees-box">' +
            '<div><div class="text-sm text-muted">OTP fee</div><div class="font-bold">' + fee + '</div></div>' +
            '<div><div class="text-sm text-muted">Bitcoin network / provider fees</div><div class="font-bold">Set by your wallet or MoonPay</div></div>' +
            '<div><div class="text-sm text-muted">Exact amount to pay</div><div class="font-bold">' + UI.escapeHtml(btc) + ' BTC</div></div>' +
            '<div><div class="text-sm text-muted">Designated wallet</div><div class="mono font-bold" style="font-size:12.5px;word-break:break-all">' + UI.escapeHtml(wallet) + '</div></div>' +
          '</div>' +
          '<ol style="margin:12px 0 0;padding-left:18px">' + steps.map(function (t) { return '<li style="margin-bottom:6px">' + t + '</li>'; }).join('') + '</ol>' +
          '<p class="text-sm text-muted" style="margin:10px 0 0">Quotes expire after ' + (s.quote_ttl_minutes || 60) + ' minutes if unpaid. An OTP code never guarantees approval of a transfer — standard KYC, eligibility and compliance checks still apply.</p>' +
        '</div>' +
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
          '<td data-label="BTC">' + UI.escapeHtml(p.btc_amount) + '</td>' +
          '<td data-label="Status">' + UI.badge(p.status) + (p.failure_reason ? '<div class="text-sm text-muted">' + UI.escapeHtml(p.failure_reason) + '</div>' : '') + '</td>' +
          '<td data-label="Code">' + codeCell + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>'
    );
  }

  // ------------------------------------------------------------ MoonPay
  function moonpayReturnUrl(reference) {
    return window.location.origin + '/otp-purchase.html?moonpay=return&ref=' + encodeURIComponent(reference || '');
  }

  // Unsigned fallback used when the signed-URL RPC (migration 025) is not
  // deployed. MoonPay rejects walletAddress/email on unsigned URLs, so they
  // are omitted here; the UI tells the customer to paste our wallet instead.
  function localCheckoutUrl(p) {
    const s = state.settings || {};
    const params = new URLSearchParams({
      apiKey: String(s.moonpay_public_key || ''),
      currencyCode: 'btc',
      baseCurrencyCode: 'usd',
      quoteCurrencyAmount: btcAmountText(p.btc_amount),
      externalTransactionId: String(p.reference || ''),
      externalCustomerId: String(user.id || ''),
      redirectURL: moonpayReturnUrl(p.reference)
    });
    return 'https://buy.moonpay.com/?' + params.toString();
  }

  function validateCheckoutUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { u = null; }
    if (!u || u.protocol !== 'https:' || u.hostname !== 'buy.moonpay.com' || !u.searchParams.get('apiKey')) {
      const err = new Error('MoonPay returned an invalid checkout link.');
      err.code = 'MOONPAY_BAD_URL';
      throw err;
    }
    return u.toString();
  }

  async function checkoutUrl(p) {
    const s = state.settings || {};
    if (!s.moonpay_public_key) {
      const err = new Error('MoonPay checkout is not configured on this platform.');
      err.code = 'MOONPAY_NOT_CONFIGURED';
      throw err;
    }
    try {
      const res = await UI.rpc('customer_get_moonpay_checkout_url', {
        p_purchase_id: p.id,
        p_redirect_url: moonpayReturnUrl(p.reference)
      });
      if (res && res.moonpay_enabled && res.url) {
        return validateCheckoutUrl(res.url);
      }
      if (res && res.moonpay_enabled === false) {
        const err = new Error('MoonPay checkout is not configured on this platform.');
        err.code = 'MOONPAY_NOT_CONFIGURED';
        throw err;
      }
      return validateCheckoutUrl(localCheckoutUrl(p));
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.indexOf('customer_get_moonpay_checkout_url') !== -1 ||
          msg.indexOf('PGRST202') !== -1 || msg.indexOf('42883') !== -1) {
        // RPC not deployed yet (migration 025 pending) → unsigned fallback.
        return validateCheckoutUrl(localCheckoutUrl(p));
      }
      throw e;
    }
  }

  function moonpayErrorText(e) {
    if (e && e.code === 'MOONPAY_NOT_CONFIGURED') {
      return 'MoonPay checkout is unavailable right now. You can still pay directly in Bitcoin: copy the wallet address above, send the exact amount shown, then paste the transaction ID below.';
    }
    if (e && e.code === 'MOONPAY_BAD_URL') {
      return 'We could not create a valid MoonPay checkout link. Please try again in a moment, or pay directly in Bitcoin using the details above.';
    }
    return 'We could not start the MoonPay checkout: ' + UI.apiErrorMessage(e) + ' You can pay directly in Bitcoin using the details above.';
  }

  function setMoonpayButtonsBusy(busy) {
    ['otp-moonpay-btn', 'otp-buy-btc-btn'].forEach(function (id) {
      const b = document.getElementById(id);
      if (b) b.disabled = busy;
    });
  }

  async function goMoonpay() {
    if (state.redirecting) return;
    const p = state.active;
    const errEl = document.getElementById('otp-moonpay-error');
    if (errEl) errEl.textContent = '';
    if (!p) {
      UI.toast('No active purchase to pay. Start a new OTP purchase first.', 'warning');
      return;
    }
    state.redirecting = true;
    setMoonpayButtonsBusy(true);
    try {
      const url = await checkoutUrl(p);
      showRedirectOverlay(url);
    } catch (e) {
      state.redirecting = false;
      setMoonpayButtonsBusy(false);
      const text = moonpayErrorText(e);
      const el = document.getElementById('otp-moonpay-error');
      if (el) el.textContent = text;
      UI.toast(text, 'error');
    }
  }

  function showRedirectOverlay(url) {
    removeRedirectOverlay();
    const wrap = document.createElement('div');
    wrap.className = 'otp-redirect-overlay';
    wrap.id = 'otp-redirect-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML =
      '<div class="otp-redirect-card">' +
        '<div class="spinner" aria-hidden="true"></div>' +
        '<h3 class="otp-redirect-title">Opening MoonPay…</h3>' +
        '<p class="text-sm text-muted">You are being redirected to MoonPay\u2019s secure checkout to pay for your OTP code. Complete the payment there, then come back here to submit the Bitcoin transaction ID — the redirect never counts as proof of payment.</p>' +
        '<div class="otp-redirect-actions">' +
          '<a class="btn btn-primary" id="otp-redirect-link" href="' + UI.escapeHtml(url) + '">Continue to MoonPay</a>' +
          '<button class="btn btn-outline" id="otp-redirect-cancel" type="button">Cancel — stay here</button>' +
        '</div>' +
        '<p class="text-sm text-muted" id="otp-redirect-note">If the page does not open automatically, use the button above.</p>' +
      '</div>';
    document.body.appendChild(wrap);

    document.getElementById('otp-redirect-cancel').addEventListener('click', function () {
      cancelRedirect('Checkout cancelled. You can reopen MoonPay any time from this page.');
    });
    document.getElementById('otp-redirect-link').addEventListener('click', function () {
      window.setTimeout(removeRedirectOverlay, 0);
    });

    redirectTimer = window.setTimeout(function () {
      redirectTimer = null;
      try {
        window.location.assign(url);
      } catch (e) {
        const note = document.getElementById('otp-redirect-note');
        if (note) note.textContent = 'Automatic redirect failed. Click “Continue to MoonPay” above to open the checkout manually.';
        state.redirecting = false;
        setMoonpayButtonsBusy(false);
      }
    }, 700);
  }

  function cancelRedirect(msg) {
    if (redirectTimer) { window.clearTimeout(redirectTimer); redirectTimer = null; }
    removeRedirectOverlay();
    state.redirecting = false;
    setMoonpayButtonsBusy(false);
    if (msg) UI.toast(msg, 'info');
  }

  function removeRedirectOverlay() {
    const el = document.getElementById('otp-redirect-overlay');
    if (el) el.remove();
  }

  function showInstructions() {
    const d = document.getElementById('otp-instructions');
    if (!d) return;
    d.open = true;
    d.classList.add('otp-instructions--flash');
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(function () { d.classList.remove('otp-instructions--flash'); }, 1800);
  }

  // ---------------------------------------------------------------- actions
  function bind() {
    const buyBtn = document.getElementById('otp-buy-btn');
    if (buyBtn) buyBtn.addEventListener('click', onBuy);

    root.querySelectorAll('[data-instr]').forEach(function (b) {
      b.addEventListener('click', showInstructions);
    });

    const copyWallet = document.getElementById('otp-copy-wallet');
    if (copyWallet) copyWallet.addEventListener('click', function () {
      copy(state.active ? state.active.wallet_address : '', 'Wallet address copied.');
    });

    const copyAmount = document.getElementById('otp-copy-amount');
    if (copyAmount) copyAmount.addEventListener('click', function () {
      copy(state.active ? String(state.active.btc_amount) : '', 'BTC amount copied.');
    });

    const moonpayBtn = document.getElementById('otp-moonpay-btn');
    if (moonpayBtn) moonpayBtn.addEventListener('click', goMoonpay);

    const buyBtcBtn = document.getElementById('otp-buy-btc-btn');
    if (buyBtcBtn) buyBtcBtn.addEventListener('click', goMoonpay);

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
    const s = state.settings || {};
    const fee = UI.money(s.price_usd != null ? s.price_usd : 100, 'USD');
    const msg = moonpayEnabled()
      ? 'Buy one OTP code for ' + fee + '? You will continue to MoonPay\u2019s secure checkout to pay by card or bank (MoonPay buys Bitcoin and delivers it to our designated wallet), or pay in Bitcoin directly. MoonPay\u2019s own service fees and Bitcoin network fees may apply in addition to the ' + fee + ' fee. Purchasing a code does not guarantee approval of any transfer or application. Proceed?'
      : 'Buy one OTP code for ' + fee + '? You will pay in Bitcoin (BTC) to the designated wallet. Bitcoin network fees may apply in addition. Purchasing a code does not guarantee approval of any transfer or application. Proceed?';
    UI.confirmDialog(msg, startPurchase);
  }

  async function startPurchase() {
    const buyBtn = document.getElementById('otp-buy-btn');
    if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = 'Creating quote…'; }
    try {
      const purchase = await UI.rpc('customer_create_otp_purchase', {
        p_user_id: user.id,
        p_payment_method: moonpayEnabled() ? 'moonpay' : 'manual_btc'
      });
      state.active = purchase;
      state.purchases.unshift(purchase);
      render();
      if (moonpayEnabled()) {
        UI.toast('Quote created — opening MoonPay checkout…', 'success');
        goMoonpay();
      } else {
        UI.toast('Quote created — pay exactly ' + purchase.btc_amount + ' BTC before it expires.', 'success');
      }
    } catch (e) {
      if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Buy OTP Code — ' + UI.money((state.settings && state.settings.price_usd) || 100, 'USD'); }
      const msg = UI.apiErrorMessage(e);
      if (String(e.message).indexOf('ACTIVE_PURCHASE_EXISTS') !== -1) {
        UI.toast('You already have an active OTP purchase. Complete or cancel it first.', 'warning');
        refresh();
      } else {
        UI.toast(msg, 'error');
      }
    }
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

  try {
    readMoonpayReturn();
    await refresh();
    if (state.moonpayReturn) {
      UI.toast('Returned from MoonPay. Returning from MoonPay never confirms payment — submit the Bitcoin transaction ID so our team can verify it on-chain.', 'info');
    }
  } catch (e) {
    console.error('OTP purchase page failed', e);
  }
  PageLoader.hide();
})();
