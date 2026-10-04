import { randomBytes } from "node:crypto";

export type Role = "host" | "moderator" | "participant";
export type PlaybackAction = "play" | "pause" | "seek" | "change_video" | "change_playlist" | "navigate_playlist";
export type ActionPayload = { time?: number; videoId?: string; playlistId?: string; playlistIndex?: number };

export interface Participant {
  userId: string;
  sessionToken: string;
  username: string;
  role: Role;
  socketId: string;
  joinedAt: number;
}

export interface ControlRequest {
  id: string;
  userId: string;
  username: string;
  action: PlaybackAction;
  payload: ActionPayload;
  createdAt: number;
}

export interface RoomSnapshot {
  id: string;
  videoId: string;
  playlistId: string;
  playlistIndex: number;
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
  participants: Omit<Participant, "socketId" | "sessionToken">[];
  requests: ControlRequest[];
}

export class Room {
  readonly participants = new Map<string, Participant>();
  readonly requests = new Map<string, ControlRequest>();
  videoId = "";
  playlistId = "";
  playlistIndex = 0;
  isPlaying = false;
  currentTime = 0;
  updatedAt = Date.now();

  constructor(readonly id: string, public hostId: string) {}

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      videoId: this.videoId,
      playlistId: this.playlistId,
      playlistIndex: this.playlistIndex,
      isPlaying: this.isPlaying,
      currentTime: this.currentTime,
      updatedAt: this.updatedAt,
      participants: [...this.participants.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(({ socketId: _socketId, sessionToken: _sessionToken, ...participant }) => participant),
      requests: [...this.requests.values()].sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  addParticipant(participant: Participant): void {
    this.participants.set(participant.userId, participant);
  }

  removeParticipant(userId: string, socketId?: string): boolean {
    const participant = this.participants.get(userId);
    if (!participant || (socketId && participant.socketId !== socketId)) return false;
    this.participants.delete(userId);
    for (const [requestId, request] of this.requests) {
      if (request.userId === userId) this.requests.delete(requestId);
    }
    return true;
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  create(socketId: string, userId: string, sessionToken: string, username: string): Room {
    let id = "";
    do {
      id = randomBytes(4).toString("hex").toUpperCase();
    } while (this.rooms.has(id));
    const room = new Room(id, userId);
    room.addParticipant({ userId, sessionToken, username, role: "host", socketId, joinedAt: Date.now() });
    this.rooms.set(id, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId.toUpperCase());
  }

  join(roomId: string, socketId: string, userId: string, sessionToken: string, username: string): Room | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    const existing = room.participants.get(userId);
    if (existing && existing.sessionToken !== sessionToken) return undefined;
    room.addParticipant({
      userId,
      sessionToken,
      username,
      role: existing?.role ?? "participant",
      socketId,
      joinedAt: existing?.joinedAt ?? Date.now(),
    });
    return room;
  }

  leave(roomId: string, userId: string, socketId: string): Room | undefined {
    const room = this.get(roomId);
    if (!room || !room.removeParticipant(userId, socketId)) return room;
    if (room.participants.size === 0) {
      this.rooms.delete(room.id);
      return undefined;
    }
    if (room.hostId === userId) {
      const nextHost = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.participants.set(nextHost.userId, { ...nextHost, role: "host" });
      room.hostId = nextHost.userId;
    }
    return room;
  }

  assignRole(room: Room, userId: string, role: "moderator" | "participant"): boolean {
    const participant = room.participants.get(userId);
    if (!participant || participant.role === "host") return false;
    room.participants.set(userId, { ...participant, role });
    room.updatedAt = Date.now();
    return true;
  }

  transferHost(room: Room, userId: string): boolean {
    const nextHost = room.participants.get(userId);
    const currentHost = room.participants.get(room.hostId);
    if (!nextHost || !currentHost || nextHost.userId === currentHost.userId) return false;
    room.participants.set(currentHost.userId, { ...currentHost, role: "moderator" });
    room.participants.set(nextHost.userId, { ...nextHost, role: "host" });
    room.hostId = nextHost.userId;
    room.updatedAt = Date.now();
    return true;
  }
}

export function isController(role: Role): boolean {
  return role === "host" || role === "moderator";
}
