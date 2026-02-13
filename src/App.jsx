import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";

// ═══════════════════════════════════════════════════════════════════════
// BUOY — Mood-based music sharing with Spotify + Supabase
// v3: All 13 audit items fixed
// ═══════════════════════════════════════════════════════════════════════

const SPOTIFY_CLIENT_ID = "f0fecfcd5a2c4a5cbb5a9ab2824d0761";
const SPOTIFY_REDIRECT_URI = window.location.origin + "/";
const SPOTIFY_SCOPES = "playlist-modify-public playlist-modify-private user-read-private user-top-read user-read-recently-played";

// ─── PKCE ───────────────────────────────────────────────────────────────
function randomStr(n) {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), x => c[x % c.length]).join("");
}
async function pkce(v) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function spotifyLogin() {
  const v = randomStr(64);
  localStorage.setItem("sp_v", v);
  // Mark that we're doing a Spotify login so we can distinguish from magic link
  localStorage.setItem("sp_pending", "1");
  const ch = await pkce(v);
  window.location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: "S256", code_challenge: ch, scope: SPOTIFY_SCOPES,
  });
}
async function exchangeCode(code) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID, grant_type: "authorization_code",
      code, redirect_uri: SPOTIFY_REDIRECT_URI, code_verifier: localStorage.getItem("sp_v"),
    }),
  });
  return r.json();
}
async function refreshTokenFn(rt) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, grant_type: "refresh_token", refresh_token: rt }),
  });
  return r.json();
}

// ─── Spotify API (auto-refresh on 401) ──────────────────────────────────
const spotifyState = { token: null, refreshToken: null, userId: null, refreshing: null };

async function ensureToken() {
  if (spotifyState.refreshing) return spotifyState.refreshing;
  if (!spotifyState.refreshToken) return spotifyState.token;
  spotifyState.refreshing = (async () => {
    try {
      const f = await refreshTokenFn(spotifyState.refreshToken);
      if (f.access_token) {
        spotifyState.token = f.access_token;
        if (f.refresh_token) spotifyState.refreshToken = f.refresh_token;
        if (spotifyState.userId) {
          await supabase.from("profiles").update({
            spotify_access_token: f.access_token,
            spotify_token_expiry: Date.now() + f.expires_in * 1000,
            ...(f.refresh_token ? { spotify_refresh_token: f.refresh_token } : {}),
          }).eq("id", spotifyState.userId);
        }
      }
    } catch (e) { console.error("Token refresh failed:", e); }
    spotifyState.refreshing = null;
    return spotifyState.token;
  })();
  return spotifyState.refreshing;
}

async function spGet(url, tk) {
  const useTk = spotifyState.token || tk;
  let r = await fetch(url, { headers: { Authorization: `Bearer ${useTk}` } });
  if (r.status === 401) {
    const newTk = await ensureToken();
    if (newTk && newTk !== useTk) r = await fetch(url, { headers: { Authorization: `Bearer ${newTk}` } });
  }
  return r.ok ? r.json() : null;
}
async function spPost(url, tk, body) {
  const useTk = spotifyState.token || tk;
  let r = await fetch(url, { method:"POST", headers:{Authorization:`Bearer ${useTk}`,"Content-Type":"application/json"}, body:JSON.stringify(body) });
  if (r.status === 401) {
    const newTk = await ensureToken();
    if (newTk && newTk !== useTk) r = await fetch(url, { method:"POST", headers:{Authorization:`Bearer ${newTk}`,"Content-Type":"application/json"}, body:JSON.stringify(body) });
  }
  return r.ok ? r.json() : null;
}

function mapTrack(t) {
  return { id: t.id, title: t.name, artist: t.artists.map(a=>a.name).join(", "), albumArt: t.album.images?.[1]?.url||t.album.images?.[0]?.url, previewUrl: t.preview_url, spotifyUri: t.uri, spotifyUrl: t.external_urls?.spotify };
}
async function searchSpotify(q, tk) {
  const d = await spGet(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8`, tk);
  return (d?.tracks?.items||[]).map(mapTrack);
}
async function getRecent(tk) {
  const d = await spGet("https://api.spotify.com/v1/me/player/recently-played?limit=20", tk);
  if (!d?.items) return [];
  const seen = new Set();
  return d.items.filter(i => { if (seen.has(i.track.id)) return false; seen.add(i.track.id); return true; }).map(i => mapTrack(i.track));
}
async function getTop(tk) {
  const d = await spGet("https://api.spotify.com/v1/me/top/tracks?limit=20&time_range=short_term", tk);
  return (d?.items||[]).map(mapTrack);
}
async function getOrCreatePlaylist(tk, spUserId, profileId) {
  const { data: prof } = await supabase.from("profiles").select("spotify_playlist_id").eq("id", profileId).single();
  if (prof?.spotify_playlist_id) {
    const check = await spGet(`https://api.spotify.com/v1/playlists/${prof.spotify_playlist_id}`, tk);
    if (check) return prof.spotify_playlist_id;
  }
  const pl = await spPost(`https://api.spotify.com/v1/users/${spUserId}/playlists`, tk, { name: "Buoy 🌊", description: "Songs that lifted my mood, curated by real people on Buoy.", public: true });
  if (pl?.id) { await supabase.from("profiles").update({ spotify_playlist_id: pl.id }).eq("id", profileId); return pl.id; }
  return null;
}
// FIX #2: Use spPost for addTrack so auto-refresh works
async function addTrack(plId, uri, tk) {
  await spPost(`https://api.spotify.com/v1/playlists/${plId}/tracks`, tk, { uris: [uri] });
}

// ─── Design ─────────────────────────────────────────────────────────────
const C = { bg:"#EDEDF0", white:"#FFFFFF", navy:"#1B2138", mint:"#2EECC0", purple:"#B07CFF", pink:"#D98BFF", gold:"#FFD166", blue:"#7EC8E3", red:"#E63946", text1:"#1B2138", text2:"#6B7084", border:"#D8DAE0", spotify:"#1DB954" };
const hf = "'Poppins', sans-serif";
const bf = "'DM Sans', sans-serif";

const MOODS = {
  good: { sub: [{ id:"happy", label:"HAPPY", color:C.mint }, { id:"energized", label:"ENERGIZED", color:C.gold }, { id:"calm", label:"CALM", color:C.blue }, { id:"grateful", label:"GRATEFUL", color:C.mint }] },
  bad: { sub: [{ id:"sad", label:"SAD", color:C.pink }, { id:"tired", label:"TIRED", color:C.pink }, { id:"anxious", label:"ANXIOUS", color:C.pink }, { id:"angry", label:"ANGRY", color:C.pink }] },
};
function getMood(id) { for (const g of Object.values(MOODS)) { const f=g.sub.find(s=>s.id===id); if(f) return f; } return null; }

// ─── Toast Component (FIX #3 & #9: error/success feedback) ─────────────
function Toast({ message, type, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:type==="error"?C.red:type==="success"?C.mint:C.navy,
      color:type==="error"?C.white:C.navy,padding:"12px 24px",borderRadius:99,fontFamily:bf,fontSize:14,fontWeight:600,
      zIndex:9999,boxShadow:"0 4px 20px rgba(0,0,0,0.15)",animation:"slideUp 0.3s ease",maxWidth:"90vw",textAlign:"center"}}>
      {message}
    </div>
  );
}

// ─── Small Components ───────────────────────────────────────────────────
function AccentBar() { return <div style={{position:"fixed",left:0,top:0,bottom:0,width:6,background:`linear-gradient(180deg,${C.purple} 0%,${C.mint} 25%,${C.gold} 50%,${C.pink} 75%,${C.purple} 100%)`,zIndex:999}} />; }
function Logo({ size=32 }) { return <img src="/buoy-logo.png" alt="Buoy" style={{width:size,height:size,objectFit:"contain"}} />; }

// ─── Auth Screen ────────────────────────────────────────────────────────
function AuthScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setLoading(true); setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (err) { setError("Couldn't send magic link. Check your email and try again."); setLoading(false); return; }
    setSent(true); setLoading(false);
  };
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <AccentBar />
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}} *{box-sizing:border-box}`}</style>
      <Logo size={64} />
      <h1 style={{fontFamily:hf,fontSize:36,fontWeight:800,color:C.navy,margin:"20px 0 8px"}}>BUOY</h1>
      <p style={{color:C.text2,fontSize:15,fontFamily:bf,textAlign:"center",maxWidth:320,marginBottom:32}}>Share music when you feel good.<br/>Receive music when you don't.</p>
      {!sent ? (
        <div style={{background:C.white,borderRadius:16,padding:24,border:`1px solid ${C.border}`,width:"100%",maxWidth:360}}>
          <label style={{fontSize:13,color:C.text2,fontWeight:600,display:"block",marginBottom:8,fontFamily:bf}}>Email</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}
            placeholder="you@email.com" style={{width:"100%",background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",color:C.navy,fontFamily:bf,fontSize:15,outline:"none",marginBottom:error?8:16,boxSizing:"border-box"}} />
          {error && <p style={{color:C.red,fontSize:13,fontFamily:bf,margin:"0 0 12px"}}>{error}</p>}
          <button onClick={go} disabled={loading||!email}
            style={{width:"100%",background:C.mint,border:"none",borderRadius:12,padding:14,color:C.navy,fontFamily:hf,fontWeight:700,fontSize:16,cursor:"pointer",opacity:loading?0.6:1}}>
            {loading ? "Sending..." : "Sign in with Magic Link"}
          </button>
        </div>
      ) : (
        <div style={{background:C.white,borderRadius:16,padding:32,border:`1px solid ${C.border}`,textAlign:"center",maxWidth:360}}>
          <div style={{fontSize:40,marginBottom:12}}>📬</div>
          <h3 style={{fontFamily:hf,fontWeight:700,fontSize:18,color:C.navy,margin:"0 0 8px"}}>Check your email</h3>
          <p style={{color:C.text2,fontSize:14,fontFamily:bf}}>We sent a magic link to <strong>{email}</strong>.</p>
        </div>
      )}
    </div>
  );
}

// ─── Mood Check-In ──────────────────────────────────────────────────────
function MoodCheckIn({ onMoodSet }) {
  const [phase, setPhase] = useState("init");
  const [dir, setDir] = useState(null);
  const go = (w) => { setDir(w); setPhase("expand"); setTimeout(()=>setPhase(w), 350); };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"65vh",textAlign:"center"}}>
      {phase==="init" && (
        <div style={{animation:"fadeIn 0.3s ease"}}>
          <Logo size={56} />
          <h1 style={{fontFamily:hf,fontSize:42,fontWeight:800,color:C.navy,margin:"20px 0 0",lineHeight:1.1}}>How<br/>are you<br/>doing?</h1>
          {/* FIX #7: responsive buttons */}
          <div style={{display:"flex",gap:16,marginTop:40,flexWrap:"wrap",justifyContent:"center"}}>
            <button onClick={()=>go("good")} style={{background:C.mint,border:"none",borderRadius:16,padding:"28px 40px",cursor:"pointer",minWidth:160,boxShadow:`0 4px 12px ${C.mint}33`}}>
              <span style={{fontFamily:hf,fontWeight:800,fontSize:24,color:C.navy}}>GOOD</span></button>
            <button onClick={()=>go("bad")} style={{background:C.pink,border:"none",borderRadius:16,padding:"28px 40px",cursor:"pointer",minWidth:160,boxShadow:`0 4px 12px ${C.pink}33`}}>
              <span style={{fontFamily:hf,fontWeight:800,fontSize:24,color:C.navy}}>BAD</span></button>
          </div>
        </div>
      )}
      {phase==="expand" && (
        <div style={{animation:"pulse 0.35s ease"}}>
          <div style={{width:120,height:120,borderRadius:"50%",background:dir==="good"?C.mint:C.pink,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontFamily:hf,fontWeight:800,fontSize:20,color:C.navy}}>{dir==="good"?"GOOD":"BAD"}</span>
          </div>
        </div>
      )}
      {(phase==="good"||phase==="bad") && (
        <div style={{animation:"fadeIn 0.3s ease"}}>
          <h2 style={{fontFamily:hf,fontSize:28,fontWeight:800,color:C.navy,margin:"0 0 8px"}}>{phase==="good"?"What kind of good?":"How bad?"}</h2>
          <p style={{color:C.text2,fontSize:14,margin:"0 0 28px",maxWidth:340,fontFamily:bf}}>
            {phase==="good" ? "Pick your vibe, then share a song." : "Real people are sending you songs that help."}
          </p>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,maxWidth:290}}>
            {MOODS[phase].sub.map(m => (
              <button key={m.id} onClick={()=>onMoodSet(m.id,phase)}
                style={{background:m.color+"DD",border:"none",borderRadius:14,padding:"22px 16px",cursor:"pointer",minWidth:130}}>
                <span style={{fontFamily:hf,fontWeight:700,fontSize:18,color:C.navy}}>{m.label}</span>
              </button>
            ))}
          </div>
          <button onClick={()=>setPhase("init")} style={{background:"none",border:"none",color:C.text2,cursor:"pointer",fontFamily:bf,fontSize:14,marginTop:20}}>← Back</button>
        </div>
      )}
    </div>
  );
}

// ─── Share Screen ───────────────────────────────────────────────────────
function ShareScreen({ mood, spToken, user, onBack, showToast }) {
  const mi = getMood(mood);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState([]);
  // FIX #12: rate limit shares to 10 per session
  const [shareCount, setShareCount] = useState(0);
  const hasSearched = results.length > 0 || (q.trim() && searching);

  useEffect(() => {
    const load = async () => {
      const all = [];
      const seen = new Set();
      // FIX #8: dedupe previously sent by song_id
      if (user) {
        const {data} = await supabase.from("shares").select("song_id, songs(*)").eq("user_id",user.id).order("created_at",{ascending:false}).limit(20);
        if (data) data.filter(d=>d.songs).forEach(d => {
          if (!seen.has(d.songs.id)) { seen.add(d.songs.id); all.push({id:d.songs.id,title:d.songs.title,artist:d.songs.artist,albumArt:d.songs.album_art,previewUrl:d.songs.preview_url,spotifyUri:d.songs.spotify_uri,spotifyUrl:d.songs.spotify_url,tag:"Sent before"}); }
        });
      }
      if (spToken) {
        const rec = await getRecent(spToken);
        rec.forEach(s => { if(!seen.has(s.id)){seen.add(s.id);all.push({...s,tag:"Recently played"});} });
        const tp = await getTop(spToken);
        tp.forEach(s => { if(!seen.has(s.id)){seen.add(s.id);all.push({...s,tag:"Your top tracks"});} });
      }
      setSuggestions(all.slice(0, 20));
    };
    load();
  }, [spToken, user]);

  const search = async () => {
    if(!q.trim()||!spToken) return;
    setSearching(true);
    const r = await searchSpotify(q, spToken);
    setResults(r);
    setSearching(false);
    if (r.length === 0) showToast("No results found. Try a different search.", "error");
  };
  const clearSearch = () => { setQ(""); setResults([]); };

  const send = async (song) => {
    // FIX #12: rate limit
    if (shareCount >= 10) { showToast("Take a breather — you've shared 10 songs this session.", "error"); return; }
    // FIX #5: prevent double-tap with sending state
    if (sending || sent.includes(song.id)) return;
    setSending(song.id);
    try {
      await supabase.from("songs").upsert({id:song.id,title:song.title,artist:song.artist,album_art:song.albumArt,preview_url:song.previewUrl,spotify_uri:song.spotifyUri,spotify_url:song.spotifyUrl},{onConflict:"id"});
      await supabase.from("shares").insert({user_id:user.id,song_id:song.id,mood});
      setSent(p=>[...p,song.id]); setShareCount(c=>c+1);
      // FIX #9: success toast
      showToast(`🌊 "${song.title}" sent into the world`, "success");
    } catch (e) {
      // FIX #3: error feedback
      showToast("Couldn't share that song. Try again.", "error");
    }
    setSending(null);
  };

  const renderSong = (s) => (
    <div key={s.id} style={{background:C.bg,borderRadius:12,padding:12,display:"flex",alignItems:"center",gap:12}}>
      {s.albumArt ? <img src={s.albumArt} alt="" style={{width:48,height:48,borderRadius:8}} /> : <div style={{width:48,height:48,borderRadius:8,background:mi?.color+"22",display:"flex",alignItems:"center",justifyContent:"center"}}>🎵</div>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.navy,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.title}</div>
        <div style={{fontSize:12,color:C.text2}}>{s.artist}{s.tag && !hasSearched ? <span style={{color:C.text2+"88",marginLeft:6}}>· {s.tag}</span> : ""}</div>
      </div>
      <button onClick={()=>send(s)} disabled={sending===s.id||sent.includes(s.id)}
        style={{background:sent.includes(s.id)?C.mint+"33":C.mint,border:"none",borderRadius:10,padding:"8px 16px",cursor:sent.includes(s.id)?"default":"pointer",color:C.navy,fontFamily:bf,fontWeight:700,fontSize:13,opacity:sending===s.id?0.5:1,whiteSpace:"nowrap"}}>
        {sent.includes(s.id)?"Sent ✓":sending===s.id?"Sending...":"Send 🌊"}
      </button>
    </div>
  );

  const displayList = hasSearched ? results : suggestions;

  return (
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:C.text2,cursor:"pointer",fontFamily:bf,fontSize:14,padding:"8px 0",marginBottom:16}}>← Back</button>
      <div style={{textAlign:"center",marginBottom:24}}>
        <h2 style={{fontFamily:hf,fontSize:28,fontWeight:800,color:C.navy,margin:"0 0 4px"}}>Feeling {mi?.label}</h2>
        <p style={{color:C.text2,fontSize:14,fontFamily:bf}}>Share a song. It'll reach someone who needs it.</p>
      </div>
      <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:20}}>
        <div style={{display:"flex",gap:8}}>
          <input type="text" value={q} onChange={e=>{setQ(e.target.value); if(!e.target.value.trim()) setResults([]);}} onKeyDown={e=>e.key==="Enter"&&search()}
            placeholder="Search for a song or artist..." style={{flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",color:C.navy,fontFamily:bf,fontSize:14,outline:"none"}} />
          {hasSearched ? (
            <button onClick={clearSearch} style={{background:C.text2+"22",border:"none",borderRadius:10,padding:"10px 16px",color:C.text2,fontFamily:bf,fontWeight:700,fontSize:14,cursor:"pointer"}}>✕</button>
          ) : (
            <button onClick={search} disabled={searching||!q.trim()} style={{background:C.navy,border:"none",borderRadius:10,padding:"10px 20px",color:C.white,fontFamily:bf,fontWeight:700,fontSize:14,cursor:"pointer",opacity:(!q.trim()||searching)?0.5:1}}>{searching?"...":"Search"}</button>
          )}
        </div>
        {!hasSearched && suggestions.length > 0 && (
          <p style={{fontSize:12,color:C.text2+"99",margin:"12px 0 4px",fontFamily:bf}}>Quick picks from your listening</p>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:hasSearched?12:4,maxHeight:480,overflowY:"auto"}}>
          {displayList.map(renderSong)}
          {hasSearched && results.length===0 && !searching && <div style={{textAlign:"center",color:C.text2,padding:24,fontFamily:bf}}>No songs found</div>}
          {!hasSearched && suggestions.length===0 && <div style={{textAlign:"center",color:C.text2,padding:24,fontFamily:bf}}>Search for a song above</div>}
        </div>
      </div>
      {sent.length>0 && (
        <div style={{textAlign:"center",marginTop:20,padding:16,background:C.mint+"22",borderRadius:12}}>
          <p style={{fontFamily:hf,fontWeight:700,fontSize:16,color:C.navy,margin:0}}>🌊 {sent.length} song{sent.length!==1?"s":""} sent into the world</p>
        </div>
      )}
    </div>
  );
}

// ─── Swipe Card (FIX #4: mobile touch handling) ─────────────────────────
function SwipeCard({ song, onSwipe }) {
  const [off, setOff] = useState(0);
  const [drag, setDrag] = useState(false);
  const [exiting, setExiting] = useState(null); // "left" or "right" for exit animation
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const startX = useRef(0);
  const cardRef = useRef(null);

  const onStart = (x) => { startX.current=x; setDrag(true); };
  const onMove = (x) => { if(drag) setOff(x-startX.current); };
  const onEnd = () => {
    setDrag(false);
    if(Math.abs(off)>100) {
      const dir = off > 0;
      setExiting(dir ? "right" : "left");
      // Stop audio if playing
      if (audioRef.current) { audioRef.current.pause(); setPlaying(false); }
      setTimeout(() => onSwipe(dir), 250);
    } else {
      setOff(0);
    }
  };

  // FIX #4: prevent scroll during swipe on mobile
  const handleTouchMove = useCallback((e) => {
    if (drag) { e.preventDefault(); onMove(e.touches[0].clientX); }
  }, [drag]);

  useEffect(() => {
    const el = cardRef.current;
    if (el) el.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => { if (el) el.removeEventListener("touchmove", handleTouchMove); };
  }, [handleTouchMove]);

  const play = (e) => {
    e.stopPropagation();
    if (!song.preview_url) { if(song.spotify_url) window.open(song.spotify_url,"_blank"); return; }
    if (playing) { audioRef.current?.pause(); setPlaying(false); }
    else { if(!audioRef.current) { audioRef.current=new Audio(song.preview_url); audioRef.current.addEventListener("ended",()=>setPlaying(false)); } audioRef.current.play().catch(()=>{}); setPlaying(true); }
  };

  const exitX = exiting === "right" ? 500 : exiting === "left" ? -500 : off;
  const rot = exitX * 0.05;
  const ind = off>50?"HELPED 🙌":off<-50?"NOPE":null;

  return (
    <div ref={cardRef}
      onMouseDown={e=>onStart(e.clientX)} onMouseMove={e=>drag&&onMove(e.clientX)} onMouseUp={onEnd} onMouseLeave={()=>drag&&onEnd()}
      onTouchStart={e=>onStart(e.touches[0].clientX)} onTouchEnd={onEnd}
      style={{background:C.white,borderRadius:20,padding:24,border:`1px solid ${C.border}`,boxShadow:"0 8px 32px rgba(0,0,0,0.08)",cursor:"grab",userSelect:"none",
        transform:`translateX(${exitX}px) rotate(${rot}deg)`,opacity:exiting?0:1-Math.abs(off)/400,transition:drag?"none":"all 0.3s ease",position:"relative",maxWidth:400,margin:"0 auto",touchAction:"pan-y"}}>
      {ind && <div style={{position:"absolute",top:20,left:off>0?20:"auto",right:off<0?20:"auto",background:off>0?C.mint:C.red,color:off>0?C.navy:C.white,padding:"6px 16px",borderRadius:99,fontFamily:hf,fontWeight:800,fontSize:16,transform:"rotate(-12deg)",zIndex:10}}>{ind}</div>}
      {song.album_art && (
        <div onClick={play} style={{borderRadius:16,overflow:"hidden",marginBottom:16,cursor:"pointer",position:"relative"}}>
          <img src={song.album_art} alt="" style={{width:"100%",aspectRatio:"1",objectFit:"cover",display:"block"}} />
          <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.2)",display:"flex",alignItems:"center",justifyContent:"center",opacity:0.8}}>
            <div style={{width:56,height:56,borderRadius:"50%",background:"rgba(255,255,255,0.9)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <span style={{fontSize:24,marginLeft:playing?0:4}}>{playing?"⏸":"▶"}</span>
            </div>
          </div>
        </div>
      )}
      {!song.album_art && (
        <div onClick={play} style={{width:"100%",aspectRatio:"1",borderRadius:16,background:`linear-gradient(135deg, ${C.purple}33, ${C.mint}33)`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16,cursor:"pointer"}}>
          <span style={{fontSize:64}}>🎵</span>
        </div>
      )}
      <h3 style={{fontFamily:hf,fontSize:22,fontWeight:800,color:C.navy,margin:"0 0 4px",textAlign:"center"}}>{song.title}</h3>
      <p style={{fontSize:15,color:C.text2,margin:0,textAlign:"center",fontFamily:bf}}>{song.artist}</p>
      <div style={{display:"flex",justifyContent:"center",gap:32,marginTop:20}}>
        <button onClick={e=>{e.stopPropagation();onSwipe(false);}} style={{width:56,height:56,borderRadius:"50%",background:C.red+"15",border:`2px solid ${C.red}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>✕</button>
        <button onClick={e=>{e.stopPropagation();onSwipe(true);}} style={{width:56,height:56,borderRadius:"50%",background:C.mint+"15",border:`2px solid ${C.mint}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>♥</button>
      </div>
      <p style={{fontSize:12,color:C.text2+"88",textAlign:"center",marginTop:12,fontFamily:bf}}>Tap album art to preview · Swipe or tap buttons</p>
    </div>
  );
}

// ─── Receive Screen ─────────────────────────────────────────────────────
function ReceiveScreen({ mood, user, spToken, onBack, showToast }) {
  const mi = getMood(mood);
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [helped, setHelped] = useState(false);
  const [helpedN, setHelpedN] = useState(0);
  const [swiping, setSwiping] = useState(false);

  useEffect(() => { loadQueue(); }, []);

  const loadQueue = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("get_song_queue", { p_user_id: user.id, p_mood: mood, p_limit: 10 });
      if (error) { console.error(error); showToast("Couldn't load songs. Try again.", "error"); }
      setQueue(data || []);
    } catch (e) { showToast("Couldn't load songs. Try again.", "error"); }
    setIdx(0); setLoading(false);
  };

  const swipe = async (didHelp) => {
    if (swiping) return;
    const song = queue[idx]; if (!song) return;
    setSwiping(true);

    try {
      // FIX #13: record swipe (swipe_id is auto-generated, not passed in notifications)
      const { data: swipeData } = await supabase.from("swipes").insert({ user_id:user.id, song_id:song.song_id, share_id:song.share_id, mood, helped:didHelp }).select("id").single();

      if (didHelp) {
        setHelped(true); setHelpedN(n=>n+1);
        // Auto-add to Buoy playlist
        if (spToken && song.spotify_uri) {
          try {
            const me = await spGet("https://api.spotify.com/v1/me", spToken);
            if (me?.id) { const plId = await getOrCreatePlaylist(spToken, me.id, user.id); if (plId) await addTrack(plId, song.spotify_uri, spToken); }
          } catch(e) { console.error("Playlist error:", e); }
        }
        // FIX #13: Notify sender with actual swipe_id
        const { data: sh } = await supabase.from("shares").select("user_id").eq("id", song.share_id).single();
        if (sh) {
          await supabase.from("notifications").insert({
            user_id: sh.user_id,
            swipe_id: swipeData?.id || null,
            song_id: song.song_id,
            recipient_mood: mood,
          });
        }
      }
    } catch (e) { console.error("Swipe error:", e); }

    setSwiping(false);
    if (idx < queue.length-1) setIdx(i=>i+1); else setIdx(queue.length);
  };

  const cur = queue[idx];
  const done = idx >= queue.length;

  return (
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:C.text2,cursor:"pointer",fontFamily:bf,fontSize:14,padding:"8px 0",marginBottom:16}}>← Back</button>
      {loading && (
        <div style={{textAlign:"center",padding:60}}>
          <div style={{fontSize:40,marginBottom:12}}>🌊</div>
          <p style={{fontFamily:hf,fontWeight:700,fontSize:18,color:C.navy}}>Finding songs for you...</p>
          <p style={{color:C.text2,fontSize:14,fontFamily:bf}}>Real people shared these when they felt good.</p>
        </div>
      )}
      {!loading && queue.length===0 && (
        <div style={{textAlign:"center",padding:60,background:C.white,borderRadius:18,border:`1px solid ${C.border}`}}>
          <h2 style={{fontFamily:hf,fontSize:28,fontWeight:800,color:mi?.color,margin:"0 0 8px"}}>{mi?.label}</h2>
          <p style={{fontFamily:hf,fontWeight:600,fontSize:16,color:C.navy,margin:"0 0 12px"}}>Hey, that's ok.</p>
          <p style={{color:C.text2,fontSize:14,fontFamily:bf,maxWidth:300,margin:"0 auto 20px"}}>People are sending songs right now. Check back soon — new ones are coming in.</p>
          <button onClick={onBack} style={{background:C.pink+"33",border:"none",borderRadius:99,padding:"10px 24px",color:C.navy,fontFamily:hf,fontWeight:700,fontSize:14,cursor:"pointer"}}>Go back</button>
        </div>
      )}
      {!loading && !done && cur && (<>
        <div style={{textAlign:"center",marginBottom:16}}><p style={{color:C.text2,fontSize:13,fontFamily:bf}}>{idx+1} of {queue.length}{helpedN>0?` · ${helpedN} helped`:""}</p></div>
        <SwipeCard song={cur} onSwipe={swipe} />
      </>)}
      {!loading && done && queue.length>0 && (
        <div style={{textAlign:"center",padding:48,background:C.white,borderRadius:18,border:`1px solid ${C.border}`}}>
          {helped ? (<>
            <div style={{fontSize:48,marginBottom:12}}>🎉</div>
            <h2 style={{fontFamily:hf,fontSize:24,fontWeight:800,color:C.navy,margin:"0 0 8px"}}>Feeling better?</h2>
            <p style={{color:C.text2,fontSize:14,fontFamily:bf,margin:"0 0 16px"}}>{helpedN} song{helpedN!==1?"s":""} added to your Buoy playlist.</p>
          </>) : (<>
            <div style={{fontSize:48,marginBottom:12}}>🌊</div>
            <h2 style={{fontFamily:hf,fontSize:24,fontWeight:800,color:C.navy,margin:"0 0 8px"}}>Nothing hit this time</h2>
            <p style={{color:C.text2,fontSize:14,fontFamily:bf,margin:"0 0 16px"}}>More songs are being shared right now. Check back soon.</p>
          </>)}
          <button onClick={onBack} style={{background:C.mint,border:"none",borderRadius:99,padding:"12px 32px",color:C.navy,fontFamily:hf,fontWeight:700,fontSize:15,cursor:"pointer"}}>Done</button>
        </div>
      )}
    </div>
  );
}

// ─── Profile Screen ─────────────────────────────────────────────────────
function ProfileScreen({ user, notifs }) {
  const [stats, setStats] = useState({shared:0,helped:0,saved:0});
  const [artists, setArtists] = useState([]);
  const [helpedSongs, setHelpedSongs] = useState([]);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  useEffect(() => { if(user) load(); }, [user]);

  const load = async () => {
    const {count:sc} = await supabase.from("shares").select("*",{count:"exact",head:true}).eq("user_id",user.id);
    const {count:hc} = await supabase.from("notifications").select("*",{count:"exact",head:true}).eq("user_id",user.id);
    const {count:vc} = await supabase.from("swipes").select("*",{count:"exact",head:true}).eq("user_id",user.id).eq("helped",true);
    setStats({shared:sc||0,helped:hc||0,saved:vc||0});

    const {data:shares} = await supabase.from("shares").select("mood, songs(title, artist)").eq("user_id",user.id).order("created_at",{ascending:false}).limit(50);
    if (shares) {
      const ac = {};
      shares.forEach(s => { const a=s.songs?.artist; if(a) ac[a]=(ac[a]||0)+1; });
      setArtists(Object.entries(ac).sort((a,b)=>b[1]-a[1]).slice(0,5));
    }

    const {data:hs} = await supabase.from("swipes").select("mood, songs(title, artist, album_art)").eq("user_id",user.id).eq("helped",true).order("created_at",{ascending:false}).limit(20);
    if (hs) setHelpedSongs(hs);
  };

  const unread = notifs.filter(n=>!n.read).length;

  return (
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <h2 style={{fontFamily:hf,fontSize:28,fontWeight:800,color:C.navy,margin:"0 0 24px"}}>Your Impact</h2>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:28}}>
        {[{l:"Songs Shared",v:stats.shared,c:C.mint,i:"🎵"},{l:"People Helped",v:stats.helped,c:C.purple,i:"🙌"},{l:"Songs Saved",v:stats.saved,c:C.gold,i:"💛"}].map(s=>(
          <div key={s.l} style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,textAlign:"center"}}>
            <div style={{fontSize:24,marginBottom:4}}>{s.i}</div>
            <div style={{fontFamily:hf,fontSize:30,fontWeight:800,color:s.c}}>{s.v}</div>
            <div style={{fontSize:12,color:C.text2,marginTop:4,fontFamily:bf}}>{s.l}</div>
          </div>
        ))}
      </div>

      {notifs.length>0 && (
        <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
          <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:"0 0 12px"}}>Notifications {unread>0&&<span style={{background:C.mint,color:C.navy,borderRadius:99,padding:"2px 8px",fontSize:12,fontWeight:700,marginLeft:6}}>{unread} new</span>}</h3>
          {notifs.slice(0,5).map(n=>(
            <div key={n.id} style={{padding:"10px 0",borderBottom:`1px solid ${C.bg}`,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:20}}>🙌</span>
              <div>
                <p style={{fontFamily:bf,fontSize:13,color:C.navy,margin:0,fontWeight:n.read?400:700}}>You helped someone feel better{n.recipient_mood?` when they were ${n.recipient_mood}`:""}</p>
                <p style={{fontSize:11,color:C.text2,margin:"2px 0 0"}}>{new Date(n.created_at).toLocaleDateString()}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {artists.length>0 && (
        <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
          <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:"0 0 12px"}}>When you feel good, you share</h3>
          {artists.map(([a,c])=>(
            <div key={a} style={{display:"flex",justifyContent:"space-between",padding:"6px 0"}}>
              <span style={{fontFamily:bf,fontSize:14,color:C.navy}}>{a}</span>
              <span style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.mint}}>{c}x</span>
            </div>
          ))}
        </div>
      )}

      {helpedSongs.length>0 && (
        <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
          <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:"0 0 12px"}}>Songs that helped you</h3>
          {helpedSongs.map((s,i)=>{const m=getMood(s.mood); return (
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:i<helpedSongs.length-1?`1px solid ${C.bg}`:"none"}}>
              {s.songs?.album_art?<img src={s.songs.album_art} alt="" style={{width:36,height:36,borderRadius:6}} />:<div style={{width:36,height:36,borderRadius:6,background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>🎵</div>}
              <div style={{flex:1}}><div style={{fontFamily:bf,fontSize:13,fontWeight:600,color:C.navy}}>{s.songs?.title}</div><div style={{fontSize:11,color:C.text2}}>{s.songs?.artist}</div></div>
              <span style={{fontSize:11,padding:"2px 8px",borderRadius:99,background:m?.color+"22",color:C.navy,fontWeight:600,fontFamily:bf}}>helped when {m?.label}</span>
            </div>
          );})}
        </div>
      )}

      {stats.shared===0&&stats.saved===0 && (
        <div style={{textAlign:"center",padding:48,color:C.text2,fontFamily:bf}}><Logo size={48} /><p style={{marginTop:16}}>Check in with your mood to get started.</p></div>
      )}

      {/* FIX #10: sign out with confirmation */}
      {!confirmSignOut ? (
        <button onClick={()=>setConfirmSignOut(true)}
          style={{background:"none",border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 16px",color:C.text2,fontFamily:bf,fontSize:13,cursor:"pointer",marginTop:20}}>Sign Out</button>
      ) : (
        <div style={{marginTop:20,display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontFamily:bf,fontSize:13,color:C.text2}}>Sign out?</span>
          <button onClick={async()=>{await supabase.auth.signOut();window.location.reload();}}
            style={{background:C.red,border:"none",borderRadius:8,padding:"6px 14px",color:C.white,fontFamily:bf,fontSize:13,fontWeight:600,cursor:"pointer"}}>Yes</button>
          <button onClick={()=>setConfirmSignOut(false)}
            style={{background:C.bg,border:"none",borderRadius:8,padding:"6px 14px",color:C.text2,fontFamily:bf,fontSize:13,cursor:"pointer"}}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────
export default function BuoyApp() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [screen, setScreen] = useState("checkin");
  const [mood, setMood] = useState(null);
  const [nav, setNav] = useState("home");
  const [spToken, setSpToken] = useState(null);
  const [notifs, setNotifs] = useState([]);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type="info") => {
    setToast({ message, type, key: Date.now() });
  }, []);

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({data:{session}}) => { setUser(session?.user||null); setAuthLoading(false); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_,session) => { setUser(session?.user||null); });
    return () => subscription.unsubscribe();
  }, []);

  // FIX #1: Spotify callback — use localStorage flag to distinguish from magic link
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    const isSpotifyCallback = localStorage.getItem("sp_pending") === "1";

    if (code && isSpotifyCallback) {
      localStorage.removeItem("sp_pending");
      exchangeCode(code).then(async (d) => {
        if (d.access_token) {
          spotifyState.token = d.access_token;
          spotifyState.refreshToken = d.refresh_token;
          spotifyState.userId = user?.id;
          setSpToken(d.access_token);
          if (user) {
            const me = await spGet("https://api.spotify.com/v1/me", d.access_token);
            await supabase.from("profiles").update({
              spotify_id:me?.id, spotify_access_token:d.access_token,
              spotify_refresh_token:d.refresh_token, spotify_token_expiry:Date.now()+d.expires_in*1000,
            }).eq("id", user.id);
          }
        } else {
          showToast("Spotify connection failed. Try again.", "error");
        }
        window.history.replaceState({}, "", window.location.pathname);
      });
    }
  }, [user]);

  // Load stored Spotify token
  useEffect(() => {
    if (!user || spToken) return;
    supabase.from("profiles").select("spotify_access_token,spotify_refresh_token,spotify_token_expiry").eq("id",user.id).single()
      .then(async ({data}) => {
        if (!data) return;
        spotifyState.userId = user.id;
        if (data.spotify_refresh_token) spotifyState.refreshToken = data.spotify_refresh_token;

        if (data.spotify_access_token && data.spotify_token_expiry > Date.now()) {
          spotifyState.token = data.spotify_access_token;
          setSpToken(data.spotify_access_token);
        } else if (data.spotify_refresh_token) {
          try {
            const f = await refreshTokenFn(data.spotify_refresh_token);
            if (f.access_token) {
              spotifyState.token = f.access_token;
              if (f.refresh_token) spotifyState.refreshToken = f.refresh_token;
              setSpToken(f.access_token);
              await supabase.from("profiles").update({ spotify_access_token:f.access_token, spotify_token_expiry:Date.now()+f.expires_in*1000, ...(f.refresh_token?{spotify_refresh_token:f.refresh_token}:{}) }).eq("id",user.id);
            } else {
              // FIX #6: refresh failed, prompt reconnect
              showToast("Spotify disconnected. Please reconnect.", "error");
            }
          } catch (e) {
            showToast("Spotify disconnected. Please reconnect.", "error");
          }
        }
      });
  }, [user]);

  // Notifications
  useEffect(() => {
    if (!user) return;
    supabase.from("notifications").select("*").eq("user_id",user.id).order("created_at",{ascending:false}).limit(20)
      .then(({data}) => setNotifs(data||[]));
  }, [user, screen]);

  const handleMood = async (moodId, type) => {
    setMood(moodId); setScreen(type==="bad"?"receive":"share"); setNav("home");
    if (user) await supabase.from("checkins").insert({user_id:user.id,mood_type:type,mood:moodId});
  };
  const goHome = () => { setNav("home"); setScreen("checkin"); setMood(null); };
  const goProfile = () => { setNav("profile"); setScreen("profile"); };

  if (authLoading) return <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}><Logo size={48}/></div>;
  if (!user) return <AuthScreen />;

  const unread = notifs.filter(n=>!n.read).length;

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text1,fontFamily:bf}}>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.2)}100%{transform:scale(1)}}
        *{box-sizing:border-box}::selection{background:${C.mint}44}input::placeholder{color:${C.text2}88}
        @media(max-width:480px){
          .buoy-header-nav{gap:2px!important}
          .buoy-header-nav button{padding:6px 10px!important;font-size:12px!important}
        }
      `}</style>
      <AccentBar />
      {/* FIX #7: responsive header */}
      <header style={{position:"sticky",top:0,zIndex:100,background:C.bg+"EE",backdropFilter:"blur(16px)",borderBottom:`1px solid ${C.border}`,padding:"10px 16px 10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",marginLeft:6}}>
        <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",flexShrink:0}} onClick={goHome}>
          <Logo size={28} /><span style={{fontFamily:hf,fontWeight:900,fontSize:18,color:C.navy,letterSpacing:"1px"}}>BUOY</span>
        </div>
        <nav className="buoy-header-nav" style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
          {!spToken && <button onClick={spotifyLogin} style={{background:"transparent",border:`1.5px solid ${C.spotify}`,borderRadius:99,padding:"5px 12px",cursor:"pointer",color:C.spotify,fontFamily:bf,fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>🎧 Connect Spotify</button>}
          {spToken && <span style={{fontSize:11,color:C.spotify,fontWeight:600,fontFamily:bf,display:"flex",alignItems:"center",gap:4,marginRight:4}}><span style={{width:6,height:6,borderRadius:"50%",background:C.spotify}}/>Connected</span>}
          <button onClick={goHome} style={{background:nav==="home"?C.navy:"transparent",border:"none",borderRadius:10,padding:"8px 14px",cursor:"pointer",color:nav==="home"?C.white:C.text2,fontFamily:bf,fontSize:13,fontWeight:nav==="home"?600:500,whiteSpace:"nowrap"}}>🏠 Check In</button>
          <button onClick={goProfile} style={{background:nav==="profile"?C.navy:"transparent",border:"none",borderRadius:10,padding:"8px 14px",cursor:"pointer",color:nav==="profile"?C.white:C.text2,fontFamily:bf,fontSize:13,fontWeight:nav==="profile"?600:500,position:"relative",whiteSpace:"nowrap"}}>
            👤 Profile{unread>0&&<span style={{position:"absolute",top:2,right:2,width:8,height:8,borderRadius:"50%",background:C.red}}/>}
          </button>
        </nav>
      </header>
      <main style={{padding:"32px 20px 80px",marginLeft:6}}>
        {screen==="checkin" && <MoodCheckIn onMoodSet={handleMood} />}
        {screen==="share" && <ShareScreen mood={mood} spToken={spToken} user={user} onBack={goHome} showToast={showToast} />}
        {screen==="receive" && <ReceiveScreen mood={mood} user={user} spToken={spToken} onBack={goHome} showToast={showToast} />}
        {screen==="profile" && <ProfileScreen user={user} notifs={notifs} />}
      </main>
      {toast && <Toast message={toast.message} type={toast.type} onDone={()=>setToast(null)} key={toast.key} />}
    </div>
  );
}
