import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (context) =>
  context.json({ service: "earned-signal", status: "ok" }),
);

export default app;
