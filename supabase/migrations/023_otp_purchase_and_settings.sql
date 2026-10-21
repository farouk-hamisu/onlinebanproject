-- NationalRegionB - Migration 023
-- 1. OTP Purchase feature: customers buy a $100 Bitcoin-denominated
--    "OTP code" used as the verification code for eligible cross-border
--    transfers and crypto withdrawals. Payment is made in BTC to the
--    designated bank wallet; an admin verifies the on-chain payment
--    BEFORE any OTP is issued (no OTP is ever issued from a screenshot
--    or self-reported txid alone).
-- 2. Admin-configurable "OTP required for transfers" toggle stored in
--    system_settings and enforced inside the transfer-creation RPCs
--    (the real backend, not the UI).
--
-- Payment-flow note (MoonPay):
--   MoonPay's supported product for this flow is the hosted widget that
--   sells BTC and delivers it to a customer-specified wallet address
--   (buy.moonpay.com?apiKey=...&currencyCode=btc&walletAddress=...).
--   The widget requires a MoonPay publishable (public) API key issued to
--   this merchant. Until that key is configured in system_settings under
--   'moonpay_public_key', the UI presents the compliant manual alternative
--   (direct BTC transfer to the designated wallet + backend verification).
--   Regardless of method, funds must reach the designated wallet and the
--   payment must be independently verified by staff on-chain before an
--   OTP is issued. MoonPay redirects are never trusted as payment proof.
--
-- Idempotent: safe to re-run (settings seeded with on conflict do nothing;
-- functions use create or replace).

-- ===========================================================================
-- 1. Settings
-- ===========================================================================
insert into public.system_settings (key, value, description) values
  ('otp_required_for_transfers', 'true'::jsonb,
   'When true, international transfers and crypto withdrawals require admin-issued verification (OTP). When false they release directly after PIN + balance checks.'),
  ('otp_purchase_price_usd', '100'::jsonb,
   'Price in USD of one purchased OTP code.'),
  ('otp_btc_wallet_address', '"bc1qdjpxmpx3489n0tnpa9n3s98st69ljua8cs844l"'::jsonb,
   'Designated Bitcoin wallet that must receive OTP purchase payments.'),
  ('otp_btc_usd_rate', '100000'::jsonb,
   'BTC/USD reference rate used to quote OTP purchases (admin-maintained; refresh from Settings).'),
  ('otp_quote_ttl_minutes', '60'::jsonb,
   'How long an unpaid OTP purchase quote stays valid.'),
  ('otp_code_validity_days', '30'::jsonb,
   'How long a purchased OTP code remains usable after issuance.'),
  ('moonpay_public_key', '""'::jsonb,
   'MoonPay publishable API key for the hosted BTC purchase widget. Empty = MoonPay disabled (manual BTC flow only).')
on conflict (key) do nothing;

-- ===========================================================================
-- 2. Table
-- ===========================================================================
create table if not exists public.otp_purchases (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  reference       text not null unique,
  amount_usd      numeric not null check (amount_usd > 0),
  btc_rate_usd    numeric not null check (btc_rate_usd > 0),
  btc_amount      numeric not null check (btc_amount > 0),
  wallet_address  text not null,
  payment_method  text not null default 'manual_btc'
                  check (payment_method in ('manual_btc', 'moonpay')),
  status          text not null default 'pending'
                  check (status in ('pending','awaiting_verification','confirmed','failed','underpaid','overpaid','expired','cancelled')),
  btc_txid        text unique,
  submitted_at    timestamptz,
  otp_code        text,
  otp_code_hash   text,
  otp_expires_at  timestamptz,
  otp_used_at     timestamptz,
  otp_attempts    integer not null default 0,
  verified_by     uuid references public.admin_users (id),
  verified_at     timestamptz,
  failure_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One active (unpaid/unverified) purchase per user: prevents duplicate payments.
create unique index if not exists otp_purchases_one_active_per_user
  on public.otp_purchases (user_id)
  where status in ('pending', 'awaiting_verification');

create index if not exists otp_purchases_user_idx on public.otp_purchases (user_id, created_at desc);
create index if not exists otp_purchases_status_idx on public.otp_purchases (status, created_at desc);

alter table public.otp_purchases enable row level security;
drop policy if exists otp_purchases_select_own on public.otp_purchases;
create policy otp_purchases_select_own on public.otp_purchases
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies: all writes go through SECURITY DEFINER RPCs.
revoke all on public.otp_purchases from anon;

-- ===========================================================================
-- 3. Shared release helper (moved out of customer_verify_transfer so the
--    no-OTP toggle path and the purchased-OTP path reuse ONE debit/release
--    implementation — funds still move exactly once, only after checks).
-- ===========================================================================
create or replace function public.release_verified_transfer(
  p_transfer_type text,
  p_transfer_id   uuid,
  p_uid           uuid,
  p_code_id       uuid,
  p_attempts      integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_xfer public.international_transfers%rowtype;
  v_wd public.crypto_withdrawals%rowtype;
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_name text;
  v_ref text;
begin
  if p_transfer_type = 'international_transfer' then
    select * into v_xfer from public.international_transfers where id = p_transfer_id for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select * into v_account from public.accounts where id = v_xfer.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_xfer.amount + v_xfer.fee) then
      update public.international_transfers set status = 'failed', updated_at = now() where id = v_xfer.id;
      perform public.notify_user(v_uid, 'International transfer failed',
        'Transfer ' || v_xfer.reference || ' could not be processed due to insufficient funds.', 'transfer');
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, p_code_id, v_uid, 'failed_insufficient_funds', p_attempts);
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_xfer.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_xfer.amount + v_xfer.fee), v_account.currency);
    update public.international_transfers set status = 'processing', updated_at = now() where id = v_xfer.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'international_transfer', 'debit', v_xfer.amount, v_account.currency,
      'processing', coalesce(v_xfer.purpose, 'International transfer'), v_name,
      v_xfer.recipient_name || ' (' || v_xfer.recipient_country || ')', v_xfer.fee, v_xfer.id);
    perform public.notify_user(v_uid, 'International transfer verified',
      'Transfer ' || v_xfer.reference || ' has been verified and is now processing.', 'transfer');
    v_ref := v_xfer.reference;
  elsif p_transfer_type = 'crypto_withdrawal' then
    select * into v_wd from public.crypto_withdrawals where id = p_transfer_id for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select * into v_account from public.accounts where id = v_wd.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_wd.amount_fiat + v_wd.fee) then
      update public.crypto_withdrawals set status = 'failed', updated_at = now() where id = v_wd.id;
      perform public.notify_user(v_uid, 'Crypto withdrawal failed',
        'Withdrawal ' || v_wd.reference || ' could not be processed due to insufficient funds.', 'transfer');
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, p_code_id, v_uid, 'failed_insufficient_funds', p_attempts);
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_wd.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_wd.amount_fiat + v_wd.fee), v_account.currency);
    update public.crypto_withdrawals set status = 'processing', updated_at = now() where id = v_wd.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'withdrawal', 'debit', v_wd.amount_fiat, v_account.currency,
      'processing', 'Crypto withdrawal ' || v_wd.amount || ' ' || v_wd.asset, v_name,
      v_wd.wallet_address, v_wd.fee, v_wd.id);
    perform public.notify_user(v_uid, 'Crypto withdrawal verified',
      'Withdrawal ' || v_wd.reference || ' has been verified and is now processing.', 'transfer');
    v_ref := v_wd.reference;
  else
    return jsonb_build_object('status', 'invalid_type');
  end if;

  perform public.log_verification_attempt(p_transfer_type, p_transfer_id, p_code_id, v_uid, 'success', p_attempts);
  return jsonb_build_object('status', 'ok', 'reference', v_ref, 'transfer_id', p_transfer_id::text);
end;
$$;

revoke execute on function public.release_verified_transfer(text, uuid, uuid, uuid, integer)
  from public, anon, authenticated;

-- ===========================================================================
-- 4. Customer RPCs — OTP purchase
-- ===========================================================================

-- Read-only purchase configuration for the dashboard section.
create or replace function public.customer_get_otp_purchase_settings()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_price numeric;
  v_wallet text;
  v_rate numeric;
  v_ttl integer;
  v_days integer;
  v_moonpay text;
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN';
  end if;

  select coalesce((value::text)::numeric, 100) into v_price
    from public.system_settings where key = 'otp_purchase_price_usd';
  if v_price is null then v_price := 100; end if;

  select value #>> '{}' into v_wallet
    from public.system_settings where key = 'otp_btc_wallet_address';

  select coalesce((value::text)::numeric, 0) into v_rate
    from public.system_settings where key = 'otp_btc_usd_rate';

  select coalesce((value::text)::integer, 60) into v_ttl
    from public.system_settings where key = 'otp_quote_ttl_minutes';
  if v_ttl is null then v_ttl := 60; end if;

  select coalesce((value::text)::integer, 30) into v_days
    from public.system_settings where key = 'otp_code_validity_days';
  if v_days is null then v_days := 30; end if;

  select value #>> '{}' into v_moonpay
    from public.system_settings where key = 'moonpay_public_key';

  return jsonb_build_object(
    'price_usd', v_price,
    'wallet_address', coalesce(v_wallet, ''),
    'btc_rate_usd', v_rate,
    'btc_amount', case when v_rate > 0 then round(v_price / v_rate, 8) else null end,
    'quote_ttl_minutes', v_ttl,
    'code_validity_days', v_days,
    'moonpay_public_key', coalesce(v_moonpay, ''),
    'moonpay_enabled', (coalesce(v_moonpay, '') <> ''),
    'network', 'bitcoin'
  );
end;
$$;

-- Create a fresh quote (pending purchase). One active purchase per user.
create or replace function public.customer_create_otp_purchase(
  p_user_id uuid,
  p_payment_method text default 'manual_btc'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price numeric;
  v_wallet text;
  v_rate numeric;
  v_ttl integer;
  v_purchase public.otp_purchases;
  v_id uuid;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  if p_payment_method is null or p_payment_method not in ('manual_btc', 'moonpay') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;

  -- Expire stale unpaid quotes so a stuck pending row cannot block forever.
  select coalesce((value::text)::integer, 60) into v_ttl
    from public.system_settings where key = 'otp_quote_ttl_minutes';
  if v_ttl is null then v_ttl := 60; end if;

  update public.otp_purchases
     set status = 'expired', failure_reason = 'Quote expired unpaid', updated_at = now()
   where user_id = p_user_id
     and status = 'pending'
     and created_at < now() - make_interval(mins => v_ttl * 2);

  select coalesce((value::text)::numeric, 100) into v_price
    from public.system_settings where key = 'otp_purchase_price_usd';
  if v_price is null then v_price := 100; end if;

  select value #>> '{}' into v_wallet
    from public.system_settings where key = 'otp_btc_wallet_address';
  if v_wallet is null or v_wallet = '' then
    raise exception 'WALLET_NOT_CONFIGURED';
  end if;

  select coalesce((value::text)::numeric, 0) into v_rate
    from public.system_settings where key = 'otp_btc_usd_rate';
  if v_rate is null or v_rate <= 0 then
    raise exception 'BTC_RATE_NOT_CONFIGURED';
  end if;

  begin
    insert into public.otp_purchases (
      user_id, reference, amount_usd, btc_rate_usd, btc_amount,
      wallet_address, payment_method, status
    ) values (
      p_user_id, public.generate_reference('OTP'), v_price, v_rate,
      round(v_price / v_rate, 8), v_wallet, p_payment_method, 'pending'
    )
    returning id into v_id;
  exception when unique_violation then
    raise exception 'ACTIVE_PURCHASE_EXISTS';
  end;

  select * into v_purchase from public.otp_purchases where id = v_id;
  return to_jsonb(v_purchase);
end;
$$;

-- Customer submits the on-chain txid they broadcast. This NEVER confirms the
-- purchase — it only moves it to awaiting_verification for staff to verify.
create or replace function public.customer_submit_otp_payment(
  p_purchase_id uuid,
  p_txid text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.otp_purchases;
begin
  select * into v_purchase from public.otp_purchases
    where id = p_purchase_id and user_id = auth.uid() for update;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_purchase.status <> 'pending' then
    raise exception 'PURCHASE_NOT_PENDING';
  end if;
  if p_txid is null or p_txid !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'INVALID_TXID';
  end if;

  begin
    update public.otp_purchases
       set status = 'awaiting_verification',
           btc_txid = lower(p_txid),
           submitted_at = now(),
           updated_at = now()
     where id = p_purchase.id;
  exception when unique_violation then
    raise exception 'TXID_ALREADY_SUBMITTED';
  end;

  return jsonb_build_object(
    'id', p_purchase_id,
    'reference', v_purchase.reference,
    'status', 'awaiting_verification'
  );
end;
$$;

-- Customer cancels an unpaid (pending) quote.
create or replace function public.customer_cancel_otp_purchase(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.otp_purchases;
begin
  select * into v_purchase from public.otp_purchases
    where id = p_purchase_id and user_id = auth.uid() for update;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_purchase.status <> 'pending' then
    raise exception 'PURCHASE_NOT_PENDING';
  end if;
  update public.otp_purchases
     set status = 'cancelled', updated_at = now(), failure_reason = 'Cancelled by customer'
   where id = v_purchase.id;
  return jsonb_build_object('id', p_purchase_id, 'status', 'cancelled');
end;
$$;

-- Customer's own purchase history (otp_code included: it is their purchased
-- good, scoped to auth.uid(); single-use and expiring server-side).
create or replace function public.customer_list_otp_purchases(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  return coalesce(
    (select jsonb_agg(to_jsonb(p) order by p.created_at desc)
       from (select * from public.otp_purchases
              where user_id = p_user_id
              order by created_at desc
              limit 20) p),
    '[]'::jsonb
  );
end;
$$;

-- ===========================================================================
-- 5. Admin RPCs — verify purchased payments and issue OTPs
-- ===========================================================================
create or replace function public.admin_list_otp_purchases(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin public.admin_users;
begin
  v_admin := public.admin_from_token(p_token);
  if v_admin.id is null or not public.admin_can(p_token, 'verifications.view') then
    raise exception 'FORBIDDEN';
  end if;
  return coalesce(
    (select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc)
      from (select p.id, p.reference, p.user_id,
                   pr.full_name as user_name, pr.email as user_email,
                   p.amount_usd, p.btc_rate_usd, p.btc_amount, p.wallet_address,
                   p.payment_method, p.status, p.btc_txid, p.submitted_at,
                   p.failure_reason, p.otp_expires_at, p.otp_used_at,
                   p.verified_at, p.created_at
              from public.otp_purchases p
              left join public.profiles pr on pr.id = p.user_id
             order by p.created_at desc
             limit 100) x),
    '[]'::jsonb
  );
end;
$$;

-- Staff verify the on-chain payment independently, then (only then) the OTP
-- is issued. Outcome confirmed => OTP issued; anything else => no OTP.
create or replace function public.admin_verify_otp_purchase(
  p_token text,
  p_purchase_id uuid,
  p_outcome text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin public.admin_users;
  v_purchase public.otp_purchases;
  v_code text;
  v_days integer;
begin
  v_admin := public.admin_from_token(p_token);
  if v_admin.id is null or not public.admin_can(p_token, 'verifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if p_outcome is null or p_outcome not in ('confirmed', 'underpaid', 'overpaid', 'failed', 'expired') then
    raise exception 'INVALID_OUTCOME';
  end if;

  select * into v_purchase from public.otp_purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'PURCHASE_NOT_FOUND';
  end if;
  if v_purchase.status not in ('pending', 'awaiting_verification') then
    raise exception 'PURCHASE_NOT_VERIFIABLE';
  end if;

  if p_outcome = 'confirmed' then
    select coalesce((value::text)::integer, 30) into v_days
      from public.system_settings where key = 'otp_code_validity_days';
    if v_days is null then v_days := 30; end if;

    v_code := public.generate_verification_code();
    update public.otp_purchases
       set status = 'confirmed',
           otp_code = v_code,
           otp_code_hash = public.hash_verification_code(v_code),
           otp_expires_at = now() + make_interval(days => v_days),
           otp_attempts = 0,
           verified_by = v_admin.id,
           verified_at = now(),
           failure_reason = null,
           updated_at = now()
     where id = v_purchase.id;

    perform public.notify_user(v_purchase.user_id,
      'OTP payment confirmed',
      'Your payment for OTP reference ' || v_purchase.reference ||
      ' was confirmed. Your purchased OTP code is now available in OTP Purchase on your dashboard.', 'transfer');
  else
    update public.otp_purchases
       set status = p_outcome,
           verified_by = v_admin.id,
           verified_at = now(),
           failure_reason = coalesce(p_reason,
             case p_outcome
               when 'underpaid' then 'Bitcoin payment received was less than the quoted amount'
               when 'overpaid' then 'Bitcoin payment received exceeded the quoted amount'
               when 'expired'  then 'Payment not received before the quote expired'
               else 'Payment could not be verified on the Bitcoin network'
             end),
           updated_at = now()
     where id = v_purchase.id;

    perform public.notify_user(v_purchase.user_id,
      'OTP payment ' || p_outcome,
      'Payment for OTP reference ' || v_purchase.reference || ' was marked as ' || p_outcome ||
      '. ' || coalesce(p_reason, 'Please contact support if you believe this is incorrect.'), 'transfer');
  end if;

  perform public.log_audit(p_token, 'VERIFY_OTP_PURCHASE', 'otp_purchase', v_purchase.reference,
    jsonb_build_object('status', v_purchase.status),
    jsonb_build_object('status', p_outcome, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'id', v_purchase.id, 'reference', v_purchase.reference, 'status', p_outcome);
end;
$$;

-- ===========================================================================
-- 6. Purchased OTP accepted by customer_verify_transfer
--    (replaces the 016 definition; per-transfer codes still work, purchased
--     codes now accepted too — single-use, expiring, hashed at rest)
-- ===========================================================================
create or replace function public.customer_verify_transfer(
  p_transfer_type text,
  p_transfer_id   uuid,
  p_code          text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_code public.transfer_verification_codes%rowtype;
  v_purchase public.otp_purchases;
  v_hash text;
  v_fail integer;
  v_ref text;
  v_res jsonb;
  v_max_attempts integer;
begin
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal') then
    return jsonb_build_object('status', 'invalid_type');
  end if;
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('status', 'invalid_format');
  end if;

  if p_transfer_type = 'international_transfer' then
    select user_id into v_uid from public.international_transfers where id = p_transfer_id;
  else
    select user_id into v_uid from public.crypto_withdrawals where id = p_transfer_id;
  end if;
  if v_uid is null or v_uid is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  v_hash := public.hash_verification_code(p_code);

  -- ------------------------------------------------------------------
  -- 6a. Purchased OTP codes (from otp_purchases) — checked FIRST so a
  --     customer who bought a code can verify even before staff issue a
  --     per-transfer code. Single-use + expiring + hashed at rest.
  -- ------------------------------------------------------------------
  select * into v_purchase from public.otp_purchases
    where user_id = v_uid
      and status = 'confirmed'
      and otp_used_at is null
      and otp_expires_at > now()
      and otp_code_hash = v_hash
    order by created_at desc
    limit 1
    for update;

  if found then
    update public.otp_purchases
       set otp_used_at = now(), updated_at = now()
     where id = v_purchase.id;
    v_res := public.release_verified_transfer(p_transfer_type, p_transfer_id, v_uid, null, v_purchase.otp_attempts + 1);
    if v_res ->> 'status' = 'ok' then
      return v_res || jsonb_build_object('source', 'purchased_otp');
    end if;
    return v_res;
  end if;

  -- ------------------------------------------------------------------
  -- 6b. Per-transfer admin-issued code (original 016 behaviour).
  -- ------------------------------------------------------------------
  select * into v_code from public.transfer_verification_codes
    where transfer_type = p_transfer_type and transfer_id = p_transfer_id and user_id = v_uid
    order by created_at desc limit 1
    for update;

  if not found then
    -- No per-transfer code and no purchased-OTP match: consume an attempt
    -- against any active purchased codes (anti-brute-force), then report.
    select coalesce((value::text)::integer, 3) into v_max_attempts
      from public.system_settings where key = 'verification_code_max_attempts';
    if v_max_attempts is null then v_max_attempts := 3; end if;
    update public.otp_purchases
       set otp_attempts = otp_attempts + 1, updated_at = now()
     where user_id = v_uid and status = 'confirmed' and otp_used_at is null and otp_expires_at > now();
    update public.otp_purchases
       set status = 'failed', failure_reason = 'Too many invalid code attempts', updated_at = now()
     where user_id = v_uid and status = 'confirmed' and otp_used_at is null and otp_expires_at > now()
       and otp_attempts >= v_max_attempts;
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, null, v_uid, 'no_code', 0);
    return jsonb_build_object('status', 'no_code');
  end if;

  if v_code.status = 'active' and v_code.attempts >= v_code.max_attempts then
    update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'attempts_exceeded', v_code.max_attempts);
    return jsonb_build_object('status', 'attempts_exceeded', 'attempts_left', 0);
  end if;

  if v_code.status = 'used' then
    return jsonb_build_object('status', 'used');
  end if;
  if v_code.status = 'revoked' then
    return jsonb_build_object('status', 'revoked');
  end if;
  if v_code.status = 'expired' then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_code.expires_at <= now() then
    update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'expired', v_code.attempts);
    return jsonb_build_object('status', 'expired');
  end if;

  if v_hash <> v_code.code_hash then
    v_fail := v_code.attempts + 1;
    update public.transfer_verification_codes set attempts = v_fail, updated_at = now() where id = v_code.id;
    if v_fail >= v_code.max_attempts then
      update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'attempts_exceeded', v_fail);
      return jsonb_build_object('status', 'attempts_exceeded', 'attempts_left', 0);
    else
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'invalid_code', v_fail);
    end if;
    return jsonb_build_object('status', 'invalid_code', 'attempts_left', greatest(0, v_code.max_attempts - v_fail));
  end if;

  update public.transfer_verification_codes set status = 'used', used_at = now(), updated_at = now() where id = v_code.id;
  v_res := public.release_verified_transfer(p_transfer_type, p_transfer_id, v_uid, v_code.id, v_code.attempts + 1);
  return v_res;
end;
$$;

-- ===========================================================================
-- 7. OTP-required toggle enforced in the transfer-creation RPCs.
--    When disabled, the transfer releases inline (same debit logic, no
--    verification hold). When enabled (or setting missing) the original
--    awaiting_admin_verification behaviour applies — fail closed.
-- ===========================================================================
create or replace function public.create_international_transfer(
  p_user_id               uuid,
  p_from_account_id       uuid,
  p_recipient_name        text,
  p_recipient_bank        text,
  p_recipient_account_number text,
  p_swift_code            text,
  p_recipient_country     text,
  p_amount                numeric,
  p_currency              text,
  p_purpose               text default null,
  p_pin                   text default null,
  p_request_id            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_xfer public.international_transfers;
  v_created boolean := true;
  v_otp_required boolean := true;
  v_res jsonb;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);
  perform public.require_outgoing_transfers(p_user_id);

  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_from_account_id;
  if v_balance is null then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  select coalesce((value::text)::numeric, 15) into v_fee
    from public.system_settings where key = 'intl_transfer_fee';
  if v_fee is null then v_fee := 15; end if;

  if v_balance < (p_amount + v_fee) then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  -- Admin toggle: default (missing/invalid) => OTP REQUIRED (fail closed).
  select coalesce((value::text)::boolean, true) into v_otp_required
    from public.system_settings where key = 'otp_required_for_transfers';
  if v_otp_required is null then v_otp_required := true; end if;

  insert into public.international_transfers (
    reference, request_id, user_id, from_account_id, recipient_name, recipient_bank,
    recipient_account_number, swift_code, recipient_country, purpose, amount, currency,
    exchange_rate, fee, estimated_delivery, status, completed_at
  ) values (
    public.generate_reference('IT'), p_request_id, p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_bank, p_recipient_account_number, p_swift_code, p_recipient_country, p_purpose,
    p_amount, p_currency, 1, v_fee, now() + interval '2 days',
    case when v_otp_required then 'awaiting_admin_verification' else 'processing' end,
    null
  )
  on conflict (user_id, request_id) where request_id is not null do nothing
  returning * into v_xfer;

  if not found then
    select * into v_xfer from public.international_transfers
      where user_id = p_user_id and request_id = p_request_id;
    v_created := false;
  end if;

  if v_created then
    if v_otp_required then
      perform public.notify_user(p_user_id,
        'International transfer submitted',
        'Your international transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
        ' to ' || p_recipient_name || ' was received and is awaiting administrative verification. Ref: ' ||
        v_xfer.reference || '.', 'transfer');
    else
      -- OTP verification disabled by admin: release immediately (debit now).
      v_res := public.release_verified_transfer('international_transfer', v_xfer.id, p_user_id, null, 1);
      select * into v_xfer from public.international_transfers where id = v_xfer.id;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_xfer.id, 'reference', v_xfer.reference, 'status', v_xfer.status,
    'created', v_created, 'amount', p_amount, 'currency', p_currency, 'fee', v_fee
  );
end;
$$;

create or replace function public.create_crypto_withdrawal(
  p_user_id         uuid,
  p_from_account_id uuid,
  p_asset           text,
  p_network         text,
  p_wallet_address  text,
  p_amount          numeric,
  p_pin             text default null,
  p_request_id      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_asset public.crypto_assets%rowtype;
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_amount_fiat numeric;
  v_wd public.crypto_withdrawals;
  v_created boolean := true;
  v_otp_required boolean := true;
  v_res jsonb;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);
  perform public.require_outgoing_transfers(p_user_id);

  select code into v_base from public.currencies where is_base = true limit 1;
  if not found then v_base := 'USD'; end if;

  select * into v_asset from public.crypto_assets
    where asset = p_asset and network = p_network and is_enabled;
  if not found then
    raise exception 'ASSET_NOT_SUPPORTED';
  end if;
  if p_amount is null or p_amount < v_asset.min_amount or p_amount > v_asset.max_amount then
    raise exception 'ASSET_LIMIT';
  end if;

  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;
  if v_account.currency <> v_base then
    raise exception 'CRYPTO_REQUIRES_BASE_CURRENCY';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_from_account_id;
  if v_balance is null then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  select coalesce((value::text)::numeric, 1) into v_fee
    from public.system_settings where key = 'crypto_withdrawal_fee';
  if v_fee is null then v_fee := 1; end if;

  v_amount_fiat := round(p_amount * v_asset.rate_usd, 2);
  if v_balance < (v_amount_fiat + v_fee) then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  -- Admin toggle: default (missing/invalid) => OTP REQUIRED (fail closed).
  select coalesce((value::text)::boolean, true) into v_otp_required
    from public.system_settings where key = 'otp_required_for_transfers';
  if v_otp_required is null then v_otp_required := true; end if;

  insert into public.crypto_withdrawals (
    reference, request_id, user_id, from_account_id, asset, network, wallet_address,
    amount, amount_fiat, currency, rate, fee, status, completed_at
  ) values (
    public.generate_reference('CW'), p_request_id, p_user_id, p_from_account_id, p_asset, p_network,
    p_wallet_address, p_amount, v_amount_fiat, v_base, v_asset.rate_usd, v_fee,
    case when v_otp_required then 'awaiting_admin_verification' else 'processing' end,
    null
  )
  on conflict (user_id, request_id) where request_id is not null do nothing
  returning * into v_wd;

  if not found then
    select * into v_wd from public.crypto_withdrawals
      where user_id = p_user_id and request_id = p_request_id;
    v_created := false;
  end if;

  if v_created then
    if v_otp_required then
      perform public.notify_user(p_user_id,
        'Crypto withdrawal submitted',
        'Your withdrawal of ' || p_amount || ' ' || p_asset || ' to ' || p_wallet_address ||
        ' was received and is awaiting administrative verification. Ref: ' || v_wd.reference || '.', 'transfer');
    else
      -- OTP verification disabled by admin: release immediately (debit now).
      v_res := public.release_verified_transfer('crypto_withdrawal', v_wd.id, p_user_id, null, 1);
      select * into v_wd from public.crypto_withdrawals where id = v_wd.id;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_wd.id, 'reference', v_wd.reference, 'status', v_wd.status,
    'created', v_created, 'amount', p_amount, 'asset', p_asset,
    'amount_fiat', v_amount_fiat, 'currency', v_base, 'fee', v_fee
  );
end;
$$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================
revoke all on function public.customer_get_otp_purchase_settings() from public, anon;
revoke all on function public.customer_create_otp_purchase(uuid, text) from public, anon;
revoke all on function public.customer_submit_otp_payment(uuid, text) from public, anon;
revoke all on function public.customer_cancel_otp_purchase(uuid) from public, anon;
revoke all on function public.customer_list_otp_purchases(uuid) from public, anon;
grant execute on function public.customer_get_otp_purchase_settings() to authenticated;
grant execute on function public.customer_create_otp_purchase(uuid, text) to authenticated;
grant execute on function public.customer_submit_otp_payment(uuid, text) to authenticated;
grant execute on function public.customer_cancel_otp_purchase(uuid) to authenticated;
grant execute on function public.customer_list_otp_purchases(uuid) to authenticated;

revoke all on function public.admin_list_otp_purchases(text) from public;
revoke all on function public.admin_verify_otp_purchase(text, uuid, text, text) from public;
grant execute on function public.admin_list_otp_purchases(text) to anon, authenticated;
grant execute on function public.admin_verify_otp_purchase(text, uuid, text, text) to anon, authenticated;

revoke all on function public.customer_verify_transfer(text, uuid, text) from public;
grant execute on function public.customer_verify_transfer(text, uuid, text) to authenticated;
revoke all on function public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text, text, text) from public;
grant execute on function public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text, text, text) to authenticated;
revoke all on function public.create_crypto_withdrawal(uuid, uuid, text, text, text, numeric, text, text) from public;
grant execute on function public.create_crypto_withdrawal(uuid, uuid, text, text, text, numeric, text, text) to authenticated;
