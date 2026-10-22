-- NationalRegionB - Migration 027
-- Unified Withdraw Funds system: one customer flow for local and international
-- withdrawals across 9 payout methods (USDT, BTC, PayPal, Cash App, Wire,
-- Wise, Payoneer, Skrill, Stripe), with server-side OTP enforcement for every
-- method controlled by the otp_required_for_transfers admin toggle, plus the
-- admin review/audit surface. Also closes the legacy create_local_transfer
-- bypass (the old local RPC never consulted the OTP toggle).

-- ===========================================================================
-- 1. Settings
-- ===========================================================================
insert into public.system_settings (key, value, description) values
  ('withdrawal_fee', '0'::jsonb,
   'Flat fee applied to every unified withdrawal (base currency).'),
  ('withdrawal_min_amount', '10'::jsonb,
   'Minimum unified withdrawal amount (base currency). 0 disables the minimum.'),
  ('withdrawal_max_amount', '250000'::jsonb,
   'Maximum unified withdrawal amount (base currency). 0 disables the maximum.'),
  ('withdrawal_methods', jsonb_build_object(
     'usdt',    jsonb_build_object('enabled', true, 'networks', jsonb_build_array('TRC20', 'ERC20', 'BEP20'), 'status', 'manual'),
     'btc',     jsonb_build_object('enabled', true, 'networks', jsonb_build_array('Bitcoin'), 'status', 'manual'),
     'paypal',  jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual'),
     'cashapp', jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual'),
     'wire',    jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual'),
     'wise',    jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual'),
     'payoneer',jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual'),
     'skrill',  jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual'),
     'stripe',  jsonb_build_object('enabled', true, 'networks', jsonb_build_array(), 'status', 'manual')
   )::jsonb,
   'Per-method availability for Withdraw Funds: enabled flag, selectable networks and processing status (manual = handled by bank staff).')
on conflict (key) do nothing;

-- ===========================================================================
-- 2. Settings helpers (internal - never exposed to API clients)
-- ===========================================================================
create or replace function public.withdrawal_setting_number(p_key text, p_default numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_num numeric;
begin
  select value into v from public.system_settings where key = p_key;
  if v is null then
    return p_default;
  end if;
  begin
    if jsonb_typeof(v) = 'number' then
      v_num := (v)::numeric;
    elsif jsonb_typeof(v) = 'string' then
      v_num := nullif(v #>> '{}', '')::numeric;
    end if;
  exception when others then
    v_num := null;
  end;
  return coalesce(v_num, p_default);
end;
$$;

create or replace function public.withdrawal_setting_bool(p_key text, p_default boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_bool boolean;
begin
  select value into v from public.system_settings where key = p_key;
  if v is null then
    return p_default;
  end if;
  begin
    if jsonb_typeof(v) = 'boolean' then
      v_bool := (v)::boolean;
    elsif jsonb_typeof(v) = 'string' then
      if lower(v #>> '{}') in ('true', 't', 'yes', 'on', '1') then
        v_bool := true;
      elsif lower(v #>> '{}') in ('false', 'f', 'no', 'off', '0') then
        v_bool := false;
      end if;
    end if;
  exception when others then
    v_bool := null;
  end;
  return coalesce(v_bool, p_default);
end;
$$;

create or replace function public.withdrawal_setting_json(p_key text, p_default jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  select value into v from public.system_settings where key = p_key;
  if v is null or jsonb_typeof(v) not in ('object', 'array') then
    return p_default;
  end if;
  return v;
end;
$$;

revoke execute on function public.withdrawal_setting_number(text, numeric) from public, anon, authenticated;
revoke execute on function public.withdrawal_setting_bool(text, boolean) from public, anon, authenticated;
revoke execute on function public.withdrawal_setting_json(text, jsonb) from public, anon, authenticated;

-- ===========================================================================
-- 3. withdrawals table
-- ===========================================================================
create table if not exists public.withdrawals (
  id                 uuid primary key default gen_random_uuid(),
  reference          text not null unique,
  request_id         text,
  user_id            uuid not null references public.profiles (id) on delete cascade,
  from_account_id    uuid not null references public.accounts (id),
  method             text not null check (method in (
                       'usdt', 'btc', 'paypal', 'cashapp', 'wire',
                       'wise', 'payoneer', 'skrill', 'stripe'
                     )),
  recipient_label    text not null,
  recipient_details  jsonb not null default '{}'::jsonb,
  amount             numeric(20, 2) not null check (amount > 0),
  fee                numeric(20, 2) not null default 0,
  currency           text not null references public.currencies (code),
  status             text not null default 'pending' check (status in (
                       'pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'
                     )),
  failure_reason     text,
  otp_source         text,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists uq_withdrawal_request
  on public.withdrawals (user_id, request_id) where request_id is not null;
create index if not exists idx_withdrawals_user on public.withdrawals (user_id, created_at desc);
create index if not exists idx_withdrawals_status on public.withdrawals (status, created_at desc);
create index if not exists idx_withdrawals_method on public.withdrawals (method, created_at desc);

drop trigger if exists touch_withdrawals_updated on public.withdrawals;
create trigger touch_withdrawals_updated before update on public.withdrawals
  for each row execute procedure public.touch_updated_at();

alter table public.withdrawals enable row level security;
drop policy if exists "withdrawals_select_own" on public.withdrawals;
create policy "withdrawals_select_own" on public.withdrawals
  for select using (user_id = auth.uid());

-- ===========================================================================
-- 4. Purchased-OTP check (shared enforcement point)
--    Consumes a valid code; on failure consumes an anti-brute-force attempt
--    against the customer's active codes. Never raises on a bad code so the
--    attempt counters commit with the response.
-- ===========================================================================
alter table public.transfer_verification_logs alter column transfer_id drop not null;

create or replace function public.withdrawal_check_otp(p_user_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_purchase public.otp_purchases%rowtype;
  v_max_attempts integer;
begin
  v_hash := public.hash_verification_code(trim(upper(coalesce(p_code, ''))));

  -- Valid, unused, unexpired code: consume it now (single use).
  select * into v_purchase from public.otp_purchases
    where user_id = p_user_id
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
    perform public.log_verification_attempt('withdrawal', null, null, p_user_id, 'success', v_purchase.otp_attempts + 1);
    return jsonb_build_object('result', 'OK', 'source', 'purchased_otp');
  end if;

  -- Code exists but is already used / expired / failed: say exactly why.
  select * into v_purchase from public.otp_purchases
    where user_id = p_user_id and status = 'confirmed' and otp_code_hash = v_hash
    order by created_at desc limit 1;
  if found then
    if v_purchase.otp_used_at is not null then
      return jsonb_build_object('result', 'INVALID', 'reason', 'used');
    elsif v_purchase.otp_expires_at <= now() then
      return jsonb_build_object('result', 'INVALID', 'reason', 'expired');
    else
      return jsonb_build_object('result', 'INVALID', 'reason', 'failed');
    end if;
  end if;

  -- Unknown code: consume an attempt against every active code (brute-force guard).
  v_max_attempts := public.withdrawal_setting_number('verification_code_max_attempts', 3)::integer;
  if v_max_attempts is null or v_max_attempts < 1 then
    v_max_attempts := 3;
  end if;

  update public.otp_purchases
     set otp_attempts = otp_attempts + 1, updated_at = now()
   where user_id = p_user_id
     and status = 'confirmed'
     and otp_used_at is null
     and otp_expires_at > now();

  select * into v_purchase from public.otp_purchases
    where user_id = p_user_id
      and status = 'confirmed'
      and otp_used_at is null
      and otp_expires_at > now()
    order by created_at desc limit 1;

  if found then
    perform public.log_verification_attempt('withdrawal', null, null, p_user_id, 'invalid_code', v_purchase.otp_attempts);
    if v_purchase.otp_attempts >= v_max_attempts then
      update public.otp_purchases
         set status = 'failed', failure_reason = 'Too many invalid code attempts', updated_at = now()
       where user_id = p_user_id
         and status = 'confirmed'
         and otp_used_at is null
         and otp_expires_at > now()
         and otp_attempts >= v_max_attempts;
      return jsonb_build_object('result', 'INVALID', 'reason', 'locked', 'attempts_left', 0);
    end if;
    return jsonb_build_object('result', 'INVALID', 'reason', 'invalid',
                              'attempts_left', greatest(v_max_attempts - v_purchase.otp_attempts, 0));
  end if;

  perform public.log_verification_attempt('withdrawal', null, null, p_user_id, 'no_code', 0);
  return jsonb_build_object('result', 'INVALID', 'reason', 'none');
end;
$$;

revoke execute on function public.withdrawal_check_otp(uuid, text) from public, anon, authenticated;

-- ===========================================================================
-- 5. Customer: withdrawal configuration
-- ===========================================================================
create or replace function public.customer_get_withdrawal_config(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_currency text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  select code into v_currency from public.currencies where is_base = true limit 1;
  return jsonb_build_object(
    'methods', public.withdrawal_setting_json('withdrawal_methods', '{}'::jsonb),
    'fee', public.withdrawal_setting_number('withdrawal_fee', 0),
    'min', public.withdrawal_setting_number('withdrawal_min_amount', 0),
    'max', public.withdrawal_setting_number('withdrawal_max_amount', 0),
    'otp_required', public.withdrawal_setting_bool('otp_required_for_transfers', true),
    'currency', coalesce(v_currency, 'USD')
  );
end;
$$;

-- ===========================================================================
-- 6. Customer: create withdrawal (the single enforcement point)
--    - PIN, outgoing restriction, account, method availability, limits and
--      balance are all validated here.
--    - When the admin OTP toggle is on (or missing - fail closed) a valid
--      purchased OTP must be supplied and is consumed atomically with the
--      debit: no row is ever created without it, and no client can skip it.
-- ===========================================================================
create or replace function public.customer_create_withdrawal(
  p_user_id            uuid,
  p_from_account_id    uuid,
  p_method             text,
  p_amount             numeric,
  p_recipient_label    text,
  p_recipient_details  jsonb default '{}'::jsonb,
  p_pin                text default null,
  p_otp_code           text default null,
  p_request_id         text default null
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
  v_min numeric;
  v_max numeric;
  v_methods jsonb;
  v_method_cfg jsonb;
  v_otp_required boolean := true;
  v_check jsonb;
  v_wd public.withdrawals%rowtype;
  v_created boolean := true;
  v_label text;
  v_details jsonb;
  v_sender text;
  v_key text;
  v_val text;
  v_req text[];
  v_networks jsonb;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  -- Idempotent replay: return the existing row before touching the OTP.
  if p_request_id is not null then
    select * into v_wd from public.withdrawals
      where user_id = p_user_id and request_id = p_request_id;
    if found then
      return jsonb_build_object(
        'result', 'OK', 'status', v_wd.status, 'id', v_wd.id, 'reference', v_wd.reference,
        'created', false, 'amount', v_wd.amount, 'currency', v_wd.currency,
        'fee', v_wd.fee, 'method', v_wd.method
      );
    end if;
  end if;

  perform public.require_customer_pin(p_user_id, p_pin);
  perform public.require_outgoing_transfers(p_user_id);

  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active'
    for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  if p_method is null or p_method not in (
    'usdt', 'btc', 'paypal', 'cashapp', 'wire', 'wise', 'payoneer', 'skrill', 'stripe'
  ) then
    raise exception 'INVALID_METHOD';
  end if;

  v_methods := public.withdrawal_setting_json('withdrawal_methods', '{}'::jsonb);
  v_method_cfg := v_methods -> p_method;
  if v_method_cfg is null or jsonb_typeof(v_method_cfg) <> 'object' then
    raise exception 'METHOD_UNAVAILABLE';
  end if;
  if coalesce((v_method_cfg ->> 'enabled')::boolean, false) is not true then
    raise exception 'METHOD_DISABLED';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_amount > 1000000000 then
    raise exception 'AMOUNT_ABOVE_MAXIMUM';
  end if;
  v_min := public.withdrawal_setting_number('withdrawal_min_amount', 0);
  v_max := public.withdrawal_setting_number('withdrawal_max_amount', 0);
  if v_min > 0 and p_amount < v_min then
    raise exception 'AMOUNT_BELOW_MINIMUM';
  end if;
  if v_max > 0 and p_amount > v_max then
    raise exception 'AMOUNT_ABOVE_MAXIMUM';
  end if;

  v_fee := public.withdrawal_setting_number('withdrawal_fee', 0);
  if v_fee is null or v_fee < 0 then
    v_fee := 0;
  end if;

  select available_balance into v_balance
    from public.account_balances where account_id = p_from_account_id;
  if v_balance is null or v_balance < (p_amount + v_fee) then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  -- Recipient validation: label, required fields per method, no credentials.
  v_label := nullif(trim(coalesce(p_recipient_label, '')), '');
  if v_label is null then
    raise exception 'RECIPIENT_REQUIRED';
  end if;
  if length(v_label) > 160 then
    raise exception 'RECIPIENT_TOO_LONG';
  end if;
  if p_recipient_details is null or jsonb_typeof(p_recipient_details) <> 'object' then
    raise exception 'RECIPIENT_DETAILS_REQUIRED';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_recipient_details) k
    where lower(k) in (
      'password', 'passcode', 'pin', 'ssn', 'social_security', 'private_key',
      'secret_key', 'seed', 'recovery_phrase', 'mnemonic', 'cvv', 'card_number'
    )
  ) then
    raise exception 'SENSITIVE_DETAILS_NOT_ALLOWED';
  end if;

  v_req := case p_method
    when 'usdt'     then array['address', 'network']
    when 'btc'      then array['address']
    when 'paypal'   then array['email']
    when 'cashapp'  then array['cashtag']
    when 'wire'     then array['beneficiary_name', 'bank_name', 'account_number', 'routing_number']
    when 'wise'     then array['recipient_name', 'email']
    when 'payoneer' then array['recipient_name', 'email']
    when 'skrill'   then array['recipient_name', 'email']
    when 'stripe'   then array['connected_account']
    else array[]::text[]
  end;

  foreach v_key in array v_req loop
    v_val := nullif(trim(coalesce(p_recipient_details ->> v_key, '')), '');
    if v_val is null then
      raise exception 'MISSING_FIELD:%', v_key;
    end if;
    if length(v_val) > 300 then
      raise exception 'FIELD_TOO_LONG:%', v_key;
    end if;
    if v_key = 'email' and v_val !~* '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
      raise exception 'INVALID_EMAIL';
    end if;
    if v_key = 'cashtag' and regexp_replace(v_val, '^\$', '') !~ '^[A-Za-z0-9_]{1,32}$' then
      raise exception 'INVALID_CASHTAG';
    end if;
  end loop;

  if p_method = 'usdt' then
    v_networks := coalesce(v_method_cfg -> 'networks', '[]'::jsonb);
    v_val := lower(nullif(trim(coalesce(p_recipient_details ->> 'network', '')), ''));
    if v_val is null then
      raise exception 'MISSING_FIELD:network';
    end if;
    if not exists (
      select 1 from jsonb_array_elements_text(v_networks) n where lower(n) = v_val
    ) then
      raise exception 'NETWORK_NOT_SUPPORTED';
    end if;
  end if;

  -- Admin OTP toggle: missing/invalid setting means REQUIRED (fail closed).
  v_otp_required := public.withdrawal_setting_bool('otp_required_for_transfers', true);
  if v_otp_required then
    if p_otp_code is null or trim(p_otp_code) = '' then
      raise exception 'OTP_REQUIRED';
    end if;
    v_check := public.withdrawal_check_otp(p_user_id, p_otp_code);
    if (v_check ->> 'result') <> 'OK' then
      return v_check;
    end if;
  end if;

  select full_name into v_sender from public.profiles where id = p_user_id;

  insert into public.withdrawals (
    reference, request_id, user_id, from_account_id, method,
    recipient_label, recipient_details, amount, fee, currency, status, otp_source
  ) values (
    public.generate_reference('WD'), p_request_id, p_user_id, p_from_account_id, p_method,
    v_label, p_recipient_details, p_amount, v_fee, v_account.currency, 'pending',
    case when v_otp_required then 'purchased_otp' else null end
  )
  on conflict (user_id, request_id) where request_id is not null do nothing
  returning * into v_wd;

  if not found then
    select * into v_wd from public.withdrawals
      where user_id = p_user_id and request_id = p_request_id;
    v_created := false;
  end if;

  if v_created then
    perform public.apply_balance_change(p_from_account_id, -(p_amount + v_fee), v_account.currency);
    perform public.record_transaction(
      p_user_id, p_from_account_id, 'withdrawal', 'debit', p_amount, v_account.currency,
      'pending', 'Withdrawal via ' || upper(p_method) || ' to ' || v_label,
      v_sender, v_label, v_fee, v_wd.id
    );
    perform public.notify_user(
      p_user_id, 'Withdrawal submitted',
      'Your withdrawal of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || v_account.currency ||
      ' via ' || upper(p_method) || ' was submitted for review. Ref: ' || v_wd.reference || '.',
      'transfer'
    );
  end if;

  return jsonb_build_object(
    'result', 'OK', 'status', v_wd.status, 'id', v_wd.id, 'reference', v_wd.reference,
    'created', v_created, 'amount', v_wd.amount, 'currency', v_wd.currency,
    'fee', v_wd.fee, 'method', v_wd.method
  );
end;
$$;

-- ===========================================================================
-- 7. Customer: list + cancel (cancel refunds while still pending/processing)
-- ===========================================================================
create or replace function public.customer_list_withdrawals(p_user_id uuid)
returns setof public.withdrawals
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select * from public.withdrawals
    where user_id = p_user_id
    order by created_at desc
    limit 100;
end;
$$;

create or replace function public.customer_cancel_withdrawal(p_user_id uuid, p_withdrawal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wd public.withdrawals%rowtype;
  v_sender text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_wd from public.withdrawals
    where id = p_withdrawal_id and user_id = p_user_id
    for update;
  if not found then
    raise exception 'WITHDRAWAL_NOT_FOUND';
  end if;
  if v_wd.status not in ('pending', 'processing') then
    raise exception 'NOT_CANCELLABLE';
  end if;

  perform public.apply_balance_change(v_wd.from_account_id, v_wd.amount + v_wd.fee, v_wd.currency);
  update public.withdrawals
     set status = 'cancelled',
         failure_reason = coalesce(v_wd.failure_reason, 'Cancelled by customer'),
         updated_at = now()
   where id = v_wd.id;
  update public.transactions set status = 'cancelled', updated_at = now()
   where related_id = v_wd.id and direction = 'debit';

  select full_name into v_sender from public.profiles where id = p_user_id;
  perform public.record_transaction(
    p_user_id, v_wd.from_account_id, 'reversal', 'credit',
    v_wd.amount + v_wd.fee, v_wd.currency, 'completed',
    'Refund - cancelled withdrawal ' || v_wd.reference,
    'NationalRegionB', coalesce(v_sender, 'Customer'), 0, v_wd.id
  );
  perform public.notify_user(
    p_user_id, 'Withdrawal cancelled',
    'Withdrawal ' || v_wd.reference || ' was cancelled and ' ||
    to_char(v_wd.amount + v_wd.fee, 'FM9,999,999,990.00') || ' ' || v_wd.currency ||
    ' was returned to your account.', 'transfer'
  );

  return jsonb_build_object('status', 'cancelled', 'id', v_wd.id, 'reference', v_wd.reference);
end;
$$;

-- ===========================================================================
-- 8. Admin: list + status updates with audit trail and refunds
-- ===========================================================================
create or replace function public.admin_list_withdrawals(
  p_token text, p_search text default '', p_status text default null,
  p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'transfers.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select w.*, p.full_name as user_name, p.email as user_email
    from public.withdrawals w join public.profiles p on p.id = w.user_id
    where (p_search = '' or w.reference ilike '%' || p_search || '%'
           or w.recipient_label ilike '%' || p_search || '%'
           or p.email ilike '%' || p_search || '%')
      and (p_status is null or w.status = p_status)
    order by w.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_update_withdrawal(
  p_token text, p_withdrawal_id uuid, p_status text, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old jsonb;
  v_wd public.withdrawals%rowtype;
  v_refund boolean := false;
  v_user_name text;
begin
  if not public.admin_can(p_token, 'transfers.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if p_status not in ('pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed') then
    raise exception 'INVALID_STATUS';
  end if;

  select * into v_wd from public.withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'WITHDRAWAL_NOT_FOUND';
  end if;

  if v_wd.status = p_status then
    return;
  end if;

  if not (
    (v_wd.status = 'pending'     and p_status in ('processing', 'completed', 'failed', 'cancelled')) or
    (v_wd.status = 'processing'  and p_status in ('completed', 'failed', 'cancelled')) or
    (v_wd.status = 'completed'   and p_status = 'reversed')
  ) then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  v_refund := p_status in ('failed', 'cancelled', 'reversed');
  select to_jsonb(w) into v_old from public.withdrawals w where id = p_withdrawal_id;

  update public.withdrawals
     set status = p_status,
         failure_reason = case
           when p_status in ('failed', 'cancelled', 'reversed')
             then coalesce(nullif(trim(p_reason), ''), failure_reason, p_status)
           else failure_reason
         end,
         completed_at = case when p_status = 'completed' then now() else completed_at end,
         updated_at = now()
   where id = p_withdrawal_id;

  update public.transactions set status = p_status, updated_at = now()
   where related_id = p_withdrawal_id and direction = 'debit';

  if v_refund then
    perform public.apply_balance_change(v_wd.from_account_id, v_wd.amount + v_wd.fee, v_wd.currency);
    select full_name into v_user_name from public.profiles where id = v_wd.user_id;
    perform public.record_transaction(
      v_wd.user_id, v_wd.from_account_id, 'reversal', 'credit',
      v_wd.amount + v_wd.fee, v_wd.currency, 'completed',
      'Refund - withdrawal ' || v_wd.reference || ' (' || p_status || ')',
      'NationalRegionB', coalesce(v_user_name, 'Customer'), 0, v_wd.id
    );
  end if;

  if p_status = 'completed' then
    perform public.notify_user(
      v_wd.user_id, 'Withdrawal completed',
      'Your withdrawal of ' || to_char(v_wd.amount, 'FM9,999,999,990.00') || ' ' || v_wd.currency ||
      ' via ' || upper(v_wd.method) || ' has been completed. Ref: ' || v_wd.reference || '.', 'transfer'
    );
  elsif p_status in ('failed', 'cancelled', 'reversed') then
    perform public.notify_user(
      v_wd.user_id, 'Withdrawal ' || p_status,
      'Withdrawal ' || v_wd.reference || ' is now ' || p_status || '. ' ||
      case when v_refund then to_char(v_wd.amount + v_wd.fee, 'FM9,999,999,990.00') || ' ' || v_wd.currency || ' was returned to your account.' else '' end,
      'transfer'
    );
  end if;

  perform public.log_audit(
    p_token, 'UPDATE_STATUS', 'withdrawal', p_withdrawal_id::text, v_old,
    jsonb_build_object('status', p_status, 'reason', p_reason)
  );
end;
$$;

-- ===========================================================================
-- 9. Close the legacy local-transfer OTP bypass
--    The old local RPC always completed immediately and never consulted
--    otp_required_for_transfers. It is redefined here to enforce the same
--    server-side OTP check (fail closed) while keeping its legacy behaviour.
-- ===========================================================================
drop function if exists public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid);
drop function if exists public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid, text);

create or replace function public.create_local_transfer(
  p_user_id               uuid,
  p_from_account_id       uuid,
  p_recipient_name        text,
  p_recipient_account_number text,
  p_recipient_bank        text,
  p_amount                numeric,
  p_currency              text,
  p_description           text,
  p_internal_recipient    uuid default null,
  p_pin                   text default null,
  p_otp_code              text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_transfer public.local_transfers%rowtype;
  v_sender_name text;
  v_otp_required boolean := true;
  v_check jsonb;
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

  select available_balance into v_balance from public.account_balances
    where account_id = p_from_account_id;
  if v_balance is null or v_balance < p_amount then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  -- Admin OTP toggle: enforced here as well (fail closed on missing setting).
  v_otp_required := public.withdrawal_setting_bool('otp_required_for_transfers', true);
  if v_otp_required then
    if p_otp_code is null or trim(p_otp_code) = '' then
      raise exception 'OTP_REQUIRED';
    end if;
    v_check := public.withdrawal_check_otp(p_user_id, p_otp_code);
    if (v_check ->> 'result') <> 'OK' then
      return v_check;
    end if;
  end if;

  select full_name into v_sender_name from public.profiles where id = p_user_id;

  perform public.apply_balance_change(p_from_account_id, -p_amount, p_currency);

  insert into public.local_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_account_number,
    recipient_bank, amount, currency, fee, description, status, completed_at
  ) values (
    public.generate_reference('LT'), p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_account_number, p_recipient_bank, p_amount, p_currency, 0,
    p_description, 'completed', now()
  ) returning * into v_transfer;

  perform public.record_transaction(
    p_user_id, p_from_account_id, 'local_transfer', 'debit', p_amount, p_currency,
    'completed', coalesce(p_description, 'Local transfer'),
    v_sender_name, p_recipient_name, 0, v_transfer.id
  );

  if p_internal_recipient is not null then
    declare
      v_dest public.accounts%rowtype;
    begin
      select * into v_dest from public.accounts
        where user_id = p_internal_recipient and currency = p_currency
        order by created_at limit 1;
      if found then
        perform public.apply_balance_change(v_dest.id, p_amount, p_currency);
        perform public.record_transaction(
          p_internal_recipient, v_dest.id, 'local_transfer', 'credit', p_amount, p_currency,
          'completed', 'Incoming local transfer', p_recipient_name, v_sender_name, 0, v_transfer.id
        );
        perform public.notify_user(p_internal_recipient,
          'Transfer received',
          'You received ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
          ' from ' || coalesce(v_sender_name, 'a customer') || '.',
          'transfer');
      end if;
    end;
  end if;

  perform public.notify_user(p_user_id,
    'Transfer completed',
    'Your transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
    ' to ' || p_recipient_name || ' was completed. Ref: ' || v_transfer.reference || '.',
    'transfer');

  return jsonb_build_object(
    'result', 'OK', 'status', 'completed', 'id', v_transfer.id,
    'reference', v_transfer.reference, 'amount', v_transfer.amount,
    'currency', v_transfer.currency, 'fee', 0
  );
end;
$$;

-- ===========================================================================
-- 10. Grants
-- ===========================================================================
grant execute on function public.customer_get_withdrawal_config(uuid) to authenticated;
grant execute on function public.customer_create_withdrawal(uuid, uuid, text, numeric, text, jsonb, text, text, text) to authenticated;
grant execute on function public.customer_list_withdrawals(uuid) to authenticated;
grant execute on function public.customer_cancel_withdrawal(uuid, uuid) to authenticated;
grant execute on function public.admin_list_withdrawals(text, text, text, int, int) to anon, authenticated;
grant execute on function public.admin_update_withdrawal(text, uuid, text, text) to anon, authenticated;
grant execute on function public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid, text, text) to anon, authenticated;
