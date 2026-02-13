import { useState, useEffect, useRef, useCallback } from "react";

// ─── Buoy MVP + Spotify Integration ────────────────────────────────────
// Mood-based music sharing with real Spotify search, previews, and playlists.

// ─── Spotify Config ─────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = "f0fecfcd5a2c4a5cbb5a9ab2824d0761";
const SPOTIFY_REDIRECT_URI = window.location.origin;
const SPOTIFY_SCOPES = "playlist-modify-public playlist-modify-private user-read-private";

// ─── PKCE Helpers ───────────────────────────────────────────────────────
function generateRandomString(length) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest("SHA-256", data);
}

function base64urlencode(a) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(a)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getCodeChallenge(verifier) {
  const hashed = await sha256(verifier);
  return base64urlencode(hashed);
}

async function redirectToSpotifyAuth() {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await getCodeChallenge(codeVerifier);
  localStorage.setItem("spotify_code_verifier", codeVerifier);
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    scope: SPOTIFY_SCOPES,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const codeVerifier = localStorage.getItem("spotify_code_verifier");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  const data = await response.json();
  if (data.access_token) {
    localStorage.setItem("spotify_access_token", data.access_token);
    localStorage.setItem("spotify_token_expiry", Date.now() + data.expires_in * 1000);
    if (data.refresh_token) localStorage.setItem("spotify_refresh_token", data.refresh_token);
  }
  return data;
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem("spotify_refresh_token");
  if (!refreshToken) return null;
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await response.json();
  if (data.access_token) {
    localStorage.setItem("spotify_access_token", data.access_token);
    localStorage.setItem("spotify_token_expiry", Date.now() + data.expires_in * 1000);
    if (data.refresh_token) localStorage.setItem("spotify_refresh_token", data.refresh_token);
  }
  return data;
}

function getValidToken() {
  const token = localStorage.getItem("spotify_access_token");
  const expiry = localStorage.getItem("spotify_token_expiry");
  if (token && expiry && Date.now() < parseInt(expiry)) return token;
  return null;
}

async function getToken() {
  let token = getValidToken();
  if (token) return token;
  const data = await refreshAccessToken();
  return data?.access_token || null;
}

// ─── Spotify API ────────────────────────────────────────────────────────
async function spotifySearch(query) {
  const token = await getToken();
  if (!token) return [];
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.tracks?.items || []).map((t) => ({
    id: t.id,
    title: t.name,
    artist: t.artists.map((a) => a.name).join(", "),
    albumArt: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
    previewUrl: t.preview_url,
    spotifyUri: t.uri,
    spotifyUrl: t.external_urls?.spotify,
  }));
}

async function spotifyCreatePlaylist(name, description, trackUris) {
  const token = await getToken();
  if (!token) return null;
  // Get user ID
  const meRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const me = await meRes.json();
  // Create playlist
  const plRes = await fetch(`https://api.spotify.com/v1/users/${me.id}/playlists`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: true }),
  });
  const playlist = await plRes.json();
  // Add tracks
  if (trackUris.length > 0) {
    await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: trackUris }),
    });
  }
  return playlist;
}

// ─── App Data ───────────────────────────────────────────────────────────
const MOODS = {
  good: {
    label: "GOOD",
    color: "#2EECC0",
    sub: [
      { id: "happy", label: "HAPPY", emoji: "😊", color: "#2EECC0" },
      { id: "energized", label: "ENERGIZED", emoji: "⚡", color: "#FFD166" },
      { id: "calm", label: "CALM", emoji: "🌿", color: "#7EC8E3" },
      { id: "grateful", label: "GRATEFUL", emoji: "💛", color: "#2EECC0" },
    ],
  },
  bad: {
    label: "BAD",
    color: "#D98BFF",
    sub: [
      { id: "sad", label: "SAD", emoji: "😢", color: "#D98BFF" },
      { id: "tired", label: "TIRED", emoji: "😴", color: "#D98BFF" },
      { id: "anxious", label: "ANXIOUS", emoji: "😰", color: "#D98BFF" },
      { id: "angry", label: "ANGRY", emoji: "😤", color: "#D98BFF" },
    ],
  },
};

const MOOD_REMEDIES = {
  sad: ["happy", "grateful"],
  tired: ["energized", "happy"],
  anxious: ["calm", "grateful"],
  angry: ["calm", "happy"],
};

const SEED_SONGS = [
  { id: "s1", title: "Here Comes the Sun", artist: "The Beatles", mood: "happy", helpsWith: ["sad", "tired"], helpedCount: 47, albumArt: null, spotifyUri: "spotify:track:6dGnYIeXmHdcikdzNNDMm2" },
  { id: "s2", title: "Weightless", artist: "Marconi Union", mood: "calm", helpsWith: ["anxious", "angry"], helpedCount: 132, albumArt: null, spotifyUri: "spotify:track:6kkwzB6hXLIONkEk9JciA6" },
  { id: "s3", title: "Don't Stop Me Now", artist: "Queen", mood: "energized", helpsWith: ["tired", "sad"], helpedCount: 89, albumArt: null, spotifyUri: "spotify:track:5T8EDUDqKcs6OSOwEsfqG7" },
  { id: "s4", title: "Three Little Birds", artist: "Bob Marley", mood: "grateful", helpsWith: ["anxious", "sad"], helpedCount: 64, albumArt: null, spotifyUri: "spotify:track:1pnEfFhMkPFsHixFvnEfbR" },
  { id: "s5", title: "Lovely Day", artist: "Bill Withers", mood: "happy", helpsWith: ["sad", "angry"], helpedCount: 56, albumArt: null, spotifyUri: "spotify:track:0bRXwKfigvpKZUurwqAlEh" },
  { id: "s6", title: "Clair de Lune", artist: "Debussy", mood: "calm", helpsWith: ["anxious", "angry"], helpedCount: 98, albumArt: null, spotifyUri: "spotify:track:1GfJbXUhOJFBBrMZhOYGBi" },
  { id: "s7", title: "Walking on Sunshine", artist: "Katrina & The Waves", mood: "energized", helpsWith: ["tired", "sad"], helpedCount: 41, albumArt: null, spotifyUri: "spotify:track:05wIrZSwuaVY4VagMEjoaI" },
  { id: "s8", title: "What a Wonderful World", artist: "Louis Armstrong", mood: "grateful", helpsWith: ["sad", "anxious"], helpedCount: 73, albumArt: null, spotifyUri: "spotify:track:29U7stRjqHU6rMiS8BfaI9" },
];

// ─── Design Tokens ──────────────────────────────────────────────────────
const C = {
  bg: "#EDEDF0",
  white: "#FFFFFF",
  navy: "#1B2138",
  navyLight: "#2A3050",
  mint: "#2EECC0",
  purple: "#B07CFF",
  pink: "#D98BFF",
  gold: "#FFD166",
  blue: "#7EC8E3",
  red: "#E63946",
  textPrimary: "#1B2138",
  textSecondary: "#6B7084",
  border: "#D8DAE0",
  spotify: "#1DB954",
};

const headingFont = `'Poppins', sans-serif`;
const bodyFont = `'DM Sans', sans-serif`;

// ─── Helpers ────────────────────────────────────────────────────────────
function getMoodInfo(moodId) {
  for (const group of Object.values(MOODS)) {
    const found = group.sub.find((s) => s.id === moodId);
    if (found) return found;
  }
  return null;
}

function getRemedySongs(badMood, songs) {
  const remedyMoods = MOOD_REMEDIES[badMood] || [];
  return songs.filter(
    (s) => remedyMoods.includes(s.mood) || (s.helpsWith && s.helpsWith.includes(badMood))
  );
}

// ─── Components ─────────────────────────────────────────────────────────

function AccentBar() {
  return (
    <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 6, background: `linear-gradient(180deg, ${C.purple} 0%, ${C.mint} 25%, ${C.gold} 50%, ${C.pink} 75%, ${C.purple} 100%)`, zIndex: 999 }} />
  );
}

function BuoyLogo({ size = 32 }) {
  return <img src="/buoy-logo.png" alt="Buoy" style={{ width: size, height: size, objectFit: "contain", borderRadius: size > 40 ? 8 : 4 }} />;
}

function SpotifyBadge({ connected, onConnect }) {
  const [hovered, setHovered] = useState(false);
  if (connected) {
    return (
      <span style={{ fontSize: 12, color: C.spotify, fontWeight: 600, fontFamily: bodyFont, display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.spotify, display: "inline-block" }} />
        Spotify Connected
      </span>
    );
  }
  return (
    <button
      onClick={onConnect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? C.spotify : "transparent",
        border: `1.5px solid ${C.spotify}`,
        borderRadius: 99, padding: "5px 14px", cursor: "pointer",
        color: hovered ? C.white : C.spotify,
        fontFamily: bodyFont, fontSize: 13, fontWeight: 600, transition: "all 0.2s ease",
        display: "flex", alignItems: "center", gap: 6,
      }}
    >
      🎧 Connect Spotify
    </button>
  );
}

function BigMoodButton({ label, color, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ background: color, border: "none", borderRadius: 16, padding: "32px 48px", cursor: "pointer", minWidth: 200, transition: "all 0.2s ease", transform: hovered ? "translateY(-3px)" : "none", boxShadow: hovered ? `0 12px 32px ${color}55` : `0 4px 12px ${color}33` }}>
      <span style={{ fontFamily: headingFont, fontWeight: 800, fontSize: 28, color: C.navy, letterSpacing: "1px" }}>{label}</span>
    </button>
  );
}

function SubMoodButton({ mood, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button onClick={() => onClick(mood)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ background: hovered ? mood.color : mood.color + "DD", border: "none", borderRadius: 14, padding: "22px 16px", cursor: "pointer", minWidth: 130, transition: "all 0.2s ease", transform: hovered ? "translateY(-2px)" : "none", boxShadow: hovered ? `0 8px 24px ${mood.color}44` : "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <span style={{ fontFamily: headingFont, fontWeight: 700, fontSize: 18, color: C.navy, letterSpacing: "0.5px" }}>{mood.label}</span>
    </button>
  );
}

function SongCard({ song, onHelped, showActions = true }) {
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const moodInfo = getMoodInfo(song.mood);

  const togglePreview = () => {
    if (!song.previewUrl) {
      if (song.spotifyUrl) window.open(song.spotifyUrl, "_blank");
      return;
    }
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
    } else {
      if (!audioRef.current) {
        audioRef.current = new Audio(song.previewUrl);
        audioRef.current.addEventListener("ended", () => setPlaying(false));
      }
      audioRef.current.play();
      setPlaying(true);
    }
  };

  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ background: C.white, border: `1px solid ${hovered ? moodInfo?.color + "66" : C.border}`, borderRadius: 14, padding: 18, transition: "all 0.2s ease", display: "flex", alignItems: "center", gap: 14, boxShadow: hovered ? `0 4px 16px ${moodInfo?.color}22` : "0 1px 4px rgba(0,0,0,0.04)" }}>
      {/* Album art or placeholder */}
      <div onClick={togglePreview} style={{ width: 52, height: 52, borderRadius: 12, overflow: "hidden", flexShrink: 0, cursor: "pointer", position: "relative", background: `linear-gradient(135deg, ${moodInfo?.color || C.purple}33, ${moodInfo?.color || C.purple}11)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {song.albumArt ? (
          <img src={song.albumArt} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 22 }}>🎵</span>
        )}
        {(song.previewUrl || song.spotifyUrl) && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", opacity: hovered ? 1 : 0, transition: "opacity 0.2s" }}>
            <span style={{ color: "white", fontSize: 18 }}>{playing ? "⏸" : "▶"}</span>
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: headingFont, fontWeight: 700, fontSize: 15, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{song.title}</div>
        <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 2 }}>{song.artist}</div>
        <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: moodInfo?.color + "22", color: C.navy, fontWeight: 600, fontFamily: bodyFont }}>{moodInfo?.label}</span>
          {song.helpsWith?.map((h) => {
            const hi = getMoodInfo(h);
            return <span key={h} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: C.bg, color: C.textSecondary, fontFamily: bodyFont }}>helps {hi?.label}</span>;
          })}
        </div>
      </div>
      {showActions && (
        <button onClick={() => onHelped?.(song)}
          style={{ background: C.mint + "22", border: `1px solid ${C.mint}44`, borderRadius: 10, padding: "7px 14px", cursor: "pointer", color: C.navy, fontSize: 12, fontWeight: 600, fontFamily: bodyFont, whiteSpace: "nowrap", transition: "all 0.2s ease" }}>
          🙌 {song.helpedCount}
        </button>
      )}
    </div>
  );
}

function NavButton({ label, icon, active, onClick }) {
  return (
    <button onClick={onClick}
      style={{ background: active ? C.navy : "transparent", border: "none", borderRadius: 10, padding: "8px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: active ? C.white : C.textSecondary, fontFamily: bodyFont, fontSize: 14, fontWeight: active ? 600 : 500, transition: "all 0.2s ease" }}>
      <span style={{ fontSize: 16 }}>{icon}</span>{label}
    </button>
  );
}

// ─── Screens ────────────────────────────────────────────────────────────

function MoodCheckIn({ onMoodSet }) {
  const [phase, setPhase] = useState("initial");
  const [fadeIn, setFadeIn] = useState(true);
  useEffect(() => { setFadeIn(true); }, [phase]);
  const handleTopLevel = (which) => { setFadeIn(false); setTimeout(() => setPhase(which), 200); };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "65vh", textAlign: "center", opacity: fadeIn ? 1 : 0, transition: "opacity 0.2s ease" }}>
      {phase === "initial" && (
        <>
          <BuoyLogo size={56} />
          <h1 style={{ fontFamily: headingFont, fontSize: 48, fontWeight: 800, color: C.navy, margin: "20px 0 0", lineHeight: 1.1 }}>How<br />are you<br />doing?</h1>
          <div style={{ display: "flex", gap: 20, marginTop: 40 }}>
            <BigMoodButton label="GOOD" color={C.mint} onClick={() => handleTopLevel("good")} />
            <BigMoodButton label="BAD" color={C.pink} onClick={() => handleTopLevel("bad")} />
          </div>
        </>
      )}
      {phase === "bad" && (
        <>
          <h1 style={{ fontFamily: headingFont, fontSize: 36, fontWeight: 800, color: C.navy, margin: "0 0 4px" }}>HOW BAD?</h1>
          <p style={{ color: C.textSecondary, fontSize: 15, margin: "0 0 32px", maxWidth: 360, fontFamily: bodyFont }}>People all over the world are sending you things that help them when they feel that way, too.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 290 }}>
            {MOODS.bad.sub.map((m) => <SubMoodButton key={m.id} mood={m} onClick={() => onMoodSet(m.id, "bad")} />)}
          </div>
        </>
      )}
      {phase === "good" && (
        <>
          <h1 style={{ fontFamily: headingFont, fontSize: 36, fontWeight: 800, color: C.navy, margin: "0 0 4px" }}>HOW GOOD?</h1>
          <p style={{ color: C.textSecondary, fontSize: 15, margin: "0 0 32px", maxWidth: 360, fontFamily: bodyFont }}>Share something you love — it'll reach someone who needs it.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 290 }}>
            {MOODS.good.sub.map((m) => <SubMoodButton key={m.id} mood={m} onClick={() => onMoodSet(m.id, "good")} />)}
          </div>
        </>
      )}
    </div>
  );
}

function ReceiveScreen({ mood, songs, onHelped, onBack, spotifyConnected }) {
  const moodInfo = getMoodInfo(mood);
  const remedySongs = getRemedySongs(mood, songs);
  const [revealed, setRevealed] = useState(0);
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState(null);

  useEffect(() => {
    if (revealed < remedySongs.length) {
      const t = setTimeout(() => setRevealed((r) => r + 1), 300);
      return () => clearTimeout(t);
    }
  }, [revealed, remedySongs.length]);

  const handleCreatePlaylist = async () => {
    if (!spotifyConnected) {
      await redirectToSpotifyAuth();
      return;
    }
    setCreatingPlaylist(true);
    const uris = remedySongs.filter((s) => s.spotifyUri).map((s) => s.spotifyUri);
    const playlist = await spotifyCreatePlaylist(
      `Buoy: Songs for when you're ${moodInfo?.label}`,
      `Curated by real people on Buoy to help when you're feeling ${moodInfo?.label?.toLowerCase()}.`,
      uris
    );
    if (playlist?.external_urls?.spotify) {
      setPlaylistUrl(playlist.external_urls.spotify);
    }
    setCreatingPlaylist(false);
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.textSecondary, cursor: "pointer", fontFamily: bodyFont, fontSize: 14, padding: "8px 0", marginBottom: 16 }}>← Back</button>
      <div style={{ textAlign: "center", marginBottom: 28, background: C.white, borderRadius: 18, padding: "32px 24px", border: `1px solid ${C.border}` }}>
        <h2 style={{ fontFamily: headingFont, fontSize: 36, fontWeight: 800, color: moodInfo?.color, margin: "0 0 6px" }}>{moodInfo?.label}</h2>
        <p style={{ fontFamily: headingFont, fontWeight: 600, fontSize: 16, color: C.navy, margin: "0 0 8px" }}>Hey, that's ok.</p>
        <p style={{ color: C.textSecondary, fontSize: 14, margin: "0 0 20px", fontFamily: bodyFont, maxWidth: 320, marginLeft: "auto", marginRight: "auto" }}>People all over the world are sending you things that help them when they feel that way, too.</p>
        <p style={{ color: C.textSecondary, fontSize: 13, fontStyle: "italic", margin: 0, fontFamily: bodyFont }}>Sit back, we'll let you know when happy things get here.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {remedySongs.length === 0 && <div style={{ textAlign: "center", color: C.textSecondary, padding: 40, fontFamily: bodyFont }}>No songs yet for this mood. Be the first to help!</div>}
        {remedySongs.slice(0, revealed).map((song) => (
          <div key={song.id} style={{ animation: "slideUp 0.4s ease" }}><SongCard song={song} onHelped={onHelped} /></div>
        ))}
      </div>
      {remedySongs.length > 0 && (
        <div style={{ textAlign: "center", marginTop: 28, padding: 24, background: C.white, borderRadius: 16, border: `1px solid ${C.border}` }}>
          {playlistUrl ? (
            <>
              <p style={{ color: C.spotify, fontSize: 16, fontWeight: 700, fontFamily: headingFont, margin: "0 0 12px" }}>Playlist Created! 🎉</p>
              <a href={playlistUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-block", background: C.spotify, borderRadius: 99, padding: "12px 32px", color: C.white, fontFamily: headingFont, fontWeight: 700, fontSize: 15, textDecoration: "none" }}>
                Open in Spotify
              </a>
            </>
          ) : (
            <>
              <p style={{ color: C.textSecondary, fontSize: 14, margin: "0 0 14px", fontFamily: bodyFont }}>Save these as a Spotify playlist?</p>
              <button onClick={handleCreatePlaylist} disabled={creatingPlaylist}
                style={{ background: spotifyConnected ? C.spotify : C.mint, border: "none", borderRadius: 99, padding: "12px 32px", color: spotifyConnected ? C.white : C.navy, fontFamily: headingFont, fontWeight: 700, fontSize: 15, cursor: "pointer", boxShadow: `0 4px 16px ${C.mint}44`, opacity: creatingPlaylist ? 0.6 : 1 }}>
                {creatingPlaylist ? "Creating..." : spotifyConnected ? "🎧 Create Spotify Playlist" : "Connect Spotify to Create Playlist"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ShareScreen({ mood, songs, setSongs, onBack, spotifyConnected }) {
  const moodInfo = getMoodInfo(mood);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedHelps, setSelectedHelps] = useState([]);
  const [selectedSong, setSelectedSong] = useState(null);
  const [shared, setShared] = useState([]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    if (spotifyConnected) {
      setSearching(true);
      const results = await spotifySearch(searchQuery);
      setSearchResults(results);
      setSearching(false);
    } else {
      // Fallback stub
      setSearchResults([{ id: "search-" + Date.now(), title: searchQuery, artist: "Connect Spotify for real results", mood, helpsWith: [], sentBy: "you", helpedCount: 0, albumArt: null, previewUrl: null, spotifyUri: null }]);
    }
    setSelectedSong(null);
    setSelectedHelps([]);
  };

  const handleShare = (song) => {
    if (selectedHelps.length === 0) return;
    const newSong = { ...song, mood, helpsWith: [...selectedHelps], helpedCount: 0 };
    setSongs((prev) => [...prev, newSong]);
    setShared((prev) => [...prev, newSong]);
    setSelectedHelps([]);
    setSearchResults([]);
    setSearchQuery("");
    setSelectedSong(null);
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.textSecondary, cursor: "pointer", fontFamily: bodyFont, fontSize: 14, padding: "8px 0", marginBottom: 16 }}>← Back</button>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <h2 style={{ fontFamily: headingFont, fontSize: 28, fontWeight: 800, color: C.navy, margin: "0 0 6px" }}>Feeling {moodInfo?.label}</h2>
        <p style={{ color: C.textSecondary, fontSize: 14, margin: 0, fontFamily: bodyFont }}>Share a song that matches your vibe. It'll reach someone who needs it.</p>
      </div>
      <div style={{ background: C.white, borderRadius: 16, border: `1px solid ${C.border}`, padding: 20, marginBottom: 20 }}>
        <label style={{ fontSize: 13, color: C.textSecondary, fontWeight: 600, display: "block", marginBottom: 8, fontFamily: bodyFont }}>
          {spotifyConnected ? "Search Spotify" : "Search for a song (connect Spotify for real results)"}
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Song title or artist..." style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px", color: C.navy, fontFamily: bodyFont, fontSize: 14, outline: "none" }} />
          <button onClick={handleSearch} disabled={searching}
            style={{ background: C.navy, border: "none", borderRadius: 10, padding: "10px 20px", color: C.white, fontFamily: bodyFont, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: searching ? 0.6 : 1 }}>
            {searching ? "..." : "Search"}
          </button>
        </div>

        {/* Search results list */}
        {searchResults.length > 0 && !selectedSong && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {searchResults.map((song) => (
              <div key={song.id} onClick={() => setSelectedSong(song)}
                style={{ background: C.bg, borderRadius: 12, padding: 12, display: "flex", alignItems: "center", gap: 12, cursor: "pointer", border: `1px solid transparent`, transition: "all 0.15s ease" }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = moodInfo?.color}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>
                {song.albumArt ? (
                  <img src={song.albumArt} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} />
                ) : (
                  <div style={{ width: 44, height: 44, borderRadius: 8, background: `linear-gradient(135deg, ${moodInfo?.color}33, ${moodInfo?.color}11)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎵</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: headingFont, fontWeight: 700, fontSize: 14, color: C.navy, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{song.title}</div>
                  <div style={{ fontSize: 12, color: C.textSecondary }}>{song.artist}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Selected song — tag and share */}
        {selectedSong && (
          <div style={{ marginTop: 16 }}>
            <div style={{ background: C.bg, borderRadius: 12, padding: 14, display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              {selectedSong.albumArt ? (
                <img src={selectedSong.albumArt} alt="" style={{ width: 52, height: 52, borderRadius: 10, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 52, height: 52, borderRadius: 10, background: `linear-gradient(135deg, ${moodInfo?.color}33, ${moodInfo?.color}11)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🎵</div>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: headingFont, fontWeight: 700, fontSize: 15, color: C.navy }}>{selectedSong.title}</div>
                <div style={{ fontSize: 12, color: C.textSecondary }}>{selectedSong.artist}</div>
              </div>
              <button onClick={() => { setSelectedSong(null); setSelectedHelps([]); }}
                style={{ background: "none", border: "none", color: C.textSecondary, cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>
            <label style={{ fontSize: 13, color: C.textSecondary, fontWeight: 600, display: "block", marginBottom: 8, fontFamily: bodyFont }}>Who does this help?</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {MOODS.bad.sub.map((bm) => {
                const sel = selectedHelps.includes(bm.id);
                return (
                  <button key={bm.id} onClick={() => setSelectedHelps((prev) => sel ? prev.filter((x) => x !== bm.id) : [...prev, bm.id])}
                    style={{ background: sel ? bm.color + "33" : C.bg, border: `2px solid ${sel ? bm.color : C.border}`, borderRadius: 10, padding: "8px 16px", cursor: "pointer", color: sel ? C.navy : C.textSecondary, fontFamily: headingFont, fontSize: 13, fontWeight: 700, transition: "all 0.2s ease" }}>
                    {bm.label}
                  </button>
                );
              })}
            </div>
            <button onClick={() => handleShare(selectedSong)} disabled={selectedHelps.length === 0}
              style={{ width: "100%", background: selectedHelps.length > 0 ? C.mint : C.border, border: "none", borderRadius: 12, padding: "13px", color: C.navy, fontFamily: headingFont, fontWeight: 700, fontSize: 15, cursor: selectedHelps.length > 0 ? "pointer" : "default", opacity: selectedHelps.length > 0 ? 1 : 0.5 }}>
              🌊 Send to someone who needs it
            </button>
          </div>
        )}
      </div>

      {!spotifyConnected && (
        <div style={{ textAlign: "center", padding: 16, background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, marginBottom: 20 }}>
          <button onClick={() => redirectToSpotifyAuth()}
            style={{ background: C.spotify, border: "none", borderRadius: 99, padding: "10px 24px", color: C.white, fontFamily: headingFont, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
            🎧 Connect Spotify for real search
          </button>
        </div>
      )}

      {shared.length > 0 && (
        <div>
          <h3 style={{ fontFamily: headingFont, fontSize: 17, fontWeight: 700, color: C.navy, margin: "24px 0 12px" }}>You've shared {shared.length} song{shared.length !== 1 ? "s" : ""} 🎉</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {shared.map((s) => <SongCard key={s.id} song={s} showActions={false} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function BrowseScreen({ songs, onHelped }) {
  const [filterMood, setFilterMood] = useState(null);
  const allMoods = [...MOODS.good.sub, ...MOODS.bad.sub];
  const filtered = filterMood ? songs.filter((s) => s.mood === filterMood || s.helpsWith?.includes(filterMood)) : songs;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ fontFamily: headingFont, fontSize: 28, fontWeight: 800, color: C.navy, margin: "0 0 6px" }}>Browse</h2>
      <p style={{ color: C.textSecondary, fontSize: 14, margin: "0 0 20px", fontFamily: bodyFont }}>Everything people have shared, tagged by mood.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <button onClick={() => setFilterMood(null)} style={{ background: !filterMood ? C.navy : C.white, border: `1.5px solid ${!filterMood ? C.navy : C.border}`, borderRadius: 99, padding: "5px 14px", color: !filterMood ? C.white : C.textSecondary, fontFamily: bodyFont, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>All</button>
        {allMoods.map((m) => (
          <button key={m.id} onClick={() => setFilterMood(m.id)} style={{ background: filterMood === m.id ? m.color + "22" : C.white, border: `1.5px solid ${filterMood === m.id ? m.color : C.border}`, borderRadius: 99, padding: "5px 14px", color: filterMood === m.id ? C.navy : C.textSecondary, fontFamily: bodyFont, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{m.label}</button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map((s) => <SongCard key={s.id} song={s} onHelped={onHelped} />)}
      </div>
    </div>
  );
}

function ProfileScreen({ userShared, userHelped, spotifyConnected }) {
  const totalHelped = userShared.reduce((sum, s) => sum + s.helpedCount, 0);
  const moodBreakdown = {};
  userShared.forEach((s) => { s.helpsWith?.forEach((h) => { moodBreakdown[h] = (moodBreakdown[h] || 0) + 1; }); });

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ fontFamily: headingFont, fontSize: 28, fontWeight: 800, color: C.navy, margin: "0 0 8px" }}>Your Impact</h2>
      {spotifyConnected && (
        <div style={{ marginBottom: 20 }}>
          <span style={{ fontSize: 12, color: C.spotify, fontWeight: 600, fontFamily: bodyFont, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.spotify, display: "inline-block" }} /> Spotify Connected
          </span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 28 }}>
        {[
          { label: "Songs Shared", value: userShared.length, color: C.mint, icon: "🎵" },
          { label: "People Helped", value: totalHelped, color: C.purple, icon: "🙌" },
          { label: "Songs Saved", value: userHelped.length, color: C.gold, icon: "💛" },
        ].map((stat) => (
          <div key={stat.label} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 24, marginBottom: 4 }}>{stat.icon}</div>
            <div style={{ fontFamily: headingFont, fontSize: 30, fontWeight: 800, color: stat.color }}>{stat.value}</div>
            <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 4, fontFamily: bodyFont }}>{stat.label}</div>
          </div>
        ))}
      </div>
      {Object.keys(moodBreakdown).length > 0 && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
          <h3 style={{ fontFamily: headingFont, fontSize: 17, fontWeight: 700, color: C.navy, margin: "0 0 14px" }}>Moods you've helped</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {Object.entries(moodBreakdown).map(([moodId, count]) => {
              const mi = getMoodInfo(moodId);
              return (
                <div key={moodId} style={{ background: mi?.color + "18", borderRadius: 12, padding: "12px 18px", textAlign: "center" }}>
                  <div style={{ fontFamily: headingFont, fontWeight: 700, fontSize: 20, color: C.navy }}>{count}</div>
                  <div style={{ fontSize: 11, color: C.textSecondary, fontFamily: bodyFont }}>{mi?.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {userShared.length > 0 && (
        <div>
          <h3 style={{ fontFamily: headingFont, fontSize: 17, fontWeight: 700, color: C.navy, margin: "0 0 12px" }}>Songs you've shared</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {userShared.map((s) => <SongCard key={s.id} song={s} showActions={false} />)}
          </div>
        </div>
      )}
      {userShared.length === 0 && userHelped.length === 0 && (
        <div style={{ textAlign: "center", padding: 48, color: C.textSecondary, fontFamily: bodyFont }}>
          <BuoyLogo size={48} />
          <p style={{ marginTop: 16 }}>Start by checking in with your mood.</p>
        </div>
      )}
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────
export default function BuoyApp() {
  const [screen, setScreen] = useState("checkin");
  const [currentMood, setCurrentMood] = useState(null);
  const [moodType, setMoodType] = useState(null);
  const [songs, setSongs] = useState(SEED_SONGS);
  const [userShared, setUserShared] = useState([]);
  const [userHelped, setUserHelped] = useState([]);
  const [nav, setNav] = useState("home");
  const [spotifyConnected, setSpotifyConnected] = useState(false);

  // Handle Spotify OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      exchangeCodeForToken(code).then((data) => {
        if (data.access_token) setSpotifyConnected(true);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
      });
    } else if (getValidToken()) {
      setSpotifyConnected(true);
    }
  }, []);

  const handleMoodSet = (moodId, type) => { setCurrentMood(moodId); setMoodType(type); setScreen(type === "bad" ? "receive" : "share"); setNav("home"); };
  const handleHelped = (song) => {
    setSongs((prev) => prev.map((s) => (s.id === song.id ? { ...s, helpedCount: s.helpedCount + 1 } : s)));
    if (!userHelped.find((s) => s.id === song.id)) setUserHelped((prev) => [...prev, song]);
  };
  const handleNav = (target) => {
    setNav(target);
    if (target === "home") { setScreen("checkin"); setCurrentMood(null); setMoodType(null); }
    else if (target === "browse") setScreen("browse");
    else if (target === "profile") setScreen("profile");
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.textPrimary, fontFamily: bodyFont }}>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        * { box-sizing: border-box; }
        ::selection { background: ${C.mint}44; }
        input::placeholder { color: ${C.textSecondary}88; }
      `}</style>
      <AccentBar />
      <header style={{ position: "sticky", top: 0, zIndex: 100, background: C.bg + "EE", backdropFilter: "blur(16px)", borderBottom: `1px solid ${C.border}`, padding: "10px 24px 10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", marginLeft: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => handleNav("home")}>
          <BuoyLogo size={30} />
          <span style={{ fontFamily: headingFont, fontWeight: 900, fontSize: 20, color: C.navy, letterSpacing: "1px" }}>BUOY</span>
        </div>
        <nav style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <SpotifyBadge connected={spotifyConnected} onConnect={() => redirectToSpotifyAuth()} />
          <NavButton label="Check In" icon="🏠" active={nav === "home"} onClick={() => handleNav("home")} />
          <NavButton label="Browse" icon="🎵" active={nav === "browse"} onClick={() => handleNav("browse")} />
          <NavButton label="Profile" icon="👤" active={nav === "profile"} onClick={() => handleNav("profile")} />
        </nav>
      </header>
      <main style={{ padding: "32px 24px 80px", marginLeft: 6 }}>
        {screen === "checkin" && <MoodCheckIn onMoodSet={handleMoodSet} />}
        {screen === "receive" && <ReceiveScreen mood={currentMood} songs={songs} onHelped={handleHelped} onBack={() => { setScreen("checkin"); setCurrentMood(null); }} spotifyConnected={spotifyConnected} />}
        {screen === "share" && <ShareScreen mood={currentMood} songs={songs} setSongs={(fn) => { setSongs(fn); const newSongs = typeof fn === "function" ? fn(songs) : fn; const added = newSongs.filter((s) => !songs.find((os) => os.id === s.id)); setUserShared((prev) => [...prev, ...added]); }} onBack={() => { setScreen("checkin"); setCurrentMood(null); }} spotifyConnected={spotifyConnected} />}
        {screen === "browse" && <BrowseScreen songs={songs} onHelped={handleHelped} />}
        {screen === "profile" && <ProfileScreen userShared={userShared} userHelped={userHelped} spotifyConnected={spotifyConnected} />}
      </main>
    </div>
  );
}
