// NationalRegionB — OTP Purchase page module (otp-purchase.html)
// Buy a $100 Bitcoin-funded OTP code. "Open MoonPay" / "Buy Bitcoin" are plain
// links to https://www.moonpay.com/ where the customer creates an account and
// buys Bitcoin themselves — no MoonPay API, keys, or checkout sessions.
// The OTP fee is paid by a direct Bitcoin transfer to the platform wallet and
// is verified on-chain by staff BEFORE any code is issued. Link clicks,
// receipts and screenshots are NEVER treated as proof of payment.
(async function () {
  const profile = await AppShell.init({ title: 'OTP Purchase' });
  if (!profile) return;
  const user = Auth.user;
  const root = document.getElementById('otp-purchase');
  if (!root) { PageLoader.hide(); return; }

  const MOONPAY_URL = 'https://www.moonpay.com/';

  const state = {
    settings: null,
    purchases: [],
    active: null,
    latest: null
  };

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

  // ------------------------------------------------------------ view state
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
    const step = currentStep();
    let html = '';

    html +=
      '<div class="otp-intro">' +
        '<div class="flex-between mb-2" style="flex-wrap:wrap;gap:8px">' +
          '<div><div class="text-sm text-muted">OTP fee</div>' +
          '<div style="font-size:22px;font-weight:800;color:var(--primary)">' + fee + ' <span class="text-sm text-muted" style="font-weight:600">per code</span></div></div>' +
          '<div style="text-align:right"><div class="text-sm text-muted">BTC reference rate</div>' +
          '<div class="font-bold">' + (s.btc_rate_usd > 0 ? UI.money(s.btc_rate_usd, 'USD') + ' / BTC' : 'Not configured') + '</div>' +
          '<span class="badge badge-info" style="margin-top:4px">Buy Bitcoin on MoonPay</span>' +
          '</div>' +
        '</div>' +
        '<p class="text-sm text-muted" style="margin:0">Pay the ' + fee + ' fee in Bitcoin (BTC) to the designated platform wallet — buy the Bitcoin on MoonPay or use your own wallet. Codes are single-use and issued only after your payment is independently verified on-chain.</p>' +
        stepperHtml(step) +
        '<div class="mt-2">' + instrBtn() + '</div>' +
      '</div>';

    if (state.active && state.active.status === 'pending') {
      html += pendingPanel(state.active, s, fee);
    } else if (state.active && state.active.status === 'awaiting_verification') {
      html += awaitingPanel(state.active, fee);
    } else if (step === 4) {
      html += codePanel(state.latest);
    } else {
      html += buyPanel(fee);
    }

    html += instructionsPanel(fee);
    html += termsPanel();
    html += historyPanel();

    root.innerHTML = html;
    bind();
  }

  function buyPanel(fee) {
    return (
      '<div class="otp-actions mb-3">' +
        '<button class="btn btn-primary btn-lg" id="otp-buy-btn" style="border-radius:12px;font-weight:700">Buy OTP Code — ' + fee + '</button>' +
        '<p class="text-sm text-muted" style="margin:8px 0 0">After confirming you will see the exact Bitcoin amount and the platform wallet address to pay.</p>' +
        '<div class="otp-cta mt-2">' +
          '<a class="btn btn-outline btn-lg" id="otp-moonpay-btn" href="' + MOONPAY_URL + '" target="_blank" rel="noopener noreferrer" style="border-radius:12px;font-weight:700">Open MoonPay</a>' +
        '</div>' +
        '<div class="mt-2">' + instrBtn() + '</div>' +
      '</div>'
    );
  }

  function pendingPanel(p, s, fee) {
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
          '<div class="text-sm font-bold mb-1">Get your Bitcoin on MoonPay, then pay this platform</div>' +
          '<a class="btn btn-primary btn-lg" id="otp-moonpay-btn" href="' + MOONPAY_URL + '" target="_blank" rel="noopener noreferrer" style="border-radius:12px;font-weight:700">Open MoonPay</a>' +
          '<p class="text-sm text-muted" style="margin:8px 0 0">Opens <strong>MoonPay\u2019s official website</strong> in a new tab — create an account there and follow MoonPay\u2019s instructions to buy Bitcoin (card or bank). Completing a purchase on MoonPay does <strong>not</strong> pay this platform automatically and does not confirm this quote.</p>' +
        '</div>' +

        '<div class="detail-grid mb-2">' +
          '<div class="detail-item"><div class="k">Send exactly</div><div class="v font-bold">' + UI.escapeHtml(p.btc_amount) + ' BTC</div></div>' +
          '<div class="detail-item"><div class="k">Network</div><div class="v">Bitcoin (BTC) — mainnet only</div></div>' +
          '<div class="detail-item"><div class="k">OTP fee</div><div class="v">' + UI.money(p.amount_usd, 'USD') + '</div></div>' +
          '<div class="detail-item"><div class="k">Rate used</div><div class="v">' + UI.money(p.btc_rate_usd, 'USD') + '/BTC</div></div>' +
        '</div>' +
        '<div class="text-sm text-muted mb-1">Platform wallet address (Bitcoin network) — this is where your ' + UI.money(p.amount_usd, 'USD') + ' payment must arrive. Extra network fees may be added by your wallet or provider.</div>' +
        '<div class="otp-wallet mono mb-1">' + UI.escapeHtml(p.wallet_address) + '</div>' +
        '<div class="text-sm text-muted mb-2">Buying Bitcoin on MoonPay does not send it here automatically: choose this address as the destination when MoonPay asks where to send your Bitcoin, or transfer it from your own wallet afterwards.</div>' +
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
          '<a class="btn btn-outline btn-lg" id="otp-buy-btc-btn" href="' + MOONPAY_URL + '" target="_blank" rel="noopener noreferrer" style="border-radius:12px;font-weight:700">Buy Bitcoin</a>' +
          '<p class="text-sm text-muted" style="margin:8px 0 0">Opens moonpay.com so you can buy Bitcoin with your own card or bank and follow MoonPay\u2019s official steps there (account, identity verification, fees). Your OTP fee is paid separately by sending exactly <strong>' + UI.escapeHtml(p.btc_amount) + ' BTC</strong> to the platform wallet above, then submitting the transaction ID for on-chain verification.</p>' +
        '</div>' +

        '<div class="mt-3">' + instrBtn() + '</div>' +
      '</div>'
    );
  }

  function awaitingPanel(p, fee) {
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

  // ------------------------------------------------------- instructions
  function instructionsPanel(fee) {
    const s = state.settings || {};
    const wallet = (state.active && state.active.wallet_address) || s.wallet_address || '—';
    const btc = (state.active && state.active.btc_amount) || btcAmountText(s.btc_amount) || '—';
    const openAttr = currentStep() === 1 ? ' open' : '';
    const moonpayLink = '<a href="' + MOONPAY_URL + '" target="_blank" rel="noopener noreferrer">www.moonpay.com</a>';

    const buySteps = [];
    buySteps.push('<strong>Visit MoonPay\u2019s official website.</strong> Open ' + moonpayLink + ', or use the Open MoonPay button on this page.');
    buySteps.push('<strong>Create an account or sign in.</strong> Follow MoonPay\u2019s registration steps if you are new there.');
    buySteps.push('<strong>Complete identity verification.</strong> MoonPay may require KYC documents before it allows purchases.');
    buySteps.push('<strong>Review your options.</strong> Check the available Bitcoin purchase options, MoonPay\u2019s fees, limits and any transaction requirements it shows.');
    buySteps.push('<strong>Complete the purchase.</strong> Follow MoonPay\u2019s official instructions to finish your intended transaction.');

    const paySteps = [];
    paySteps.push('<strong>Confirm your purchase here.</strong> Click \u201CBuy OTP Code — ' + fee + '\u201D and confirm. We create a payment quote showing the exact Bitcoin amount (' + UI.escapeHtml(btc) + ' BTC), the OTP fee (' + fee + ') and the platform wallet address.');
    paySteps.push('<strong>Pay the platform wallet.</strong> Send exactly ' + UI.escapeHtml(btc) + ' BTC to the platform wallet address shown on this page (use the Copy button). If you bought Bitcoin on MoonPay, enter this address when MoonPay asks where to send it — MoonPay does <strong>not</strong> know about this address unless you type it there, and nothing is sent automatically. BTC only — other coins sent here may be unrecoverable; Bitcoin network miner fees may apply.');
    paySteps.push('<strong>Submit the transaction ID (txid).</strong> After paying, copy the 64-character Bitcoin transaction ID — from your wallet\u2019s history or from the purchase confirmation MoonPay shows or emails you — and paste it into the field on this page.');
    paySteps.push('<strong>We verify on-chain.</strong> Our team checks the transaction directly on the Bitcoin network. Screenshots, receipts, or your own confirmation are never accepted as proof. The status stays \u201CAwaiting verification\u201D until staff confirm it.');
    paySteps.push('<strong>Get your code.</strong> Once payment is verified the status changes to Confirmed and your one-time code appears on this page. It is single-use and valid for ' + (s.code_validity_days || 30) + ' days.');

    const list = function (items) {
      return '<ol style="margin:6px 0 14px;padding-left:18px">' + items.map(function (t) { return '<li style="margin-bottom:6px">' + t + '</li>'; }).join('') + '</ol>';
    };

    return (
      '<details class="otp-instructions mb-3" id="otp-instructions"' + openAttr + '>' +
        '<summary>Payment instructions — how to pay your ' + fee + ' OTP fee</summary>' +
        '<div class="text-sm" style="margin-top:10px">' +
          '<div class="otp-fees-box">' +
            '<div><div class="text-sm text-muted">OTP fee</div><div class="font-bold">' + fee + '</div></div>' +
            '<div><div class="text-sm text-muted">Bitcoin network / provider fees</div><div class="font-bold">Set by your wallet or MoonPay</div></div>' +
            '<div><div class="text-sm text-muted">Exact amount to pay the platform</div><div class="font-bold">' + UI.escapeHtml(btc) + ' BTC</div></div>' +
            '<div><div class="text-sm text-muted">Platform wallet (payment destination)</div><div class="mono font-bold" style="font-size:12.5px;word-break:break-all">' + UI.escapeHtml(wallet) + '</div></div>' +
          '</div>' +
          '<p class="text-sm text-muted" style="margin:8px 0 0">MoonPay and this platform are separate: buying Bitcoin on MoonPay only pays your OTP fee if you send the Bitcoin to the platform wallet above. A MoonPay purchase is never treated here as a completed payment.</p>' +
          '<div class="font-bold" style="margin-top:12px">Buying Bitcoin on MoonPay (optional)</div>' +
          list(buySteps) +
          '<div class="font-bold">Paying this platform &amp; getting your code</div>' +
          list(paySteps) +
          '<p class="text-sm text-muted" style="margin:0">Quotes expire after ' + (s.quote_ttl_minutes || 60) + ' minutes if unpaid. An OTP code never guarantees approval of a transfer — standard KYC, eligibility and compliance checks still apply.</p>' +
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
  // Plain link to MoonPay's official website — no API, keys, or sessions.
  // The anchors (href + target="_blank") handle opening on desktop and mobile;
  // clicking them never changes purchase status or issues a code.

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
    const msg = 'Buy one OTP code for ' + fee + '? You will receive a payment quote with the exact Bitcoin amount and the platform wallet address to pay. You can buy Bitcoin first on MoonPay via the Open MoonPay button. Purchasing a code does not guarantee approval of any transfer or application. Proceed?';
    UI.confirmDialog(msg, startPurchase);
  }

  async function startPurchase() {
    const buyBtn = document.getElementById('otp-buy-btn');
    if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = 'Creating quote…'; }
    try {
      const purchase = await UI.rpc('customer_create_otp_purchase', {
        p_user_id: user.id,
        p_payment_method: 'manual_btc'
      });
      state.active = purchase;
      state.purchases.unshift(purchase);
      render();
      UI.toast('Quote created — pay exactly ' + purchase.btc_amount + ' BTC before it expires.', 'success');
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
    await refresh();
  } catch (e) {
    console.error('OTP purchase page failed', e);
  }
  PageLoader.hide();
})();
