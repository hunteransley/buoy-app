import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

// ═══════════════════════════════════════════════════════════════════════
// BUOY — Mood-based music sharing with Spotify + Supabase
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
async function refreshToken(rt) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, grant_type: "refresh_token", refresh_token: rt }),
  });
  return r.json();
}

// ─── Spotify API ────────────────────────────────────────────────────────
const spGet = async (url, tk) => { const r = await fetch(url, {headers:{Authorization:`Bearer ${tk}`}}); return r.ok ? r.json() : null; };
const spPost = async (url, tk, body) => { const r = await fetch(url, {method:"POST",headers:{Authorization:`Bearer ${tk}`,"Content-Type":"application/json"},body:JSON.stringify(body)}); return r.json(); };

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
async function addTrack(plId, uri, tk) {
  await fetch(`https://api.spotify.com/v1/playlists/${plId}/tracks`, { method:"POST", headers:{Authorization:`Bearer ${tk}`,"Content-Type":"application/json"}, body:JSON.stringify({uris:[uri]}) });
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

// ─── Small Components ───────────────────────────────────────────────────
function AccentBar() { return <div style={{position:"fixed",left:0,top:0,bottom:0,width:6,background:`linear-gradient(180deg,${C.purple} 0%,${C.mint} 25%,${C.gold} 50%,${C.pink} 75%,${C.purple} 100%)`,zIndex:999}} />; }
function Logo({ size=32 }) { return <img src="/buoy-logo.png" alt="Buoy" style={{width:size,height:size,objectFit:"contain"}} />; }

// ─── Auth Screen ────────────────────────────────────────────────────────
function AuthScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true);
    await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    setSent(true); setLoading(false);
  };
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <AccentBar />
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <Logo size={64} />
      <h1 style={{fontFamily:hf,fontSize:36,fontWeight:800,color:C.navy,margin:"20px 0 8px"}}>BUOY</h1>
      <p style={{color:C.text2,fontSize:15,fontFamily:bf,textAlign:"center",maxWidth:320,marginBottom:32}}>Share music when you feel good.<br/>Receive music when you don't.</p>
      {!sent ? (
        <div style={{background:C.white,borderRadius:16,padding:24,border:`1px solid ${C.border}`,width:"100%",maxWidth:360}}>
          <label style={{fontSize:13,color:C.text2,fontWeight:600,display:"block",marginBottom:8,fontFamily:bf}}>Email</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}
            placeholder="you@email.com" style={{width:"100%",background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",color:C.navy,fontFamily:bf,fontSize:15,outline:"none",marginBottom:16,boxSizing:"border-box"}} />
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
          <h1 style={{fontFamily:hf,fontSize:48,fontWeight:800,color:C.navy,margin:"20px 0 0",lineHeight:1.1}}>How<br/>are you<br/>doing?</h1>
          <div style={{display:"flex",gap:20,marginTop:40}}>
            <button onClick={()=>go("good")} style={{background:C.mint,border:"none",borderRadius:16,padding:"32px 48px",cursor:"pointer",minWidth:200,boxShadow:`0 4px 12px ${C.mint}33`}}>
              <span style={{fontFamily:hf,fontWeight:800,fontSize:28,color:C.navy}}>GOOD</span></button>
            <button onClick={()=>go("bad")} style={{background:C.pink,border:"none",borderRadius:16,padding:"32px 48px",cursor:"pointer",minWidth:200,boxShadow:`0 4px 12px ${C.pink}33`}}>
              <span style={{fontFamily:hf,fontWeight:800,fontSize:28,color:C.navy}}>BAD</span></button>
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
function ShareScreen({ mood, spToken, user, onBack }) {
  const mi = getMood(mood);
  const [tab, setTab] = useState("search");
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [recent, setRecent] = useState([]);
  const [top, setTop] = useState([]);
  const [prevSent, setPrevSent] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState([]);

  useEffect(() => {
    if (spToken) { getRecent(spToken).then(setRecent); getTop(spToken).then(setTop); }
    if (user) {
      supabase.from("shares").select("song_id, songs(*)").eq("user_id",user.id).order("created_at",{ascending:false}).limit(20)
        .then(({data}) => { if(data) setPrevSent(data.filter(d=>d.songs).map(d=>({id:d.songs.id,title:d.songs.title,artist:d.songs.artist,albumArt:d.songs.album_art,previewUrl:d.songs.preview_url,spotifyUri:d.songs.spotify_uri,spotifyUrl:d.songs.spotify_url}))); });
    }
  }, [spToken, user]);

  const search = async () => { if(!q.trim()||!spToken) return; setSearching(true); setResults(await searchSpotify(q,spToken)); setSearching(false); };
  const send = async (song) => {
    setSending(song.id);
    await supabase.from("songs").upsert({id:song.id,title:song.title,artist:song.artist,album_art:song.albumArt,preview_url:song.previewUrl,spotify_uri:song.spotifyUri,spotify_url:song.spotifyUrl},{onConflict:"id"});
    await supabase.from("shares").insert({user_id:user.id,song_id:song.id,mood});
    setSent(p=>[...p,song.id]); setSending(null);
  };

  const renderList = (songs) => (
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:12}}>
      {songs.map(s => (
        <div key={s.id} style={{background:C.bg,borderRadius:12,padding:12,display:"flex",alignItems:"center",gap:12}}>
          {s.albumArt ? <img src={s.albumArt} alt="" style={{width:48,height:48,borderRadius:8}} /> : <div style={{width:48,height:48,borderRadius:8,background:mi?.color+"22",display:"flex",alignItems:"center",justifyContent:"center"}}>🎵</div>}
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.navy,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.title}</div>
            <div style={{fontSize:12,color:C.text2}}>{s.artist}</div>
          </div>
          <button onClick={()=>send(s)} disabled={sending===s.id||sent.includes(s.id)}
            style={{background:sent.includes(s.id)?C.mint+"33":C.mint,border:"none",borderRadius:10,padding:"8px 16px",cursor:sent.includes(s.id)?"default":"pointer",color:C.navy,fontFamily:bf,fontWeight:700,fontSize:13,opacity:sending===s.id?0.5:1}}>
            {sent.includes(s.id)?"Sent ✓":sending===s.id?"...":"Send 🌊"}
          </button>
        </div>
      ))}
      {songs.length===0 && <div style={{textAlign:"center",color:C.text2,padding:24,fontFamily:bf}}>No songs found</div>}
    </div>
  );

  const tabs = [{id:"search",label:"Search"},{id:"recent",label:"Recent"},{id:"top",label:"Top Tracks"},{id:"sent",label:"Previously Sent"}];

  return (
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:C.text2,cursor:"pointer",fontFamily:bf,fontSize:14,padding:"8px 0",marginBottom:16}}>← Back</button>
      <div style={{textAlign:"center",marginBottom:24}}>
        <h2 style={{fontFamily:hf,fontSize:28,fontWeight:800,color:C.navy,margin:"0 0 4px"}}>Feeling {mi?.label}</h2>
        <p style={{color:C.text2,fontSize:14,fontFamily:bf}}>Share a song. It'll reach someone who needs it.</p>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{background:tab===t.id?C.navy:C.white,border:`1px solid ${tab===t.id?C.navy:C.border}`,borderRadius:99,padding:"6px 14px",color:tab===t.id?C.white:C.text2,fontFamily:bf,fontSize:13,fontWeight:600,cursor:"pointer"}}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:20}}>
        {tab==="search" && (<>
          <div style={{display:"flex",gap:8}}>
            <input type="text" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()}
              placeholder="Song or artist..." style={{flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",color:C.navy,fontFamily:bf,fontSize:14,outline:"none"}} />
            <button onClick={search} disabled={searching} style={{background:C.navy,border:"none",borderRadius:10,padding:"10px 20px",color:C.white,fontFamily:bf,fontWeight:700,fontSize:14,cursor:"pointer"}}>{searching?"...":"Search"}</button>
          </div>
          {renderList(results)}
        </>)}
        {tab==="recent" && renderList(recent)}
        {tab==="top" && renderList(top)}
        {tab==="sent" && renderList(prevSent)}
      </div>
      {sent.length>0 && (
        <div style={{textAlign:"center",marginTop:20,padding:16,background:C.mint+"22",borderRadius:12}}>
          <p style={{fontFamily:hf,fontWeight:700,fontSize:16,color:C.navy,margin:0}}>🌊 {sent.length} song{sent.length!==1?"s":""} sent into the world</p>
        </div>
      )}
    </div>
  );
}

// ─── Swipe Card ─────────────────────────────────────────────────────────
function SwipeCard({ song, onSwipe }) {
  const [off, setOff] = useState(0);
  const [drag, setDrag] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const startX = useRef(0);

  const onStart = (x) => { startX.current=x; setDrag(true); };
  const onMove = (x) => { if(drag) setOff(x-startX.current); };
  const onEnd = () => { setDrag(false); if(Math.abs(off)>100) onSwipe(off>0); setOff(0); };

  const play = (e) => {
    e.stopPropagation();
    if (!song.preview_url) { if(song.spotify_url) window.open(song.spotify_url,"_blank"); return; }
    if (playing) { audioRef.current?.pause(); setPlaying(false); }
    else { if(!audioRef.current) { audioRef.current=new Audio(song.preview_url); audioRef.current.addEventListener("ended",()=>setPlaying(false)); } audioRef.current.play(); setPlaying(true); }
  };

  const rot = off*0.05;
  const ind = off>50?"HELPED 🙌":off<-50?"NOPE":null;

  return (
    <div onMouseDown={e=>onStart(e.clientX)} onMouseMove={e=>drag&&onMove(e.clientX)} onMouseUp={onEnd} onMouseLeave={()=>drag&&onEnd()}
      onTouchStart={e=>onStart(e.touches[0].clientX)} onTouchMove={e=>onMove(e.touches[0].clientX)} onTouchEnd={onEnd}
      style={{background:C.white,borderRadius:20,padding:24,border:`1px solid ${C.border}`,boxShadow:"0 8px 32px rgba(0,0,0,0.08)",cursor:"grab",userSelect:"none",
        transform:`translateX(${off}px) rotate(${rot}deg)`,opacity:1-Math.abs(off)/300,transition:drag?"none":"all 0.3s ease",position:"relative",maxWidth:400,margin:"0 auto"}}>
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
      <h3 style={{fontFamily:hf,fontSize:22,fontWeight:800,color:C.navy,margin:"0 0 4px",textAlign:"center"}}>{song.title}</h3>
      <p style={{fontSize:15,color:C.text2,margin:0,textAlign:"center",fontFamily:bf}}>{song.artist}</p>
      <div style={{display:"flex",justifyContent:"center",gap:32,marginTop:20}}>
        <button onClick={e=>{e.stopPropagation();onSwipe(false);}} style={{width:56,height:56,borderRadius:"50%",background:C.red+"15",border:`2px solid ${C.red}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>✕</button>
        <button onClick={e=>{e.stopPropagation();onSwipe(true);}} style={{width:56,height:56,borderRadius:"50%",background:C.mint+"15",border:`2px solid ${C.mint}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>♥</button>
      </div>
      <p style={{fontSize:12,color:C.text2+"88",textAlign:"center",marginTop:12,fontFamily:bf}}>Tap to preview · Swipe or tap buttons</p>
    </div>
  );
}

// ─── Receive Screen ─────────────────────────────────────────────────────
function ReceiveScreen({ mood, user, spToken, onBack }) {
  const mi = getMood(mood);
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [helped, setHelped] = useState(false);
  const [helpedN, setHelpedN] = useState(0);

  useEffect(() => { loadQueue(); }, []);

  const loadQueue = async () => {
    setLoading(true);
    const { data } = await supabase.rpc("get_song_queue", { p_user_id: user.id, p_mood: mood, p_limit: 10 });
    setQueue(data || []); setIdx(0); setLoading(false);
  };

  const swipe = async (didHelp) => {
    const song = queue[idx]; if (!song) return;
    await supabase.from("swipes").insert({ user_id:user.id, song_id:song.song_id, share_id:song.share_id, mood, helped:didHelp });
    if (didHelp) {
      setHelped(true); setHelpedN(n=>n+1);
      // Auto-add to Buoy playlist
      if (spToken && song.spotify_uri) {
        try {
          const me = await spGet("https://api.spotify.com/v1/me", spToken);
          if (me?.id) { const plId = await getOrCreatePlaylist(spToken, me.id, user.id); if (plId) await addTrack(plId, song.spotify_uri, spToken); }
        } catch(e) { console.error(e); }
      }
      // Notify sender
      const { data: sh } = await supabase.from("shares").select("user_id").eq("id", song.share_id).single();
      if (sh) await supabase.from("notifications").insert({ user_id:sh.user_id, swipe_id:null, song_id:song.song_id, recipient_mood:mood });
    }
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
          <p style={{color:C.text2,fontSize:14,fontFamily:bf,maxWidth:300,margin:"0 auto"}}>People are sending songs right now. Check back soon — new ones are coming in.</p>
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

      <button onClick={async()=>{await supabase.auth.signOut();window.location.reload();}}
        style={{background:"none",border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 16px",color:C.text2,fontFamily:bf,fontSize:13,cursor:"pointer",marginTop:20}}>Sign Out</button>
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

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({data:{session}}) => { setUser(session?.user||null); setAuthLoading(false); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_,session) => { setUser(session?.user||null); });
    return () => subscription.unsubscribe();
  }, []);

  // Spotify callback
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    // Only handle if it's a Spotify callback (not Supabase magic link)
    if (code && !window.location.hash.includes("access_token") && !p.get("type")) {
      exchangeCode(code).then(async (d) => {
        if (d.access_token) {
          setSpToken(d.access_token);
          if (user) {
            const me = await spGet("https://api.spotify.com/v1/me", d.access_token);
            await supabase.from("profiles").update({
              spotify_id:me?.id, spotify_access_token:d.access_token,
              spotify_refresh_token:d.refresh_token, spotify_token_expiry:Date.now()+d.expires_in*1000,
            }).eq("id", user.id);
          }
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
        if (data.spotify_access_token && data.spotify_token_expiry > Date.now()) { setSpToken(data.spotify_access_token); }
        else if (data.spotify_refresh_token) {
          const f = await refreshToken(data.spotify_refresh_token);
          if (f.access_token) {
            setSpToken(f.access_token);
            await supabase.from("profiles").update({ spotify_access_token:f.access_token, spotify_token_expiry:Date.now()+f.expires_in*1000, ...(f.refresh_token?{spotify_refresh_token:f.refresh_token}:{}) }).eq("id",user.id);
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
      `}</style>
      <AccentBar />
      <header style={{position:"sticky",top:0,zIndex:100,background:C.bg+"EE",backdropFilter:"blur(16px)",borderBottom:`1px solid ${C.border}`,padding:"10px 24px 10px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",marginLeft:6}}>
        <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={goHome}>
          <Logo size={30} /><span style={{fontFamily:hf,fontWeight:900,fontSize:20,color:C.navy,letterSpacing:"1px"}}>BUOY</span>
        </div>
        <nav style={{display:"flex",gap:4,alignItems:"center"}}>
          {!spToken && <button onClick={spotifyLogin} style={{background:"transparent",border:`1.5px solid ${C.spotify}`,borderRadius:99,padding:"5px 14px",cursor:"pointer",color:C.spotify,fontFamily:bf,fontSize:13,fontWeight:600}}>🎧 Connect Spotify</button>}
          {spToken && <span style={{fontSize:12,color:C.spotify,fontWeight:600,fontFamily:bf,display:"flex",alignItems:"center",gap:4,marginRight:8}}><span style={{width:8,height:8,borderRadius:"50%",background:C.spotify}}/>Connected</span>}
          <button onClick={goHome} style={{background:nav==="home"?C.navy:"transparent",border:"none",borderRadius:10,padding:"8px 16px",cursor:"pointer",color:nav==="home"?C.white:C.text2,fontFamily:bf,fontSize:14,fontWeight:nav==="home"?600:500}}>🏠 Check In</button>
          <button onClick={goProfile} style={{background:nav==="profile"?C.navy:"transparent",border:"none",borderRadius:10,padding:"8px 16px",cursor:"pointer",color:nav==="profile"?C.white:C.text2,fontFamily:bf,fontSize:14,fontWeight:nav==="profile"?600:500,position:"relative"}}>
            👤 Profile{unread>0&&<span style={{position:"absolute",top:2,right:2,width:8,height:8,borderRadius:"50%",background:C.red}}/>}
          </button>
        </nav>
      </header>
      <main style={{padding:"32px 24px 80px",marginLeft:6}}>
        {screen==="checkin" && <MoodCheckIn onMoodSet={handleMood} />}
        {screen==="share" && <ShareScreen mood={mood} spToken={spToken} user={user} onBack={goHome} />}
        {screen==="receive" && <ReceiveScreen mood={mood} user={user} spToken={spToken} onBack={goHome} />}
        {screen==="profile" && <ProfileScreen user={user} notifs={notifs} />}
      </main>
    </div>
  );
}
