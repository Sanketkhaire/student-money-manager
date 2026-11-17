'use strict';

/* ============================================================
   Auth — Amazon Cognito Hosted UI, OAuth 2.0 authorization code + PKCE.
   - No client secret in the browser (public client + PKCE).
   - `state` protects the redirect against CSRF.
   - Only the short-lived access/ID tokens are kept, in sessionStorage
     (cleared when the tab closes). The refresh token is never stored.
   ============================================================ */
const Auth = (() => {
  const cfg = window.SMM_CONFIG || {};
  const TOKENS_KEY = 'smm.auth';
  const PKCE_KEY = 'smm.pkce';
  const EXPIRY_SKEW_MS = 60 * 1000;

  function isConfigured() {
    return Boolean(cfg.apiBaseUrl && cfg.cognitoDomain && cfg.cognitoClientId);
  }

  function redirectUri() {
    return `${window.location.origin}/`;
  }

  function safeGet(storage, key) {
    try { return JSON.parse(storage.getItem(key)); } catch { return null; }
  }

  function safeSet(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  function safeRemove(storage, key) {
    try { storage.removeItem(key); } catch { /* ignore */ }
  }

  function base64url(bytes) {
    let bin = '';
    bytes.forEach(b => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomString(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return base64url(new Uint8Array(digest));
  }

  function decodeJwtPayload(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch {
      return null;
    }
  }

  async function login() {
    const verifier = randomString(48);
    const state = randomString(16);
    safeSet(sessionStorage, PKCE_KEY, { verifier, state });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.cognitoClientId,
      redirect_uri: redirectUri(),
      scope: 'openid email',
      state,
      code_challenge_method: 'S256',
      code_challenge: await sha256(verifier),
    });
    window.location.assign(`${cfg.cognitoDomain}/oauth2/authorize?${params}`);
  }

  /** If the page was loaded from a Cognito redirect, exchange the code for tokens. */
  async function handleRedirect() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (!code && !error) return;

    // Remove code/state from the address bar and history straight away.
    window.history.replaceState(null, '', url.pathname);

    const pkce = safeGet(sessionStorage, PKCE_KEY);
    safeRemove(sessionStorage, PKCE_KEY);

    if (error) throw new Error('Sign-in was cancelled or failed.');
    if (!pkce || !state || state !== pkce.state) throw new Error('Sign-in failed a security check. Please try again.');

    const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.cognitoClientId,
        code,
        redirect_uri: redirectUri(),
        code_verifier: pkce.verifier,
      }),
    });
    if (!res.ok) throw new Error('Could not complete sign-in. Please try again.');
    const data = await res.json();
    safeSet(sessionStorage, TOKENS_KEY, {
      accessToken: data.access_token,
      idToken: data.id_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    });
  }

  function getTokens() {
    const t = safeGet(sessionStorage, TOKENS_KEY);
    if (!t || typeof t.accessToken !== 'string' || Date.now() > t.expiresAt - EXPIRY_SKEW_MS) return null;
    return t;
  }

  function getAccessToken() {
    const t = getTokens();
    return t ? t.accessToken : null;
  }

  function isSignedIn() {
    return getTokens() !== null;
  }

  function getUserEmail() {
    const t = getTokens();
    const claims = t && decodeJwtPayload(t.idToken);
    return claims && typeof claims.email === 'string' ? claims.email : '';
  }

  function clearSession() {
    safeRemove(sessionStorage, TOKENS_KEY);
  }

  function logout() {
    clearSession();
    const params = new URLSearchParams({ client_id: cfg.cognitoClientId, logout_uri: redirectUri() });
    window.location.assign(`${cfg.cognitoDomain}/logout?${params}`);
  }

  return { isConfigured, login, handleRedirect, getAccessToken, isSignedIn, getUserEmail, clearSession, logout };
})();
