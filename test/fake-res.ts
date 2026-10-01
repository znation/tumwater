import type http from "node:http";

/** The shared fake `http.ServerResponse` for the dashboard endpoint unit tests
 * (gui-args.test.ts, gui-endpoints.test.ts): capture writeHead/end into a plain object so a
 * handler's status, content-type, and body can be asserted without a socket. The handlers
 * under test only ever answer through writeHead + end, so this captures everything they
 * can emit. */
export interface Captured {
  status?: number;
  contentType?: string;
  body: string;
}

export function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = { body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.contentType = headers["content-type"];
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}
