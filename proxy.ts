import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

// A convenience redirect, NOT an authorization boundary.
//
// This checks only whether a session cookie is PRESENT. It does not verify the
// signature or the expiry, and it deliberately never will: Next's own guidance
// is that proxy code runs separately from render code and may be deployed to a
// CDN, and a server action is reachable without passing through here at all.
// Every real check is requireAdmin() / requireInstance() in lib/auth.ts, called
// inside each page and each action.
//
// So the worst this can do is send a signed-out visitor to /login one hop
// earlier, or let a forged cookie through to a page that will reject it anyway.
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the login page itself, the reviewer surface, Next's
  // internals, and static files.
  //
  // `/r` is exempt because reviewers do not hold the app-level password and must
  // not be sent to /login. Their gate is requireReviewer() in lib/reviewer-auth.ts,
  // called in every reviewer page and every reviewer action — the same posture
  // as the admin gates, and for the same reason: this file is a convenience
  // redirect, not an authorization boundary.
  //
  // `r(?:/|$)` and not a bare `r`, which would also exempt every future
  // top-level path that happens to begin with the letter r.
  matcher: ["/((?!login|r(?:/|$)|_next/static|_next/image|favicon.ico).*)"],
};
