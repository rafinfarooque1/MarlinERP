import type { Request, Router } from "express";
import { ReportExportError } from "./reportExportContract";

/**
 * Transitional in-process adapter for canonical GET handlers not yet extracted
 * into services. The caller supplies a SERVER-CONSTANT path, never a client URL.
 * Executes the router's original permission/scope middleware with the original
 * authenticated employee. No network, cookies, token forwarding or self-loop.
 */
export function readReportRoute(router: Router, original: Request, path: string, query: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = Object.create(original);
    Object.defineProperties(request, {
      method: { value: "GET", writable: true },
      url: { value: path, writable: true },
      originalUrl: { value: `/api${path}`, writable: true },
      baseUrl: { value: "", writable: true },
      query: { value: query, writable: true },
      body: { value: undefined, writable: true },
      params: { value: {}, writable: true },
      headers: { value: { ...original.headers }, writable: true },
    });
    let status = 200;
    const headers = new Map<string, unknown>();
    const finish = (payload: any) => {
      if (status < 200 || status >= 300) reject(new ReportExportError(status, payload?.error || "Report source request failed"));
      else if (payload === undefined) reject(new ReportExportError(502, "Report source returned no payload"));
      else resolve(payload);
    };
    const response: any = {
      locals: {}, req: request,
      status(code: number) { status = code; return this; },
      setHeader(key: string, value: unknown) { headers.set(key.toLowerCase(), value); return this; },
      getHeader(key: string) { return headers.get(key.toLowerCase()); },
      set(key: string, value: unknown) { return this.setHeader(key, value); },
      header(key: string, value: unknown) { return this.setHeader(key, value); },
      json: finish, send: finish, end: finish,
    };
    request.res = response;
    // Express 5 forwards rejected async handlers through this callback.
    router(request, response, (error?: unknown) => reject(error || new ReportExportError(404, "Canonical report source was not found")));
  });
}