"use client";
// components/LibraryVideo.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Click-to-load demo video for a library page. The iframe does not exist
// until the user asks for it — the pages are static and fast, and nobody
// gets a YouTube request (or its cookies) for a video they never played.
// This is also why there is no thumbnail: a poster from i.ytimg.com would
// mean a third-party request on every page view AND an img-src CSP hole,
// for a preview frame that adds nothing the title doesn't.
// Same embed parameters as the in-session overlay.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { T } from "@/lib/tokens";
import Glyph from "@/components/Glyph";

export default function LibraryVideo({ vid, name }) {
  const [open, setOpen] = useState(false);
  if (!vid) return null;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{width:"100%",padding:"13px 16px",background:T.surface,border:"none",boxShadow:T.elev,borderRadius:T.r,cursor:"pointer",display:"flex",alignItems:"center",gap:12,textAlign:"left",fontFamily:T.text}}>
        <Glyph name="play" size={15} color={T.ink2}/>
        <span>
          <span style={{display:"block",fontSize:14,fontWeight:500,color:T.ink}}>Watch it done</span>
          <span style={{display:"block",fontSize:12,color:T.ink3,marginTop:2}}>Loads from YouTube when you tap</span>
        </span>
      </button>
    );
  }

  return (
    <iframe
      title={`${name} — demonstration`}
      src={`https://www.youtube.com/embed/${vid}?autoplay=0&modestbranding=1&rel=0`}
      style={{width:"100%",aspectRatio:"16/9",border:"none",borderRadius:T.r,background:T.ground,display:"block"}}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
    />
  );
}
