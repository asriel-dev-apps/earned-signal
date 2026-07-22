import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Last-resort backstop: any unhandled throw (loader/render) renders this clean
// page inside `Layout` instead of a blank document. Kept intentionally minimal.
export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? "お探しのページを表示できませんでした。"
    : "予期しないエラーが発生しました。時間をおいて、もう一度お試しください。";
  return (
    <main>
      <h1>エラーが発生しました</h1>
      <p>{message}</p>
      <a href="/">トップへ戻る</a>
    </main>
  );
}
