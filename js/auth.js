// NationalRegionB — Customer authentication (Supabase Auth)
// Handles login/register/forgot/reset/logout, session persistence, protected pages.

const Auth = {
  user: null,
  profile: null,

  async init() {
    const { data: { session }, error } = await SB.auth.getSession();
    if (error) {
      console.error('Session error:', error.message);
      return null;
    }
    this.user = session ? session.user : null;
    return this.user;
  },

  // Listen for auth state changes (expiry, refresh, etc.)
  listen(callback) {
    SB.auth.onAuthStateChange((event, session) => {
      this.user = session ? session.user : null;
      if (event === 'SIGNED_OUT') {
        this.profile = null;
      }
      if (callback) callback(event, session);
    });
  },

  async signIn(email, password) {
    const { data, error } = await SB.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    this.user = data.user;
    return data.user;
  },

  async signUp(fullName, email, password, pin) {
    const meta = { full_name: fullName };
    if (pin && /^[0-9]{4}$/.test(pin)) meta.pin = pin;
    const { data, error } = await SB.auth.signUp({
      email,
      password,
      options: {
        data: meta
      }
    });
    if (error) throw new Error(error.message);
    return data;
  },

  // Re-send the signup confirmation email (for projects with Confirm email ON).
  async resendConfirmation(email) {
    const { data, error } = await SB.auth.resend({ type: 'signup', email });
    if (error) throw new Error(error.message);
    return data;
  },

  // Normalize auth errors to user-friendly messages (never leak raw internals).
  friendlyError(err) {
    const msg = String((err && err.message) || err || '').toLowerCase();
    if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed')) {
      return { code: 'UNCONFIRMED', message: 'Your email address has not been confirmed yet.' };
    }
    if (msg.includes('invalid login credentials') || msg.includes('invalid_credentials')) {
      return { code: 'BAD_CREDENTIALS', message: 'Incorrect email or password. Please try again.' };
    }
    if (msg.includes('rate limit') || msg.includes('too many requests')) {
      return { code: 'RATE_LIMIT', message: 'Too many attempts. Please wait a minute and try again.' };
    }
    if (msg.includes('user already registered') || msg.includes('already been registered')) {
      return { code: 'EXISTS', message: 'An account with this email already exists. Try logging in instead.' };
    }
    return { code: 'UNKNOWN', message: (err && err.message) || 'Something went wrong. Please try again.' };
  },

  async resetPassword(email) {
    const { data, error } = await SB.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password.html'
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async updatePassword(newPassword) {
    const { data, error } = await SB.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
    return data;
  },

  async signOut() {
    const { error } = await SB.auth.signOut();
    if (error) throw new Error(error.message);
    this.user = null;
    this.profile = null;
  },

  // Current user's profile row
  async fetchProfile() {
    if (!this.user) return null;
    if (this.profile && this.profile.id === this.user.id) return this.profile;
    const { data, error } = await SB.from('profiles')
      .select('*')
      .eq('id', this.user.id)
      .maybeSingle();
    if (error) throw error;
    this.profile = data;
    return data;
  },

  async updateProfile(fields) {
    if (!this.user) throw new Error('Not authenticated');
    const { data, error } = await SB.from('profiles')
      .update(fields)
      .eq('id', this.user.id)
      .select()
      .single();
    if (error) throw error;
    this.profile = data;
    return data;
  },

  // ---- Page guards ----
  async requireAuth(redirectTo) {
    await this.init();
    if (!this.user) {
      const target = redirectTo || 'login.html';
      UI.toast('Please log in to access your account.', 'warning');
      window.location.href = target + (window.location.pathname.includes('/') ? '?next=' + encodeURIComponent(window.location.pathname.split('/').pop()) : '');
      return null;
    }
    return this.user;
  },

  // For login/register pages: bounce already-authenticated users
  async redirectIfAuthed() {
    await this.init();
    if (this.user) {
      window.location.href = 'dashboard.html';
      return true;
    }
    return false;
  },

  async logout() {
    try {
      await this.signOut();
    } catch (e) {
      console.error('Signout error', e);
    }
    window.location.href = 'login.html';
  }
};