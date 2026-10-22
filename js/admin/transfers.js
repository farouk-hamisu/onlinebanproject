// NationalRegionB — Admin transfers module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Transfers');

  const PAGE = 12;
  let page = 1;
  let kind = 'local';
  const STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'];
  const WD_NAMES = {
    usdt: 'USDT (Tether)', btc: 'Bitcoin (BTC)', paypal: 'PayPal', cashapp: 'Cash App',
    wire: 'Wire Transfer', wise: 'Wise', payoneer: 'Payoneer', skrill: 'Skrill', stripe: 'Stripe'
  };

  function isWd() { return kind === 'withdrawals'; }
  function isIntl() { return kind === 'intl'; }

  function recipientName(t) {
    if (isWd()) return t.recipient_label || '—';
    return t.recipient_name;
  }

  function listFn() {
    if (isWd()) return 'admin_list_withdrawals';
    return kind === 'local' ? 'admin_list_local_transfers' : 'admin_list_intl_transfers';
  }

  document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>'; }).join('');

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const el = document.getElementById('transfer-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading transfers...</span></div>';
    try {
      const search = document.getElementById('f-search').value.trim();
      const status = document.getElementById('f-status').value || null;
      const res = await adminApi(listFn(), { p_search: search, p_status: status, p_limit: PAGE, p_offset: (page - 1) * PAGE });
      if (seq !== loadSeq) return;
      render(res.rows || []);
      renderPagination(res.total || 0);
    } catch (e) {
      if (seq !== loadSeq) return;
      el.innerHTML = UI.emptyState('Could not load transfers');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('transfer-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No transfers found'); return; }
    const thirdHeader = isIntl() ? 'Country' : isWd() ? 'Method' : 'Bank';
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Reference</th><th>Recipient</th><th>' + thirdHeader + '</th><th>Amount</th><th>Fee</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (t) {
        const third = isIntl()
          ? UI.escapeHtml(t.recipient_country)
          : isWd()
            ? UI.escapeHtml(WD_NAMES[t.method] || t.method)
            : UI.escapeHtml(t.recipient_bank || '—');
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(recipientName(t)) + '<div class="cell-sub">' + UI.escapeHtml(t.user_email || '') + '</div></td>' +
          '<td data-label="' + thirdHeader + '">' + third + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Fee">' + UI.money(t.fee || 0, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-view="' + t.id + '" title="View">' + ICONS.eye + '</button>' +
            '<button class="row-action" data-status="' + t.id + '" title="Update status">' + ICONS.edit + '</button>' +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = rows.find(function (x) { return x.id === b.getAttribute('data-view'); });
        const fields = viewFields(t).map(function (f) {
          return '<div class="detail-item"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + '</div></div>';
        }).join('');
        UI.openModal('<div class="detail-grid">' + fields + '</div>', { title: isWd() ? 'Withdrawal Details' : 'Transfer Details' });
      });
    });
    el.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = rows.find(function (x) { return x.id === b.getAttribute('data-status'); });
        updateStatus(t);
      });
    });
  }

  function viewFields(t) {
    if (isWd()) {
      const details = t.recipient_details && typeof t.recipient_details === 'object' ? t.recipient_details : {};
      const detailLines = Object.keys(details).map(function (k) {
        return UI.escapeHtml(k.replace(/_/g, ' ')) + ': <span style="font-weight:600">' + UI.escapeHtml(String(details[k])) + '</span>';
      }).join('<br>') || '—';
      return [
        ['Reference', UI.escapeHtml(t.reference)],
        ['Method', UI.escapeHtml(WD_NAMES[t.method] || t.method)],
        ['Recipient', UI.escapeHtml(t.recipient_label || '—')],
        ['Customer', UI.escapeHtml(t.user_email || '—')],
        ['Amount', UI.money(t.amount, t.currency)],
        ['Fee', UI.money(t.fee || 0, t.currency)],
        ['Status', UI.badge(t.status)],
        ['Details', detailLines],
        ['OTP source', t.otp_source ? UI.escapeHtml(t.otp_source.replace(/_/g, ' ')) : '—'],
        ['Failure reason', t.failure_reason ? UI.escapeHtml(t.failure_reason) : '—'],
        ['Created', UI.formatDateTime(t.created_at)],
        ['Completed', t.completed_at ? UI.formatDateTime(t.completed_at) : '—']
      ];
    }
    return [
      ['Reference', UI.escapeHtml(t.reference)],
      ['Recipient', UI.escapeHtml(t.recipient_name)],
      ['Bank', UI.escapeHtml(t.recipient_bank || '—')],
      ['Account', UI.escapeHtml(t.recipient_account_number)],
      isIntl() ? ['SWIFT/BIC', UI.escapeHtml(t.swift_code || '—')] : null,
      isIntl() ? ['Country', UI.escapeHtml(t.recipient_country)] : null,
      ['Amount', UI.money(t.amount, t.currency)],
      ['Fee', UI.money(t.fee || 0, t.currency)],
      ['Status', UI.badge(t.status)],
      ['Description', UI.escapeHtml(t.description || t.purpose || '—')],
      ['Created', UI.formatDateTime(t.created_at)],
      isIntl() ? ['Delivery', UI.formatDate(t.estimated_delivery)] : null
    ].filter(Boolean);
  }

  function updateStatus(t) {
    const reasonField = isWd()
      ? '<div class="field"><label>Reason <span class="text-muted">(required for failed / cancelled / reversed)</span></label><input type="text" class="input" id="st-reason" placeholder="e.g. Recipient account rejected the payout"></div>'
      : '';
    const statusOpts = isWd()
      ? STATUSES.filter(function (s) { return s === t.status || allowedWdTransition(t.status, s); })
      : STATUSES;
    const modal = UI.openModal(
      '<div class="field"><label>New status</label><select class="select" id="st-status">' +
        statusOpts.map(function (s) { return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + UI.typeLabel(s) + '</option>'; }).join('') +
      '</select></div>' + reasonField + '<div class="form-error" id="st-error"></div>',
      { title: 'Update Status — ' + t.reference, footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Update</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      try {
        const newStatus = document.getElementById('st-status').value;
        if (isWd()) {
          await adminApi('admin_update_withdrawal', {
            p_withdrawal_id: t.id,
            p_status: newStatus,
            p_reason: (document.getElementById('st-reason').value || '').trim() || null
          });
        } else {
          const fn = kind === 'local' ? 'admin_update_local_transfer' : 'admin_update_intl_transfer';
          await adminApi(fn, { p_transfer_id: t.id, p_status: newStatus });
        }
        UI.toast('Transfer status updated.', 'success');
        modal.close();
        load();
      } catch (e) { document.getElementById('st-error').textContent = UI.apiErrorMessage(e); }
    });
  }

  function allowedWdTransition(from, to) {
    if (from === 'pending') return ['processing', 'completed', 'failed', 'cancelled'].indexOf(to) !== -1;
    if (from === 'processing') return ['completed', 'failed', 'cancelled'].indexOf(to) !== -1;
    if (from === 'completed') return to === 'reversed';
    return false;
  }

  function renderPagination(total) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const el = document.getElementById('pagination');
    let html = '<button data-p="' + (page - 1) + '" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>';
    for (let i = 1; i <= pages; i++) html += '<button data-p="' + i + '" class="' + (i === page ? 'active' : '') + '">' + i + '</button>';
    html += '<button data-p="' + (page + 1) + '" ' + (page >= pages ? 'disabled' : '') + '>›</button>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () { page = Number(b.getAttribute('data-p')); load(); });
    });
  }

  document.getElementById('f-search').addEventListener('input', function () { page = 1; load(); });
  document.getElementById('f-status').addEventListener('change', function () { page = 1; load(); });
  document.getElementById('f-kind').addEventListener('change', function () {
    kind = this.value;
    page = 1;
    load();
  });

  await load();
  PageLoader.hide();
})();