-- NationalRegionB - Migration 025
-- MoonPay checkout URL generation (server-side URL signing).
--
-- Why this exists:
--   MoonPay's hosted checkout (buy.moonpay.com) can pre-fill the amount,
--   e-mail and - critically - the destination wallet address so the customer
--   cannot pay into the wrong wallet. MoonPay REQUIRES that any URL carrying
--   walletAddress (or walletAddresses) be signed server-side with the
--   merchant's secret key; unsigned wallet URLs fail to load
--   (https://dev.moonpay.com/widget/on-ramp/customization/url-signing).
--
-- Signing algorithm (verified against MoonPay's published test vector):
--   1. Build the query string with every parameter VALUE URL-encoded.
--   2. message   = '?' || query          (leading question mark included)
--   3. signature = base64( HMAC-SHA256(secret_key, message) )
--   4. Append &signature=<url-encoded signature> LAST; never modify after.
--   Test vector: secret sk_test_DocsVector00 over the docs example query must
--   produce oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=
--
-- Security notes:
--   * The secret key lives only in system_settings ('moonpay_secret_key')
--     and is never returned to any client (customer settings RPC whitelists
--     its own keys; this function returns only the signed URL).
--   * All query parameters are built internally from our settings and the
--     caller's OWN pending purchase - clients cannot sign arbitrary URLs
--     (open-redirect / arbitrary-wallet hardening).
--   * p_redirect_url is validated against a strict host/path allowlist;
--     anything else falls back to the production origin.
--   * When no secret key is configured the function returns an UNSIGNED
--     checkout WITHOUT walletAddress/email (MoonPay rejects sensitive
--     parameters on unsigned URLs); the UI then instructs the customer to
--     paste our wallet address when MoonPay asks for it.
--   * The redirect back to this site is NEVER treated as payment proof -
--     staff still verify the txid on-chain before an OTP is issued.
--
-- Idempotent: safe to re-run (settings seeded with on conflict do nothing;
-- functions use create or replace).

-- ===========================================================================
-- 1. Settings
-- ===========================================================================
insert into public.system_settings (key, value, description) values
  ('moonpay_secret_key', '""'::jsonb,
   'MoonPay secret API key (sk_...) used server-side to sign checkout URLs so the wallet address can be pre-filled. Never exposed to customers. Empty = unsigned checkout without wallet pre-fill.')
on conflict (key) do nothing;

-- ===========================================================================
-- 2. URL-encoding helper (RFC 3986: keep unreserved, percent-encode bytes)
-- ===========================================================================
create or replace function public.moonpay_urlencode(p text)
returns text
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  v_bytes bytea;
  v_out   text := '';
  v_i     integer;
  v_b     integer;
begin
  if p is null then
    return null;
  end if;
  v_bytes := convert_to(p, 'UTF8');
  for v_i in 0 .. length(v_bytes) - 1 loop
    v_b := get_byte(v_bytes, v_i);
    if (v_b >= 48 and v_b <= 57)      -- 0-9
       or (v_b >= 65 and v_b <= 90)   -- A-Z
       or (v_b >= 97 and v_b <= 122)  -- a-z
       or v_b in (45, 46, 95, 126)    -- - . _ ~
    then
      v_out := v_out || chr(v_b);
    else
      v_out := v_out || '%' || upper(lpad(to_hex(v_b), 2, '0'));
    end if;
  end loop;
  return v_out;
end;
$$;

revoke execute on function public.moonpay_urlencode(text) from public, anon, authenticated;

-- ===========================================================================
-- 3. Checkout URL RPC (customer)
-- ===========================================================================
create or replace function public.customer_get_moonpay_checkout_url(
  p_purchase_id uuid,
  p_redirect_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid      uuid := auth.uid();
  v_purchase public.otp_purchases;
  v_pub      text;
  v_secret   text;
  v_email    text;
  v_query    text;
  v_url      text;
  v_redirect text;
  v_signed   boolean := false;
  v_wallet   boolean := false;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_purchase from public.otp_purchases
   where id = p_purchase_id and user_id = v_uid;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_purchase.status <> 'pending' then
    raise exception 'PURCHASE_NOT_PENDING';
  end if;

  select value #>> '{}' into v_pub
    from public.system_settings where key = 'moonpay_public_key';
  if v_pub is null or v_pub = '' then
    return jsonb_build_object(
      'moonpay_enabled', false,
      'url', null,
      'signed', false,
      'wallet_prefilled', false,
      'reason', 'MoonPay is not configured');
  end if;

  -- Redirect allowlist (open-redirect hardening); default to production.
  if p_redirect_url is null
     or p_redirect_url !~ '^https?://(www\.nationalregionb\.com|nationalregionb\.com|localhost|127\.0\.0\.1)(:[0-9]+)?/otp-purchase\.html\?' then
    v_redirect := 'https://www.nationalregionb.com/otp-purchase.html?moonpay=return&ref='
                  || public.moonpay_urlencode(v_purchase.reference);
  else
    v_redirect := p_redirect_url;
  end if;

  -- Amount: pin the exact BTC the quote requires (MoonPay charges the fiat
  -- equivalent plus its own service fees on top). Values are URL-encoded
  -- before signing; the signature is appended last and never modified after.
  v_query := 'apiKey=' || public.moonpay_urlencode(v_pub)
          || '&currencyCode=btc'
          || '&baseCurrencyCode=usd'
          || '&quoteCurrencyAmount=' || public.moonpay_urlencode(v_purchase.btc_amount::text)
          || '&externalTransactionId=' || public.moonpay_urlencode(v_purchase.reference)
          || '&externalCustomerId=' || public.moonpay_urlencode(v_purchase.user_id::text)
          || '&redirectURL=' || public.moonpay_urlencode(v_redirect);

  select value #>> '{}' into v_secret
    from public.system_settings where key = 'moonpay_secret_key';

  if v_secret is not null and v_secret <> '' then
    select email into v_email from public.profiles where id = v_uid;
    v_query := v_query
            || '&walletAddress=' || public.moonpay_urlencode(v_purchase.wallet_address);
    if v_email is not null and v_email <> '' then
      v_query := v_query || '&email=' || public.moonpay_urlencode(v_email);
    end if;
    v_url := 'https://buy.moonpay.com/?' || v_query
          || '&signature=' || public.moonpay_urlencode(
               encode(hmac(convert_to('?' || v_query, 'UTF8'),
                           convert_to(v_secret, 'UTF8'), 'sha256'), 'base64'));
    v_signed  := true;
    v_wallet  := true;
  else
    v_url := 'https://buy.moonpay.com/?' || v_query;
  end if;

  return jsonb_build_object(
    'moonpay_enabled', true,
    'url', v_url,
    'signed', v_signed,
    'wallet_prefilled', v_wallet,
    'wallet_address', v_purchase.wallet_address,
    'btc_amount', v_purchase.btc_amount,
    'amount_usd', v_purchase.amount_usd
  );
end;
$$;

revoke all on function public.customer_get_moonpay_checkout_url(uuid, text) from public, anon;
grant execute on function public.customer_get_moonpay_checkout_url(uuid, text) to authenticated;
