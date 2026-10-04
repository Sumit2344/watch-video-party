import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

type Role = "host" | "moderator" | "participant";
type Action = "play" | "pause" | "seek" | "change_video";
type Participant = { userId: string; username: string; role: Role; joinedAt: number };
type Request = { id: string; userId: string; username: string; action: Action; payload: { time?: number; videoId?: string } };
type RoomState = { id: string; videoId: string; isPlaying: boolean; currentTime: number; updatedAt: number; participants: Participant[] };
type ChatMessage = { id: string; userId: string; username: string; kind: "text" | "gif"; message?: string; gifData?: string; createdAt: number };
type LiveReaction = { id: string; userId: string; username: string; emoji: string; createdAt: number };
type JoinedPayload = { state: RoomState; requests: Request[] };
const LIVE_REACTIONS = ["❤️", "👍", "😂", "🔥"] as const;
const MAX_GIF_SIZE = 512 * 1024;

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement, options: {
        videoId?: string;
        playerVars?: Record<string, number | string>;
        events?: {
          onReady?: (event: { target: YouTubePlayer }) => void;
          onStateChange?: (event: { data: number }) => void;
          onError?: (event: { data: number }) => void;
        };
      }) => YouTubePlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById(videoId: string, startSeconds?: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

const configuredApiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const API_URL = /^https?:\/\//i.test(configuredApiUrl) ? configuredApiUrl : `https://${configuredApiUrl}`;
const USER_ID_KEY = "together-user-id";
const SESSION_TOKEN_KEY = "together-session-token";

function userId(): string {
  let id = sessionStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

function sessionToken(): string {
  let token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  }
  return token;
}

function extractVideoId(value: string): string | null {
  const input = value.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const id = url.hostname.includes("youtu.be")
      ? url.pathname.slice(1)
      : url.searchParams.get("v") ??
        (url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1] ?? "");
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function App() {
  const socket = useMemo<Socket>(() => io(API_URL, { autoConnect: false }), []);
  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get("room") ?? "");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveReactions, setLiveReactions] = useState<LiveReaction[]>([]);
  const [chatText, setChatText] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [duration, setDuration] = useState(0);
  const [liveTime, setLiveTime] = useState(0);
  const [needsPlaybackTap, setNeedsPlaybackTap] = useState(false);
  const playerHost = useRef<HTMLDivElement>(null);
  const gifInput = useRef<HTMLInputElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const lastApplied = useRef("");
  const roomRef = useRef<RoomState | null>(null);
  roomRef.current = room;
  const meId = useMemo(() => userId(), []);
  const meToken = useMemo(() => sessionToken(), []);
  const me = room?.participants.find((person) => person.userId === meId);
  const canControl = me?.role === "host" || me?.role === "moderator";
  const isHost = me?.role === "host";

  useEffect(() => {
    const onConnect = () => { setConnected(true); setError(""); };
    const onDisconnect = () => setConnected(false);
    const onJoined = ({ state, requests: nextRequests }: JoinedPayload) => {
      setRoom(state);
      setRequests(nextRequests);
      setError("");
      setMessages([]);
      setLiveReactions([]);
      history.replaceState(null, "", `?room=${state.id}`);
      setRoomCode(state.id);
    };
    const onUpdated = ({ state, requests: nextRequests }: JoinedPayload) => {
      setRoom(state);
      setRequests(nextRequests);
    };
    const onError = (message: string) => setError(message);
    const onRemoved = () => {
      setRoom(null);
      setRequests([]);
      history.replaceState(null, "", location.pathname);
      setError("You were removed from this room by the host.");
    };
    const onChat = (message: ChatMessage) => setMessages((current) => [...current.slice(-99), message]);
    const onLiveReaction = (reaction: LiveReaction) => {
      setLiveReactions((current) => [...current.filter((item) => Date.now() - item.createdAt < 2600).slice(-11), reaction]);
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room_joined", onJoined);
    socket.on("room_updated", onUpdated);
    socket.on("room_error", onError);
    socket.on("participant_removed", onRemoved);
    socket.on("chat_message", onChat);
    socket.on("live_reaction", onLiveReaction);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room_joined", onJoined);
      socket.off("room_updated", onUpdated);
      socket.off("room_error", onError);
      socket.off("participant_removed", onRemoved);
      socket.off("chat_message", onChat);
      socket.off("live_reaction", onLiveReaction);
      socket.disconnect();
    };
  }, [socket]);

  useEffect(() => {
    if (liveReactions.length === 0) return;
    const timer = window.setTimeout(() => {
      setLiveReactions((current) => current.filter((reaction) => Date.now() - reaction.createdAt < 2600));
    }, 2700);
    return () => window.clearTimeout(timer);
  }, [liveReactions]);

  useEffect(() => {
    if (!room?.videoId) return;
    let interval: number | undefined;
    let playerReady = false;
    let cancelled = false;
    const initPlayer = () => {
      if (cancelled || !playerHost.current || !window.YT?.Player || player.current) return;
      const initialRoom = roomRef.current;
      if (!initialRoom?.videoId) return;
      player.current = new window.YT.Player(playerHost.current, {
        videoId: initialRoom.videoId,
        playerVars: { autoplay: 0, controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: ({ target }) => {
            playerReady = true;
            const currentRoom = roomRef.current;
            if (currentRoom?.videoId) {
              if (currentRoom.isPlaying) target.loadVideoById(currentRoom.videoId, currentRoom.currentTime);
              else target.cueVideoById(currentRoom.videoId, currentRoom.currentTime);
              lastApplied.current = `${currentRoom.videoId}:${currentRoom.isPlaying}:${currentRoom.currentTime}`;
            } else {
              lastApplied.current = "";
            }
            setDuration(target.getDuration());
          },
          onStateChange: ({ data }) => {
            if (data === 1) {
              setNeedsPlaybackTap(false);
              setLiveTime(player.current?.getCurrentTime() ?? 0);
            } else if (data === 2 && roomRef.current?.isPlaying) {
              setNeedsPlaybackTap(true);
            }
          },
          onError: ({ data }) => {
            const message = data === 101 || data === 150
              ? "This video owner does not allow playback on other websites. Try another YouTube video."
              : data === 100
                ? "This video is private or unavailable. Try a public YouTube video."
                : data === 153
                  ? "YouTube could not verify the embedding page. Check the browser privacy settings and try again."
                  : "YouTube could not play this video. Try another video.";
            setError(message);
          },
        },
      });
      interval = window.setInterval(() => {
        if (playerReady && player.current) {
          const time = player.current.getCurrentTime();
          if (Number.isFinite(time)) setLiveTime(time);
          const total = player.current.getDuration();
          if (Number.isFinite(total) && total > 0) setDuration(total);
        }
      }, 1000);
    };
    if (window.YT?.Player) initPlayer();
    else {
      const existing = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      }
      const previousCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousCallback?.();
        initPlayer();
      };
    }
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
      player.current?.destroy();
      player.current = null;
    };
  }, [Boolean(room?.videoId)]);

  useEffect(() => {
    if (!room || !canControl) return;
    const interval = window.setInterval(() => {
      const time = player.current?.getCurrentTime();
      if (typeof time === "number" && Number.isFinite(time)) socket.emit("time_update", { time });
    }, 2000);
    return () => window.clearInterval(interval);
  }, [Boolean(room), canControl, socket]);

  useEffect(() => {
    if (!room?.videoId || !player.current) return;
    const signature = `${room.videoId}:${room.isPlaying}:${room.currentTime}`;
    if (lastApplied.current === signature) return;
    const currentVideo = lastApplied.current.split(":")[0];
    if (currentVideo !== room.videoId) {
      if (room.isPlaying) player.current.loadVideoById(room.videoId, room.currentTime);
      else player.current.cueVideoById(room.videoId, room.currentTime);
      setDuration(0);
    } else if (room.isPlaying) {
      const actual = player.current.getCurrentTime();
      if (Math.abs(actual - room.currentTime) > 2) player.current.seekTo(room.currentTime, true);
      if (player.current.getPlayerState() !== 1) player.current.playVideo();
    } else {
      if (player.current.getPlayerState() !== 2) player.current.pauseVideo();
      if (Math.abs(player.current.getCurrentTime() - room.currentTime) > 2) player.current.seekTo(room.currentTime, true);
    }
    lastApplied.current = signature;
  }, [room?.videoId, room?.isPlaying, room?.currentTime]);

  useEffect(() => {
    if (!room?.isPlaying || !room.videoId || !player.current) {
      setNeedsPlaybackTap(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (roomRef.current?.isPlaying && player.current?.getPlayerState() !== 1) {
        setNeedsPlaybackTap(true);
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [room?.videoId, room?.isPlaying, room?.updatedAt]);

  useEffect(() => {
    if (room?.videoId) setError("");
  }, [room?.videoId]);

  const connectToRoom = (event: FormEvent, create: boolean) => {
    event.preventDefault();
    if (!username.trim()) return setError("Add your name first.");
    setError("");
    if (!socket.connected) socket.connect();
    const send = () => socket.emit(create ? "create_room" : "join_room", {
      userId: meId,
      sessionToken: meToken,
      username: username.trim(),
      ...(create ? {} : { roomId: roomCode.trim() }),
    });
    if (socket.connected) send();
    else socket.once("connect", send);
  };

  const playbackAction = (action: Action, payload: { time?: number; videoId?: string } = {}) => {
    if (canControl) socket.emit("playback_action", { action, payload });
    else socket.emit("request_control", { action, payload });
  };

  const controlPlayback = () => {
    if (!room) return;
    playbackAction(room.isPlaying ? "pause" : "play", { time: player.current?.getCurrentTime() ?? room.currentTime });
  };

  const startPlaybackFromGesture = () => {
    if (!room || !player.current) return;
    player.current.seekTo(room.currentTime, true);
    player.current.playVideo();
    setNeedsPlaybackTap(false);
  };

  const changeVideo = (event: FormEvent) => {
    event.preventDefault();
    const videoId = extractVideoId(videoInput);
    if (!videoId) return setError("Paste a valid YouTube link or 11-character video ID.");
    playbackAction("change_video", { videoId });
    setVideoInput("");
    setError("");
  };

  const sendChat = (event: FormEvent) => {
    event.preventDefault();
    if (!chatText.trim()) return;
    socket.emit("chat_message", { message: chatText.trim() });
    setChatText("");
  };

  const sendGif = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "image/gif" && !file.name.toLowerCase().endsWith(".gif")) {
      setError("Choose a GIF file to share.");
      return;
    }
    if (file.size > MAX_GIF_SIZE) {
      setError("GIFs must be 512 KB or smaller.");
      return;
    }
    if (!socket.connected) {
      setError("Reconnecting — try sharing the GIF again when connected.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("The GIF could not be read. Please try again.");
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.startsWith("data:image/gif;base64,")) {
        setError("That file could not be read as a GIF.");
        return;
      }
      socket.emit("chat_message", { gifData: reader.result });
      setError("");
    };
    reader.readAsDataURL(file);
  };

  const sendLiveReaction = (emoji: typeof LIVE_REACTIONS[number]) => {
    if (!connected) {
      setError("Reactions are available when the room is connected.");
      return;
    }
    socket.emit("live_reaction", { emoji });
  };

  const copyInvite = async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(`${location.origin}/?room=${room.id}`);
      setInviteCopied(true);
      setError("");
      window.setTimeout(() => setInviteCopied(false), 2200);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = `${location.origin}/?room=${room.id}`;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) {
        setError(`Room code: ${room.id} (copy it from the room header).`);
        return;
      }
      setInviteCopied(true);
      setError("");
      window.setTimeout(() => setInviteCopied(false), 2200);
    }
  };

  const leaveRoom = () => {
    socket.disconnect();
    setRoom(null);
    setRequests([]);
    setMessages([]);
    history.replaceState(null, "", location.pathname);
  };

  if (!room) {
    return (
      <main className="landing">
        <div className="grain" />
        <header className="brand"><span className="brand-mark">t.</span><span>together</span><span className="brand-caption">WATCH CLUB</span></header>
        <section className="hero">
          <div className="eyebrow"><span className="pulse-dot" /> YOUR PEOPLE. YOUR SCREEN.</div>
          <h1>Good videos<br />are <span>better together.</span></h1>
          <p className="hero-copy">A little corner of the internet for watching, laughing, and rewinding together — wherever you are.</p>
          <form className="entry-card" onSubmit={(event) => connectToRoom(event, false)}>
            <label htmlFor="display-name">YOUR NAME</label>
            <input id="display-name" autoComplete="nickname" placeholder="What should we call you?" maxLength={24} value={username} onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor="room-code">ROOM CODE <span className="optional-label">OPTIONAL IF YOU'RE HOSTING</span></label>
            <div className="room-input-wrap"><span className="hash">#</span><input id="room-code" placeholder="e.g. A1B2C3D4" maxLength={8} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} /></div>
            <button className="primary-button join-button" type="submit">Join the room <span>↗</span></button>
            <div className="or-divider"><span /> OR <span /></div>
            <button className="create-button" type="button" onClick={(event) => connectToRoom(event, true)}>Create a new room <span>＋</span></button>
            {error && <div className="error-banner">{error}</div>}
          </form>
          <div className="landing-foot"><span>NO ACCOUNTS. JUST GOOD COMPANY.</span><span>MADE FOR YOUR GROUP CHAT ✳</span></div>
        </section>
        <div className="decor decor-one">✳</div><div className="decor decor-two">✴</div><div className="decor decor-three">✷</div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand top-brand" href="/" onClick={(event) => { event.preventDefault(); leaveRoom(); }}><span className="brand-mark">t.</span><span>together</span></a>
        <div className="room-topline"><span className="live-indicator" /> ROOM <b>{room.id}</b><button className="copy-button" onClick={copyInvite} aria-label={inviteCopied ? "Invite link copied" : "Copy room invite link"} title={inviteCopied ? "Invite link copied" : "Copy invite link"}>{inviteCopied ? "✓" : "↗"}</button></div>
        <div className="top-actions"><span className={`connection ${connected ? "online" : ""}`}><i />{connected ? "CONNECTED" : "RECONNECTING"}</span><button className="leave-button" onClick={leaveRoom}>Leave room <span>↗</span></button></div>
      </header>

      <div className="workspace">
        <section className="watch-column">
          <div className="room-heading"><div><div className="eyebrow">A LITTLE ROOM FOR EVERYONE</div><h1>Watch <span>together.</span></h1></div><div className="watching-pill"><span /> {room.participants.length} watching</div></div>
          <div className="player-frame">
            <div className="video-stage">
              <div className={`youtube-host ${room.videoId ? "active" : ""}`} ref={playerHost} />
              {!room.videoId && <div className="empty-player"><div className="play-disc">▶</div><p>The good stuff goes here.</p><span>Drop a YouTube link below to get started.</span></div>}
              {needsPlaybackTap && room.isPlaying && <button className="sync-overlay" onClick={startPlaybackFromGesture}><span>▶</span><b>Tap to sync</b><small>Your browser needs a click to start the shared video.</small></button>}
              {room.videoId && <div className="video-tag"><span>▶</span> WATCHING TOGETHER</div>}
              <div className="floating-reactions" aria-live="polite">
                {liveReactions.map((reaction) => <span className="floating-reaction" key={reaction.id} title={`${reaction.username} reacted`}>{reaction.emoji}</span>)}
              </div>
            </div>
            <div className="player-controls">
              <div className="control-row">
                <button className={`play-control ${canControl ? "" : "disabled"}`} disabled={!room.videoId} onClick={controlPlayback} aria-label={room.isPlaying ? "Pause or request pause" : "Play or request play"} title={canControl ? undefined : "Request approval for playback"}>{room.isPlaying ? "Ⅱ" : "▶"}</button>
                <span className="time-readout">{formatTime(liveTime || room.currentTime)} <span>/ {formatTime(duration)}</span></span>
                <div className="control-spacer" />
                <span className="control-hint">{canControl ? "HOST CONTROLS" : "REQUEST CONTROL TO MAKE CHANGES"}</span>
              </div>
              <input className="seek-bar" type="range" min="0" max={Math.max(duration, 1)} step="1" value={Math.min(liveTime || room.currentTime, Math.max(duration, 1))} disabled={!room.videoId} onChange={(event) => { const time = Number(event.target.value); setLiveTime(time); if (canControl) player.current?.seekTo(time, true); }} onMouseUp={(event) => playbackAction("seek", { time: Number((event.target as HTMLInputElement).value) })} onTouchEnd={(event) => playbackAction("seek", { time: Number((event.target as HTMLInputElement).value) })} />
            </div>
          </div>
          <div className="live-reaction-bar">
            <span><i /> LIVE REACTIONS</span>
            {LIVE_REACTIONS.map((emoji) => <button type="button" key={emoji} disabled={!connected} onClick={() => sendLiveReaction(emoji)} aria-label={`Send ${emoji} reaction`} title={`Send ${emoji}`}>{emoji}</button>)}
          </div>
          <form className="video-form" onSubmit={changeVideo}>
            <span className="link-icon">↗</span><input aria-label="YouTube video URL" placeholder={canControl ? "Paste a YouTube link or video ID..." : "Paste a YouTube link to request a video..."} value={videoInput} onChange={(event) => setVideoInput(event.target.value)} />
            <button type="submit" disabled={!videoInput.trim()}>{canControl ? "Change video" : "Request video"} <span>→</span></button>
          </form>
          {error && <div className="room-error">{error}<button onClick={() => setError("")}>×</button></div>}
          <div className="note-strip"><span>✦</span> {canControl ? "You're in charge of the remote. Make it a good one." : "You're watching as a guest. Ask the host to give you the remote."}</div>
        </section>

        <aside className="side-column">
          <section className="side-card people-card">
            <div className="card-heading"><div><div className="eyebrow">THE CREW</div><h2>In the room <span className="count-badge">{room.participants.length}</span></h2></div><button className="icon-button" onClick={copyInvite} title="Invite friends">↗</button></div>
            <div className="participant-list">
              {room.participants.map((person, index) => (
                <div className="participant" key={person.userId}>
                  <div className={`avatar avatar-${index % 5}`}>{person.username.slice(0, 1).toUpperCase()}</div>
                  <div className="person-info"><b>{person.username}{person.userId === meId ? <span className="you-label"> YOU</span> : ""}</b><span>{person.role === "host" ? "Room host" : person.role === "moderator" ? "Co-pilot" : "Here for the vibes"}</span></div>
                  <span className={`role-badge ${person.role}`}>{person.role === "host" ? "HOST" : person.role === "moderator" ? "MOD" : "GUEST"}</span>
                  {isHost && person.userId !== meId && <details className="person-menu"><summary>···</summary><div className="menu-popover">
                    <button onClick={() => socket.emit("assign_role", { userId: person.userId, role: person.role === "moderator" ? "participant" : "moderator" })}>{person.role === "moderator" ? "Remove moderator" : "Make moderator"}</button>
                    <button onClick={() => socket.emit("transfer_host", { userId: person.userId })}>Make host</button>
                    <button className="danger-text" onClick={() => socket.emit("remove_participant", { userId: person.userId })}>Remove from room</button>
                  </div></details>}
                </div>
              ))}
            </div>
            <button className="invite-button" onClick={copyInvite}>＋ <span>{inviteCopied ? "Link copied!" : "Invite someone"}</span><span className="invite-arrow">{inviteCopied ? "✓" : "↗"}</span></button>
          </section>

          {canControl && <section className="side-card request-card">
            <div className="card-heading"><div><div className="eyebrow">THEY HAVE A THOUGHT</div><h2>Requests <span className="request-count">{requests.length}</span></h2></div></div>
            {requests.length === 0 ? <p className="empty-requests">Any requests from the crew will show up here.</p> : <div className="request-list">{requests.map((request) => <div className="request-item" key={request.id}><div><b>{request.username}</b><span>{request.action === "change_video" ? "wants to change the video" : request.action === "seek" ? `wants to skip to ${formatTime(request.payload.time ?? 0)}` : `wants to ${request.action}`}</span></div><div className="request-actions"><button className="approve" onClick={() => socket.emit("resolve_request", { requestId: request.id, approved: true })}>✓</button><button className="reject" onClick={() => socket.emit("resolve_request", { requestId: request.id, approved: false })}>×</button></div></div>)}</div>}
          </section>}

          <section className="side-card chat-card">
            <div className="card-heading"><div><div className="eyebrow">BETTER WITH BANTER</div><h2>The side chat <span className="chat-spark">✳</span></h2></div></div>
            <div className="chat-messages">
              {messages.length === 0 ? <div className="chat-empty"><span>☁</span><p>It's quiet in here.<br />Say something nice.</p></div> : messages.map((message) => <div className={`chat-message ${message.userId === meId ? "mine" : ""}`} key={message.id}><div className="chat-meta"><b>{message.userId === meId ? "You" : message.username}</b><span>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>{message.kind === "gif" && message.gifData ? <img className="gif-message" src={message.gifData} alt={`${message.username}'s GIF`} /> : <p>{message.message}</p>}</div>)}
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input placeholder="Send a little message..." maxLength={500} value={chatText} onChange={(event) => setChatText(event.target.value)} />
              <input ref={gifInput} className="gif-file-input" type="file" accept="image/gif,.gif" onChange={sendGif} aria-label="Choose a GIF to share" />
              <button className="gif-button" type="button" disabled={!connected} onClick={() => gifInput.current?.click()} aria-label="Share a GIF" title="Share a GIF (512 KB max)">GIF</button>
              <button type="submit" disabled={!chatText.trim() || !connected} aria-label="Send message">↑</button>
            </form>
          </section>
          <div className="privacy-note">✳ <span>ROOMS ARE PRIVATE BY LINK.<br />ONLY INVITE YOUR PEOPLE.</span></div>
        </aside>
      </div>
      <footer className="app-footer"><span>together is better.</span><span>MADE FOR THE GROUP CHAT <b>✳</b></span></footer>
    </main>
  );
}

export default App;
