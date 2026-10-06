-- NationalRegionB - Migration 017
-- Promote hamisuf29@gmail.com to a full portal administrator (super_admin).
--
-- This creates an entry in public.admin_users, which is what /admin/login.html
-- authenticates against (email + bcrypt password) -- it is NOT the same as the
-- user's Supabase Auth / customer account. The customer profile for this email
-- is left untouched.
--
-- Password: the admin-portal password for a brand-new row is set below.
-- Change it after running this migration (Admin portal -> Settings -> Admins
-- -> Edit -> "New password"). If the admin already exists, their current
-- password is kept and only the role/status are updated.

do $$
declare
  v_email     text := 'hamisuf29@gmail.com';
  v_password  text := 'Admin@123';
  v_role      uuid;
  v_full_name text;
begin
  -- Preconditions: this database must already have the app schema.
  if to_regclass('public.admin_roles') is null
     or to_regclass('public.admin_users') is null
     or to_regclass('public.profiles') is null then
    raise exception 'app schema not found (public.admin_roles / admin_users / profiles missing): run migrations 001-016 in order on THIS database first, see README step 3';
  end if;
  if to_regprocedure('public.admin_hash_password(text)') is null then
    raise exception 'public.admin_hash_password(text) not found: run migration 006_admin_functions.sql first';
  end if;

  -- The super_admin role is created by 010_bootstrap.sql / seed.sql.
  select id into v_role from public.admin_roles where name = 'super_admin';
  if v_role is null then
    raise exception 'admin role "super_admin" not found - run 010_bootstrap.sql first';
  end if;

  -- Reuse the display name from the customer profile when one exists.
  select full_name into v_full_name
  from public.profiles
  where lower(email) = lower(v_email)
  limit 1;
  v_full_name := coalesce(nullif(v_full_name, ''), 'Dev Hamilton');

  -- 1) promote / reactivate an existing admin row (case-insensitive match)
  update public.admin_users
     set role_id    = v_role,
         status     = 'active',
         full_name  = case when coalesce(full_name, '') = '' then v_full_name else full_name end,
         updated_at = now()
   where lower(email) = lower(v_email);

  -- 2) otherwise create the row
  if not found then
    insert into public.admin_users (email, password_hash, full_name, role_id, status)
    values (lower(v_email),
            public.admin_hash_password(v_password),
            v_full_name,
            v_role,
            'active');
  end if;
end $$;
