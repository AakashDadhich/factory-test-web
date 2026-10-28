import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

const NAME_PATTERN = /^[A-Za-z]{1,40}$/;

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/greeting", (req, res) => {
    const name = req.query.name;
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      res.status(400).json({ error: "name must be 1 to 40 letters" });
      return;
    }
    res.json({ message: `Hello, ${name}!` });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = clientErrorStatus(err);
    res.status(status ?? 500).json({ error: status ? "bad request" : "internal error" });
  });

  return app;
}

function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return status;
    }
  }
  return undefined;
}
