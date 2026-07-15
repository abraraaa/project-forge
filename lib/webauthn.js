// @ts-check
// lib/webauthn.js
// ─────────────────────────────────────────────────────────────────────────────
// Client-side WebAuthn helpers for passkey registration and authentication.
// Uses the browser's native Web Authentication API (navigator.credentials).
// ─────────────────────────────────────────────────────────────────────────────

// Check if WebAuthn is supported in this browser
export function isWebAuthnSupported() {
  return (
    typeof window !== "undefined" &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential === "function"
  );
}

// Check if platform authenticator (Face ID, Touch ID, Windows Hello) is available
export async function isPlatformAuthenticatorAvailable() {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// Convert ArrayBuffer to base64url string
function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Convert base64url string to ArrayBuffer
function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Register a new passkey for a profile.
// `authToken` (optional) proves control of an EXISTING passkey — required by
// the server only when the profile already holds a verifiable credential
// (adding a second passkey). First-time setup passes nothing.
// Returns { credentialId } on success, null on failure/cancel.
export async function registerPasskey(profile, authToken = null) {
  if (!isWebAuthnSupported()) {
    throw new Error("WebAuthn not supported");
  }

  // Get registration options from server
  const optionsRes = await fetch("/api/auth/register-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  if (!optionsRes.ok) {
    const err = await optionsRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to get registration options");
  }
  const options = await optionsRes.json();

  // Convert base64url strings to ArrayBuffers for the browser API
  const publicKeyOptions = {
    challenge: base64urlToBuffer(options.challenge),
    rp: options.rp,
    user: {
      id: base64urlToBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout || 60000,
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation || "none",
  };

  // Create the credential
  // navigator.credentials.create() returns the generic Credential type in the
  // DOM lib, but with publicKey options it always resolves to PublicKeyCredential.
  // Cast to any so the .rawId / .response accesses below typecheck — the
  // server validates the actual shape, this is just our reading of it.
  /** @type {any} */
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: publicKeyOptions });
  } catch (e) {
    if (e.name === "NotAllowedError") {
      return null; // User cancelled
    }
    throw e;
  }

  // Send credential to server for verification and storage
  const verifyRes = await fetch("/api/auth/register-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile,
      authToken,
      credential: {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
          attestationObject: bufferToBase64url(credential.response.attestationObject),
        },
      },
    }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to verify registration");
  }

  return await verifyRes.json();
}

// Authenticate with an existing passkey
// Returns { verified: true, profile } on success, null on failure/cancel
export async function authenticatePasskey(profile) {
  if (!isWebAuthnSupported()) {
    throw new Error("WebAuthn not supported");
  }

  // Get authentication options from server
  const optionsRes = await fetch("/api/auth/login-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  if (!optionsRes.ok) {
    const err = await optionsRes.json().catch(() => ({}));
    throw new Error(err.error || "Failed to get authentication options");
  }
  const options = await optionsRes.json();

  // Convert base64url strings to ArrayBuffers
  const publicKeyOptions = {
    challenge: base64urlToBuffer(options.challenge),
    timeout: options.timeout || 60000,
    rpId: options.rpId,
    allowCredentials: options.allowCredentials?.map(cred => ({
      id: base64urlToBuffer(cred.id),
      type: cred.type,
      transports: cred.transports,
    })),
    userVerification: options.userVerification || "preferred",
  };

  // Get the credential. See registerPasskey() for why we cast to any.
  /** @type {any} */
  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey: publicKeyOptions });
  } catch (e) {
    if (e.name === "NotAllowedError") {
      return null; // User cancelled
    }
    throw e;
  }

  // Send assertion to server for verification
  const verifyRes = await fetch("/api/auth/login-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile,
      credential: {
        id: assertion.id,
        rawId: bufferToBase64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
          authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
          signature: bufferToBase64url(assertion.response.signature),
          userHandle: assertion.response.userHandle
            ? bufferToBase64url(assertion.response.userHandle)
            : null,
        },
      },
    }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err.error || "Authentication failed");
  }

  return await verifyRes.json();
}

// Check if a profile has passkeys registered.
// Returns true/false when the server answered; null when the check itself
// failed (offline, mid-deploy blip, 5xx). Callers MUST NOT nag off null —
// "couldn't determine" is not "doesn't have one". A transient failure here
// once pinned the passkey setup card for a whole visit and read as "sync
// is broken" (2026-07-09).
export async function hasPasskey(profile) {
  try {
    const res = await fetch(`/api/auth/check?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.hasPasskey === true;
  } catch {
    return null;
  }
}
