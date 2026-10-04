import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import {
  ActionPayload,
  ControlRequest,
  isController,
  PlaybackAction,
  Room,
  RoomManager,
} from "./roomManager.js";

const app = express();
const httpServer = createServer(app);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const allowedOrigins = clientOrigin.trim() === "*"
  ? "*"
  : clientOrigin.split(",").map((origin) => origin.trim());
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
});
const rooms = new RoomManager();
const socketRooms = new Map<string, string>();

app.use(cors({ origin: allowedOrigins }));
app.get("/health", (_request, response) => response.json({ status: "ok" }));

type IdentityInput = { userId?: unknown; username?: unknown; sessionToken?: unknown; roomId?: unknown };

function validIdentity(
  input: IdentityInput | null | undefined,
): input is IdentityInput & { userId: string; username: string; sessionToken: string } {
  return (
    typeof input?.userId === "string" &&
    /^[\w-]{1,80}$/.test(input.userId) &&
    validUsername(input.username) &&
    validSessionToken(input.sessionToken)
  );
}

function validUsername(username: unknown): username is string {
  return typeof username === "string" && username.trim().length > 0 && username.trim().length <= 24;
}

function validSessionToken(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{16,80}$/.test(value);
}

function validVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{11}$/.test(value);
}

function emitError(socket: Socket, message: string): void {
  socket.emit("room_error", message);
}

function stateFor(room: Room) {
  const { requests, ...state } = room.snapshot();
  return { state, requests };
}

function publishRoom(room: Room): void {
  io.to(room.id).emit("room_updated", stateFor(room));
}

function applyAction(room: Room, action: PlaybackAction, payload: ActionPayload): boolean {
  if ((action === "play" || action === "pause") && !room.videoId) return false;
  if (action === "play" || action === "pause") {
    room.isPlaying = action === "play";
    if (typeof payload.time === "number" && Number.isFinite(payload.time) && payload.time >= 0) {
      room.currentTime = Math.min(payload.time, 86_400);
    }
  }
  if (action === "seek") {
    if (typeof payload.time !== "number" || !Number.isFinite(payload.time) || payload.time < 0) return false;
    room.currentTime = Math.min(payload.time, 86_400);
  }
  if (action === "change_video") {
    if (!validVideoId(payload.videoId)) return false;
    room.videoId = payload.videoId;
    room.currentTime = 0;
    room.isPlaying = false;
  }
  room.updatedAt = Date.now();
  return true;
}

function notifyRoomJoined(socket: Socket, room: Room): void {
  socket.emit("room_joined", stateFor(room));
  publishRoom(room);
}

async function leaveCurrentRoom(socket: Socket, userId: string): Promise<void> {
  const roomId = socketRooms.get(socket.id);
  if (!roomId) return;
  socketRooms.delete(socket.id);
  await socket.leave(roomId);
  const room = rooms.leave(roomId, userId, socket.id);
  if (room) publishRoom(room);
}

io.on("connection", (socket) => {
  socket.on("create_room", async (input: IdentityInput) => {
    if (!validIdentity(input)) return emitError(socket, "Enter a valid name to create a room.");
    await leaveCurrentRoom(socket, input.userId);
    const room = rooms.create(socket.id, input.userId, input.sessionToken, input.username.trim());
    socketRooms.set(socket.id, room.id);
    await socket.join(room.id);
    notifyRoomJoined(socket, room);
  });

  socket.on("join_room", async (input: IdentityInput) => {
    if (!validIdentity(input)) return emitError(socket, "Enter a valid name to join.");
    if (typeof input.roomId !== "string" || !/^[\da-f]{8}$/i.test(input.roomId.trim())) {
      return emitError(socket, "Room codes contain 8 letters or numbers.");
    }
    await leaveCurrentRoom(socket, input.userId);
    const room = rooms.join(input.roomId.trim(), socket.id, input.userId, input.sessionToken, input.username.trim());
    if (!room) return emitError(socket, "That room was not found, or this browser cannot rejoin that participant.");
    socketRooms.set(socket.id, room.id);
    await socket.join(room.id);
    notifyRoomJoined(socket, room);
  });

  socket.on("playback_action", (input: { action?: unknown; payload?: ActionPayload }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    // Identity is taken from the active socket, never from the event payload.
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || !isController(actor.role)) return emitError(socket, "Only the host or a moderator can control playback.");
    const action = input?.action;
    if (action !== "play" && action !== "pause" && action !== "seek" && action !== "change_video") {
      return emitError(socket, "That playback action is not supported.");
    }
    if (!applyAction(room, action, input.payload ?? {})) return emitError(socket, "The playback action has invalid data.");
    publishRoom(room);
  });

  socket.on("request_control", (input: { action?: unknown; payload?: ActionPayload }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    const action = input?.action;
    if (!room || !actor || actor.role !== "participant") return emitError(socket, "Only participants need to request approval.");
    if (action !== "play" && action !== "pause" && action !== "seek" && action !== "change_video") {
      return emitError(socket, "That playback request is not supported.");
    }
    const payload = input.payload ?? {};
    if (action === "seek" && (typeof payload.time !== "number" || !Number.isFinite(payload.time) || payload.time < 0)) {
      return emitError(socket, "Enter a valid seek position.");
    }
    if (action === "change_video" && !validVideoId(payload.videoId)) return emitError(socket, "Enter a valid YouTube video.");
    if ((action === "play" || action === "pause") && !room.videoId) return emitError(socket, "Choose a video before requesting playback.");
    const request: ControlRequest = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      userId: actor.userId,
      username: actor.username,
      action,
      payload,
      createdAt: Date.now(),
    };
    room.requests.set(request.id, request);
    publishRoom(room);
  });

  socket.on("resolve_request", (input: { requestId?: unknown; approved?: unknown }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || !isController(actor.role)) return emitError(socket, "Only the host or a moderator can review requests.");
    const request = typeof input?.requestId === "string" ? room.requests.get(input.requestId) : undefined;
    if (!request) return emitError(socket, "That request is no longer available.");
    room.requests.delete(request.id);
    if (input.approved === true) {
      if (!applyAction(room, request.action, request.payload)) return emitError(socket, "The requested action could not be applied.");
    } else {
      room.updatedAt = Date.now();
    }
    publishRoom(room);
  });

  socket.on("assign_role", (input: { userId?: unknown; role?: unknown }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || actor.role !== "host") return emitError(socket, "Only the host can change participant roles.");
    if (typeof input?.userId !== "string" || (input.role !== "moderator" && input.role !== "participant")) {
      return emitError(socket, "Choose a participant and a valid role.");
    }
    if (!rooms.assignRole(room, input.userId, input.role as "moderator" | "participant")) {
      return emitError(socket, "That participant could not be updated.");
    }
    publishRoom(room);
  });

  socket.on("remove_participant", (input: { userId?: unknown }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || actor.role !== "host") return emitError(socket, "Only the host can remove participants.");
    const target = typeof input?.userId === "string" ? room.participants.get(input.userId) : undefined;
    if (!target || target.role === "host") return emitError(socket, "That participant cannot be removed.");
    io.to(target.socketId).emit("participant_removed");
    io.sockets.sockets.get(target.socketId)?.leave(room.id);
    socketRooms.delete(target.socketId);
    room.removeParticipant(target.userId, target.socketId);
    publishRoom(room);
  });

  socket.on("transfer_host", (input: { userId?: unknown }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || actor.role !== "host") return emitError(socket, "Only the host can transfer ownership.");
    if (typeof input?.userId !== "string" || !rooms.transferHost(room, input.userId)) {
      return emitError(socket, "Choose another participant to transfer host to.");
    }
    publishRoom(room);
  });

  socket.on("chat_message", (input: { message?: unknown }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || typeof input?.message !== "string") return;
    const message = input.message.trim().slice(0, 500);
    if (!message) return;
    io.to(room.id).emit("chat_message", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: actor.userId,
      username: actor.username,
      message,
      createdAt: Date.now(),
    });
  });

  socket.on("time_update", (input: { time?: unknown }) => {
    const room = rooms.get(socketRooms.get(socket.id) ?? "");
    const actor = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (!room || !actor || !isController(actor.role) || typeof input?.time !== "number" || !Number.isFinite(input.time) || input.time < 0) return;
    room.currentTime = Math.min(input.time, 86_400);
    room.updatedAt = Date.now();
    publishRoom(room);
  });

  socket.on("disconnect", async () => {
    const roomId = socketRooms.get(socket.id);
    const room = roomId ? rooms.get(roomId) : undefined;
    const participant = room && [...room.participants.values()].find((entry) => entry.socketId === socket.id);
    if (participant) await leaveCurrentRoom(socket, participant.userId);
  });
});

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`Watch party server listening on port ${port}`);
});
