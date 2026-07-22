import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

// Public routes (no auth) sit at the top level; everything that requires a
// signed-in principal lives under the pathless `protected` layout whose
// middleware enforces authentication (ADR 0012 §Decision 4/5).
export default [
  route("login", "routes/login.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
  route("logout", "routes/logout.tsx"),
  layout("routes/protected.tsx", [index("routes/home.tsx")]),
] satisfies RouteConfig;
