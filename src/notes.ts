import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

export const MAX_NOTE_LENGTH = 2000;
export const MAX_NOTES_PER_USER = 500;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const RATE_LIMIT_PER_MINUTE = 120;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Session {
  userId: string;
  csrfToken: string;
}

/** Resolves the existing app session for a request; returns undefined when there is none. */
export type SessionResolver = (req: Request) => Session | undefined;

export interface Note {
  id: string;
  ownerId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** Every operation takes the owner id so ownership is part of the query condition. */
export interface NoteStore {
  create(ownerId: string, text: string): Note | undefined;
  get(ownerId: string, id: string): Note | undefined;
  list(ownerId: string, offset: number, limit: number): Note[];
  update(ownerId: string, id: string, text: string): Note | undefined;
  delete(ownerId: string, id: string): boolean;
  deleteAllForOwner(ownerId: string): number;
}

export type SecurityLogger = (event: Record<string, string>) => void;

export class MemoryNoteStore implements NoteStore {
  private readonly notes = new Map<string, Note>();

  create(ownerId: string, text: string): Note | undefined {
    let count = 0;
    for (const n of this.notes.values()) {
      if (n.ownerId === ownerId) count++;
    }
    if (count >= MAX_NOTES_PER_USER) return undefined;
    const now = new Date().toISOString();
    const note: Note = { id: randomUUID(), ownerId, text, createdAt: now, updatedAt: now };
    this.notes.set(note.id, note);
    return { ...note };
  }

  get(ownerId: string, id: string): Note | undefined {
    const note = this.notes.get(id);
    return note && note.ownerId === ownerId ? { ...note } : undefined;
  }

  list(ownerId: string, offset: number, limit: number): Note[] {
    return [...this.notes.values()]
      .filter((n) => n.ownerId === ownerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(offset, offset + limit)
      .map((n) => ({ ...n }));
  }

  update(ownerId: string, id: string, text: string): Note | undefined {
    const note = this.notes.get(id);
    if (!note || note.ownerId !== ownerId) return undefined;
    note.text = text;
    note.updatedAt = new Date().toISOString();
    return { ...note };
  }

  delete(ownerId: string, id: string): boolean {
    const note = this.notes.get(id);
    if (!note || note.ownerId !== ownerId) return false;
    return this.notes.delete(id);
  }

  deleteAllForOwner(ownerId: string): number {
    let removed = 0;
    for (const [id, n] of this.notes) {
      if (n.ownerId === ownerId && this.notes.delete(id)) removed++;
    }
    return removed;
  }
}

export interface NotesOptions {
  sessions: SessionResolver;
  store: NoteStore;
  allowedOrigins: string[];
  log: SecurityLogger;
}

// JSON.stringify in the default logger escapes control characters, preventing log injection.
export const defaultSecurityLogger: SecurityLogger = (event) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
};

function publicNote(n: Note): { id: string; text: string; createdAt: string; updatedAt: string } {
  return { id: n.id, text: n.text, createdAt: n.createdAt, updatedAt: n.updatedAt };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const text = (body as { text?: unknown }).text;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_NOTE_LENGTH) {
    return undefined;
  }
  return text;
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return undefined;
  const n = Number(value);
  return n >= min && n <= max ? n : undefined;
}

export function createNotesRouter(opts: NotesOptions): express.Router {
  const router = express.Router();
  const windows = new Map<string, { start: number; count: number }>();

  const notFound = (res: Response): void => {
    res.status(404).json({ error: "not found" });
  };
  const badRequest = (res: Response): void => {
    res.status(400).json({ error: "bad request" });
  };

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    const session = opts.sessions(req);
    if (!session || !session.userId) {
      opts.log({ event: "auth_failure", action: req.method, outcome: "denied" });
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.locals.session = session;
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    const { userId } = res.locals.session as Session;
    const now = Date.now();
    const w = windows.get(userId);
    if (!w || now - w.start >= 60_000) {
      if (windows.size > 10_000) windows.clear();
      windows.set(userId, { start: now, count: 1 });
    } else if (++w.count > RATE_LIMIT_PER_MINUTE) {
      opts.log({ event: "rate_limited", userId, action: req.method, outcome: "denied" });
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    const session = res.locals.session as Session;
    const origin = req.get("origin");
    const token = req.get("x-csrf-token");
    const originOk = origin === undefined || opts.allowedOrigins.includes(origin);
    const tokenOk =
      typeof token === "string" && session.csrfToken.length > 0 && safeEqual(token, session.csrfToken);
    if (!originOk || !tokenOk) {
      opts.log({ event: "csrf_rejected", userId: session.userId, action: req.method, outcome: "denied" });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  });

  router.post("/", (req, res) => {
    const { userId } = res.locals.session as Session;
    const text = parseText(req.body);
    if (text === undefined) {
      badRequest(res);
      return;
    }
    const note = opts.store.create(userId, text);
    if (!note) {
      opts.log({ event: "note_quota", userId, action: "create", outcome: "denied" });
      res.status(409).json({ error: "limit reached" });
      return;
    }
    opts.log({ event: "note_create", userId, noteId: note.id, action: "create", outcome: "success" });
    res.status(201).json(publicNote(note));
  });

  router.get("/", (req, res) => {
    const { userId } = res.locals.session as Session;
    const limit = parseInteger(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = parseInteger(req.query.offset, 0, 0, 1_000_000);
    if (limit === undefined || offset === undefined) {
      badRequest(res);
      return;
    }
    res.json({ notes: opts.store.list(userId, offset, limit).map(publicNote), limit, offset });
  });

  const denyUnknown = (req: Request, res: Response, action: string): void => {
    const { userId } = res.locals.session as Session;
    const rawId = req.params.id;
    const noteId = typeof rawId === "string" && ID_PATTERN.test(rawId) ? rawId : "invalid";
    opts.log({ event: "note_access_denied", userId, noteId, action, outcome: "not_found" });
    notFound(res);
  };

  const validId = (req: Request): string | undefined => {
    const id = req.params.id;
    return typeof id === "string" && ID_PATTERN.test(id) ? id : undefined;
  };

  router.get("/:id", (req, res) => {
    const { userId } = res.locals.session as Session;
    const id = validId(req);
    const note = id ? opts.store.get(userId, id) : undefined;
    if (!note) {
      denyUnknown(req, res, "read");
      return;
    }
    res.json(publicNote(note));
  });

  router.put("/:id", (req, res) => {
    const { userId } = res.locals.session as Session;
    const id = validId(req);
    const text = parseText(req.body);
    if (text === undefined) {
      badRequest(res);
      return;
    }
    const note = id ? opts.store.update(userId, id, text) : undefined;
    if (!note) {
      denyUnknown(req, res, "update");
      return;
    }
    opts.log({ event: "note_update", userId, noteId: note.id, action: "update", outcome: "success" });
    res.json(publicNote(note));
  });

  router.delete("/:id", (req, res) => {
    const { userId } = res.locals.session as Session;
    const id = validId(req);
    if (!id || !opts.store.delete(userId, id)) {
      denyUnknown(req, res, "delete");
      return;
    }
    opts.log({ event: "note_delete", userId, noteId: id, action: "delete", outcome: "success" });
    res.status(204).end();
  });

  return router;
}
