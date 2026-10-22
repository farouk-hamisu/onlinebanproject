-- NationalRegionB - Migration 026
-- Simplify the OTP purchase MoonPay integration.
--
-- The platform now only LINKS to MoonPay's official website
-- (https://www.moonpay.com/) so customers can create an account and buy
-- Bitcoin there themselves. No hosted-checkout session is created, so:
--   * the signed checkout-URL RPC (025) is removed,
--   * the URL-signing helper (025) is removed,
--   * MoonPay API-key settings (publishable/secret) are removed —
--     no credentials are stored or required anymore.
--
-- The OTP fee itself is still paid by a direct Bitcoin transfer to the
-- platform wallet and verified on-chain by staff before any code is issued;
-- that flow (023/024) is untouched. Existing otp_purchases rows with
-- payment_method = 'moonpay' keep their value (the CHECK constraint is left
-- in place). Idempotent.

-- 1. Drop the signed checkout RPC and its helper (created in 025).
drop function if exists public.customer_get_moonpay_checkout_url(uuid, text);
drop function if exists public.moonpay_urlencode(text);

-- 2. Remove MoonPay credentials from system settings.
delete from public.system_settings
 where key in ('moonpay_public_key', 'moonpay_secret_key');

-- 3. Customer-facing settings payload without MoonPay fields.
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

  return jsonb_build_object(
    'price_usd', v_price,
    'wallet_address', coalesce(v_wallet, ''),
    'btc_rate_usd', v_rate,
    'btc_amount', case when v_rate > 0 then round(v_price / v_rate, 8) else null end,
    'quote_ttl_minutes', v_ttl,
    'code_validity_days', v_days,
    'network', 'bitcoin'
  );
end;
$$;

revoke all on function public.customer_get_otp_purchase_settings() from public, anon;
grant execute on function public.customer_get_otp_purchase_settings() to authenticated;
