/**
 * @file middleware.ts
 * @description Next.js Edge Middleware for route protection and CSP nonce.
 *
 * This middleware runs at the Edge/Server level to protect sensitive routes
 * before the page even renders, preventing unauthorized users from seeing
 * a flash of protected content.
 *
 * Protected routes:
 * - /payouts (maintainer dashboard)
 * - /settings (user settings)
 *
 * The middleware checks for the presence of an HttpOnly JWT cookie.
 * If missing or malformed, it redirects to the homepage or login page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateNonce } from '@/utils/cspNonce';

// Define protected routes that require authentication
const PROTECTED_ROUTES = ['/payouts', '/settings'];

// Define public routes that should never be redirected
const PUBLIC_ROUTES = ['/', '/login', '/dashboard', '/organizations', '/profile'];

/**
 * Middleware function to protect routes and inject CSP nonce.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Generate a nonce for this request
  const nonce = generateNonce();

  // Prepare a response that will continue processing
  const response = NextResponse.next();
  // Attach nonce via a custom header for the Document to read
  response.headers.set('x-csp-nonce', nonce);
  // Build CSP header with the nonce for inline scripts
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'`;
  response.headers.set('Content-Security-Policy', csp);

  // Skip middleware for static assets, API routes, and public routes
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/static') ||
    PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'))
  ) {
    return response;
  }

  // Check if the current path is a protected route
  const isProtectedRoute = PROTECTED_ROUTES.some(route =>
    pathname === route || pathname.startsWith(route + '/')
  );

  if (!isProtectedRoute) {
    return response;
  }

  // Check for JWT cookie (HttpOnly cookie set by backend)
  const token =
    request.cookies.get('auth-token')?.value ||
    request.cookies.get('jwt')?.value ||
    request.cookies.get('token')?.value;

  // If no token found, redirect to homepage
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  // Basic token format validation (non‑cryptographic)
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    const payload = parts[1];
    if (!payload) {
      throw new Error('Invalid payload');
    }
    Buffer.from(payload, 'base64');
  } catch (error) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  // Token valid – allow request to proceed
  return response;
}

/**
 * Configure which paths the middleware should run on.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
  ],
};
