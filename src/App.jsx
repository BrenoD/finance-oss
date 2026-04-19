import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://jrxohwaqctkrnbldsuxk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyeG9od2FxY3Rrcm5ibGRzdXhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTc2OTksImV4cCI6MjA5MTk5MzY5OX0.3dkMlImiM1y5fJ-SRHETnWuUs7-hYy-BqcmdgxwRWOU";
const APP_URL      = window.location.origin;   // redirect after OAuth

const DB_READY = SUPABASE_URL !== "YOUR_SUPABASE_URL" && SUPABASE_KEY !== "YOUR_SUPABASE_ANON_KEY";

// ─────────────────────────────────────────────────────────────────────────────
//  SUPABASE AUTH CLIENT (REST-based, no npm)
// ─────────────────────────────────────────────────────────────────────────────
const auth = {
  // Sign in with OAuth provider (Google, GitHub) — redirects to provider
  signInWithProvider(provider) {
    window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(APP_URL)}`;
  },

  // Magic link — sends email with login link
  async sendMagicLink(email) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error_description || e.msg || "Failed"); }
    return true;
  },

  // Exchange URL hash token after OAuth/magic link redirect
  async getSessionFromHash() {
    const hash = window.location.hash;
    if (!hash.includes("access_token")) return null;
    const params = new URLSearchParams(hash.replace("#",""));
    const access_token  = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (!access_token) return null;
    // Store tokens
    localStorage.setItem("sb_access_token",  access_token);
    localStorage.setItem("sb_refresh_token", refresh_token || "");
    // Clear hash from URL without reload
    window.history.replaceState({}, document.title, window.location.pathname);
    return access_token;
  },

  // Get current user from stored token
  async getUser() {
    const token = localStorage.getItem("sb_access_token");
    if (!token) return null;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}` },
    });
    if (!r.ok) { localStorage.removeItem("sb_access_token"); return null; }
    return r.json();
  },

  // Sign out
  async signOut() {
    const token = localStorage.getItem("sb_access_token");
    if (token) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}` },
      }).catch(()=>{});
    }
    localStorage.removeItem("sb_access_token");
    localStorage.removeItem("sb_refresh_token");
  },

  getToken() { return localStorage.getItem("sb_access_token") || SUPABASE_KEY; },
};

// ─────────────────────────────────────────────────────────────────────────────
//  SUPABASE DB CLIENT (auth-aware)
// ─────────────────────────────────────────────────────────────────────────────
const sb = {
  h() {
    return {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${auth.getToken()}`,
      "Prefer": "return=representation",
    };
  },
  url: (table, qs="") => `${SUPABASE_URL}/rest/v1/${table}${qs ? "?"+qs : ""}`,
  async select(table, qs="") {
    const r = await fetch(this.url(table,qs), { headers: this.h() });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async insert(table, body) {
    const r = await fetch(this.url(table), { method:"POST", headers:this.h(), body:JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async update(table, id, body) {
    const r = await fetch(this.url(table,`id=eq.${id}`), { method:"PATCH", headers:this.h(), body:JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async upsert(table, body) {
    const r = await fetch(this.url(table), {
      method:"POST", body:JSON.stringify(body),
      headers: { ...this.h(), "Prefer":"return=representation,resolution=merge-duplicates" },
    });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async delete(table, id) {
    const r = await fetch(this.url(table,`id=eq.${id}`), { method:"DELETE", headers:this.h() });
    if (!r.ok) throw new Error(await r.text()); return true;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  FALLBACK: localStorage (used when DB not configured)
// ─────────────────────────────────────────────────────────────────────────────
const LS = {
  get: (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v)   => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};


// ─────────────────────────────────────────────────────────────────────────────
//  COUPLE API
//  Run in Supabase SQL Editor:
//  create table if not exists couples (
//    id bigint generated always as identity primary key,
//    owner_id uuid not null, partner_id uuid,
//    invite_code text unique not null, partner_name text,
//    created_at timestamptz default now()
//  );
//  alter table couples disable row level security;
//  create table if not exists activity_feed (
//    id bigint generated always as identity primary key,
//    couple_id bigint references couples(id) on delete cascade,
//    user_id uuid not null, user_name text,
//    type text not null, label text not null,
//    amount numeric, created_at timestamptz default now()
//  );
//  alter table activity_feed disable row level security;
// ─────────────────────────────────────────────────────────────────────────────
const coupleApi = {
  makeCode: () => Math.random().toString(36).slice(2,10).toUpperCase(),
  async getOrCreate(userId) {
    if (!DB_READY) return null;
    try {
      const asOwner = await sb.select("couples",`owner_id=eq.${userId}`);
      if (asOwner.length>0) return asOwner[0];
      const asPartner = await sb.select("couples",`partner_id=eq.${userId}`);
      if (asPartner.length>0) return asPartner[0];
      const [row] = await sb.insert("couples",{owner_id:userId,invite_code:coupleApi.makeCode()});
      return row;
    } catch(e){console.error(e);return null;}
  },
  async joinByCode(code,userId,userName) {
    if (!DB_READY) return {error:"DB not configured"};
    try {
      const rows = await sb.select("couples",`invite_code=eq.${code}`);
      if (rows.length===0) return {error:"Invalid invite code"};
      const couple=rows[0];
      if (couple.owner_id===userId) return {already:true,couple};
      if (couple.partner_id) return {already:true,couple};
      await sb.update("couples",couple.id,{partner_id:userId,partner_name:userName});
      return {success:true,couple:{...couple,partner_id:userId,partner_name:userName}};
    } catch(e){return {error:e.message};}
  },
  async getCouple(userId) {
    if (!DB_READY) return null;
    try {
      const asOwner=await sb.select("couples",`owner_id=eq.${userId}`);
      if (asOwner.length>0) return {...asOwner[0],role:"owner"};
      const asPartner=await sb.select("couples",`partner_id=eq.${userId}`);
      if (asPartner.length>0) return {...asPartner[0],role:"partner"};
      return null;
    } catch(e){return null;}
  },
  async log(coupleId,userId,userName,type,label,amount) {
    if (!DB_READY||!coupleId) return;
    try { await sb.insert("activity_feed",{couple_id:coupleId,user_id:userId,user_name:userName,type,label,amount:amount||null}); }
    catch(e){console.error(e);}
  },
  async getFeed(coupleId) {
    if (!DB_READY||!coupleId) return [];
    try { return await sb.select("activity_feed",`couple_id=eq.${coupleId}&order=created_at.desc&limit=100`); }
    catch(e){return [];}
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const GBP   = "\u00a3";
const fmt   = (v) => GBP + parseFloat(v||0).toFixed(2);
const nowDate = () => new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});
const nowTime = () => new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});

const getLogoUrl = (title) => {
  const map = {
    netflix:"netflix.com", spotify:"spotify.com", amazon:"amazon.com",
    "amazon prime":"amazon.com", prime:"amazon.com", youtube:"youtube.com",
    "youtube premium":"youtube.com", disney:"disneyplus.com", "disney+":"disneyplus.com",
    apple:"apple.com", "apple tv":"apple.com", "apple music":"apple.com", icloud:"apple.com",
    microsoft:"microsoft.com", office:"microsoft.com", "microsoft 365":"microsoft.com",
    xbox:"xbox.com", playstation:"playstation.com", ps:"playstation.com",
    hulu:"hulu.com", hbo:"hbo.com", "hbo max":"hbo.com", max:"max.com",
    paramount:"paramountplus.com", peacock:"peacocktv.com", twitch:"twitch.tv",
    adobe:"adobe.com", figma:"figma.com", notion:"notion.so", slack:"slack.com",
    zoom:"zoom.us", dropbox:"dropbox.com", github:"github.com", canva:"canva.com",
    linkedin:"linkedin.com", duolingo:"duolingo.com", chatgpt:"openai.com",
    openai:"openai.com", claude:"anthropic.com", anthropic:"anthropic.com",
    google:"google.com", "google one":"google.com", tinder:"tinder.com",
    bumble:"bumble.com", audible:"audible.com", kindle:"amazon.com",
    patreon:"patreon.com", nordvpn:"nordvpn.com", expressvpn:"expressvpn.com",
    grammarly:"grammarly.com", "1password":"1password.com",
    norton:"norton.com", deezer:"deezer.com", crunchyroll:"crunchyroll.com",
  };
  const key = title.toLowerCase().trim();
  for (const k of Object.keys(map))
    if (key.includes(k) || k.includes(key)) return `https://logo.clearbit.com/${map[k]}`;
  return `https://logo.clearbit.com/${title.toLowerCase().split(" ")[0].replace(/[^a-z0-9]/g,"")+".com"}`;
};

const getInitials = (t) => t.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();

const getWeekKey = (date = new Date()) => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
};

const weekLabel = (key) => {
  const [yr, w] = key.split("-W");
  const jan4 = new Date(Date.UTC(+yr, 0, 4));
  const mon  = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay()||7) + 1 + (parseInt(w)-1)*7);
  const sun  = new Date(mon); sun.setUTCDate(mon.getUTCDate()+6);
  const f    = (d) => d.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
  return `${f(mon)} \u2013 ${f(sun)}`;
};

const ACCENTS = ["#E8FF47","#FF4757","#2ED573","#1E90FF","#FF6B81","#ECF0F1","#FFA502","#A29BFE"];


// ─────────────────────────────────────────────────────────────────────────────
//  LOGIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email,    setEmail]    = useState("");
  const [sending,  setSending]  = useState(false);
  const [sent,     setSent]     = useState(false);
  const [err,      setErr]      = useState("");
  const [provider, setProvider] = useState(null); // "google" | "github"

  const handleMagicLink = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email."); return; }
    setSending(true); setErr("");
    try {
      await auth.sendMagicLink(email);
      setSent(true);
    } catch(e) { setErr(e.message); }
    setSending(false);
  };

  const handleOAuth = (p) => {
    setProvider(p);
    auth.signInWithProvider(p);
  };

  const PROVIDERS = [
    {
      id: "google",
      label: "Continue with Google",
      icon: (
        <svg width="18" height="18" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.35-8.16 2.35-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          <path fill="none" d="M0 0h48v48H0z"/>
        </svg>
      ),
      bg:"rgba(255,255,255,0.06)", border:"rgba(255,255,255,0.12)", color:"#fff",
    },
    {
      id: "github",
      label: "Continue with GitHub",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/>
        </svg>
      ),
      bg:"rgba(255,255,255,0.06)", border:"rgba(255,255,255,0.12)", color:"#fff",
    },
  ];

  return (
    <div style={{
      minHeight:"100vh", background:"#070707",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'DM Sans','Helvetica Neue',sans-serif",
      position:"relative", overflow:"hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        @keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes scanline{0%{top:-2px}100%{top:100vh}}
        @keyframes pulse2{0%,100%{opacity:.4}50%{opacity:1}}
        * { box-sizing:border-box }
        input { outline:none; font-family:inherit }
        input::placeholder{color:rgba(255,255,255,.2)}
      `}</style>

      {/* bg grid */}
      <div style={{position:"fixed",inset:0,
        backgroundImage:"linear-gradient(rgba(232,255,71,0.016) 1px,transparent 1px),linear-gradient(90deg,rgba(232,255,71,0.016) 1px,transparent 1px)",
        backgroundSize:"52px 52px", pointerEvents:"none"}}/>
      {/* scanline */}
      <div style={{position:"fixed",left:0,right:0,height:3,zIndex:0,pointerEvents:"none",
        background:"linear-gradient(transparent,rgba(232,255,71,0.025),transparent)",
        animation:"scanline 10s linear infinite"}}/>

      {/* glow orb */}
      <div style={{position:"fixed",top:"30%",left:"50%",transform:"translateX(-50%)",
        width:600,height:400,borderRadius:"50%",pointerEvents:"none",
        background:"radial-gradient(ellipse,rgba(232,255,71,0.04) 0%,transparent 70%)"}}/>

      <div style={{
        position:"relative",zIndex:1,width:"100%",maxWidth:400,padding:"1.5rem",
        animation:"fadeUp .5s ease both",
      }}>
        {/* Logo mark */}
        <div style={{textAlign:"center",marginBottom:"2.5rem"}}>
          <div style={{
            width:52,height:52,borderRadius:"14px",margin:"0 auto 1rem",
            background:"rgba(232,255,71,0.08)",border:"1px solid rgba(232,255,71,0.25)",
            display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:"0 0 30px rgba(232,255,71,0.08)",fontSize:"1.5rem",
          }}>💷</div>
          <div style={{fontWeight:700,fontSize:"1.3rem",letterSpacing:"-0.02em",color:"#fff"}}>Finance OS</div>
          <div style={{color:"rgba(255,255,255,0.25)",fontSize:"0.72rem",letterSpacing:"0.15em",marginTop:4}}>
            SIGN IN TO CONTINUE
          </div>
        </div>

        {/* Card */}
        <div style={{
          background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.08)",
          borderRadius:"16px",padding:"1.75rem",
          boxShadow:"0 20px 60px rgba(0,0,0,0.5)",
          position:"relative",overflow:"hidden",
        }}>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1.5,
            background:"linear-gradient(90deg,transparent,rgba(232,255,71,0.5),transparent)"}}/>

          {!DB_READY ? (
            <div style={{textAlign:"center",padding:"1rem 0"}}>
              <div style={{color:"#FF4757",fontSize:"0.78rem",lineHeight:1.6,marginBottom:"1rem"}}>
                Configure Supabase first — see the setup guide.
              </div>
              <button onClick={()=>onLogin({email:"demo@local",id:"local"})} style={{
                width:"100%",padding:"0.75rem",background:"rgba(232,255,71,0.1)",
                border:"1px solid rgba(232,255,71,0.3)",borderRadius:"9px",
                color:"#E8FF47",cursor:"pointer",fontWeight:600,
                fontSize:"0.78rem",letterSpacing:"0.1em",
              }}>CONTINUE WITHOUT LOGIN (demo)</button>
            </div>
          ) : sent ? (
            <div style={{textAlign:"center",padding:"1rem 0",animation:"fadeUp .3s ease both"}}>
              <div style={{fontSize:"2.5rem",marginBottom:"0.875rem",animation:"pulse2 2s ease infinite"}}>📧</div>
              <div style={{fontWeight:600,fontSize:"0.95rem",marginBottom:"0.5rem"}}>Check your inbox</div>
              <div style={{color:"rgba(255,255,255,0.4)",fontSize:"0.78rem",lineHeight:1.6}}>
                We sent a magic login link to<br/>
                <span style={{color:"#E8FF47"}}>{email}</span>
              </div>
              <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.68rem",marginTop:"1rem",letterSpacing:"0.08em"}}>
                Click the link in the email to sign in instantly
              </div>
              <button onClick={()=>setSent(false)} style={{
                marginTop:"1.25rem",background:"none",border:"none",
                color:"rgba(255,255,255,0.25)",cursor:"pointer",fontSize:"0.72rem",letterSpacing:"0.1em",
              }}>← BACK</button>
            </div>
          ) : (
            <>
              {/* OAuth buttons */}
              <div style={{display:"flex",flexDirection:"column",gap:"0.625rem",marginBottom:"1.25rem"}}>
                {PROVIDERS.map(p=>(
                  <button key={p.id} onClick={()=>handleOAuth(p.id)}
                    disabled={provider===p.id}
                    style={{
                      display:"flex",alignItems:"center",justifyContent:"center",gap:"0.75rem",
                      padding:"0.75rem 1rem",cursor:"pointer",transition:"all .15s",
                      background:p.bg,border:`1px solid ${p.border}`,
                      borderRadius:"10px",color:p.color,
                      fontSize:"0.85rem",fontWeight:500,
                      opacity:provider&&provider!==p.id?0.4:1,
                    }}
                    onMouseOver={e=>{ if(!provider) e.currentTarget.style.borderColor="rgba(255,255,255,0.28)"; }}
                    onMouseOut={e=>{ e.currentTarget.style.borderColor=p.border; }}
                  >
                    {provider===p.id?(
                      <div style={{width:18,height:18,border:"2px solid rgba(255,255,255,0.2)",
                        borderTop:"2px solid #fff",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
                    ):p.icon}
                    {provider===p.id?"Redirecting...":p.label}
                  </button>
                ))}
              </div>

              {/* divider */}
              <div style={{display:"flex",alignItems:"center",gap:"0.75rem",marginBottom:"1.25rem"}}>
                <div style={{flex:1,height:1,background:"rgba(255,255,255,0.07)"}}/>
                <span style={{color:"rgba(255,255,255,0.2)",fontSize:"0.65rem",letterSpacing:"0.1em"}}>OR EMAIL</span>
                <div style={{flex:1,height:1,background:"rgba(255,255,255,0.07)"}}/>
              </div>

              {/* magic link */}
              <div style={{display:"flex",gap:"0.5rem"}}>
                <input
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={e=>{setEmail(e.target.value);setErr("");}}
                  onKeyDown={e=>e.key==="Enter"&&handleMagicLink()}
                  style={{
                    flex:1,background:"#111",border:"1px solid rgba(255,255,255,0.1)",
                    borderRadius:"9px",color:"#fff",padding:"0.7rem 0.875rem",
                    fontSize:"0.88rem",fontFamily:"'DM Mono',monospace",
                  }}
                />
                <button onClick={handleMagicLink} disabled={sending} style={{
                  padding:"0.7rem 1rem",background:"#E8FF47",border:"none",
                  borderRadius:"9px",color:"#080808",cursor:"pointer",fontWeight:700,
                  fontSize:"0.75rem",letterSpacing:"0.1em",flexShrink:0,
                  opacity:sending?0.6:1,transition:"all .15s",whiteSpace:"nowrap",
                }}
                  onMouseOver={e=>{ if(!sending) e.currentTarget.style.background="#fff"; }}
                  onMouseOut={e=>{ e.currentTarget.style.background="#E8FF47"; }}
                >
                  {sending?(
                    <div style={{width:16,height:16,border:"2px solid rgba(0,0,0,0.2)",
                      borderTop:"2px solid #000",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
                  ):"SEND LINK"}
                </button>
              </div>

              {err&&(
                <div style={{marginTop:"0.75rem",color:"#FF4757",fontSize:"0.75rem",
                  letterSpacing:"0.06em",textAlign:"center"}}>{err}</div>
              )}

              <div style={{marginTop:"1.25rem",color:"rgba(255,255,255,0.15)",
                fontSize:"0.65rem",textAlign:"center",lineHeight:1.6,letterSpacing:"0.05em"}}>
                No password needed. We’ll email you a secure login link.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  INVITE MODAL
// ─────────────────────────────────────────────────────────────────────────────
function InviteModal({onClose,couple}) {
  const [copied,setCopied]=useState(false);
  const link=couple?`${APP_URL}?invite=${couple.invite_code}`:"Loading...";
  const hasPartner=!!couple?.partner_id;
  const copy=()=>{ navigator.clipboard.writeText(link).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);}); };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:800,
      display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(14px)",padding:"1rem"}}>
      <div style={{background:"#090909",border:"1px solid rgba(255,255,255,0.09)",borderRadius:"16px",
        padding:"1.75rem",maxWidth:420,width:"100%",animation:"popIn .22s ease both",position:"relative"}}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:1.5,
          background:"linear-gradient(90deg,transparent,rgba(255,105,180,0.6),transparent)",borderRadius:"16px 16px 0 0"}}/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.25rem"}}>
          <div style={{display:"flex",alignItems:"center",gap:"0.625rem"}}>
            <span style={{fontSize:"1.4rem"}}>♥</span>
            <div>
              <div style={{fontWeight:600,fontSize:"0.9rem"}}>Invite Partner</div>
              <div style={{color:"rgba(255,255,255,0.25)",fontSize:"0.65rem",letterSpacing:"0.1em"}}>
                {hasPartner?"PARTNER CONNECTED":"SHARE THIS LINK"}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"rgba(255,255,255,0.28)",cursor:"pointer",fontSize:18,padding:0}}>x</button>
        </div>
        {hasPartner?(
          <div style={{textAlign:"center",padding:"1rem 0"}}>
            <div style={{fontSize:"2rem",marginBottom:"0.75rem"}}>♥</div>
            <div style={{fontWeight:600,fontSize:"0.9rem",marginBottom:"0.375rem"}}>Already connected!</div>
            <div style={{color:"rgba(255,255,255,0.35)",fontSize:"0.78rem"}}>Your partner has joined. Check the Together tab.</div>
          </div>
        ):(
          <>
            <div style={{color:"rgba(255,255,255,0.4)",fontSize:"0.78rem",lineHeight:1.6,marginBottom:"1.1rem"}}>
              Send this link to your partner. When they open it and sign in, you will be connected and see each other's activity in the <strong style={{color:"#FF69B4"}}>Together</strong> tab.
            </div>
            <div style={{display:"flex",gap:"0.45rem",marginBottom:"1rem"}}>
              <div style={{flex:1,background:"#111",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"8px",
                padding:"0.7rem 0.875rem",fontFamily:"'DM Mono',monospace",fontSize:"0.72rem",
                color:"rgba(255,255,255,0.5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{link}</div>
              <button onClick={copy} style={{padding:"0.7rem 1rem",background:copied?"#2ED573":"#FF69B4",
                border:"none",borderRadius:"8px",color:"#fff",cursor:"pointer",fontWeight:700,
                fontSize:"0.72rem",letterSpacing:"0.08em",transition:"background .2s",flexShrink:0,whiteSpace:"nowrap"}}>
                {copied?"COPIED":"COPY"}
              </button>
            </div>
            <div style={{background:"rgba(255,105,180,0.05)",border:"1px solid rgba(255,105,180,0.12)",
              borderRadius:"8px",padding:"0.75rem 0.875rem",display:"flex",alignItems:"center",gap:"0.5rem"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:"#FFA502",flexShrink:0}}/>
              <div style={{color:"rgba(255,255,255,0.3)",fontSize:"0.68rem",letterSpacing:"0.06em"}}>Waiting for partner to join...</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOGETHER TAB
// ─────────────────────────────────────────────────────────────────────────────
function TogetherTab({couple,user}) {
  const [feed,setFeed]=useState([]);
  const [loading,setLoading]=useState(true);
  const myName=user?.user_metadata?.full_name||user?.email?.split("@")[0]||"Me";
  const herName=couple?.partner_name||"Partner";
  const hasPartner=!!couple?.partner_id;
  useEffect(()=>{
    if(!couple){setLoading(false);return;}
    coupleApi.getFeed(couple.id).then(f=>{setFeed(f);setLoading(false);});
    const iv=setInterval(()=>coupleApi.getFeed(couple.id).then(f=>setFeed(f)),20000);
    return ()=>clearInterval(iv);
  },[couple]);
  const typeColor=(t)=>({subscription:"#A29BFE",expense:"#FF4757",weekly:"#FFA502",payment:"#2ED573",income:"#E8FF47"}[t]||"#fff");
  const typeLabel=(t,label,amount)=>({
    payment:`paid ${label}`,
    income:`updated income`,
    subscription:`added: ${label}`,
    expense:`added expense: ${label}`,
    weekly:`logged: ${label}`,
  }[t]||label);
  const fmtDate=(iso)=>{const d=new Date(iso);return d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})+" · "+d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});};
  if(!hasPartner) return (
    <div style={{animation:"fadeUp .32s ease both",textAlign:"center",padding:"4rem 0"}}>
      <div style={{fontSize:"3rem",marginBottom:"1rem"}}>♥</div>
      <div style={{fontWeight:600,fontSize:"0.95rem",marginBottom:"0.5rem"}}>No partner yet</div>
      <div style={{color:"rgba(255,255,255,0.35)",fontSize:"0.78rem",lineHeight:1.6}}>Use the ♥ Invite button to connect with your partner.</div>
    </div>
  );
  return (
    <div style={{animation:"fadeUp .32s ease both"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:"1rem",marginBottom:"1.25rem",
        padding:"0.875rem",background:"rgba(255,105,180,0.04)",border:"1px solid rgba(255,105,180,0.12)",borderRadius:"12px"}}>
        {[{name:myName,bg:"linear-gradient(135deg,#E8FF47,#A8C000)",c:"#080808"},{name:herName,bg:"linear-gradient(135deg,#FF69B4,#FF4757)",c:"#fff"}].map((p,i)=>(
          <div key={i} style={{textAlign:"center"}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:p.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.9rem",fontWeight:700,color:p.c,margin:"0 auto 0.25rem"}}>{p.name[0].toUpperCase()}</div>
            <div style={{color:"rgba(255,255,255,0.4)",fontSize:"0.62rem",letterSpacing:"0.1em"}}>{p.name.split(" ")[0].toUpperCase()}</div>
          </div>
        ))}
        <div style={{fontSize:"1.25rem",color:"#FF69B4"}}>♥</div>
      </div>
      {loading?(
        <div style={{textAlign:"center",padding:"2rem 0"}}>
          <div style={{width:28,height:28,border:"2px solid rgba(232,255,71,0.1)",borderTop:"2px solid #E8FF47",borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto"}}/>
        </div>
      ):feed.length===0?(
        <div style={{textAlign:"center",padding:"3rem 0",color:"rgba(255,255,255,0.15)",fontSize:"0.72rem",letterSpacing:"0.15em"}}>NO ACTIVITY YET</div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:"0.5rem"}}>
          {feed.map((item,i)=>{
            const isMe=item.user_id===user?.id;
            const name=item.user_name||(isMe?myName:herName);
            return (
              <div key={item.id} style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",borderRadius:"11px",
                padding:"0.75rem 1rem",display:"flex",alignItems:"center",gap:"0.875rem",
                animation:`fadeUp .28s ease ${i*.03}s both`,position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",left:0,top:"15%",bottom:"15%",width:2.5,borderRadius:"0 2px 2px 0",background:isMe?"#E8FF47":"#FF69B4"}}/>
                <div style={{width:32,height:32,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:"0.78rem",fontWeight:700,color:isMe?"#080808":"#fff",
                  background:isMe?"linear-gradient(135deg,#E8FF47,#A8C000)":"linear-gradient(135deg,#FF69B4,#FF4757)"}}>
                  {name[0].toUpperCase()}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:"0.4rem",flexWrap:"wrap"}}>
                    <span style={{color:isMe?"#E8FF47":"#FF69B4",fontSize:"0.7rem",letterSpacing:"0.08em",fontWeight:600}}>{name.split(" ")[0].toUpperCase()}</span>
                    <span style={{color:"rgba(255,255,255,0.6)",fontSize:"0.8rem"}}>{typeLabel(item.type,item.label,item.amount)}</span>
                  </div>
                  <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.62rem",fontFamily:"'DM Mono',monospace",marginTop:2}}>{fmtDate(item.created_at)}</div>
                </div>
                {item.amount&&item.type!=="income"&&(
                  <div style={{fontFamily:"'DM Mono',monospace",fontWeight:500,fontSize:"0.85rem",color:typeColor(item.type),flexShrink:0}}>{fmt(item.amount)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP BANNER — shown when DB not configured
// ─────────────────────────────────────────────────────────────────────────────
function SetupBanner() {
  const [open, setOpen] = useState(true);
  if (!open) return (
    <div onClick={()=>setOpen(true)} style={{
      position:"fixed",bottom:"1rem",right:"1rem",zIndex:900,
      background:"rgba(232,255,71,0.12)",border:"1px solid rgba(232,255,71,0.3)",
      borderRadius:"8px",padding:"0.4rem 0.75rem",cursor:"pointer",
      fontSize:"0.65rem",letterSpacing:"0.12em",color:"#E8FF47",
    }}>DB NOT CONFIGURED</div>
  );
  return (
    <div style={{
      position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:900,
      display:"flex",alignItems:"center",justifyContent:"center",
      padding:"1rem",backdropFilter:"blur(12px)",
    }}>
      <div style={{
        background:"#0d0d0d",border:"1px solid rgba(232,255,71,0.3)",
        borderRadius:"16px",padding:"2rem",maxWidth:580,width:"100%",
        maxHeight:"90vh",overflowY:"auto",
      }}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:1.5,
          background:"linear-gradient(90deg,transparent,#E8FF47,transparent)",
          borderRadius:"16px 16px 0 0"}}/>

        <div style={{display:"flex",alignItems:"center",gap:"0.75rem",marginBottom:"1.5rem"}}>
          <div style={{width:36,height:36,borderRadius:"9px",background:"rgba(232,255,71,0.1)",
            border:"1px solid rgba(232,255,71,0.3)",display:"flex",alignItems:"center",
            justifyContent:"center",fontSize:"1.1rem"}}>🗄️</div>
          <div>
            <div style={{fontWeight:700,fontSize:"0.9rem",color:"#E8FF47",letterSpacing:"0.1em"}}>SUPABASE SETUP</div>
            <div style={{color:"rgba(255,255,255,0.3)",fontSize:"0.65rem",letterSpacing:"0.08em"}}>
              FREE BACKEND · 5 MINUTES
            </div>
          </div>
        </div>

        {[
          {n:"1",t:"Create a free Supabase project",d:'Go to supabase.com → "New Project" → choose any name and region.'},
          {n:"2",t:"Run this SQL in the SQL Editor",d:"Copy the SQL below and paste it in Supabase → SQL Editor → New query → Run."},
          {n:"3",t:"Copy your credentials",d:'Go to Settings → API. Copy "Project URL" and "anon public" key.'},
          {n:"4",t:"Paste into this file",d:'Replace YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY at the top of the .jsx file.'},
        ].map(step=>(
          <div key={step.n} style={{display:"flex",gap:"0.875rem",marginBottom:"1.1rem"}}>
            <div style={{width:28,height:28,borderRadius:"50%",background:"rgba(232,255,71,0.1)",
              border:"1px solid rgba(232,255,71,0.25)",display:"flex",alignItems:"center",
              justifyContent:"center",fontSize:"0.75rem",fontWeight:700,color:"#E8FF47",
              flexShrink:0,fontFamily:"'DM Mono',monospace"}}>{step.n}</div>
            <div>
              <div style={{fontWeight:600,fontSize:"0.85rem",marginBottom:"0.2rem"}}>{step.t}</div>
              <div style={{color:"rgba(255,255,255,0.4)",fontSize:"0.78rem",lineHeight:1.5}}>{step.d}</div>
            </div>
          </div>
        ))}

        <div style={{background:"#060606",border:"1px solid rgba(255,255,255,0.08)",
          borderRadius:"10px",padding:"1rem",marginBottom:"1.25rem",
          fontFamily:"'DM Mono',monospace",fontSize:"0.72rem",
          color:"rgba(255,255,255,0.55)",lineHeight:1.8,overflowX:"auto",whiteSpace:"pre"}}>
{`-- Run this SQL in Supabase SQL Editor

create table if not exists subscriptions (
  id        bigint generated always as identity primary key,
  title     text not null,
  amount    numeric not null,
  ci        int default 0,
  logo_err  boolean default false,
  created_at timestamptz default now()
);

create table if not exists sub_payments (
  id       bigint generated always as identity primary key,
  sub_id   bigint references subscriptions(id) on delete cascade,
  paid_date text,
  paid_time text,
  created_at timestamptz default now()
);

create table if not exists expenses (
  id        bigint generated always as identity primary key,
  label     text not null,
  amount    numeric not null,
  paid_date text,
  paid_time text,
  created_at timestamptz default now()
);

create table if not exists weekly_entries (
  id         bigint generated always as identity primary key,
  week_key   text not null,
  label      text not null,
  amount     numeric not null,
  note       text,
  paid_date  text,
  paid_time  text,
  created_at timestamptz default now()
);

create table if not exists settings (
  key   text primary key,
  value text
);

-- disable RLS for personal use (single user)
alter table subscriptions  disable row level security;
alter table sub_payments   disable row level security;
alter table expenses       disable row level security;
alter table weekly_entries disable row level security;
alter table settings       disable row level security;`}
        </div>

        <div style={{display:"flex",gap:"0.5rem"}}>
          <button onClick={()=>setOpen(false)} style={{
            flex:1,padding:"0.75rem",background:"rgba(255,255,255,0.04)",
            border:"1px solid rgba(255,255,255,0.08)",borderRadius:"9px",
            color:"rgba(255,255,255,0.4)",cursor:"pointer",fontSize:"0.72rem",letterSpacing:"0.1em",
          }}>USE WITHOUT DB (localStorage only)</button>
          <button onClick={()=>setOpen(false)} style={{
            flex:1,padding:"0.75rem",background:"#E8FF47",
            border:"none",borderRadius:"9px",color:"#080808",
            cursor:"pointer",fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em",
          }}>DONE — CLOSE</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATE TIME PICKER
// ─────────────────────────────────────────────────────────────────────────────
function DateTimePicker({ value, onChange }) {
  const [mode, setMode] = useState("ask");
  const [manDate, setManDate] = useState("");
  const [manTime, setManTime] = useState("");

  const handleToday = () => {
    onChange({ date: nowDate(), time: nowTime() });
    setMode("today");
  };

  const handleManualChange = (d, t) => {
    if (d) {
      const parsed = new Date(d);
      const dateStr = parsed.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});
      onChange({ date: dateStr, time: t || "" });
    }
  };

  const inp = {
    background:"#111",border:"1px solid rgba(255,255,255,0.1)",
    borderRadius:"7px",color:"#fff",padding:"0.55rem 0.75rem",
    fontSize:"0.82rem",fontFamily:"'DM Mono',monospace",colorScheme:"dark",
  };
  const lbl2 = {color:"rgba(255,255,255,0.25)",fontSize:"0.62rem",letterSpacing:"0.15em",
    display:"block",marginBottom:"0.3rem",textTransform:"uppercase"};

  if (mode==="ask") return (
    <div style={{marginBottom:"0.875rem"}}>
      <label style={lbl2}>PAYMENT DATE</label>
      <div style={{display:"flex",gap:"0.4rem"}}>
        <button onClick={handleToday} style={{
          flex:1,padding:"0.6rem 0.5rem",cursor:"pointer",transition:"all .15s",
          background:"rgba(46,213,115,0.1)",border:"1px solid rgba(46,213,115,0.35)",
          borderRadius:"8px",color:"#2ED573",fontSize:"0.72rem",fontWeight:700,letterSpacing:"0.08em",
        }}
          onMouseOver={e=>e.currentTarget.style.background="rgba(46,213,115,0.2)"}
          onMouseOut={e=>e.currentTarget.style.background="rgba(46,213,115,0.1)"}
        >\u2713 PAID TODAY</button>
        <button onClick={()=>setMode("manual")} style={{
          flex:1,padding:"0.6rem 0.5rem",cursor:"pointer",transition:"all .15s",
          background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",
          borderRadius:"8px",color:"rgba(255,255,255,0.45)",fontSize:"0.72rem",letterSpacing:"0.08em",
        }}
          onMouseOver={e=>e.currentTarget.style.borderColor="rgba(255,255,255,0.25)"}
          onMouseOut={e=>e.currentTarget.style.borderColor="rgba(255,255,255,0.1)"}
        >SET DATE</button>
      </div>
    </div>
  );

  if (mode==="today") return (
    <div style={{marginBottom:"0.875rem"}}>
      <label style={lbl2}>PAYMENT DATE</label>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"0.6rem 0.875rem",background:"rgba(46,213,115,0.07)",
        border:"1px solid rgba(46,213,115,0.25)",borderRadius:"8px"}}>
        <div>
          <div style={{fontSize:"0.82rem",fontWeight:500,color:"#2ED573"}}>{value?.date}</div>
          <div style={{fontSize:"0.65rem",color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace"}}>{value?.time}</div>
        </div>
        <button onClick={()=>{setMode("ask");onChange(null);}} style={{
          background:"none",border:"none",color:"rgba(255,255,255,0.2)",cursor:"pointer",fontSize:14,
        }}>×</button>
      </div>
    </div>
  );

  return (
    <div style={{marginBottom:"0.875rem"}}>
      <label style={lbl2}>PAYMENT DATE</label>
      <div style={{display:"flex",gap:"0.4rem",marginBottom:"0.4rem"}}>
        <input type="date" value={manDate}
          onChange={e=>{setManDate(e.target.value);handleManualChange(e.target.value,manTime);}}
          style={{...inp,flex:1}}/>
        <input type="time" value={manTime}
          onChange={e=>{setManTime(e.target.value);handleManualChange(manDate,e.target.value);}}
          style={{...inp,width:100}}/>
      </div>
      <button onClick={()=>{setMode("ask");onChange(null);}} style={{
        background:"none",border:"none",color:"rgba(255,255,255,0.2)",cursor:"pointer",
        fontSize:"0.65rem",letterSpacing:"0.1em",padding:0,
      }}>\u2190 BACK</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARTICLE CANVAS
// ─────────────────────────────────────────────────────────────────────────────
function ParticleCanvas() {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current, ctx = c.getContext("2d");
    const resize = () => { c.width=window.innerWidth; c.height=window.innerHeight; };
    resize(); window.addEventListener("resize",resize);
    const pts = Array.from({length:40},()=>({
      x:Math.random()*c.width, y:Math.random()*c.height,
      r:Math.random()*1.4+0.3, vx:(Math.random()-.5)*.2, vy:(Math.random()-.5)*.2,
      a:Math.random()*.22+.04,
    }));
    let id;
    const draw = () => {
      ctx.clearRect(0,0,c.width,c.height);
      pts.forEach(p=>{
        p.x=(p.x+p.vx+c.width)%c.width; p.y=(p.y+p.vy+c.height)%c.height;
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fillStyle=`rgba(232,255,71,${p.a})`; ctx.fill();
      });
      for(let i=0;i<pts.length;i++) for(let j=i+1;j<pts.length;j++){
        const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y, d=Math.hypot(dx,dy);
        if(d<90){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);
          ctx.strokeStyle=`rgba(232,255,71,${.05*(1-d/90)})`;ctx.lineWidth=.4;ctx.stroke();}
      }
      id=requestAnimationFrame(draw);
    };
    draw();
    return ()=>{cancelAnimationFrame(id);window.removeEventListener("resize",resize);};
  },[]);
  return <canvas ref={ref} style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0}}/>;
}

function Tilt({children,style}) {
  const r=useRef(null);
  return (
    <div ref={r} style={{transition:"transform .12s ease",...style}}
      onMouseMove={e=>{const b=r.current.getBoundingClientRect();
        r.current.style.transform=`perspective(700px) rotateX(${((e.clientY-b.top)/b.height-.5)*-11}deg) rotateY(${((e.clientX-b.left)/b.width-.5)*11}deg) scale3d(1.013,1.013,1.013)`;}}
      onMouseLeave={()=>{r.current.style.transform="perspective(700px) rotateX(0) rotateY(0) scale3d(1,1,1)";}}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI MODAL
// ─────────────────────────────────────────────────────────────────────────────
function AIModal({onClose,subscriptions,expenses,weeklyIncome}) {
  const [loading,setLoading]=useState(true);
  const [advice,setAdvice]=useState("");
  const [err,setErr]=useState("");
  const totalSubs=subscriptions.reduce((s,x)=>s+parseFloat(x.amount||0),0);
  const totalExp=expenses.reduce((s,x)=>s+parseFloat(x.amount||0),0);
  const balance=weeklyIncome-totalSubs-totalExp;

  useEffect(()=>{
    fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,
        messages:[{role:"user",content:`Personal finance consultant. Reply in English, be direct.
Weekly income: \u00a3${weeklyIncome.toFixed(2)} / \u00a3${(weeklyIncome*4).toFixed(2)} monthly (combined household)
Subscriptions (\u00a3${totalSubs.toFixed(2)}): ${subscriptions.map(s=>`${s.title}: \u00a3${s.amount}`).join(", ")}
Expenses (\u00a3${totalExp.toFixed(2)}): ${expenses.map(e=>`${e.label}: \u00a3${e.amount}`).join(", ")}
Weekly balance: \u00a3${balance.toFixed(2)}
1) Spending % breakdown 2) What to cut 3) Savings plan 4) 3/6/12 month projection 5) 3 tips. Emojis, real numbers. Max 300 words.`}]})
    }).then(r=>r.json()).then(d=>{
      if(d.content?.[0]?.text) setAdvice(d.content[0].text);
      else setErr("Failed to generate analysis.");
      setLoading(false);
    }).catch(()=>{setErr("Connection error.");setLoading(false);});
  },[]);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:1000,
      display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem",backdropFilter:"blur(14px)"}}>
      <div style={{background:"#090909",border:"1px solid rgba(232,255,71,0.2)",borderRadius:"16px",
        padding:"1.75rem",maxWidth:560,width:"100%",maxHeight:"84vh",overflowY:"auto",position:"relative",
        boxShadow:"0 0 80px rgba(232,255,71,0.04)"}}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:1,
          background:"linear-gradient(90deg,transparent,#E8FF47,transparent)"}}/>
        <button onClick={onClose} style={{position:"absolute",top:"1rem",right:"1rem",
          background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",
          color:"rgba(255,255,255,0.4)",borderRadius:"6px",width:28,height:28,cursor:"pointer",
          fontSize:15,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        <div style={{display:"flex",alignItems:"center",gap:"0.875rem",marginBottom:"1.5rem"}}>
          <div style={{width:38,height:38,borderRadius:"9px",background:"rgba(232,255,71,0.08)",
            border:"1px solid rgba(232,255,71,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🤖</div>
          <div>
            <div style={{fontWeight:700,fontSize:"0.82rem",color:"#E8FF47",letterSpacing:"0.12em"}}>AI FINANCIAL ANALYSIS</div>
            <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.65rem",letterSpacing:"0.1em"}}>CLAUDE \u00b7 ADVISOR</div>
          </div>
        </div>
        {loading?(<div style={{textAlign:"center",padding:"3rem 0"}}>
          <div style={{width:40,height:40,border:"2px solid rgba(232,255,71,0.1)",borderTop:"2px solid #E8FF47",
            borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto 1rem"}}/>
          <div style={{color:"rgba(255,255,255,0.25)",fontSize:"0.72rem",letterSpacing:"0.15em"}}>ANALYSING...</div>
        </div>):err?(
          <div style={{color:"#FF4757",textAlign:"center",padding:"2rem",fontSize:"0.85rem"}}>{err}</div>
        ):(
          <div style={{color:"rgba(255,255,255,0.82)",lineHeight:1.8,fontSize:"0.875rem",whiteSpace:"pre-wrap"}}>{advice}</div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEEKLY TAB
// ─────────────────────────────────────────────────────────────────────────────
function WeeklyTab({subs,expenses,income}) {
  const [selWeek,setSelWeek]=useState(getWeekKey());
  const [entries,setEntries]=useState([]);
  const [loadingW,setLoadingW]=useState(false);
  const [showAddEntry,setShowAddEntry]=useState(false);
  const [newEntry,setNewEntry]=useState({label:"",amount:"",note:""});
  const [entryPayDate,setEntryPayDate]=useState(null);
  const [saving,setSaving]=useState(false);

  const weekKeys = Array.from({length:8},(_,i)=>{
    const d=new Date(); d.setDate(d.getDate()-i*7); return getWeekKey(d);
  });

  // Load entries for selected week
  const loadEntries = useCallback(async () => {
    setLoadingW(true);
    try {
      if (DB_READY) {
        const rows = await sb.select("weekly_entries", `week_key=eq.${selWeek}&order=created_at.asc`);
        setEntries(rows);
      } else {
        const all = LS.get("fm_weeklyLog",{});
        setEntries((all[selWeek]||{expenses:[]}).expenses);
      }
    } catch(e) { console.error(e); }
    setLoadingW(false);
  },[selWeek]);

  useEffect(()=>{ loadEntries(); },[loadEntries]);

  const addEntry = async () => {
    if(!newEntry.label||!newEntry.amount) return;
    setSaving(true);
    const payload = {
      week_key: selWeek,
      label: newEntry.label,
      amount: parseFloat(newEntry.amount),
      note: newEntry.note||null,
      paid_date: entryPayDate?.date || nowDate(),
      paid_time: entryPayDate?.time || nowTime(),
    };
    try {
      if (DB_READY) {
        const [row] = await sb.insert("weekly_entries", payload);
        setEntries(p=>[...p, row]);
      } else {
        const row = {...payload, id:Date.now()};
        const all = LS.get("fm_weeklyLog",{});
        const updated = {...all,[selWeek]:{expenses:[...(all[selWeek]?.expenses||[]),row]}};
        LS.set("fm_weeklyLog",updated);
        setEntries(p=>[...p,row]);
      }
    } catch(e){console.error(e);}
    setNewEntry({label:"",amount:"",note:""});
    setEntryPayDate(null);
    setShowAddEntry(false);
    setSaving(false);
  };

  const removeEntry = async (id) => {
    try {
      if (DB_READY) {
        await sb.delete("weekly_entries", id);
      } else {
        const all = LS.get("fm_weeklyLog",{});
        const updated = {...all,[selWeek]:{expenses:(all[selWeek]?.expenses||[]).filter(e=>e.id!==id)}};
        LS.set("fm_weeklyLog",updated);
      }
      setEntries(p=>p.filter(e=>e.id!==id));
    } catch(e){console.error(e);}
  };

  const weekExpTotal = entries.reduce((s,e)=>s+parseFloat(e.amount||0),0);
  const weekSubsTotal = subs.reduce((s,x)=>s+parseFloat(x.amount||0),0);
  const weekTotal = weekExpTotal + weekSubsTotal;
  const weekBalance = income - weekTotal;

  const inp={width:"100%",background:"#111",border:"1px solid rgba(255,255,255,0.08)",
    borderRadius:"8px",color:"#fff",padding:"0.7rem 0.875rem",fontSize:"0.88rem",
    fontFamily:"'DM Mono',monospace"};
  const lbl={color:"rgba(255,255,255,0.25)",fontSize:"0.62rem",letterSpacing:"0.15em",
    display:"block",marginBottom:"0.3rem",textTransform:"uppercase"};

  return (
    <div style={{animation:"fadeUp .32s ease both"}}>
      {/* week pills */}
      <div style={{display:"flex",gap:"0.4rem",overflowX:"auto",paddingBottom:"0.5rem",marginBottom:"1rem",scrollbarWidth:"none"}}>
        {weekKeys.map((wk,i)=>(
          <button key={wk} onClick={()=>setSelWeek(wk)} style={{
            flexShrink:0,padding:"0.45rem 0.875rem",border:"1px solid",borderRadius:"8px",
            cursor:"pointer",fontSize:"0.65rem",fontWeight:600,letterSpacing:"0.1em",
            fontFamily:"'DM Mono',monospace",transition:"all .15s",
            background:selWeek===wk?"#E8FF47":"#0c0c0c",
            borderColor:selWeek===wk?"#E8FF47":"rgba(255,255,255,0.07)",
            color:selWeek===wk?"#080808":"rgba(255,255,255,0.35)",
          }}>{i===0?"THIS WEEK":i===1?"LAST WEEK":`-${i}W`}</button>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1rem"}}>
        <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.62rem",letterSpacing:"0.14em",fontFamily:"'DM Mono',monospace"}}>
          {weekLabel(selWeek)}
        </div>
        {DB_READY&&(
          <div style={{display:"flex",alignItems:"center",gap:"0.4rem",
            color:"#2ED573",fontSize:"0.58rem",letterSpacing:"0.1em"}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:"#2ED573",boxShadow:"0 0 4px #2ED573"}}/>
            SUPABASE
          </div>
        )}
      </div>

      {/* summary */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"0.5rem",marginBottom:"1rem"}}>
        {[
          {l:"DIRECT DEBITS",v:weekSubsTotal,c:"#A29BFE"},
          {l:"EXPENSES",v:weekExpTotal,c:"#FF4757"},
          {l:"BALANCE",v:weekBalance,c:weekBalance>=0?"#2ED573":"#FF4757"},
        ].map(s=>(
          <Tilt key={s.l}>
            <div style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
              borderRadius:"12px",padding:"0.875rem",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1.5,
                background:`linear-gradient(90deg,transparent,${s.c}55,transparent)`}}/>
              <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.55rem",letterSpacing:"0.12em",marginBottom:"0.35rem"}}>{s.l}</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontWeight:500,fontSize:"0.9rem",color:s.c}}>{fmt(s.v)}</div>
            </div>
          </Tilt>
        ))}
      </div>

      {/* direct debits */}
      <div style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
        borderRadius:"12px",marginBottom:"0.75rem",overflow:"hidden"}}>
        <div style={{padding:"0.7rem 1rem",borderBottom:"1px solid rgba(255,255,255,0.04)",
          display:"flex",justifyContent:"space-between"}}>
          <span style={{color:"rgba(255,255,255,0.25)",fontSize:"0.6rem",letterSpacing:"0.14em"}}>DIRECT DEBITS</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:"0.7rem",color:"#A29BFE"}}>{fmt(weekSubsTotal)}</span>
        </div>
        {subs.length===0?(
          <div style={{padding:"1rem",color:"rgba(255,255,255,0.1)",fontSize:"0.7rem",textAlign:"center"}}>NONE</div>
        ):subs.map((sub,i)=>(
          <div key={sub.id} style={{display:"flex",alignItems:"center",gap:"0.75rem",
            padding:"0.6rem 1rem",borderBottom:i<subs.length-1?"1px solid rgba(255,255,255,0.03)":"none"}}>
            <div style={{width:26,height:26,borderRadius:"6px",overflow:"hidden",flexShrink:0,
              background:"rgba(255,255,255,0.04)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <img src={getLogoUrl(sub.title)} style={{width:"100%",objectFit:"contain",padding:3}} alt=""
                onError={e=>e.target.style.display="none"}/>
            </div>
            <div style={{flex:1,fontSize:"0.8rem",color:"rgba(255,255,255,0.55)"}}>{sub.title}</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:"0.78rem",color:"rgba(255,255,255,0.3)"}}>{fmt(sub.amount)}</div>
          </div>
        ))}
      </div>

      {/* entries header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.625rem"}}>
        <div style={{color:"rgba(255,255,255,0.18)",fontSize:"0.6rem",letterSpacing:"0.15em",fontFamily:"'DM Mono',monospace"}}>
          {entries.length} ENTRIES \u00b7 {fmt(weekExpTotal)}
        </div>
        <button onClick={()=>setShowAddEntry(true)} style={{
          background:"#FF4757",border:"none",borderRadius:"7px",color:"#fff",
          padding:"0.4rem 0.8rem",cursor:"pointer",fontWeight:700,fontSize:"0.68rem",letterSpacing:"0.1em",
        }}>+ ADD</button>
      </div>

      {loadingW?(
        <div style={{textAlign:"center",padding:"2rem 0"}}>
          <div style={{width:28,height:28,border:"2px solid rgba(232,255,71,0.1)",borderTop:"2px solid #E8FF47",
            borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto"}}/>
        </div>
      ):(
        <div style={{display:"grid",gap:"0.4rem"}}>
          {entries.length===0?(
            <div style={{textAlign:"center",padding:"2rem 0",color:"rgba(255,255,255,0.1)",
              fontSize:"0.68rem",letterSpacing:"0.15em"}}>NO ENTRIES THIS WEEK</div>
          ):entries.map((e,i)=>(
            <div key={e.id} style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
              borderRadius:"10px",padding:"0.7rem 0.875rem",
              display:"flex",alignItems:"center",gap:"0.75rem",
              animation:`fadeUp .28s ease ${i*.04}s both`,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",left:0,top:"18%",bottom:"18%",width:2,
                borderRadius:"0 2px 2px 0",background:"#FF4757"}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:500,fontSize:"0.85rem"}}>{e.label}</div>
                <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.62rem",fontFamily:"'DM Mono',monospace",marginTop:2}}>
                  {e.paid_date||e.date}{(e.paid_time||e.time)?` \u00b7 ${e.paid_time||e.time}`:""}
                  {e.note?<span style={{color:"rgba(255,255,255,0.18)",fontStyle:"italic"}}> \u00b7 {e.note}</span>:null}
                </div>
              </div>
              <div style={{fontFamily:"'DM Mono',monospace",fontWeight:500,fontSize:"0.88rem",color:"#FF4757",flexShrink:0}}>
                {fmt(e.amount)}
              </div>
              <button onClick={()=>removeEntry(e.id)} style={{
                background:"rgba(255,71,87,.06)",border:"1px solid rgba(255,71,87,.12)",
                borderRadius:"6px",color:"rgba(255,71,87,.5)",
                width:24,height:24,cursor:"pointer",fontSize:"0.78rem",
                display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
              }}>×</button>
            </div>
          ))}
        </div>
      )}

      {(entries.length>0||subs.length>0)&&(
        <div style={{marginTop:"0.875rem",padding:"0.875rem 1rem",
          background:"rgba(232,255,71,0.04)",border:"1px solid rgba(232,255,71,0.1)",
          borderRadius:"10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{color:"rgba(255,255,255,0.3)",fontSize:"0.65rem",letterSpacing:"0.14em"}}>WEEK TOTAL</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontWeight:600,fontSize:"1rem",
            color:weekBalance>=0?"#E8FF47":"#FF4757"}}>{fmt(weekTotal)}</span>
        </div>
      )}

      {/* add entry modal */}
      {showAddEntry&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:700,
          display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(14px)",padding:"1rem"}}>
          <div style={{background:"#090909",border:"1px solid rgba(255,255,255,0.09)",borderRadius:"16px",
            padding:"1.5rem",maxWidth:360,width:"100%",animation:"popIn .22s ease both",
            maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.1rem"}}>
              <div>
                <span style={{color:"rgba(255,255,255,0.22)",fontSize:"0.62rem",letterSpacing:"0.18em"}}>NEW EXPENSE</span>
                <div style={{color:"rgba(255,255,255,0.14)",fontSize:"0.58rem",fontFamily:"'DM Mono',monospace",marginTop:2}}>{weekLabel(selWeek)}</div>
              </div>
              <button onClick={()=>{setShowAddEntry(false);setEntryPayDate(null);}} style={{background:"none",border:"none",
                color:"rgba(255,255,255,0.28)",cursor:"pointer",fontSize:17,padding:0}}>×</button>
            </div>
            <DateTimePicker value={entryPayDate} onChange={setEntryPayDate}/>
            {[
              {l:"DESCRIPTION",k:"label",p:"Groceries, Transport...",t:"text"},
              {l:"AMOUNT \u00a3",k:"amount",p:"0.00",t:"number"},
              {l:"NOTE (optional)",k:"note",p:"e.g. Tesco, Oyster...",t:"text"},
            ].map(f=>(
              <div key={f.k} style={{marginBottom:"0.75rem"}}>
                <label style={lbl}>{f.l}</label>
                <input type={f.t} placeholder={f.p} value={newEntry[f.k]}
                  onChange={e=>setNewEntry(p=>({...p,[f.k]:e.target.value}))}
                  onKeyDown={e=>e.key==="Enter"&&addEntry()} style={inp}/>
              </div>
            ))}
            <div style={{display:"flex",gap:"0.45rem"}}>
              <button onClick={()=>{setShowAddEntry(false);setEntryPayDate(null);}} style={{flex:1,padding:"0.65rem",
                background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",
                borderRadius:"8px",color:"rgba(255,255,255,0.35)",cursor:"pointer",fontSize:"0.72rem",letterSpacing:"0.1em"}}>CANCEL</button>
              <button onClick={addEntry} disabled={saving} style={{flex:1,padding:"0.65rem",background:"#FF4757",
                border:"none",borderRadius:"8px",color:"#fff",cursor:"pointer",
                fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em",opacity:saving?0.6:1}}>
                {saving?"SAVING...":"ADD"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
function FinanceApp({ user, onSignOut }) {
  const [subs,setSubs]           = useState([]);
  const [expenses,setExpenses]   = useState([]);
  const [income,setIncome]       = useState(600);
  const [loading,setLoading]     = useState(true);
  const [showAdd,setShowAdd]     = useState(false);
  const [showAddExp,setShowAddExp] = useState(false);
  const [showAI,setShowAI]       = useState(false);
  const [histId,setHistId]       = useState(null);
  const [newSub,setNewSub]       = useState({title:"",amount:""});
  const [newExp,setNewExp]       = useState({label:"",amount:""});
  const [subPayDate,setSubPayDate] = useState(null);
  const [expPayDate,setExpPayDate] = useState(null);
  const [editInc,setEditInc]     = useState(false);
  const [tab,setTab]             = useState("subs");
  const [topTab,setTopTab]       = useState("mine");
  const [paidAnim,setPaidAnim]   = useState({});
  const [savingInc,setSavingInc]           = useState(false);
  const [couple,setCouple]                 = useState(null);
  const [showInvite,setShowInvite]         = useState(false);
  const [partnerEnabled,setPartnerEnabled] = useState(()=>LS.get("fm_partnerEnabled",false));
  const [partnerName,setPartnerName]       = useState(()=>LS.get("fm_partnerName","Fiancée"));
  const [partnerIncome,setPartnerIncome]   = useState(()=>LS.get("fm_partnerIncome",0));
  const [editPartner,setEditPartner]       = useState(false);
  const [editPartnerName,setEditPartnerName] = useState(false);

  // ── LOAD ALL DATA ───────────────────────────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        if (DB_READY) {
          const [subsRows, expRows, settingRows] = await Promise.all([
            sb.select("subscriptions","order=created_at.asc"),
            sb.select("expenses","order=created_at.asc"),
            sb.select("settings","key=eq.income"),
          ]);
          // fetch payment history for each sub
          const payments = await sb.select("sub_payments","order=created_at.desc");
          const subsWithHistory = subsRows.map(s=>({
            ...s,
            ci: s.ci ?? 0,
            logoErr: s.logo_err ?? false,
            history: payments.filter(p=>p.sub_id===s.id).map(p=>({date:p.paid_date,time:p.paid_time})),
          }));
          setSubs(subsWithHistory);
          setExpenses(expRows);
          if(settingRows.length>0) setIncome(parseFloat(settingRows[0].value)||600);
          // partner settings
          const [peName,peVal,peEnabled] = await Promise.all([
            sb.select("settings","key=eq.partnerName"),
            sb.select("settings","key=eq.partnerIncome"),
            sb.select("settings","key=eq.partnerEnabled"),
          ]);
          if(peName.length>0) setPartnerName(peName[0].value);
          if(peVal.length>0)  setPartnerIncome(parseFloat(peVal[0].value)||0);
          if(peEnabled.length>0) setPartnerEnabled(peEnabled[0].value==="true");
          const c = await coupleApi.getOrCreate(user.id);
          setCouple(c);
        } else {
          setSubs(LS.get("fm_subs",[
            {id:1,title:"Netflix",amount:"17.99",ci:0,history:[],logoErr:false},
            {id:2,title:"Spotify",amount:"11.99",ci:2,history:[],logoErr:false},
          ]));
          setExpenses(LS.get("fm_expenses",[
            {id:1,label:"Groceries",amount:"80"},
            {id:2,label:"Transport",amount:"40"},
          ]));
          setIncome(LS.get("fm_income",600));
        }
      } catch(e){ console.error("Load error:",e); }
      setLoading(false);
    })();
  },[]);

  // ── PERSIST income ──────────────────────────────────────────────────────────
  const saveIncome = async (val) => {
    setSavingInc(true);
    try {
      if (DB_READY) {
        await sb.upsert("settings",{key:"income",value:String(val)});
      } else {
        LS.set("fm_income",val);
      }
      const uname = user?.user_metadata?.full_name||user?.email?.split("@")[0]||"User";
      coupleApi.log(couple?.id,user?.id,uname,"income",`${GBP}${parseFloat(val).toFixed(2)}`,val);
    } catch(e){console.error(e);}
    setSavingInc(false);
  };

  // ── SAVE PARTNER
  const savePartner = (name, val, enabled) => {
    LS.set("fm_partnerEnabled", enabled);
    LS.set("fm_partnerName", name);
    LS.set("fm_partnerIncome", val);
    if (DB_READY) {
      sb.upsert("settings",{key:"partnerEnabled",value:String(enabled)}).catch(()=>{});
      sb.upsert("settings",{key:"partnerName",value:name}).catch(()=>{});
      sb.upsert("settings",{key:"partnerIncome",value:String(val)}).catch(()=>{});
    }
  };

  // ── ADD SUBSCRIPTION ────────────────────────────────────────────────────────
  const addSub = async () => {
    if(!newSub.title||!newSub.amount) return;
    try {
      const payload = {title:newSub.title, amount:parseFloat(newSub.amount),
        ci:subs.length%ACCENTS.length, logo_err:false};
      if (DB_READY) {
        const [row] = await sb.insert("subscriptions", payload);
        let history = [];
        if (subPayDate) {
          const [prow] = await sb.insert("sub_payments",{sub_id:row.id,paid_date:subPayDate.date,paid_time:subPayDate.time});
          history = [{date:prow.paid_date,time:prow.paid_time}];
        }
        setSubs(p=>[...p,{...row,logoErr:false,history}]);
        const uname=user?.user_metadata?.full_name||user?.email?.split("@")[0]||"User";
        coupleApi.log(couple?.id,user?.id,uname,"subscription",newSub.title,parseFloat(newSub.amount));
      } else {
        const row = {...payload,id:Date.now(),history:subPayDate?[{date:subPayDate.date,time:subPayDate.time}]:[],logoErr:false};
        const updated = [...subs,row];
        setSubs(updated); LS.set("fm_subs",updated);
      }
    } catch(e){console.error(e);}
    setNewSub({title:"",amount:""}); setSubPayDate(null); setShowAdd(false);
  };

  // ── MARK PAID ───────────────────────────────────────────────────────────────
  const markPaid = async (id) => {
    const d = nowDate(), t = nowTime();
    try {
      if (DB_READY) {
        await sb.insert("sub_payments",{sub_id:id,paid_date:d,paid_time:t});
      }
      setSubs(p=>p.map(s=>s.id===id?{...s,history:[{date:d,time:t},...s.history]}:s));
      const pSub=subs.find(s=>s.id===id);
      const pname=user?.user_metadata?.full_name||user?.email?.split("@")[0]||"User";
      coupleApi.log(couple?.id,user?.id,pname,"payment",pSub?.title||"subscription",pSub?.amount);
      if (!DB_READY) LS.set("fm_subs",subs.map(s=>s.id===id?{...s,history:[{date:d,time:t},...s.history]}:s));
    } catch(e){console.error(e);}
    setPaidAnim(p=>({...p,[id]:true}));
    setTimeout(()=>setPaidAnim(p=>({...p,[id]:false})),900);
  };

  // ── DELETE SUBSCRIPTION ─────────────────────────────────────────────────────
  const removeSub = async (id) => {
    try {
      if (DB_READY) await sb.delete("subscriptions",id);
      const updated = subs.filter(s=>s.id!==id);
      setSubs(updated);
      if (!DB_READY) LS.set("fm_subs",updated);
    } catch(e){console.error(e);}
  };

  // ── ADD EXPENSE ─────────────────────────────────────────────────────────────
  const addExp = async () => {
    if(!newExp.label||!newExp.amount) return;
    const payload = {
      label:newExp.label, amount:parseFloat(newExp.amount),
      paid_date:expPayDate?.date||null, paid_time:expPayDate?.time||null,
    };
    try {
      if (DB_READY) {
        const [row] = await sb.insert("expenses", payload);
        setExpenses(p=>[...p,row]);
        const ename=user?.user_metadata?.full_name||user?.email?.split("@")[0]||"User";
        coupleApi.log(couple?.id,user?.id,ename,"expense",newExp.label,parseFloat(newExp.amount));
      } else {
        const row = {...payload,id:Date.now()};
        const updated = [...expenses,row];
        setExpenses(updated); LS.set("fm_expenses",updated);
      }
    } catch(e){console.error(e);}
    setNewExp({label:"",amount:""}); setExpPayDate(null); setShowAddExp(false);
  };

  // ── DELETE EXPENSE ──────────────────────────────────────────────────────────
  const removeExp = async (id) => {
    try {
      if (DB_READY) await sb.delete("expenses",id);
      const updated = expenses.filter(e=>e.id!==id);
      setExpenses(updated);
      if (!DB_READY) LS.set("fm_expenses",updated);
    } catch(e){console.error(e);}
  };

  const histSub    = subs.find(s=>s.id===histId);
  const myName     = user?.user_metadata?.full_name||user?.email?.split("@")[0]||"Me";
  const herName    = couple?.partner_name||partnerName||"Partner";
  const totalSubs  = subs.reduce((s,x)=>s+parseFloat(x.amount||0),0);
  const totalExp   = expenses.reduce((s,x)=>s+parseFloat(x.amount||0),0);
  const totalOut   = totalSubs+totalExp;
  const totalIncome = income + (partnerEnabled ? partnerIncome : 0);
  const balance    = totalIncome-totalOut;
  const pct        = totalIncome>0?Math.min((totalOut/totalIncome)*100,100).toFixed(0):0;

  const inp={width:"100%",background:"#111",border:"1px solid rgba(255,255,255,0.08)",
    borderRadius:"8px",color:"#fff",padding:"0.7rem 0.875rem",fontSize:"0.88rem",
    fontFamily:"'DM Mono',monospace"};
  const lbl={color:"rgba(255,255,255,0.25)",fontSize:"0.62rem",letterSpacing:"0.15em",
    display:"block",marginBottom:"0.3rem",textTransform:"uppercase"};

  const TABS=[
    {k:"subs",    l:"\u25a3  DIRECT DEBITS"},
    {k:"weekly",  l:"\u25eb  WEEKLY"},
    {k:"expenses",l:"\u25c8  EXPENSES"},
    {k:"overview",l:"\u25c9  OVERVIEW"},
  ];

  return (
    <div style={{minHeight:"100vh",background:"#070707",
      fontFamily:"'DM Sans','Helvetica Neue',sans-serif",color:"#fff",
      position:"relative",overflowX:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap');
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        @keyframes popIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
        @keyframes paidPop{0%{transform:scale(1)}35%{transform:scale(1.2)}100%{transform:scale(1)}}
        @keyframes scanline{0%{top:-2px}100%{top:100vh}}
        @keyframes blink{0%,100%{opacity:.8}50%{opacity:.2}}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-thumb{background:rgba(232,255,71,.15);border-radius:2px}
        *{box-sizing:border-box} input,button{outline:none;font-family:inherit}
        input::placeholder{color:rgba(255,255,255,.18)}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
        input[type=date],input[type=time]{color-scheme:dark}
      `}</style>

      {!DB_READY && <SetupBanner/>}

      <div style={{position:"fixed",left:0,right:0,height:3,zIndex:0,pointerEvents:"none",
        background:"linear-gradient(transparent,rgba(232,255,71,0.025),transparent)",
        animation:"scanline 10s linear infinite"}}/>
      <div style={{position:"fixed",inset:0,zIndex:0,pointerEvents:"none",
        backgroundImage:"linear-gradient(rgba(232,255,71,0.016) 1px,transparent 1px),linear-gradient(90deg,rgba(232,255,71,0.016) 1px,transparent 1px)",
        backgroundSize:"52px 52px"}}/>
      <ParticleCanvas/>

      <div style={{position:"relative",zIndex:1,maxWidth:840,margin:"0 auto",padding:"1.25rem 1rem 6rem"}}>

        {/* loading skeleton */}
        {loading&&(
          <div style={{textAlign:"center",padding:"4rem 0"}}>
            <div style={{width:36,height:36,border:"2px solid rgba(232,255,71,0.1)",borderTop:"2px solid #E8FF47",
              borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto 1rem"}}/>
            <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.7rem",letterSpacing:"0.15em"}}>LOADING...</div>
          </div>
        )}

        {!loading&&(<>

        {/* ── USER BAR ────────────────────────────────────────────────────── */}
        <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",
          gap:"0.625rem",marginBottom:"0.875rem",animation:"fadeUp .35s ease both"}}>
          <div style={{display:"flex",alignItems:"center",gap:"0.5rem",
            background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",
            borderRadius:"20px",padding:"0.35rem 0.75rem 0.35rem 0.45rem"}}>
            <div style={{width:22,height:22,borderRadius:"50%",overflow:"hidden",flexShrink:0,
              background:"linear-gradient(135deg,#E8FF47,#A8C000)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.65rem",fontWeight:700,color:"#080808"}}>
              {user?.user_metadata?.avatar_url
                ? <img src={user.user_metadata.avatar_url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt=""/>
                : (user?.email||"?")[0].toUpperCase()
              }
            </div>
            <span style={{color:"rgba(255,255,255,0.45)",fontSize:"0.65rem",fontFamily:"'DM Mono',monospace",
              maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {user?.user_metadata?.full_name || user?.email || "User"}
            </span>
          </div>
          <div style={{display:"flex",gap:"0.4rem"}}>
            <button onClick={()=>setShowInvite(true)} style={{
              background:"rgba(255,105,180,0.08)",border:"1px solid rgba(255,105,180,0.25)",
              borderRadius:"8px",color:"#FF69B4",
              padding:"0.35rem 0.65rem",cursor:"pointer",fontSize:"0.65rem",
              letterSpacing:"0.1em",transition:"all .15s",
            }}
              onMouseOver={e=>e.currentTarget.style.background="rgba(255,105,180,0.18)"}
              onMouseOut={e=>e.currentTarget.style.background="rgba(255,105,180,0.08)"}
            >♥ INVITE</button>
            <button onClick={onSignOut} style={{
              background:"rgba(255,71,87,0.08)",border:"1px solid rgba(255,71,87,0.2)",
              borderRadius:"8px",color:"rgba(255,71,87,0.7)",
              padding:"0.35rem 0.65rem",cursor:"pointer",fontSize:"0.65rem",
              letterSpacing:"0.1em",transition:"all .15s",
            }}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(255,71,87,0.15)";e.currentTarget.style.color="#FF4757";}}
              onMouseOut={e=>{e.currentTarget.style.background="rgba(255,71,87,0.08)";e.currentTarget.style.color="rgba(255,71,87,0.7)";}}
            >SIGN OUT</button>
          </div>
        </div>

        {/* ── INCOME ──────────────────────────────────────────────────────── */}
        <Tilt style={{marginBottom:"1.1rem",animation:"fadeUp .45s ease both"}}>
          <div style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.065)",
            borderRadius:"14px",padding:"1.25rem 1.5rem",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:1.5,
              background:"linear-gradient(90deg,transparent,rgba(232,255,71,0.7),transparent)"}}/>
            <div style={{position:"absolute",top:-50,right:-30,width:180,height:180,
              background:"radial-gradient(circle,rgba(232,255,71,0.03) 0%,transparent 70%)",borderRadius:"50%"}}/>

            {/* -- top row: my income + partner toggle + stats -- */}
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:"0.875rem"}}>

              {/* MY INCOME */}
              <div>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",marginBottom:"0.2rem"}}>
                  <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.6rem",letterSpacing:"0.2em"}}>MY WEEKLY</div>
                  {DB_READY&&(
                    <div style={{display:"flex",alignItems:"center",gap:"0.3rem",color:"#2ED573",fontSize:"0.55rem",letterSpacing:"0.1em"}}>
                      <div style={{width:4,height:4,borderRadius:"50%",background:"#2ED573",boxShadow:"0 0 4px #2ED573"}}/>
                      SUPABASE
                    </div>
                  )}
                </div>
                {editInc?(
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    <span style={{color:"rgba(255,255,255,0.25)",fontFamily:"'DM Mono',monospace",fontSize:"1.1rem"}}>{GBP}</span>
                    <input type="number" value={income} autoFocus
                      onChange={e=>setIncome(parseFloat(e.target.value)||0)}
                      onBlur={()=>{ setEditInc(false); saveIncome(income); }}
                      onKeyDown={e=>{ if(e.key==="Enter"){ setEditInc(false); saveIncome(income); }}}
                      style={{background:"transparent",border:"none",borderBottom:"1.5px solid #E8FF47",
                        color:"#fff",fontSize:"2.1rem",fontWeight:600,width:130,
                        fontFamily:"'DM Mono',monospace",padding:"0 0 2px"}}/>
                    {savingInc&&<span style={{color:"rgba(232,255,71,0.5)",fontSize:"0.65rem"}}>saving...</span>}
                  </div>
                ):(
                  <div onClick={()=>setEditInc(true)} style={{cursor:"pointer",display:"flex",alignItems:"baseline",gap:3}}>
                    <span style={{color:"rgba(255,255,255,0.22)",fontFamily:"'DM Mono',monospace",fontSize:"0.95rem"}}>{GBP}</span>
                    <span style={{fontSize:"2.1rem",fontWeight:600,letterSpacing:"-0.02em",fontFamily:"'DM Mono',monospace"}}>
                      {income.toFixed(2)}
                    </span>
                    <span style={{color:"rgba(255,255,255,0.12)",fontSize:"0.72rem",marginLeft:4}}>\u270e</span>
                  </div>
                )}
              </div>

              {/* PARTNER INCOME */}
              <div style={{flex:1,minWidth:160}}>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",marginBottom:"0.3rem"}}>
                  {/* toggle */}
                  <div onClick={()=>{
                    const next=!partnerEnabled;
                    setPartnerEnabled(next);
                    savePartner(partnerName,partnerIncome,next);
                  }} style={{
                    width:32,height:18,borderRadius:9,cursor:"pointer",
                    background:partnerEnabled?"#E8FF47":"rgba(255,255,255,0.08)",
                    border:`1px solid ${partnerEnabled?"#E8FF47":"rgba(255,255,255,0.12)"}`,
                    position:"relative",transition:"all .2s",flexShrink:0,
                  }}>
                    <div style={{
                      position:"absolute",top:2,
                      left:partnerEnabled?14:2,
                      width:12,height:12,borderRadius:"50%",
                      background:partnerEnabled?"#080808":"rgba(255,255,255,0.35)",
                      transition:"left .2s",
                    }}/>
                  </div>
                  {/* editable name */}
                  {editPartnerName?(
                    <input autoFocus value={partnerName}
                      onChange={e=>setPartnerName(e.target.value)}
                      onBlur={()=>{setEditPartnerName(false);savePartner(partnerName,partnerIncome,partnerEnabled);}}
                      onKeyDown={e=>e.key==="Enter"&&(setEditPartnerName(false),savePartner(partnerName,partnerIncome,partnerEnabled))}
                      style={{background:"transparent",border:"none",borderBottom:"1px solid rgba(255,105,180,0.6)",
                        color:"#FF69B4",fontSize:"0.6rem",letterSpacing:"0.15em",width:80,
                        fontFamily:"'DM Mono',monospace",textTransform:"uppercase",padding:"0 0 1px"}}/>
                  ):(
                    <span onClick={()=>partnerEnabled&&setEditPartnerName(true)}
                      style={{color:"rgba(255,105,180,0.7)",fontSize:"0.6rem",letterSpacing:"0.15em",
                        cursor:partnerEnabled?"pointer":"default",
                        borderBottom:partnerEnabled?"1px dashed rgba(255,105,180,0.25)":"none"}}>
                      {partnerName.toUpperCase()}
                    </span>
                  )}
                </div>

                {partnerEnabled?(
                  editPartner?(
                    <div style={{display:"flex",alignItems:"center",gap:3}}>
                      <span style={{color:"rgba(255,105,180,0.5)",fontFamily:"'DM Mono',monospace",fontSize:"0.9rem"}}>{GBP}</span>
                      <input type="number" value={partnerIncome} autoFocus
                        onChange={e=>setPartnerIncome(parseFloat(e.target.value)||0)}
                        onBlur={()=>{setEditPartner(false);savePartner(partnerName,partnerIncome,partnerEnabled);}}
                        onKeyDown={e=>e.key==="Enter"&&(setEditPartner(false),savePartner(partnerName,partnerIncome,partnerEnabled))}
                        style={{background:"transparent",border:"none",borderBottom:"1.5px solid #FF69B4",
                          color:"#FF69B4",fontSize:"1.6rem",fontWeight:600,width:120,
                          fontFamily:"'DM Mono',monospace",padding:"0 0 2px"}}/>
                    </div>
                  ):(
                    <div onClick={()=>setEditPartner(true)} style={{cursor:"pointer",display:"flex",alignItems:"baseline",gap:3}}>
                      <span style={{color:"rgba(255,105,180,0.4)",fontFamily:"'DM Mono',monospace",fontSize:"0.9rem"}}>{GBP}</span>
                      <span style={{fontSize:"1.6rem",fontWeight:600,letterSpacing:"-0.02em",fontFamily:"'DM Mono',monospace",color:"#FF69B4"}}>
                        {partnerIncome.toFixed(2)}
                      </span>
                      <span style={{color:"rgba(255,105,180,0.2)",fontSize:"0.72rem",marginLeft:4}}>\u270e</span>
                    </div>
                  )
                ):(
                  <div style={{color:"rgba(255,255,255,0.1)",fontSize:"0.72rem",fontFamily:"'DM Mono',monospace",marginTop:4}}>
                    toggle to add
                  </div>
                )}
              </div>

              {/* STATS */}
              <div style={{display:"flex",gap:"0.625rem",flexWrap:"wrap"}}>
                {[
                  {l:"OUT",    v:fmt(totalOut),  c:"#FF4757"},
                  {l:"BALANCE",v:fmt(balance),   c:balance>=0?"#2ED573":"#FF4757"},
                  {l:"SAVED",  v:`${totalIncome>0?((balance/totalIncome)*100).toFixed(0):0}%`, c:"#E8FF47"},
                ].map(s=>(
                  <div key={s.l} style={{background:"#111",border:"1px solid rgba(255,255,255,0.055)",
                    borderRadius:"9px",padding:"0.6rem 0.875rem",textAlign:"center",minWidth:78}}>
                    <div style={{color:s.c,fontWeight:500,fontSize:"0.92rem",fontFamily:"'DM Mono',monospace"}}>{s.v}</div>
                    <div style={{color:"rgba(255,255,255,0.18)",fontSize:"0.58rem",letterSpacing:"0.1em",marginTop:2}}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* combined income row */}
            {partnerEnabled&&(
              <div style={{marginTop:"0.875rem",padding:"0.6rem 0.875rem",
                background:"rgba(255,105,180,0.04)",border:"1px solid rgba(255,105,180,0.12)",
                borderRadius:"8px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem"}}>
                  <span style={{fontSize:"0.85rem"}}>\u2665</span>
                  <span style={{color:"rgba(255,255,255,0.3)",fontSize:"0.62rem",letterSpacing:"0.12em"}}>COMBINED WEEKLY</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:"1rem"}}>
                  <span style={{color:"rgba(255,255,255,0.2)",fontSize:"0.65rem",fontFamily:"'DM Mono',monospace"}}>
                    {fmt(income)} + {fmt(partnerIncome)}
                  </span>
                  <span style={{fontFamily:"'DM Mono',monospace",fontWeight:600,fontSize:"1rem",color:"#FF69B4"}}>
                    {fmt(totalIncome)}
                  </span>
                </div>
              </div>
            )}

            <div style={{marginTop:"1rem"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.28rem"}}>
                <span style={{color:"rgba(255,255,255,0.18)",fontSize:"0.6rem",letterSpacing:"0.12em"}}>COMMITTED</span>
                <span style={{color:pct>80?"#FF4757":pct>60?"#FFA502":"#E8FF47",
                  fontSize:"0.6rem",fontFamily:"'DM Mono',monospace"}}>{pct}%</span>
              </div>
              <div style={{height:3.5,background:"rgba(255,255,255,0.05)",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:2,
                  background:pct>80?"linear-gradient(90deg,#FF4757,#FF6B81)":
                              pct>60?"linear-gradient(90deg,#FFA502,#FFD32A)":
                              "linear-gradient(90deg,#E8FF47,#C8E600)",
                  width:`${pct}%`,transition:"width .7s cubic-bezier(.34,1.56,.64,1)",
                  boxShadow:pct>80?"0 0 6px #FF475788":"0 0 6px rgba(232,255,71,.5)"}}/>
              </div>
            </div>
          </div>
        </Tilt>

        {/* TOP TABS: Meu / Dela / Juntos */}
        <div style={{display:"flex",gap:3,marginBottom:"0.75rem",
          background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
          borderRadius:"10px",padding:3}}>
          {[
            {k:"mine",    l:"\u25cf  "+myName.split(" ")[0].toUpperCase()},
            {k:"hers",    l:"\u25cf  "+herName.split(" ")[0].toUpperCase()},
            {k:"together",l:"\u2665  JUNTOS"},
          ].map(t=>(
            <button key={t.k} onClick={()=>setTopTab(t.k)} style={{
              flex:1,padding:"0.5rem 0.25rem",border:"none",borderRadius:"7px",cursor:"pointer",
              fontSize:"0.65rem",fontWeight:600,letterSpacing:"0.08em",transition:"all .15s",
              background:topTab===t.k?(t.k==="together"?"#FF69B4":"#E8FF47"):"transparent",
              color:topTab===t.k?"#080808":t.k==="together"?"rgba(255,105,180,0.5)":"rgba(255,255,255,0.28)",
              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
            }}>{t.l}</button>
          ))}
        </div>
        {topTab==="mine"&&(
        <div style={{display:"flex",gap:3,marginBottom:"1.1rem",
          background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
          borderRadius:"10px",padding:3}}>
          {TABS.map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{
              flex:1,padding:"0.5rem 0.25rem",border:"none",borderRadius:"7px",cursor:"pointer",
              fontSize:"0.65rem",fontWeight:600,letterSpacing:"0.08em",transition:"all .15s",
              background:tab===t.k?"#E8FF47":"transparent",
              color:tab===t.k?"#080808":"rgba(255,255,255,0.28)",
              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
            }}>{t.l}</button>
          ))}
        </div>)}


        {/* ── DIRECT DEBITS ───────────────────────────────────────────────── */}
        {tab==="subs"&&(
          <div style={{animation:"fadeUp .32s ease both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.875rem"}}>
              <div style={{color:"rgba(255,255,255,0.18)",fontSize:"0.6rem",letterSpacing:"0.15em",fontFamily:"'DM Mono',monospace"}}>
                {subs.length} ACTIVE \u00b7 {fmt(totalSubs)}/WK
              </div>
              <button onClick={()=>setShowAdd(true)} style={{
                background:"#E8FF47",border:"none",borderRadius:"7px",color:"#080808",
                padding:"0.45rem 0.875rem",cursor:"pointer",fontWeight:700,
                fontSize:"0.72rem",letterSpacing:"0.1em",transition:"background .15s",
              }}
                onMouseOver={e=>e.currentTarget.style.background="#fff"}
                onMouseOut={e=>e.currentTarget.style.background="#E8FF47"}
              >+ NEW</button>
            </div>
            <div style={{display:"grid",gap:"0.5rem"}}>
              {subs.map((sub,i)=>(
                <Tilt key={sub.id} style={{animation:`fadeUp .32s ease ${i*.055}s both`}}>
                  <div style={{background:"#0c0c0c",
                    border:`1px solid ${paidAnim[sub.id]?"rgba(46,213,115,.45)":"rgba(255,255,255,0.055)"}`,
                    borderRadius:"12px",padding:"0.875rem 1rem",
                    display:"flex",alignItems:"center",gap:"0.875rem",
                    transition:"border-color .3s",position:"relative",overflow:"hidden"}}>
                    <div style={{position:"absolute",left:0,top:"15%",bottom:"15%",width:2.5,
                      borderRadius:"0 2px 2px 0",background:ACCENTS[sub.ci]}}/>
                    <div style={{width:42,height:42,borderRadius:"9px",flexShrink:0,overflow:"hidden",
                      background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.055)",
                      display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {!sub.logoErr?(
                        <img src={getLogoUrl(sub.title)} alt={sub.title}
                          style={{width:"100%",height:"100%",objectFit:"contain",padding:5}}
                          onError={()=>setSubs(p=>p.map(s=>s.id===sub.id?{...s,logoErr:true}:s))}/>
                      ):(
                        <span style={{fontWeight:700,fontSize:"0.82rem",color:ACCENTS[sub.ci]}}>{getInitials(sub.title)}</span>
                      )}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:500,fontSize:"0.88rem",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{sub.title}</div>
                      <div style={{color:"rgba(255,255,255,0.22)",fontSize:"0.65rem",fontFamily:"'DM Mono',monospace",marginTop:2}}>
                        {sub.history?.length>0?`${sub.history[0].date} \u00b7 ${sub.history[0].time}`:"—"}
                      </div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontWeight:500,fontSize:"0.9rem"}}>{fmt(sub.amount)}</div>
                      <div style={{color:"rgba(255,255,255,0.18)",fontSize:"0.58rem",letterSpacing:"0.08em"}}>/WEEK</div>
                    </div>
                    <div style={{display:"flex",gap:"0.35rem",flexShrink:0}}>
                      <button onClick={()=>markPaid(sub.id)} style={{
                        background:paidAnim[sub.id]?"#2ED573":"rgba(46,213,115,.07)",
                        border:`1px solid ${paidAnim[sub.id]?"#2ED573":"rgba(46,213,115,.22)"}`,
                        borderRadius:"7px",color:paidAnim[sub.id]?"#080808":"#2ED573",
                        padding:"0.3rem 0.6rem",cursor:"pointer",fontSize:"0.68rem",fontWeight:700,
                        letterSpacing:"0.08em",animation:paidAnim[sub.id]?"paidPop .9s ease":"none",
                        transition:"all .16s",whiteSpace:"nowrap",
                      }}>{paidAnim[sub.id]?"\u2713 PAID":"PAID"}</button>
                      <button onClick={()=>setHistId(sub.id)} style={{
                        background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",
                        borderRadius:"7px",color:"rgba(255,255,255,0.3)",
                        padding:"0.3rem 0.5rem",cursor:"pointer",fontSize:"0.68rem",
                        fontFamily:"'DM Mono',monospace",whiteSpace:"nowrap",
                      }}>{sub.history?.length||0}</button>
                      <button onClick={()=>removeSub(sub.id)} style={{
                        background:"rgba(255,71,87,.05)",border:"1px solid rgba(255,71,87,.12)",
                        borderRadius:"7px",color:"rgba(255,71,87,.55)",
                        width:26,height:26,cursor:"pointer",fontSize:"0.82rem",
                        display:"flex",alignItems:"center",justifyContent:"center",
                      }}>×</button>
                    </div>
                  </div>
                </Tilt>
              ))}
            </div>
            {subs.length===0&&(
              <div style={{textAlign:"center",padding:"3rem 0",color:"rgba(255,255,255,.12)",
                fontSize:"0.72rem",letterSpacing:"0.15em"}}>NO SUBSCRIPTIONS</div>
            )}
          </div>
        )}

        {/* ── WEEKLY ──────────────────────────────────────────────────────── */}
        {tab==="weekly"&&(
          <WeeklyTab subs={subs} expenses={expenses} income={totalIncome}/>
        )}

        {/* ── EXPENSES ────────────────────────────────────────────────────── */}
        {tab==="expenses"&&(
          <div style={{animation:"fadeUp .32s ease both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.875rem"}}>
              <div style={{color:"rgba(255,255,255,0.18)",fontSize:"0.6rem",letterSpacing:"0.15em",fontFamily:"'DM Mono',monospace"}}>
                {expenses.length} ITEMS \u00b7 {fmt(totalExp)}/WK
              </div>
              <button onClick={()=>setShowAddExp(true)} style={{
                background:"#FF4757",border:"none",borderRadius:"7px",color:"#fff",
                padding:"0.45rem 0.875rem",cursor:"pointer",fontWeight:700,
                fontSize:"0.72rem",letterSpacing:"0.1em",
              }}>+ NEW</button>
            </div>
            <div style={{display:"grid",gap:"0.5rem"}}>
              {expenses.map((exp,i)=>(
                <Tilt key={exp.id} style={{animation:`fadeUp .32s ease ${i*.055}s both`}}>
                  <div style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
                    borderRadius:"12px",padding:"0.875rem 1rem",display:"flex",alignItems:"center",gap:"0.875rem",
                    position:"relative",overflow:"hidden"}}>
                    <div style={{position:"absolute",left:0,top:"15%",bottom:"15%",width:2.5,
                      borderRadius:"0 2px 2px 0",background:"#FF4757"}}/>
                    <div style={{width:38,height:38,borderRadius:"8px",background:"rgba(255,71,87,.06)",
                      border:"1px solid rgba(255,71,87,.12)",display:"flex",alignItems:"center",
                      justifyContent:"center",fontSize:"1rem",flexShrink:0,color:"#FF4757"}}>\u25c8</div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:500,fontSize:"0.88rem"}}>{exp.label}</div>
                      {(exp.paid_date||exp.date)&&(
                        <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.62rem",fontFamily:"'DM Mono',monospace",marginTop:2}}>
                          {exp.paid_date||exp.date}{(exp.paid_time||exp.time)?` \u00b7 ${exp.paid_time||exp.time}`:""}
                        </div>
                      )}
                    </div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontWeight:500,fontSize:"0.9rem",color:"#FF4757"}}>{fmt(exp.amount)}</div>
                    <button onClick={()=>removeExp(exp.id)} style={{
                      background:"rgba(255,71,87,.05)",border:"1px solid rgba(255,71,87,.12)",
                      borderRadius:"7px",color:"rgba(255,71,87,.55)",
                      width:26,height:26,cursor:"pointer",fontSize:"0.82rem",
                      display:"flex",alignItems:"center",justifyContent:"center",
                    }}>×</button>
                  </div>
                </Tilt>
              ))}
            </div>
            {expenses.length===0&&(
              <div style={{textAlign:"center",padding:"3rem 0",color:"rgba(255,255,255,.12)",
                fontSize:"0.72rem",letterSpacing:"0.15em"}}>NO EXPENSES</div>
            )}
          </div>
        )}

        {/* ── OVERVIEW ────────────────────────────────────────────────────── */}
        {tab==="overview"&&(
          <div style={{animation:"fadeUp .32s ease both"}}>
            <div style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
              borderRadius:"14px",padding:"1.25rem 1.5rem",marginBottom:"0.875rem"}}>
              {[
                {l:"SUBSCRIPTIONS", v:totalSubs, c:"#A29BFE"},
                {l:"EXPENSES",      v:totalExp,  c:"#FF4757"},
                {l:"FREE BALANCE",  v:Math.max(balance,0), c:"#E8FF47"},
              ].map(item=>(
                <div key={item.l} style={{marginBottom:"0.875rem"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:"0.28rem"}}>
                    <span style={{color:"rgba(255,255,255,.25)",fontSize:"0.6rem",letterSpacing:"0.12em"}}>{item.l}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"0.68rem",color:item.c}}>
                      {fmt(item.v)} \u00b7 {totalIncome>0?((item.v/totalIncome)*100).toFixed(0):0}%
                    </span>
                  </div>
                  <div style={{height:4,background:"rgba(255,255,255,.04)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:2,background:item.c,
                      width:`${totalIncome>0?Math.min((item.v/totalIncome)*100,100):0}%`,
                      transition:"width .8s cubic-bezier(.34,1.56,.64,1)",
                      boxShadow:`0 0 5px ${item.c}77`}}/>
                  </div>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:"0.5rem",marginBottom:"0.875rem"}}>
              {[
                {l:"MONTHLY",      v:(totalIncome*4).toFixed(2),         s:"income",    c:"#63b3ff"},
                {l:"OUT/MONTH",    v:(totalOut*4).toFixed(2),            s:"total",     c:"#FF4757"},
                {l:"SAVINGS/MO",   v:(Math.max(balance,0)*4).toFixed(2), s:"estimated", c:"#2ED573"},
                {l:"IN 12 MONTHS", v:(Math.max(balance,0)*52).toFixed(2),s:"potential", c:"#E8FF47"},
              ].map(card=>(
                <Tilt key={card.l}>
                  <div style={{background:"#0c0c0c",border:"1px solid rgba(255,255,255,0.055)",
                    borderRadius:"12px",padding:"1rem",position:"relative",overflow:"hidden"}}>
                    <div style={{position:"absolute",top:0,left:0,right:0,height:1.5,
                      background:`linear-gradient(90deg,transparent,${card.c}55,transparent)`}}/>
                    <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.58rem",letterSpacing:"0.14em",marginBottom:"0.45rem"}}>{card.l}</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontWeight:500,fontSize:"0.95rem",color:card.c}}>
                      {GBP}{card.v}
                    </div>
                    <div style={{color:"rgba(255,255,255,.14)",fontSize:"0.6rem",marginTop:3,letterSpacing:"0.06em"}}>{card.s}</div>
                  </div>
                </Tilt>
              ))}
            </div>
            <button onClick={()=>setShowAI(true)} style={{
              width:"100%",padding:"0.875rem 1.25rem",background:"transparent",
              border:"1px solid rgba(232,255,71,0.25)",borderRadius:"12px",color:"#E8FF47",
              cursor:"pointer",fontWeight:600,fontSize:"0.75rem",letterSpacing:"0.14em",
              display:"flex",alignItems:"center",justifyContent:"center",gap:"0.75rem",transition:"all .18s",
            }}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(232,255,71,0.05)";e.currentTarget.style.borderColor="rgba(232,255,71,0.5)";}}
              onMouseOut={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="rgba(232,255,71,0.25)";}}
            >
              <span>🤖</span>
              AI ANALYSIS \u00b7 OPTIMISE FINANCES
              <span style={{color:"rgba(232,255,71,0.35)",animation:"blink 2.5s ease infinite"}}>\u25c6</span>
            </button>
          </div>
        )}

        </>)}
        {/* end mine */}

        {/* HERS TAB */}
        {topTab==="hers"&&(
          <div style={{animation:"fadeUp .32s ease both",textAlign:"center",padding:"3.5rem 0"}}>
            <div style={{fontSize:"2.5rem",marginBottom:"1rem"}}>♥</div>
            <div style={{fontWeight:600,fontSize:"0.95rem",marginBottom:"0.5rem",color:"#FF69B4"}}>
              {herName.split(" ")[0]}'s View
            </div>
            <div style={{color:"rgba(255,255,255,0.3)",fontSize:"0.78rem",lineHeight:1.7,maxWidth:320,margin:"0 auto"}}>
              {couple?.partner_id
                ? `${herName.split(" ")[0]} manages her own finances on her device. Check the Juntos tab to see all shared activity.`
                : "Invite your partner first. Use the ♥ Invite button above to generate a link."}
            </div>
          </div>
        )}

        {/* TOGETHER TAB */}
        {topTab==="together"&&<TogetherTab couple={couple} user={user}/>}

      </div>

      {/* ── MODAL: ADD SUBSCRIPTION ──────────────────────────────────────── */}
      {showAdd&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:500,
          display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(14px)",padding:"1rem"}}>
          <div style={{background:"#090909",border:"1px solid rgba(255,255,255,0.09)",borderRadius:"16px",
            padding:"1.5rem",maxWidth:360,width:"100%",animation:"popIn .22s ease both",
            maxHeight:"90vh",overflowY:"auto",boxShadow:"0 0 60px rgba(0,0,0,0.9)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.1rem"}}>
              <span style={{color:"rgba(255,255,255,0.22)",fontSize:"0.62rem",letterSpacing:"0.18em"}}>NEW SUBSCRIPTION</span>
              <button onClick={()=>{setShowAdd(false);setSubPayDate(null);}} style={{background:"none",border:"none",
                color:"rgba(255,255,255,0.28)",cursor:"pointer",fontSize:17,padding:0}}>×</button>
            </div>
            <DateTimePicker value={subPayDate} onChange={setSubPayDate}/>
            {[{l:"SERVICE",k:"title",p:"Netflix, Spotify...",t:"text"},{l:"AMOUNT \u00a3",k:"amount",p:"9.99",t:"number"}].map(f=>(
              <div key={f.k} style={{marginBottom:"0.75rem"}}>
                <label style={lbl}>{f.l}</label>
                <input type={f.t} placeholder={f.p} value={newSub[f.k]}
                  onChange={e=>setNewSub(p=>({...p,[f.k]:e.target.value}))}
                  onKeyDown={e=>e.key==="Enter"&&addSub()} style={inp}/>
              </div>
            ))}
            {newSub.title&&(
              <div style={{display:"flex",alignItems:"center",gap:"0.55rem",padding:"0.55rem 0.75rem",
                background:"rgba(232,255,71,0.03)",border:"1px solid rgba(232,255,71,0.08)",
                borderRadius:"7px",marginBottom:"0.75rem"}}>
                <img src={getLogoUrl(newSub.title)} style={{width:26,height:26,objectFit:"contain",
                  background:"rgba(255,255,255,0.04)",borderRadius:5,padding:3}}
                  onError={e=>e.target.style.display="none"} alt=""/>
                <span style={{color:"rgba(255,255,255,0.22)",fontSize:"0.65rem",letterSpacing:"0.1em"}}>LOGO DETECTED</span>
              </div>
            )}
            <div style={{display:"flex",gap:"0.45rem"}}>
              <button onClick={()=>{setShowAdd(false);setSubPayDate(null);}} style={{flex:1,padding:"0.65rem",background:"rgba(255,255,255,0.04)",
                border:"1px solid rgba(255,255,255,0.07)",borderRadius:"8px",
                color:"rgba(255,255,255,0.35)",cursor:"pointer",fontSize:"0.72rem",letterSpacing:"0.1em"}}>CANCEL</button>
              <button onClick={addSub} style={{flex:1,padding:"0.65rem",background:"#E8FF47",
                border:"none",borderRadius:"8px",color:"#080808",cursor:"pointer",
                fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em"}}>ADD</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: ADD EXPENSE ───────────────────────────────────────────── */}
      {showAddExp&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:500,
          display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(14px)",padding:"1rem"}}>
          <div style={{background:"#090909",border:"1px solid rgba(255,255,255,0.09)",borderRadius:"16px",
            padding:"1.5rem",maxWidth:360,width:"100%",animation:"popIn .22s ease both",
            maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.1rem"}}>
              <span style={{color:"rgba(255,255,255,0.22)",fontSize:"0.62rem",letterSpacing:"0.18em"}}>NEW EXPENSE</span>
              <button onClick={()=>{setShowAddExp(false);setExpPayDate(null);}} style={{background:"none",border:"none",
                color:"rgba(255,255,255,0.28)",cursor:"pointer",fontSize:17,padding:0}}>×</button>
            </div>
            <DateTimePicker value={expPayDate} onChange={setExpPayDate}/>
            {[{l:"DESCRIPTION",k:"label",p:"Groceries, Transport...",t:"text"},{l:"WEEKLY AMOUNT \u00a3",k:"amount",p:"50.00",t:"number"}].map(f=>(
              <div key={f.k} style={{marginBottom:"0.75rem"}}>
                <label style={lbl}>{f.l}</label>
                <input type={f.t} placeholder={f.p} value={newExp[f.k]}
                  onChange={e=>setNewExp(p=>({...p,[f.k]:e.target.value}))}
                  onKeyDown={e=>e.key==="Enter"&&addExp()} style={inp}/>
              </div>
            ))}
            <div style={{display:"flex",gap:"0.45rem"}}>
              <button onClick={()=>{setShowAddExp(false);setExpPayDate(null);}} style={{flex:1,padding:"0.65rem",background:"rgba(255,255,255,0.04)",
                border:"1px solid rgba(255,255,255,0.07)",borderRadius:"8px",
                color:"rgba(255,255,255,0.35)",cursor:"pointer",fontSize:"0.72rem",letterSpacing:"0.1em"}}>CANCEL</button>
              <button onClick={addExp} style={{flex:1,padding:"0.65rem",background:"#FF4757",
                border:"none",borderRadius:"8px",color:"#fff",cursor:"pointer",
                fontWeight:700,fontSize:"0.72rem",letterSpacing:"0.1em"}}>ADD</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: HISTORY ───────────────────────────────────────────────── */}
      {histId&&histSub&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:600,
          display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(14px)",padding:"1rem"}}>
          <div style={{background:"#090909",border:"1px solid rgba(255,255,255,0.09)",borderRadius:"16px",
            padding:"1.5rem",maxWidth:400,width:"100%",maxHeight:"76vh",overflowY:"auto",
            animation:"popIn .22s ease both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.1rem"}}>
              <div style={{display:"flex",alignItems:"center",gap:"0.65rem"}}>
                <div style={{width:34,height:34,borderRadius:"8px",overflow:"hidden",
                  background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.055)",
                  display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {!histSub.logoErr?
                    <img src={getLogoUrl(histSub.title)} style={{width:"100%",objectFit:"contain",padding:4}}
                      onError={()=>setSubs(p=>p.map(s=>s.id===histSub.id?{...s,logoErr:true}:s))} alt=""/>:
                    <span style={{fontWeight:700,fontSize:"0.78rem",color:ACCENTS[histSub.ci]}}>{getInitials(histSub.title)}</span>
                  }
                </div>
                <div>
                  <div style={{fontWeight:500,fontSize:"0.88rem"}}>{histSub.title}</div>
                  <div style={{color:"rgba(255,255,255,0.18)",fontSize:"0.6rem",letterSpacing:"0.1em"}}>
                    {histSub.history?.length||0} RECORDS</div>
                </div>
              </div>
              <button onClick={()=>setHistId(null)} style={{background:"none",border:"none",
                color:"rgba(255,255,255,0.28)",cursor:"pointer",fontSize:17,padding:0}}>×</button>
            </div>
            {!histSub.history?.length?(
              <div style={{textAlign:"center",padding:"2rem 0",color:"rgba(255,255,255,.12)",
                fontSize:"0.68rem",letterSpacing:"0.14em"}}>NO RECORDS</div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:"0.4rem"}}>
                {histSub.history.map((h,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:"0.65rem",
                    background:"rgba(255,255,255,0.025)",border:"1px solid rgba(46,213,115,0.1)",
                    borderRadius:"8px",padding:"0.65rem 0.875rem",
                    animation:`fadeUp .28s ease ${i*.04}s both`}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#2ED573",flexShrink:0,boxShadow:"0 0 5px #2ED573"}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:"0.8rem",fontWeight:400}}>{h.date}</div>
                      <div style={{color:"rgba(255,255,255,0.22)",fontSize:"0.65rem",fontFamily:"'DM Mono',monospace"}}>{h.time}</div>
                    </div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:"0.8rem",color:"rgba(255,255,255,0.35)"}}>{fmt(histSub.amount)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showInvite&&<InviteModal onClose={()=>setShowInvite(false)} couple={couple}/>}
      {showAI&&(
        <AIModal onClose={()=>setShowAI(false)} subscriptions={subs} expenses={expenses} weeklyIncome={totalIncome}/>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROOT — handles auth session, shows Login or App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [user,    setUser]    = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(()=>{
    (async()=>{
      // 1. Check if we just came back from OAuth / magic link redirect
      // Check for invite code in URL
      const urlParams = new URLSearchParams(window.location.search);
      const inviteCode = urlParams.get("invite");
      if (inviteCode) LS.set("pending_invite", inviteCode);

      const token = await auth.getSessionFromHash();
      if (token) {
        const u = await auth.getUser();
        if (u) {
          // Join couple if came via invite
          const inv = LS.get("pending_invite", null);
          if (inv) {
            const uname = u.user_metadata?.full_name||u.email?.split("@")[0]||"Partner";
            await coupleApi.joinByCode(inv, u.id, uname);
            LS.set("pending_invite", null);
            window.history.replaceState({}, document.title, window.location.pathname);
          }
          setUser(u); setAuthLoading(false); return;
        }
      }
      // 2. Check existing stored session
      if (!DB_READY) {
        // No DB — auto-login locally
        setUser({email:"local@demo",id:"local"});
        setAuthLoading(false);
        return;
      }
      const u = await auth.getUser().catch(()=>null);
      if (u) {
        const inv = LS.get("pending_invite", null);
        if (inv) {
          const uname = u.user_metadata?.full_name||u.email?.split("@")[0]||"Partner";
          await coupleApi.joinByCode(inv, u.id, uname);
          LS.set("pending_invite", null);
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
      setUser(u || null);
      setAuthLoading(false);
    })();
  },[]);

  const handleSignOut = async () => {
    await auth.signOut();
    setUser(null);
  };

  if (authLoading) return (
    <div style={{minHeight:"100vh",background:"#070707",display:"flex",
      alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans',sans-serif"}}>
      <div>
        <div style={{width:36,height:36,border:"2px solid rgba(232,255,71,0.1)",
          borderTop:"2px solid #E8FF47",borderRadius:"50%",
          animation:"spin 1s linear infinite",margin:"0 auto 1rem"}}/>
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
        <div style={{color:"rgba(255,255,255,0.2)",fontSize:"0.7rem",letterSpacing:"0.15em",textAlign:"center"}}>
          AUTHENTICATING...
        </div>
      </div>
    </div>
  );

  if (!user) return <LoginScreen onLogin={setUser}/>;

  return <FinanceApp user={user} onSignOut={handleSignOut}/>;
}
