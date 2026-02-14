import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";

// ═══════════════════════════════════════════════════════════════════════
// BUOY v4 — Spotify-first auth, cross-device, in-app playback
// ═══════════════════════════════════════════════════════════════════════

// ─── Spotify API (with auto-refresh via Supabase session) ───────────────
const spotifyState = { token: null, refreshToken: null, userId: null };

async function getSpotifyToken() {
  // First check if we have a valid token in state
  if (spotifyState.token) return spotifyState.token;
  
  // Try to get from Supabase session (Supabase stores the provider token)
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.provider_token) {
    spotifyState.token = session.provider_token;
    spotifyState.refreshToken = session.provider_refresh_token;
    return session.provider_token;
  }
  
  // Try from profile
  if (spotifyState.userId) {
    const { data } = await supabase.from("profiles").select("spotify_access_token,spotify_refresh_token,spotify_token_expiry").eq("id", spotifyState.userId).single();
    if (data?.spotify_access_token && data.spotify_token_expiry > Date.now()) {
      spotifyState.token = data.spotify_access_token;
      spotifyState.refreshToken = data.spotify_refresh_token;
      return data.spotify_access_token;
    }
    if (data?.spotify_refresh_token) {
      return await refreshSpotifyToken(data.spotify_refresh_token);
    }
  }
  return null;
}

async function refreshSpotifyToken(rt) {
  try {
    // Use Supabase's built-in refresh if available
    const { data, error } = await supabase.auth.refreshSession();
    if (data?.session?.provider_token) {
      spotifyState.token = data.session.provider_token;
      if (data.session.provider_refresh_token) spotifyState.refreshToken = data.session.provider_refresh_token;
      // Persist to profile
      if (spotifyState.userId) {
        await supabase.from("profiles").update({
          spotify_access_token: data.session.provider_token,
          spotify_token_expiry: Date.now() + 3600000,
          ...(data.session.provider_refresh_token ? { spotify_refresh_token: data.session.provider_refresh_token } : {}),
        }).eq("id", spotifyState.userId);
      }
      return data.session.provider_token;
    }
  } catch (e) { console.error("Supabase refresh failed:", e); }
  
  // Fallback: direct Spotify refresh
  if (rt) {
    try {
      const { data: profile } = await supabase.from("profiles").select("spotify_refresh_token").eq("id", spotifyState.userId).single();
      const refreshTk = rt || profile?.spotify_refresh_token;
      if (!refreshTk) return null;
      
      // We need the client ID from the Supabase Spotify provider config
      // Since we're using Supabase OAuth, we'll rely on the session refresh above
      // If that failed, user needs to re-login
      return null;
    } catch (e) { return null; }
  }
  return null;
}

async function spGet(url) {
  let tk = await getSpotifyToken();
  if (!tk) return null;
  let r = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
  if (r.status === 401) {
    tk = await refreshSpotifyToken(spotifyState.refreshToken);
    if (tk) r = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
    else return null;
  }
  return r.ok ? r.json() : null;
}
async function spPost(url, body) {
  let tk = await getSpotifyToken();
  if (!tk) return null;
  let r = await fetch(url, { method:"POST", headers:{Authorization:`Bearer ${tk}`,"Content-Type":"application/json"}, body:JSON.stringify(body) });
  if (r.status === 401) {
    tk = await refreshSpotifyToken(spotifyState.refreshToken);
    if (tk) r = await fetch(url, { method:"POST", headers:{Authorization:`Bearer ${tk}`,"Content-Type":"application/json"}, body:JSON.stringify(body) });
    else return null;
  }
  return r.ok ? r.json() : null;
}

function mapTrack(t) {
  return { id: t.id, title: t.name, artist: t.artists.map(a=>a.name).join(", "), albumArt: t.album.images?.[1]?.url||t.album.images?.[0]?.url, previewUrl: t.preview_url, spotifyUri: t.uri, spotifyUrl: t.external_urls?.spotify };
}
async function searchSpotify(q) {
  const d = await spGet(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8`);
  return (d?.tracks?.items||[]).map(mapTrack);
}
async function getRecent() {
  const d = await spGet("https://api.spotify.com/v1/me/player/recently-played?limit=20");
  if (!d?.items) return [];
  const seen = new Set();
  return d.items.filter(i => { if (seen.has(i.track.id)) return false; seen.add(i.track.id); return true; }).map(i => mapTrack(i.track));
}
async function getTop() {
  const d = await spGet("https://api.spotify.com/v1/me/top/tracks?limit=20&time_range=short_term");
  return (d?.items||[]).map(mapTrack);
}
async function getOrCreatePlaylist(profileId) {
  const { data: prof } = await supabase.from("profiles").select("spotify_playlist_id,spotify_id").eq("id", profileId).single();
  if (prof?.spotify_playlist_id) {
    const check = await spGet(`https://api.spotify.com/v1/playlists/${prof.spotify_playlist_id}`);
    if (check) return prof.spotify_playlist_id;
  }
  const spUserId = prof?.spotify_id;
  if (!spUserId) return null;
  const pl = await spPost(`https://api.spotify.com/v1/users/${spUserId}/playlists`, { name: "Buoy 🌊", description: "Songs that lifted my mood, curated by real people on Buoy.", public: true });
  if (pl?.id) { await supabase.from("profiles").update({ spotify_playlist_id: pl.id }).eq("id", profileId); return pl.id; }
  return null;
}
async function addTrack(plId, uri) {
  await spPost(`https://api.spotify.com/v1/playlists/${plId}/tracks`, { uris: [uri] });
}

// ─── Design ─────────────────────────────────────────────────────────────
const C = { bg:"#EDEDF0", white:"#FFFFFF", navy:"#1B2138", mint:"#2EECC0", purple:"#B07CFF", pink:"#D98BFF", gold:"#FFD166", blue:"#7EC8E3", red:"#E63946", text1:"#1B2138", text2:"#6B7084", border:"#D8DAE0", spotify:"#1DB954" };
const hf = "'Poppins', sans-serif";
const bf = "'DM Sans', sans-serif";

const MOODS = {
  good: { sub: [{ id:"happy", label:"HAPPY", color:C.mint }, { id:"energized", label:"ENERGIZED", color:C.gold }, { id:"calm", label:"CALM", color:C.blue }, { id:"grateful", label:"GRATEFUL", color:C.mint }] },
  bad: { sub: [{ id:"sad", label:"SAD", color:C.pink }, { id:"tired", label:"TIRED", color:C.pink }, { id:"anxious", label:"ANXIOUS", color:C.pink }, { id:"angry", label:"ANGRY", color:C.pink }] },
};
function getMood(id) { for(const g of Object.values(MOODS)){const f=g.sub.find(s=>s.id===id);if(f)return f;} return null; }
const MOOD_COLORS = { happy:C.mint, energized:C.gold, calm:C.blue, grateful:C.mint, sad:C.pink, tired:C.pink, anxious:C.pink, angry:C.pink };

// ─── Toast ──────────────────────────────────────────────────────────────
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

// ─── Spotify Embed Player ───────────────────────────────────────────────
function SpotifyEmbed({ trackId, compact }) {
  if (!trackId) return null;
  return (
    <iframe
      src={`https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0`}
      width="100%"
      height={compact ? 80 : 152}
      frameBorder="0"
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
      style={{borderRadius:12}}
    />
  );
}

// ─── Auth Screen ────────────────────────────────────────────────────────
function AuthScreen() {
  const [loading, setLoading] = useState(false);
  const login = async () => {
    setLoading(true);
    await supabase.auth.signInWithOAuth({
      provider: "spotify",
      options: {
        redirectTo: window.location.origin,
        scopes: "playlist-modify-public playlist-modify-private user-read-private user-top-read user-read-recently-played",
      },
    });
  };
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <AccentBar />
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}*{box-sizing:border-box}`}</style>
      <Logo size={64} />
      <h1 style={{fontFamily:hf,fontSize:36,fontWeight:800,color:C.navy,margin:"20px 0 12px"}}>BUOY</h1>
      <p style={{color:C.navy,fontSize:18,fontFamily:hf,fontWeight:700,textAlign:"center",maxWidth:320,marginBottom:6}}>Your music knows how you feel.</p>
      <p style={{color:C.text2,fontSize:14,fontFamily:bf,textAlign:"center",maxWidth:300,marginBottom:32}}>Connect Spotify and we'll show you.</p>
      <button onClick={login} disabled={loading}
        style={{background:C.spotify,border:"none",borderRadius:99,padding:"16px 40px",color:C.white,fontFamily:hf,fontWeight:700,fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",gap:10,opacity:loading?0.7:1,boxShadow:`0 4px 16px ${C.spotify}44`}}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
        {loading ? "Reading your vibe..." : "See How You've Been Feeling"}
      </button>
      <p style={{color:C.text2+"88",fontSize:12,marginTop:16,fontFamily:bf,textAlign:"center",maxWidth:280}}>Takes 10 seconds. No password needed.</p>
    </div>
  );
}

// ─── Mood Analysis Engine ────────────────────────────────────────────────
async function analyzeMood() {
  // Pull EVERYTHING Spotify gives us, in parallel for speed
  const [recent, topShort, topMed, topLong, artShort, artMed, artLong] = await Promise.all([
    spGet("https://api.spotify.com/v1/me/player/recently-played?limit=50"),
    spGet("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term"),
    spGet("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term"),
    spGet("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=long_term"),
    spGet("https://api.spotify.com/v1/me/top/artists?limit=50&time_range=short_term"),
    spGet("https://api.spotify.com/v1/me/top/artists?limit=50&time_range=medium_term"),
    spGet("https://api.spotify.com/v1/me/top/artists?limit=50&time_range=long_term"),
  ]);

  const recentItems = recent?.items || [];
  const shortTracks = topShort?.items || [];
  const medTracks = topMed?.items || [];
  const longTracks = topLong?.items || [];
  const shortArtists = artShort?.items || [];
  const medArtists = artMed?.items || [];
  const longArtists = artLong?.items || [];

  if (shortTracks.length === 0 && recentItems.length === 0) return null;

  // ═══════════════════════════════════════════════════════════════════════
  // 1. LISTENING TIMELINE — what your week actually looked like
  // ═══════════════════════════════════════════════════════════════════════
  const dayMap = {};
  recentItems.forEach(item => {
    const day = item.played_at.slice(0, 10);
    if (!dayMap[day]) dayMap[day] = [];
    dayMap[day].push({ track: item.track, played_at: item.played_at });
  });

  const days = Object.entries(dayMap).sort(([a],[b]) => a.localeCompare(b)).map(([date, items]) => {
    const avgPop = items.reduce((s, i) => s + i.track.popularity, 0) / items.length;
    const vibe = avgPop / 100;
    const explicitRatio = items.filter(i => i.track.explicit).length / items.length;
    // Unique artists as diversity signal
    const uniqueArtists = new Set(items.map(i => i.track.artists[0]?.name)).size;
    const diversity = Math.min(uniqueArtists / items.length, 1);

    let mood, emoji, color;
    if (vibe >= 0.72) { mood = "On Top"; emoji = "⚡"; color = C.gold; }
    else if (vibe >= 0.58) { mood = "Cruising"; emoji = "☀️"; color = C.mint; }
    else if (vibe >= 0.44) { mood = "Drifting"; emoji = "🌊"; color = C.blue; }
    else if (vibe >= 0.30) { mood = "Digging Deep"; emoji = "🌙"; color = C.purple; }
    else { mood = "In the Dark"; emoji = "🌧"; color = C.pink; }
    return { date, mood, emoji, color, vibe, explicitRatio, diversity, trackCount: items.length,
      topArt: items[0]?.track.album?.images?.[1]?.url };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. OVERALL VIBE — your emotional center of gravity right now
  // ═══════════════════════════════════════════════════════════════════════
  const vibeSource = shortTracks.length > 0 ? shortTracks : recentItems.map(i => i.track);
  const pops = vibeSource.map(t => t.popularity || 0).filter(p => p > 0);
  const avgPop = pops.length > 0 ? pops.reduce((s, p) => s + p, 0) / pops.length : 50;
  const overallVibe = avgPop / 100;
  const explicitPct = vibeSource.length > 0 ? Math.round((vibeSource.filter(t => t.explicit).length / vibeSource.length) * 100) : 0;

  let overallMood, overallEmoji, overallColor, overallDesc;
  if (overallVibe >= 0.72) {
    overallMood = "Radiating Energy"; overallEmoji = "⚡"; overallColor = C.gold;
    overallDesc = "You're gravitating toward big, bright, undeniable music right now. Main character energy.";
  } else if (overallVibe >= 0.58) {
    overallMood = "Feeling Good"; overallEmoji = "☀️"; overallColor = C.mint;
    overallDesc = "Steady warmth. You're choosing music that keeps the mood lifted without forcing it.";
  } else if (overallVibe >= 0.44) {
    overallMood = "In Between Worlds"; overallEmoji = "🌤"; overallColor = C.blue;
    overallDesc = "Neither high nor low — you're in a contemplative space. Your music is searching for something.";
  } else if (overallVibe >= 0.30) {
    overallMood = "Going Inward"; overallEmoji = "🌙"; overallColor = C.purple;
    overallDesc = "You're drawn to depth right now. The music you're choosing says you're processing something.";
  } else {
    overallMood = "In Your Feels"; overallEmoji = "🌧"; overallColor = C.pink;
    overallDesc = "Raw and real. You're not reaching for easy comfort — you're sitting with it.";
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. ALBUM ART — the visual signature of your listening
  // ═══════════════════════════════════════════════════════════════════════
  const seenArt = new Set();
  const albumArts = [];
  [...shortTracks, ...recentItems.map(i => i.track)].forEach(t => {
    const art = t.album?.images?.[1]?.url || t.album?.images?.[0]?.url;
    if (art && !seenArt.has(art)) { seenArt.add(art); albumArts.push(art); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. GENRE DNA — weighted by artist rank, compared across time
  // ═══════════════════════════════════════════════════════════════════════
  const weightedGenres = (artists) => {
    const scores = {};
    artists.forEach((a, i) => {
      const weight = artists.length - i; // Higher ranked = higher weight
      (a.genres || []).forEach(g => { scores[g] = (scores[g] || 0) + weight; });
    });
    return Object.entries(scores).sort((a, b) => b[1] - a[1]);
  };

  const shortGenres = weightedGenres(shortArtists);
  const longGenres = weightedGenres(longArtists);
  const topGenres = shortGenres.slice(0, 7).map(([g]) => g);

  const longGenreNames = new Set(longGenres.slice(0, 15).map(([g]) => g));
  const shortGenreNames = new Set(shortGenres.slice(0, 15).map(([g]) => g));
  const emergingGenres = topGenres.filter(g => !longGenreNames.has(g)).slice(0, 3);
  const fadingGenres = longGenres.slice(0, 15).map(([g]) => g).filter(g => !shortGenreNames.has(g)).slice(0, 3);

  // ═══════════════════════════════════════════════════════════════════════
  // 5. ARTIST EVOLUTION — who's rising, who's fading, who's forever
  // ═══════════════════════════════════════════════════════════════════════
  const toMap = (list) => {
    const m = {};
    list.forEach((a, i) => {
      m[a.name] = { rank: i, img: a.images?.[2]?.url || a.images?.[0]?.url, name: a.name };
    });
    return m;
  };
  const shortMap = toMap(shortArtists);
  const medMap = toMap(medArtists);
  const longMap = toMap(longArtists);

  const comfortArtists = shortArtists
    .filter(a => medMap[a.name] && longMap[a.name])
    .slice(0, 5)
    .map(a => ({ name: a.name, img: a.images?.[2]?.url || a.images?.[0]?.url }));

  const rising = shortArtists
    .filter(a => !longMap[a.name])
    .slice(0, 5)
    .map(a => ({ name: a.name, img: a.images?.[2]?.url || a.images?.[0]?.url }));

  const fading = longArtists
    .filter(a => !shortMap[a.name])
    .slice(0, 4)
    .map(a => ({ name: a.name, img: a.images?.[2]?.url || a.images?.[0]?.url }));

  // ═══════════════════════════════════════════════════════════════════════
  // 6. KEY TRACKS — your #1 now vs your #1 of all time
  // ═══════════════════════════════════════════════════════════════════════
  const topTrackNow = shortTracks[0];
  const topTrackAllTime = longTracks[0];

  // ═══════════════════════════════════════════════════════════════════════
  // 7. EMOTIONAL DIMENSIONS — how you use music to feel
  // ═══════════════════════════════════════════════════════════════════════

  // Obscurity → reframed as "Depth" — how far beneath the surface you go
  const obscurity = Math.round(100 - avgPop);

  // Loyalty → reframed as "Emotional Anchoring" — do you return to what's safe
  const loyaltyPct = shortArtists.length > 0
    ? Math.round((shortArtists.filter(a => longMap[a.name]).length / shortArtists.length) * 100)
    : 0;

  // Diversity → reframed as "Emotional Range" — how wide your mood palette is
  const uniqueShortArtists = new Set(shortTracks.map(t => t.artists[0]?.name)).size;
  const diversityPct = Math.round((uniqueShortArtists / Math.max(shortTracks.length, 1)) * 100);

  // Volatility — how much your daily vibe swings (from the day data)
  let volatility = 0;
  if (days.length >= 2) {
    const diffs = [];
    for (let i = 1; i < days.length; i++) diffs.push(Math.abs(days[i].vibe - days[i-1].vibe));
    volatility = diffs.length > 0 ? Math.round((diffs.reduce((s,d) => s+d, 0) / diffs.length) * 200) : 0;
  }
  volatility = Math.min(volatility, 100) || 0;

  // Emotional scores — the 4 dimensions we show
  const emotionalScores = [
    { key: "range", label: "Emotional Range", value: diversityPct, color: C.blue,
      desc: diversityPct >= 65 ? "You feel widely. Your music spans the full emotional spectrum."
        : diversityPct >= 40 ? "You have depth in familiar zones, with room to explore."
        : "You go deep, not wide. When something resonates, you stay." },
    { key: "anchoring", label: "Comfort Seeking", value: loyaltyPct, color: C.mint,
      desc: loyaltyPct >= 55 ? "You return to what's safe. Music is your anchor."
        : loyaltyPct >= 30 ? "You balance the familiar and the new."
        : "You're always reaching for something you haven't heard." },
    { key: "depth", label: "Depth", value: obscurity, color: C.purple,
      desc: obscurity >= 55 ? "You dig beneath the surface. The obvious isn't enough."
        : obscurity >= 35 ? "You move between the known and the hidden."
        : "You gravitate toward shared experience — music everyone knows." },
    { key: "volatility", label: "Mood Swing", value: volatility, color: C.gold,
      desc: volatility >= 50 ? "Your mood through music shifts dramatically day to day."
        : volatility >= 20 ? "You have natural ebbs and flows."
        : "Steady. Your emotional baseline through music barely moves." },
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // 8. EMOTIONAL ARCHETYPE — how you use music to process feelings
  // ═══════════════════════════════════════════════════════════════════════
  let personality, personalityEmoji, personalityDesc;
  if (obscurity >= 55 && loyaltyPct <= 35) {
    personality = "The Seeker"; personalityEmoji = "🧭";
    personalityDesc = "You use music to explore feelings you can't name yet. When something shifts inside you, you go looking for the sound that matches.";
  } else if (obscurity >= 55 && loyaltyPct > 35) {
    personality = "The Alchemist"; personalityEmoji = "✨";
    personalityDesc = "You transform how you feel through music. You have trusted artists who know how to take you from one emotional state to another.";
  } else if (obscurity < 35 && loyaltyPct <= 35) {
    personality = "The Mirror"; personalityEmoji = "🪞";
    personalityDesc = "You reach for music that reflects exactly how you already feel. You don't want to be fixed — you want to be understood.";
  } else if (obscurity < 35 && loyaltyPct > 55) {
    personality = "The Anchor"; personalityEmoji = "⚓";
    personalityDesc = "Music is your constant. The same voices, the same sounds — they hold you steady no matter what life does.";
  } else if (diversityPct >= 65) {
    personality = "The Empath"; personalityEmoji = "🌊";
    personalityDesc = "You feel everything, and your music proves it. Your range is rare — you can sit in sadness and dance in joy in the same hour.";
  } else {
    personality = "The Shapeshifter"; personalityEmoji = "🦋";
    personalityDesc = "Your emotional relationship with music is fluid. It shifts with your life, and that's the most honest thing it can do.";
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 9. MOOD NARRATIVE — a sentence that ties it together
  // ═══════════════════════════════════════════════════════════════════════
  const topArtistName = shortArtists[0]?.name || "your favorites";
  const topGenre = topGenres[0] || "eclectic sounds";
  let narrative;
  if (days.length >= 3) {
    const moodShift = days[days.length-1].vibe - days[0].vibe;
    if (moodShift > 0.15) narrative = `Your week started quiet and built toward something brighter. ${topArtistName} has been the soundtrack to that shift.`;
    else if (moodShift < -0.15) narrative = `You started the week high and have been settling into something more introspective. Lots of ${topGenre} in that descent.`;
    else narrative = `Your week has been steady — consistently drawn to ${topGenre} with ${topArtistName} anchoring the mood.`;
  } else {
    narrative = `Right now, your listening is centered around ${topGenre}. ${topArtistName} is your gravity.`;
  }

  return {
    days, overallMood, overallEmoji, overallColor, overallVibe, overallDesc, narrative,
    albumArts: albumArts.slice(0, 9),
    topGenres, emergingGenres, fadingGenres,
    comfortArtists, rising, fading,
    topTrackNow, topTrackAllTime,
    emotionalScores, obscurity, loyaltyPct, diversityPct, explicitPct, volatility,
    personality, personalityEmoji, personalityDesc,
    trackCount: Math.max(vibeSource.length, recentItems.length),
  };
}

// ─── Mood Report UI ─────────────────────────────────────────────────────
function MoodReport({ onContinue }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    analyzeMood().then(d => {
      setData(d);
      setLoading(false);
      setTimeout(() => setRevealed(true), 400);
    }).catch(() => { setLoading(false); });
  }, []);

  if (loading) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"80vh",textAlign:"center"}}>
      <div style={{fontSize:48,marginBottom:16,animation:"float 2s ease-in-out infinite"}}>🎧</div>
      <h2 style={{fontFamily:hf,fontSize:24,fontWeight:800,color:C.navy,margin:"0 0 8px"}}>Reading your music...</h2>
      <p style={{color:C.text2,fontSize:14,fontFamily:bf,maxWidth:280,margin:"0 auto"}}>Analyzing your listening across time</p>
      <div style={{width:200,height:4,background:C.border,borderRadius:99,marginTop:24,overflow:"hidden"}}>
        <div style={{height:"100%",background:`linear-gradient(90deg,${C.mint},${C.purple})`,borderRadius:99,animation:"loading 1.5s ease-in-out infinite"}} />
      </div>
      <style>{`@keyframes loading{0%{width:20%;margin-left:0}50%{width:60%;margin-left:20%}100%{width:20%;margin-left:80%}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}`}</style>
    </div>
  );

  if (!data) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"80vh",textAlign:"center"}}>
      <div style={{fontSize:48,marginBottom:16}}>🎵</div>
      <h2 style={{fontFamily:hf,fontSize:24,fontWeight:800,color:C.navy,margin:"0 0 8px"}}>Couldn't read your music yet</h2>
      <p style={{color:C.text2,fontSize:14,fontFamily:bf,maxWidth:300,margin:"0 auto 24px"}}>Try signing out and back in to refresh your Spotify connection.</p>
      <button onClick={onContinue} style={{background:C.mint,border:"none",borderRadius:99,padding:"14px 36px",color:C.navy,fontFamily:hf,fontWeight:700,fontSize:16,cursor:"pointer"}}>Continue anyway</button>
    </div>
  );

  const d = data;

  // Reusable artist row
  const ArtistRow = ({a}) => (
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0"}}>
      {a.img ? <img src={a.img} alt="" style={{width:32,height:32,borderRadius:"50%",objectFit:"cover"}} />
        : <div style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.1)"}} />}
      <span style={{fontSize:14,fontFamily:bf,fontWeight:600}}>{a.name}</span>
    </div>
  );

  // Reusable track row
  const TrackRow = ({t, label}) => t ? (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:14,background:C.bg,borderRadius:14}}>
      {t.album?.images?.[1]?.url && <img src={t.album.images[1].url} alt="" style={{width:52,height:52,borderRadius:10}} />}
      <div style={{flex:1,minWidth:0}}>
        <p style={{fontSize:11,color:C.text2,fontFamily:bf,margin:"0 0 2px",textTransform:"uppercase",letterSpacing:"0.5px"}}>{label}</p>
        <p style={{fontFamily:hf,fontWeight:700,fontSize:15,color:C.navy,margin:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.name}</p>
        <p style={{fontSize:12,color:C.text2,margin:0}}>{t.artists?.[0]?.name}</p>
      </div>
    </div>
  ) : null;

  return (
    <div style={{maxWidth:440,margin:"0 auto",opacity:revealed?1:0,transition:"opacity 0.6s ease"}}>

      {/* ═══════════════════════════════════════════════════════════════════
          THE CARD — the screenshotable piece, the viral asset
          ═══════════════════════════════════════════════════════════════════ */}
      <div style={{
        background:`linear-gradient(155deg, ${C.navy} 0%, #1a2240 55%, ${d.overallColor}18 100%)`,
        borderRadius:24, padding:"28px 24px", color:C.white, position:"relative", overflow:"hidden", marginBottom:20,
      }}>
        {/* Background orbs */}
        <div style={{position:"absolute",top:-50,right:-50,width:180,height:180,borderRadius:"50%",background:d.overallColor+"15"}} />
        <div style={{position:"absolute",bottom:-35,left:-35,width:130,height:130,borderRadius:"50%",background:C.purple+"0C"}} />

        <div style={{position:"relative",zIndex:1}}>
          {/* Brand + date */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:22}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}>
              <Logo size={20} />
              <span style={{fontFamily:hf,fontWeight:800,fontSize:11,letterSpacing:"2.5px",opacity:0.45}}>BUOY</span>
            </div>
            <span style={{fontSize:10,opacity:0.25,fontFamily:bf}}>{new Date().toLocaleDateString("en",{month:"long",year:"numeric"})}</span>
          </div>

          {/* Mood headline */}
          <div style={{marginBottom:22}}>
            <div style={{fontSize:42,marginBottom:8}}>{d.overallEmoji}</div>
            <h2 style={{fontFamily:hf,fontSize:32,fontWeight:900,margin:"0 0 10px",lineHeight:1.05,letterSpacing:"-0.5px"}}>{d.overallMood}</h2>
            <p style={{fontSize:13,opacity:0.6,fontFamily:bf,margin:0,lineHeight:1.55,maxWidth:340}}>{d.overallDesc}</p>
          </div>

          {/* Album art grid */}
          {d.albumArts.length >= 4 && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:3,marginBottom:22,borderRadius:14,overflow:"hidden"}}>
              {d.albumArts.slice(0, 9).map((a,i) => (
                <img key={i} src={a} alt="" style={{width:"100%",aspectRatio:"1",objectFit:"cover",display:"block"}} />
              ))}
            </div>
          )}

          {/* Personality badge */}
          <div style={{background:"rgba(255,255,255,0.06)",borderRadius:14,padding:"16px 18px",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <span style={{fontSize:22}}>{d.personalityEmoji}</span>
              <span style={{fontFamily:hf,fontWeight:800,fontSize:20}}>{d.personality}</span>
            </div>
            <p style={{fontSize:12,opacity:0.55,fontFamily:bf,margin:0,lineHeight:1.45}}>{d.personalityDesc}</p>
          </div>

          {/* Emotional dimensions */}
          <div style={{marginBottom:18}}>
            {d.emotionalScores.map(s => (
              <div key={s.key} style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <span style={{fontSize:10,opacity:0.5,fontFamily:bf,textTransform:"uppercase",letterSpacing:"1px"}}>{s.label}</span>
                  <span style={{fontSize:13,fontFamily:hf,fontWeight:700,color:s.color}}>{s.value}%</span>
                </div>
                <div style={{height:4,background:"rgba(255,255,255,0.08)",borderRadius:99,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${Math.max(s.value, 3)}%`,background:s.color,borderRadius:99,transition:"width 0.8s ease"}} />
                </div>
              </div>
            ))}
          </div>

          {/* Week bars */}
          {d.days.length > 1 && (
            <div style={{marginBottom:18}}>
              <p style={{fontSize:9,textTransform:"uppercase",letterSpacing:"2px",opacity:0.3,fontFamily:bf,margin:"0 0 10px"}}>Your Mood This Week</p>
              <div style={{display:"flex",gap:4,alignItems:"flex-end",height:56}}>
                {d.days.map((day,i) => {
                  const h = 14 + day.vibe * 42;
                  const label = new Date(day.date+"T12:00:00").toLocaleDateString("en",{weekday:"narrow"});
                  return (
                    <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",height:"100%"}}>
                      <div style={{width:"100%",height:h,background:`linear-gradient(180deg,${day.color},${day.color}66)`,borderRadius:5}} />
                      <span style={{fontSize:8,opacity:0.35,fontFamily:bf,marginTop:3}}>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Genre pills */}
          {d.topGenres.length > 0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {d.topGenres.map(g => (
                <span key={g} style={{fontSize:10,padding:"4px 10px",borderRadius:99,background:"rgba(255,255,255,0.07)",fontFamily:bf,fontWeight:500,opacity:0.6}}>{g}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          NARRATIVE — the human insight
          ═══════════════════════════════════════════════════════════════════ */}
      {d.narrative && (
        <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:"16px 18px",marginBottom:16}}>
          <p style={{fontFamily:bf,fontSize:14,color:C.navy,margin:0,lineHeight:1.55,fontStyle:"italic"}}>{d.narrative}</p>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          DEEP DIVE TABS
          ═══════════════════════════════════════════════════════════════════ */}
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {["Overview","Artists","Evolution"].map((label, i) => (
          <button key={label} onClick={()=>setTab(i)} style={{
            flex:1,background:tab===i?C.navy:C.white,color:tab===i?C.white:C.text2,
            border:`1px solid ${tab===i?C.navy:C.border}`,borderRadius:10,padding:"10px 8px",
            fontFamily:bf,fontWeight:tab===i?700:500,fontSize:13,cursor:"pointer",transition:"all 0.2s ease",
          }}>{label}</button>
        ))}
      </div>

      {/* Tab: Overview */}
      {tab===0 && (
        <div style={{display:"flex",flexDirection:"column",gap:12,animation:"fadeIn 0.3s ease"}}>
          {d.topTrackNow && <TrackRow t={d.topTrackNow} label="Your #1 Right Now" />}
          {d.topTrackAllTime && d.topTrackAllTime?.id !== d.topTrackNow?.id && (
            <TrackRow t={d.topTrackAllTime} label="Your #1 of All Time" />
          )}
          <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18}}>
            <p style={{fontSize:11,textTransform:"uppercase",letterSpacing:"1px",color:C.text2,fontFamily:bf,margin:"0 0 14px"}}>Your Emotional Dimensions</p>
            {d.emotionalScores.map(s => (
              <div key={s.key} style={{padding:"10px 0",borderBottom:`1px solid ${C.bg}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.navy}}>{s.label}</span>
                  <span style={{fontFamily:hf,fontWeight:800,fontSize:16,color:s.color}}>{s.value}%</span>
                </div>
                <div style={{height:5,background:C.bg,borderRadius:99,overflow:"hidden",marginBottom:6}}>
                  <div style={{height:"100%",width:`${Math.max(s.value,3)}%`,background:s.color,borderRadius:99}} />
                </div>
                <p style={{fontFamily:bf,fontSize:12,color:C.text2,margin:0,lineHeight:1.4}}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Artists */}
      {tab===1 && (
        <div style={{display:"flex",flexDirection:"column",gap:12,animation:"fadeIn 0.3s ease"}}>
          {d.comfortArtists.length > 0 && (
            <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18}}>
              <p style={{fontSize:11,textTransform:"uppercase",letterSpacing:"1px",color:C.text2,fontFamily:bf,margin:"0 0 4px"}}>Your Emotional Anchors 💛</p>
              <p style={{fontSize:12,color:C.text2,fontFamily:bf,margin:"0 0 8px",lineHeight:1.4}}>The artists you return to no matter what you're feeling. They hold you steady.</p>
              {d.comfortArtists.map(a => <ArtistRow key={a.name} a={a} />)}
            </div>
          )}
          {d.rising.length > 0 && (
            <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18}}>
              <p style={{fontSize:11,textTransform:"uppercase",letterSpacing:"1px",color:C.text2,fontFamily:bf,margin:"0 0 4px"}}>New Emotional Territory 🔥</p>
              <p style={{fontSize:12,color:C.text2,fontFamily:bf,margin:"0 0 8px",lineHeight:1.4}}>Something new is resonating. These artists are meeting a feeling you didn't have words for yet.</p>
              {d.rising.map(a => <ArtistRow key={a.name} a={a} />)}
            </div>
          )}
          {d.fading.length > 0 && (
            <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18}}>
              <p style={{fontSize:11,textTransform:"uppercase",letterSpacing:"1px",color:C.text2,fontFamily:bf,margin:"0 0 4px"}}>Growing Past 🌙</p>
              <p style={{fontSize:12,color:C.text2,fontFamily:bf,margin:"0 0 8px",lineHeight:1.4}}>You've moved on from these. The feelings they held for you have changed shape.</p>
              {d.fading.map(a => <ArtistRow key={a.name} a={a} />)}
            </div>
          )}
        </div>
      )}

      {/* Tab: Evolution */}
      {tab===2 && (
        <div style={{display:"flex",flexDirection:"column",gap:12,animation:"fadeIn 0.3s ease"}}>
          {d.emergingGenres.length > 0 && (
            <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18}}>
              <p style={{fontSize:11,textTransform:"uppercase",letterSpacing:"1px",color:C.text2,fontFamily:bf,margin:"0 0 4px"}}>Where Your Feelings Are Going 📈</p>
              <p style={{fontSize:12,color:C.text2,fontFamily:bf,margin:"0 0 10px"}}>New genres in your life. The sounds your emotions are reaching for now.</p>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {d.emergingGenres.map(g => <span key={g} style={{fontSize:13,padding:"6px 14px",borderRadius:99,background:C.mint+"22",color:C.navy,fontFamily:bf,fontWeight:600}}>{g}</span>)}
              </div>
            </div>
          )}
          {d.fadingGenres.length > 0 && (
            <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18}}>
              <p style={{fontSize:11,textTransform:"uppercase",letterSpacing:"1px",color:C.text2,fontFamily:bf,margin:"0 0 4px"}}>What You've Outgrown 📉</p>
              <p style={{fontSize:12,color:C.text2,fontFamily:bf,margin:"0 0 10px"}}>These sounds used to hold something for you. You've moved past whatever that was.</p>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {d.fadingGenres.map(g => <span key={g} style={{fontSize:13,padding:"6px 14px",borderRadius:99,background:C.pink+"22",color:C.navy,fontFamily:bf,fontWeight:600}}>{g}</span>)}
              </div>
            </div>
          )}
          {d.emergingGenres.length === 0 && d.fadingGenres.length === 0 && (
            <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:18,textAlign:"center"}}>
              <p style={{fontSize:14,color:C.navy,fontFamily:bf,margin:0,fontStyle:"italic"}}>Your emotional palette through music has been remarkably consistent. You know what you need.</p>
            </div>
          )}
        </div>
      )}

      {/* CTA */}
      <div style={{textAlign:"center",marginTop:24,marginBottom:24}}>
        <button onClick={onContinue} style={{
          background:C.mint,border:"none",borderRadius:99,padding:"16px 36px",color:C.navy,
          fontFamily:hf,fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:`0 4px 16px ${C.mint}33`,width:"100%",
        }}>
          {d.overallVibe >= 0.5 ? "I'm feeling good — share a song" : "I need a lift — find me something"}
        </button>
        <p style={{color:C.text2,fontSize:12,fontFamily:bf,marginTop:10}}>Screenshot your card and share it ↑</p>
      </div>
    </div>
  );
}

// ─── First Share (Onboarding) ───────────────────────────────────────────
function FirstShareScreen({ user, onComplete, showToast }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState(false);
  const [previewTrack, setPreviewTrack] = useState(null);
  const hasSearched = results.length > 0 || (q.trim() && searching);

  useEffect(() => {
    const load = async () => {
      const all = []; const seen = new Set();
      const rec = await getRecent();
      rec.forEach(s => { if(!seen.has(s.id)){seen.add(s.id);all.push(s);} });
      const tp = await getTop();
      tp.forEach(s => { if(!seen.has(s.id)){seen.add(s.id);all.push(s);} });
      setSuggestions(all.slice(0,12));
    };
    load();
  }, []);

  const search = async () => { if(!q.trim()) return; setSearching(true); const r = await searchSpotify(q); setResults(r); setSearching(false); };
  const send = async (song) => {
    if (sending) return;
    setSending(song.id);
    try {
      await supabase.from("songs").upsert({id:song.id,title:song.title,artist:song.artist,album_art:song.albumArt,preview_url:song.previewUrl,spotify_uri:song.spotifyUri,spotify_url:song.spotifyUrl},{onConflict:"id"});
      await supabase.from("shares").insert({user_id:user.id,song_id:song.id,mood:"happy"});
      await supabase.from("profiles").update({has_shared:true}).eq("id",user.id);
      setSent(true);
    } catch(e) { showToast("Couldn't share. Try again.","error"); }
    setSending(null);
  };

  if (sent) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"70vh",textAlign:"center",animation:"fadeIn 0.4s ease",padding:24}}>
      <div style={{fontSize:64,marginBottom:16}}>🌊</div>
      <h2 style={{fontFamily:hf,fontSize:28,fontWeight:800,color:C.navy,margin:"0 0 12px",lineHeight:1.2}}>Your song is out there</h2>
      <p style={{color:C.text2,fontSize:15,fontFamily:bf,maxWidth:320,margin:"0 0 8px",lineHeight:1.5}}>It's now waiting for someone who needs it.</p>
      <p style={{color:C.navy,fontSize:15,fontFamily:bf,fontWeight:600,maxWidth:320,margin:"0 0 32px",lineHeight:1.5}}>Every time your song helps someone, we'll let you know.</p>
      <button onClick={onComplete} style={{background:C.mint,border:"none",borderRadius:99,padding:"14px 36px",color:C.navy,fontFamily:hf,fontWeight:700,fontSize:16,cursor:"pointer",boxShadow:`0 4px 12px ${C.mint}33`}}>Continue</button>
    </div>
  );

  const displayList = hasSearched ? results : suggestions;
  const renderSong = (s) => (
    <div key={s.id}>
      <div style={{background:previewTrack===s.id?C.white:C.bg,borderRadius:12,padding:12,display:"flex",alignItems:"center",gap:12,border:previewTrack===s.id?`2px solid ${C.mint}`:"2px solid transparent",cursor:"pointer"}}
        onClick={()=>setPreviewTrack(previewTrack===s.id?null:s.id)}>
        {s.albumArt?<img src={s.albumArt} alt="" style={{width:48,height:48,borderRadius:8}} />:<div style={{width:48,height:48,borderRadius:8,background:C.mint+"22",display:"flex",alignItems:"center",justifyContent:"center"}}>🎵</div>}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.navy,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.title}</div>
          <div style={{fontSize:12,color:C.text2}}>{s.artist}</div>
        </div>
        <button onClick={e=>{e.stopPropagation();send(s);}} disabled={!!sending}
          style={{background:C.mint,border:"none",borderRadius:10,padding:"8px 16px",cursor:"pointer",color:C.navy,fontFamily:bf,fontWeight:700,fontSize:13,opacity:sending===s.id?0.5:1,whiteSpace:"nowrap"}}>
          {sending===s.id?"Sending...":"Send 🌊"}
        </button>
      </div>
      {previewTrack===s.id && <div style={{margin:"4px 0 8px",animation:"slideUp 0.2s ease"}}><SpotifyEmbed trackId={s.id} compact /></div>}
    </div>
  );

  return (
    <div style={{maxWidth:560,margin:"0 auto",padding:"0 4px"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <Logo size={48} />
        <h2 style={{fontFamily:hf,fontSize:26,fontWeight:800,color:C.navy,margin:"16px 0 8px",lineHeight:1.2}}>Share a song that<br/>makes you feel good</h2>
        <p style={{color:C.text2,fontSize:14,fontFamily:bf,maxWidth:300,margin:"0 auto"}}>It'll reach someone who needs it.</p>
      </div>
      <div style={{background:C.white,borderRadius:16,border:`1px solid ${C.border}`,padding:20}}>
        <div style={{display:"flex",gap:8}}>
          <input type="text" value={q} onChange={e=>{setQ(e.target.value);if(!e.target.value.trim())setResults([]);}} onKeyDown={e=>e.key==="Enter"&&search()}
            placeholder="Search for a song or artist..." style={{flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",color:C.navy,fontFamily:bf,fontSize:14,outline:"none"}} />
          {hasSearched?(<button onClick={()=>{setQ("");setResults([]);}} style={{background:C.text2+"22",border:"none",borderRadius:10,padding:"10px 16px",color:C.text2,fontFamily:bf,fontWeight:700,fontSize:14,cursor:"pointer"}}>✕</button>
          ):(<button onClick={search} disabled={searching||!q.trim()} style={{background:C.navy,border:"none",borderRadius:10,padding:"10px 20px",color:C.white,fontFamily:bf,fontWeight:700,fontSize:14,cursor:"pointer",opacity:(!q.trim()||searching)?0.5:1}}>{searching?"...":"Search"}</button>)}
        </div>
        {!hasSearched && suggestions.length>0 && <p style={{fontSize:12,color:C.text2+"99",margin:"12px 0 4px",fontFamily:bf}}>From your recent listening · tap to preview</p>}
        <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8,maxHeight:420,overflowY:"auto"}}>
          {displayList.map(renderSong)}
          {hasSearched && results.length===0 && !searching && <div style={{textAlign:"center",color:C.text2,padding:24,fontFamily:bf}}>No songs found</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Mood Check-In ──────────────────────────────────────────────────────
function MoodCheckIn({ onMoodSet, helpedSinceLastVisit }) {
  const [phase, setPhase] = useState("init");
  const [dir, setDir] = useState(null);
  const go = (w) => { setDir(w); setPhase("expand"); setTimeout(()=>setPhase(w), 350); };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"65vh",textAlign:"center"}}>
      {phase==="init" && (
        <div style={{animation:"fadeIn 0.3s ease"}}>
          {helpedSinceLastVisit > 0 && (
            <div style={{background:C.mint+"22",borderRadius:16,padding:"14px 24px",marginBottom:28,animation:"slideUp 0.4s ease"}}>
              <p style={{fontFamily:hf,fontWeight:700,fontSize:16,color:C.navy,margin:0}}>🙌 You helped {helpedSinceLastVisit} {helpedSinceLastVisit===1?"person":"people"} since last time</p>
            </div>
          )}
          <Logo size={56} />
          <h1 style={{fontFamily:hf,fontSize:42,fontWeight:800,color:C.navy,margin:"20px 0 0",lineHeight:1.1}}>How<br/>are you<br/>doing?</h1>
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
function ShareScreen({ mood, user, onBack, showToast }) {
  const mi = getMood(mood);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState([]);
  const [shareCount, setShareCount] = useState(0);
  const [previewTrack, setPreviewTrack] = useState(null);
  const hasSearched = results.length > 0 || (q.trim() && searching);

  useEffect(() => {
    const load = async () => {
      const all = [];
      const seen = new Set();
      if (user) {
        const {data} = await supabase.from("shares").select("song_id, songs(*)").eq("user_id",user.id).order("created_at",{ascending:false}).limit(20);
        if (data) data.filter(d=>d.songs).forEach(d => {
          if (!seen.has(d.songs.id)) { seen.add(d.songs.id); all.push({id:d.songs.id,title:d.songs.title,artist:d.songs.artist,albumArt:d.songs.album_art,previewUrl:d.songs.preview_url,spotifyUri:d.songs.spotify_uri,spotifyUrl:d.songs.spotify_url,tag:"Sent before"}); }
        });
      }
      const rec = await getRecent();
      rec.forEach(s => { if(!seen.has(s.id)){seen.add(s.id);all.push({...s,tag:"Recently played"});} });
      const tp = await getTop();
      tp.forEach(s => { if(!seen.has(s.id)){seen.add(s.id);all.push({...s,tag:"Your top tracks"});} });
      setSuggestions(all.slice(0, 20));
    };
    load();
  }, [user]);

  const search = async () => {
    if(!q.trim()) return;
    setSearching(true);
    const r = await searchSpotify(q);
    setResults(r);
    setSearching(false);
    if (r.length === 0) showToast("No results found. Try a different search.", "error");
  };
  const clearSearch = () => { setQ(""); setResults([]); };

  const send = async (song) => {
    if (shareCount >= 10) { showToast("Take a breather — you've shared 10 songs this session.", "error"); return; }
    if (sending || sent.includes(song.id)) return;
    setSending(song.id);
    try {
      await supabase.from("songs").upsert({id:song.id,title:song.title,artist:song.artist,album_art:song.albumArt,preview_url:song.previewUrl,spotify_uri:song.spotifyUri,spotify_url:song.spotifyUrl},{onConflict:"id"});
      await supabase.from("shares").insert({user_id:user.id,song_id:song.id,mood});
      setSent(p=>[...p,song.id]); setShareCount(c=>c+1);
      showToast(`🌊 "${song.title}" sent into the world`, "success");
    } catch (e) { showToast("Couldn't share that song. Try again.", "error"); }
    setSending(null);
  };

  const renderSong = (s) => (
    <div key={s.id}>
      <div style={{background:previewTrack===s.id?C.white:C.bg,borderRadius:12,padding:12,display:"flex",alignItems:"center",gap:12,border:previewTrack===s.id?`2px solid ${C.mint}`:"2px solid transparent",cursor:"pointer"}}
        onClick={()=>setPreviewTrack(previewTrack===s.id?null:s.id)}>
        {s.albumArt ? <img src={s.albumArt} alt="" style={{width:48,height:48,borderRadius:8}} /> : <div style={{width:48,height:48,borderRadius:8,background:mi?.color+"22",display:"flex",alignItems:"center",justifyContent:"center"}}>🎵</div>}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.navy,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.title}</div>
          <div style={{fontSize:12,color:C.text2}}>{s.artist}{s.tag && !hasSearched ? <span style={{color:C.text2+"88",marginLeft:6}}>· {s.tag}</span> : ""}</div>
        </div>
        <button onClick={(e)=>{e.stopPropagation();send(s);}} disabled={sending===s.id||sent.includes(s.id)}
          style={{background:sent.includes(s.id)?C.mint+"33":C.mint,border:"none",borderRadius:10,padding:"8px 16px",cursor:sent.includes(s.id)?"default":"pointer",color:C.navy,fontFamily:bf,fontWeight:700,fontSize:13,opacity:sending===s.id?0.5:1,whiteSpace:"nowrap"}}>
          {sent.includes(s.id)?"Sent ✓":sending===s.id?"Sending...":"Send 🌊"}
        </button>
      </div>
      {previewTrack===s.id && (
        <div style={{margin:"4px 0 8px",animation:"slideUp 0.2s ease"}}>
          <SpotifyEmbed trackId={s.id} compact />
        </div>
      )}
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
          <p style={{fontSize:12,color:C.text2+"99",margin:"12px 0 4px",fontFamily:bf}}>Quick picks from your listening · tap to preview</p>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:hasSearched?12:4,maxHeight:520,overflowY:"auto"}}>
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

// ─── Swipe Card (with Spotify embed) ────────────────────────────────────
function SwipeCard({ song, onSwipe }) {
  const [off, setOff] = useState(0);
  const [drag, setDrag] = useState(false);
  const [exiting, setExiting] = useState(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const startX = useRef(0);
  const cardRef = useRef(null);

  const onStart = (x) => { startX.current=x; setDrag(true); };
  const onMove = (x) => { if(drag) setOff(x-startX.current); };
  const onEnd = () => {
    setDrag(false);
    if(Math.abs(off)>100) {
      setExiting(off > 0 ? "right" : "left");
      setTimeout(() => onSwipe(off > 0), 250);
    } else { setOff(0); }
  };

  const handleTouchMove = useCallback((e) => {
    if (drag) { e.preventDefault(); onMove(e.touches[0].clientX); }
  }, [drag]);

  useEffect(() => {
    const el = cardRef.current;
    if (el) el.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => { if (el) el.removeEventListener("touchmove", handleTouchMove); };
  }, [handleTouchMove]);

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
      
      {/* Album art */}
      {song.album_art && !showPlayer && (
        <div onClick={()=>setShowPlayer(true)} style={{borderRadius:16,overflow:"hidden",marginBottom:16,cursor:"pointer",position:"relative"}}>
          <img src={song.album_art} alt="" style={{width:"100%",aspectRatio:"1",objectFit:"cover",display:"block"}} />
          <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.15)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{width:56,height:56,borderRadius:"50%",background:"rgba(255,255,255,0.9)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <span style={{fontSize:24,marginLeft:4}}>▶</span>
            </div>
          </div>
        </div>
      )}
      {!song.album_art && !showPlayer && (
        <div onClick={()=>setShowPlayer(true)} style={{width:"100%",aspectRatio:"1",borderRadius:16,background:`linear-gradient(135deg, ${C.purple}33, ${C.mint}33)`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16,cursor:"pointer"}}>
          <span style={{fontSize:64}}>🎵</span>
        </div>
      )}
      
      {/* Spotify embed player */}
      {showPlayer && (
        <div style={{marginBottom:16}}>
          <SpotifyEmbed trackId={song.song_id || song.id} />
          <button onClick={()=>setShowPlayer(false)} style={{background:"none",border:"none",color:C.text2,fontSize:12,cursor:"pointer",fontFamily:bf,marginTop:4,width:"100%",textAlign:"center"}}>Hide player</button>
        </div>
      )}

      <h3 style={{fontFamily:hf,fontSize:22,fontWeight:800,color:C.navy,margin:"0 0 4px",textAlign:"center"}}>{song.title}</h3>
      <p style={{fontSize:15,color:C.text2,margin:0,textAlign:"center",fontFamily:bf}}>{song.artist}</p>
      <div style={{display:"flex",justifyContent:"center",gap:32,marginTop:20}}>
        <button onClick={e=>{e.stopPropagation();onSwipe(false);}} style={{width:56,height:56,borderRadius:"50%",background:C.red+"15",border:`2px solid ${C.red}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>✕</button>
        <button onClick={e=>{e.stopPropagation();onSwipe(true);}} style={{width:56,height:56,borderRadius:"50%",background:C.mint+"15",border:`2px solid ${C.mint}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>♥</button>
      </div>
      <p style={{fontSize:12,color:C.text2+"88",textAlign:"center",marginTop:12,fontFamily:bf}}>Tap cover to listen · Swipe or tap buttons</p>
    </div>
  );
}

// ─── Receive Screen ─────────────────────────────────────────────────────
function ReceiveScreen({ mood, user, onBack, showToast }) {
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
      if (error) showToast("Couldn't load songs. Try again.", "error");
      setQueue(data || []);
    } catch (e) { showToast("Couldn't load songs. Try again.", "error"); }
    setIdx(0); setLoading(false);
  };

  const swipe = async (didHelp) => {
    if (swiping) return;
    const song = queue[idx]; if (!song) return;
    setSwiping(true);
    try {
      const { data: swipeData } = await supabase.from("swipes").insert({ user_id:user.id, song_id:song.song_id, share_id:song.share_id, mood, helped:didHelp }).select("id").single();
      if (didHelp) {
        setHelped(true); setHelpedN(n=>n+1);
        if (song.spotify_uri) {
          try {
            const plId = await getOrCreatePlaylist(user.id);
            if (plId) await addTrack(plId, song.spotify_uri);
          } catch(e) { console.error("Playlist error:", e); }
        }
        const { data: sh } = await supabase.from("shares").select("user_id").eq("id", song.share_id).single();
        if (sh) await supabase.from("notifications").insert({ user_id:sh.user_id, swipe_id:swipeData?.id||null, song_id:song.song_id, recipient_mood:mood });
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

// ─── Mood Calendar ── #8 ────────────────────────────────────────────────
function MoodCalendar({ checkins }) {
  const days = [];
  const now = new Date();
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    const dayCheckins = checkins.filter(c => c.created_at.slice(0,10) === key);
    let color = C.border + "44";
    if (dayCheckins.length > 0) {
      const hadBad = dayCheckins.some(c => c.mood_type === "bad");
      const hadGood = dayCheckins.some(c => c.mood_type === "good");
      const last = dayCheckins[dayCheckins.length - 1];
      if (hadBad && hadGood) color = C.gold;
      else if (hadGood) color = MOOD_COLORS[last.mood] || C.mint;
      else color = MOOD_COLORS[last.mood] || C.pink;
    }
    days.push({ key, color, date: d });
  }
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].color !== C.border + "44") streak++; else break;
  }
  return (
    <div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:0}}>Your mood</h3>
        {streak>1&&<span style={{fontFamily:bf,fontSize:13,fontWeight:700,color:C.gold}}>{streak}-day streak 🔥</span>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:6}}>
        {days.map(d=>(<div key={d.key} title={d.key} style={{width:"100%",aspectRatio:"1",borderRadius:"50%",background:d.color,transition:"all 0.2s ease"}} />))}
      </div>
      <div style={{display:"flex",gap:12,marginTop:10,justifyContent:"center",flexWrap:"wrap"}}>
        {[{c:C.mint,l:"Good"},{c:C.pink,l:"Bad"},{c:C.gold,l:"Recovered"},{c:C.border+"44",l:"No check-in"}].map(x=>(
          <div key={x.l} style={{display:"flex",alignItems:"center",gap:4}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:x.c}} /><span style={{fontSize:10,color:C.text2,fontFamily:bf}}>{x.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Profile Screen ──────────────────────────────────────────────────────
function ProfileScreen({ user, notifs, spotifyName, checkins }) {
  const [stats,setStats]=useState({shared:0,helped:0,saved:0});
  const [artists,setArtists]=useState([]);
  const [helpedSongs,setHelpedSongs]=useState([]);
  const [confirmSignOut,setConfirmSignOut]=useState(false);
  const [showReport,setShowReport]=useState(false);
  useEffect(()=>{if(user) load();},[user]);
  const load=async()=>{
    const {count:sc}=await supabase.from("shares").select("*",{count:"exact",head:true}).eq("user_id",user.id);
    const {count:hc}=await supabase.from("notifications").select("*",{count:"exact",head:true}).eq("user_id",user.id);
    const {count:vc}=await supabase.from("swipes").select("*",{count:"exact",head:true}).eq("user_id",user.id).eq("helped",true);
    setStats({shared:sc||0,helped:hc||0,saved:vc||0});
    const {data:shares}=await supabase.from("shares").select("mood, songs(title, artist)").eq("user_id",user.id).order("created_at",{ascending:false}).limit(50);
    if(shares){const ac={};shares.forEach(s=>{const a=s.songs?.artist;if(a)ac[a]=(ac[a]||0)+1;});setArtists(Object.entries(ac).sort((a,b)=>b[1]-a[1]).slice(0,5));}
    const {data:hs}=await supabase.from("swipes").select("mood, songs(title, artist, album_art)").eq("user_id",user.id).eq("helped",true).order("created_at",{ascending:false}).limit(20);
    if(hs) setHelpedSongs(hs);
  };
  const unread=notifs.filter(n=>!n.read).length;
  const totalActions=stats.shared+stats.saved;

  if(showReport) return (
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <button onClick={()=>setShowReport(false)} style={{background:"none",border:"none",color:C.text2,cursor:"pointer",fontFamily:bf,fontSize:14,padding:"8px 0",marginBottom:16}}>← Back to Profile</button>
      <MoodReport onContinue={()=>setShowReport(false)} />
    </div>
  );

  return (
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
        <div style={{width:48,height:48,borderRadius:"50%",background:C.spotify+"22",display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:24}}>🎧</span></div>
        <div><h2 style={{fontFamily:hf,fontSize:24,fontWeight:800,color:C.navy,margin:0}}>{spotifyName||"Your Impact"}</h2><p style={{fontSize:12,color:C.spotify,fontFamily:bf,margin:0,fontWeight:600}}>Connected via Spotify</p></div>
      </div>
      {/* Mood Report button */}
      <button onClick={()=>setShowReport(true)} style={{width:"100%",background:`linear-gradient(135deg,${C.navy},#2a3154)`,border:"none",borderRadius:16,padding:"18px 20px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <span style={{fontSize:28}}>🎧</span>
        <div style={{textAlign:"left"}}>
          <div style={{fontFamily:hf,fontWeight:700,fontSize:15,color:C.white}}>Your Mood Report</div>
          <div style={{fontFamily:bf,fontSize:12,color:C.white,opacity:0.6}}>See what your music says about you</div>
        </div>
        <span style={{marginLeft:"auto",color:C.white,opacity:0.4,fontSize:18}}>→</span>
      </button>
      {checkins.length>0&&<MoodCalendar checkins={checkins} />}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:28}}>
        {[{l:"Songs Shared",v:stats.shared,c:C.mint,i:"🎵"},{l:"People Helped",v:stats.helped,c:C.purple,i:"🙌"},{l:"Songs Saved",v:stats.saved,c:C.gold,i:"💛"}].map(s=>(
          <div key={s.l} style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,textAlign:"center"}}>
            <div style={{fontSize:24,marginBottom:4}}>{s.i}</div><div style={{fontFamily:hf,fontSize:30,fontWeight:800,color:s.c}}>{s.v}</div><div style={{fontSize:12,color:C.text2,marginTop:4,fontFamily:bf}}>{s.l}</div>
          </div>))}
      </div>
      {notifs.length>0&&(<div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
        <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:"0 0 12px"}}>Notifications {unread>0&&<span style={{background:C.mint,color:C.navy,borderRadius:99,padding:"2px 8px",fontSize:12,fontWeight:700,marginLeft:6}}>{unread} new</span>}</h3>
        {notifs.slice(0,5).map(n=>(<div key={n.id} style={{padding:"10px 0",borderBottom:`1px solid ${C.bg}`,display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:20}}>🙌</span><div><p style={{fontFamily:bf,fontSize:13,color:C.navy,margin:0,fontWeight:n.read?400:700}}>You helped someone feel better{n.recipient_mood?` when they were ${n.recipient_mood}`:""}</p><p style={{fontSize:11,color:C.text2,margin:"2px 0 0"}}>{new Date(n.created_at).toLocaleDateString()}</p></div></div>))}
      </div>)}
      {artists.length>0&&(<div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
        <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:"0 0 12px"}}>When you feel good, you share</h3>
        {artists.map(([a,c])=>(<div key={a} style={{display:"flex",justifyContent:"space-between",padding:"6px 0"}}><span style={{fontFamily:bf,fontSize:14,color:C.navy}}>{a}</span><span style={{fontFamily:hf,fontWeight:700,fontSize:14,color:C.mint}}>{c}x</span></div>))}
      </div>)}
      {helpedSongs.length>0&&(<div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:20}}>
        <h3 style={{fontFamily:hf,fontSize:17,fontWeight:700,color:C.navy,margin:"0 0 12px"}}>Songs that helped you</h3>
        {helpedSongs.map((s,i)=>{const m=getMood(s.mood);return(<div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:i<helpedSongs.length-1?`1px solid ${C.bg}`:"none"}}>{s.songs?.album_art?<img src={s.songs.album_art} alt="" style={{width:36,height:36,borderRadius:6}} />:<div style={{width:36,height:36,borderRadius:6,background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>🎵</div>}<div style={{flex:1}}><div style={{fontFamily:bf,fontSize:13,fontWeight:600,color:C.navy}}>{s.songs?.title}</div><div style={{fontSize:11,color:C.text2}}>{s.songs?.artist}</div></div><span style={{fontSize:11,padding:"2px 8px",borderRadius:99,background:m?.color+"22",color:C.navy,fontWeight:600,fontFamily:bf}}>helped when {m?.label}</span></div>);})}
      </div>)}
      {totalActions===0&&(<div style={{textAlign:"center",padding:40,background:C.white,borderRadius:16,border:`1px solid ${C.border}`,marginBottom:20}}><Logo size={48} /><p style={{fontFamily:hf,fontWeight:700,fontSize:16,color:C.navy,margin:"16px 0 8px"}}>Your Buoy story starts here</p><p style={{color:C.text2,fontSize:13,fontFamily:bf,margin:0}}>Share a song to see your mood patterns and impact.</p></div>)}
      {totalActions>0&&totalActions<5&&(<div style={{background:C.purple+"11",borderRadius:12,padding:"12px 16px",marginBottom:20}}><p style={{fontFamily:bf,fontSize:13,color:C.navy,margin:0,fontWeight:600}}>🌊 {5-totalActions} more {(5-totalActions)===1?"action":"actions"} to unlock your full mood patterns</p></div>)}
      {!confirmSignOut?(<button onClick={()=>setConfirmSignOut(true)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 16px",color:C.text2,fontFamily:bf,fontSize:13,cursor:"pointer",marginTop:20}}>Sign Out</button>
      ):(<div style={{marginTop:20,display:"flex",gap:8,alignItems:"center"}}><span style={{fontFamily:bf,fontSize:13,color:C.text2}}>Sign out?</span><button onClick={async()=>{await supabase.auth.signOut();window.location.reload();}} style={{background:C.red,border:"none",borderRadius:8,padding:"6px 14px",color:C.white,fontFamily:bf,fontSize:13,fontWeight:600,cursor:"pointer"}}>Yes</button><button onClick={()=>setConfirmSignOut(false)} style={{background:C.bg,border:"none",borderRadius:8,padding:"6px 14px",color:C.text2,fontFamily:bf,fontSize:13,cursor:"pointer"}}>Cancel</button></div>)}
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────
export default function BuoyApp() {
  const [user,setUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [screen,setScreen]=useState("checkin");
  const [mood,setMood]=useState(null);
  const [nav,setNav]=useState("home");
  const [notifs,setNotifs]=useState([]);
  const [toast,setToast]=useState(null);
  const [spotifyName,setSpotifyName]=useState(null);
  const [spotifyReady,setSpotifyReady]=useState(false);
  const [hasShared,setHasShared]=useState(true);
  const [showMoodReport,setShowMoodReport]=useState(false);
  const [checkins,setCheckins]=useState([]);
  const [helpedSinceLastVisit,setHelpedSinceLastVisit]=useState(0);
  const showToast=useCallback((message,type="info")=>{setToast({message,type,key:Date.now()});},[]);

  useEffect(()=>{
    supabase.auth.getSession().then(({data:{session}})=>{setUser(session?.user||null);if(session)handleSession(session);setAuthLoading(false);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{setUser(session?.user||null);if(session)handleSession(session);});
    return ()=>subscription.unsubscribe();
  },[]);

  const handleSession=async(session)=>{
    const u=session.user;
    spotifyState.userId=u.id;
    const {data:profile}=await supabase.from("profiles").select("has_shared,display_name,spotify_id,spotify_access_token,spotify_refresh_token,spotify_token_expiry").eq("id",u.id).single();
    if(profile){
      // Check actual shares if flag is false (handles existing users before this column existed)
      let shared = !!profile.has_shared;
      if(!shared){const {count}=await supabase.from("shares").select("*",{count:"exact",head:true}).eq("user_id",u.id);if(count>0){shared=true;await supabase.from("profiles").update({has_shared:true}).eq("id",u.id);}}
      setHasShared(shared);setSpotifyName(profile.display_name);
      if(!shared) setShowMoodReport(true);
    }else{setHasShared(false);setShowMoodReport(true);}
    if(session.provider_token){
      spotifyState.token=session.provider_token;spotifyState.refreshToken=session.provider_refresh_token;setSpotifyReady(true);
      const me=await spGet("https://api.spotify.com/v1/me");
      if(me){setSpotifyName(me.display_name);await supabase.from("profiles").update({spotify_id:me.id,display_name:me.display_name,spotify_access_token:session.provider_token,spotify_refresh_token:session.provider_refresh_token||spotifyState.refreshToken,spotify_token_expiry:Date.now()+3600000}).eq("id",u.id);}
    }else if(profile){
      if(profile.spotify_access_token&&profile.spotify_token_expiry>Date.now()){spotifyState.token=profile.spotify_access_token;spotifyState.refreshToken=profile.spotify_refresh_token;setSpotifyReady(true);}
      else if(profile.spotify_refresh_token){const r=await doRefresh(profile.spotify_refresh_token);if(r)setSpotifyReady(true);else showToast("Spotify expired. Sign out and back in.","error");}
    }
    const {data:ci}=await supabase.from("checkins").select("*").eq("user_id",u.id).order("created_at",{ascending:true}).limit(200);
    if(ci)setCheckins(ci);
    if(ci&&ci.length>0){const last=ci[ci.length-1].created_at;const {count}=await supabase.from("notifications").select("*",{count:"exact",head:true}).eq("user_id",u.id).gt("created_at",last);setHelpedSinceLastVisit(count||0);}
  };

  useEffect(()=>{if(!user)return;supabase.from("notifications").select("*").eq("user_id",user.id).order("created_at",{ascending:false}).limit(20).then(({data})=>setNotifs(data||[]));},[user,screen]);

  const handleMood=async(moodId,type)=>{
    setMood(moodId);setScreen(type==="bad"?"receive":"share");setNav("home");
    if(user){await supabase.from("checkins").insert({user_id:user.id,mood_type:type,mood:moodId});setCheckins(prev=>[...prev,{user_id:user.id,mood_type:type,mood:moodId,created_at:new Date().toISOString()}]);}
    setHelpedSinceLastVisit(0);
  };
  const handleFirstShare=()=>{setHasShared(true);setScreen("checkin");};
  const goHome=()=>{setNav("home");setScreen("checkin");setMood(null);};
  const goProfile=()=>{setNav("profile");setScreen("profile");};

  if(authLoading) return <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}><Logo size={48}/></div>;
  if(!user) return <AuthScreen />;

  // New user flow: Mood Report → First Share → Normal app
  if(showMoodReport) return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text1,fontFamily:bf}}>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}*{box-sizing:border-box}::selection{background:${C.mint}44}`}</style>
      <AccentBar /><main style={{padding:"48px 20px 80px",marginLeft:6}}>
        <MoodReport onContinue={()=>{setShowMoodReport(false);}} />
      </main>
      {toast&&<Toast message={toast.message} type={toast.type} onDone={()=>setToast(null)} key={toast.key} />}
    </div>
  );

  if(!hasShared) return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text1,fontFamily:bf}}>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}*{box-sizing:border-box}::selection{background:${C.mint}44}input::placeholder{color:${C.text2}88}`}</style>
      <AccentBar /><main style={{padding:"48px 20px 80px",marginLeft:6}}><FirstShareScreen user={user} onComplete={handleFirstShare} showToast={showToast} /></main>
      {toast&&<Toast message={toast.message} type={toast.type} onDone={()=>setToast(null)} key={toast.key} />}
    </div>
  );

  const unread=notifs.filter(n=>!n.read).length;
  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text1,fontFamily:bf}}>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.2)}100%{transform:scale(1)}}*{box-sizing:border-box}::selection{background:${C.mint}44}input::placeholder{color:${C.text2}88}@media(max-width:480px){.buoy-nav{gap:2px!important}.buoy-nav button{padding:6px 10px!important;font-size:12px!important}}`}</style>
      <AccentBar />
      <header style={{position:"sticky",top:0,zIndex:100,background:C.bg+"EE",backdropFilter:"blur(16px)",borderBottom:`1px solid ${C.border}`,padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",marginLeft:6}}>
        <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",flexShrink:0}} onClick={goHome}><Logo size={28} /><span style={{fontFamily:hf,fontWeight:900,fontSize:18,color:C.navy,letterSpacing:"1px"}}>BUOY</span></div>
        <nav className="buoy-nav" style={{display:"flex",gap:4,alignItems:"center"}}>
          <span style={{fontSize:11,color:C.spotify,fontWeight:600,fontFamily:bf,display:"flex",alignItems:"center",gap:4,marginRight:4}}><span style={{width:6,height:6,borderRadius:"50%",background:spotifyReady?C.spotify:C.red}}/>{spotifyReady?"Connected":"Offline"}</span>
          <button onClick={goHome} style={{background:nav==="home"?C.navy:"transparent",border:"none",borderRadius:10,padding:"8px 14px",cursor:"pointer",color:nav==="home"?C.white:C.text2,fontFamily:bf,fontSize:13,fontWeight:nav==="home"?600:500,whiteSpace:"nowrap"}}>🏠 Check In</button>
          <button onClick={goProfile} style={{background:nav==="profile"?C.navy:"transparent",border:"none",borderRadius:10,padding:"8px 14px",cursor:"pointer",color:nav==="profile"?C.white:C.text2,fontFamily:bf,fontSize:13,fontWeight:nav==="profile"?600:500,position:"relative",whiteSpace:"nowrap"}}>👤 Profile{unread>0&&<span style={{position:"absolute",top:2,right:2,width:8,height:8,borderRadius:"50%",background:C.red}}/>}</button>
        </nav>
      </header>
      <main style={{padding:"32px 20px 80px",marginLeft:6}}>
        {screen==="checkin"&&<MoodCheckIn onMoodSet={handleMood} helpedSinceLastVisit={helpedSinceLastVisit} />}
        {screen==="share"&&<ShareScreen mood={mood} user={user} onBack={goHome} showToast={showToast} />}
        {screen==="receive"&&<ReceiveScreen mood={mood} user={user} onBack={goHome} showToast={showToast} />}
        {screen==="profile"&&<ProfileScreen user={user} notifs={notifs} spotifyName={spotifyName} checkins={checkins} />}
      </main>
      {toast&&<Toast message={toast.message} type={toast.type} onDone={()=>setToast(null)} key={toast.key} />}
    </div>
  );
}
