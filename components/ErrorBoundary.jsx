"use client";

import { Component } from "react";
import { T } from "@/lib/tokens";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Log to console for debugging — no third-party error reporting yet
    console.error("[forge:boundary]", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleClearAndReload = () => {
    // Audit #11: this used to be localStorage.clear() — destroying UNPUSHED
    // per-profile data (the only copy, if sync hadn't run) while the copy
    // promised safety. Now: best-effort flush of pending pushes first, then
    // clear ONLY device-level/cache keys — every forge:<profile>:* store
    // survives. Corrupted-profile-data crashes can still be cleared via the
    // profile wipe, which is passkey-gated and says what it deletes.
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "This resets app-level caches and reloads. Your training data on this device is kept. Continue?"
      );
      if (confirmed) {
        import("@/lib/storage")
          .then((m) => m.flushPendingPushes?.())
          .catch(() => {})
          .finally(() => {
            const DEVICE_PREFIXES = ["forge:onboarded", "forge:weekConfig", "forge:programmeBlock", "forge:pendingPushes", "forge:lastSyncAt", "forge:tonnageMilestoneSeen", "forge:iosInstallDismissed"];
            for (let i = localStorage.length - 1; i >= 0; i--) {
              const k = localStorage.key(i);
              if (k && DEVICE_PREFIXES.some((p) => k === p)) localStorage.removeItem(k);
            }
            window.location.reload();
          });
      }
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            background: T.bg0,
            color: T.text1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            fontFamily: T.sans,
          }}
        >
          <div
            style={{
              fontFamily: T.serif,
              fontSize: 32,
              fontWeight: 300,
              marginBottom: 16,
              color: T.coral,
            }}
          >
            Something broke
          </div>
          <p
            style={{
              fontSize: 14,
              color: T.text2,
              textAlign: "center",
              maxWidth: 320,
              lineHeight: 1.6,
              marginBottom: 32,
            }}
          >
            The app hit an unexpected error. Your data's saved — don't worry.
          </p>

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={this.handleReset}
              style={{
                background: T.coral,
                color: T.bg0,
                border: "none",
                borderRadius: T.r.md,
                padding: "14px 28px",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={this.handleClearAndReload}
              style={{
                background: T.bg2,
                color: T.text2,
                border: `1px solid ${T.bg3}`,
                borderRadius: T.r.md,
                padding: "14px 28px",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Clear cache
            </button>
          </div>

          {process.env.NODE_ENV === "development" && this.state.error && (
            <pre
              style={{
                marginTop: 32,
                padding: 16,
                background: T.bg1,
                borderRadius: T.r.sm,
                fontSize: 11,
                color: T.text3,
                maxWidth: "90vw",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {this.state.error.toString()}
              {"\n"}
              {this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
