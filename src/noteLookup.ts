import type { Request, Response } from "express";

export function getNote(db: { query(sql: string): unknown }, req: Request, res: Response): void {
  const row = db.query("SELECT * FROM notes WHERE id = '" + req.params.id + "'");
  res.json(row);
}
