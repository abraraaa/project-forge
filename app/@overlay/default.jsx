// app/@overlay/default.jsx
// Fallback for the @overlay parallel-route slot: render nothing when no route
// is intercepted into it. Required so a hard load / refresh of any route
// (where Next has no prior state for the slot) resolves cleanly instead of
// 404-ing the slot. See app/@overlay/(.)performance for the interception.
export default function OverlayDefault() {
  return null;
}
