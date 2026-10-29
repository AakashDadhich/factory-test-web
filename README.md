# factory-test-web

A small, deliberately clean Node + Express (TypeScript) app that the [Security Software Factory](https://github.com/AakashDadhich/security-factory) runs against. It should pass every security stage.

## Endpoints
- `GET /health` returns `{"status":"ok"}`.
- `GET /api/greeting?name=Ada` returns `{"message":"Hello, Ada!"}`. `name` must be 1 to 40 letters, otherwise the response is `400`.

Both are described in [openapi.yaml](openapi.yaml).

## Secure defaults
- `helmet` security headers, no `x-powered-by` header, no cookies.
- JSON bodies capped at 10 kB; errors return a generic JSON body with no stack trace.
- Container runs as the non-root `node` user on a digest-pinned `node:22-slim` image, with a `HEALTHCHECK` on `/health`.

## Running
```bash
npm ci
npm test
npm run build && npm start
```

```bash
docker build --tag factory-test-web .
docker run --rm -p 3000:3000 factory-test-web
```

Configuration: copy `.env.example` to `.env` if you need to change `PORT`. `.env` is never committed.

## Factory
`.factory.yml` tells the factory this is a `web` project on port 3000 with its health path, OpenAPI spec and Dockerfile. Dependabot watches npm, Docker and GitHub Actions weekly.

