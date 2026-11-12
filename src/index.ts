#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { loadConfig, type Config } from "./config.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";
import { YnabService } from "./ynab.js";

const VERSION = "1.0.0";

function buildServer(ynab: YnabService, config: Config): McpServer {
  const server = new McpServer(
    { name: "ynab", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, ynab, config);
  return server;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function runHttp(config: Config, ynab: YnabService) {
  if (!config.authToken && !/^(1|true)$/i.test(process.env.ALLOW_UNAUTHENTICATED ?? "")) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set. Refusing to expose budget data without auth " +
        "(set ALLOW_UNAUTHENTICATED=true only for local testing).",
    );
  }

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.set("trust proxy", true);

  app.get(["/", "/health"], (_req, res) => {
    res.json({ status: "ok", name: "ynab-mcp", version: VERSION, mcp_endpoint: "/mcp" });
  });

  // Auth: "Authorization: Bearer <token>" header, or the token as a path segment
  // (/mcp/<token>) for clients that can only be given a URL (e.g. Claude custom connectors).
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!config.authToken) return next();
    const header = req.headers.authorization;
    const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
    const supplied = bearer ?? pathToken;
    if (supplied && safeEqual(supplied, config.authToken)) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  // Stateless Streamable HTTP: a fresh server+transport per request. The YNAB cache
  // lives in YnabService and is shared across requests.
  const handle = async (req: Request, res: Response) => {
    const server = buildServer(ynab, config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP request failed:", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server: use POST)." },
      id: null,
    });
  };

  for (const path of ["/mcp", "/mcp/:token"]) {
    app.post(path, auth, handle);
    app.get(path, auth, notAllowed);
    app.delete(path, auth, notAllowed);
  }

  app.listen(config.port, "0.0.0.0", () => {
    console.log(
      `YNAB MCP server listening on :${config.port} (plan=${config.defaultPlanId}, writes=${config.allowWrites ? "on" : "off"}, ` +
        `auth=${config.authToken ? "on" : "OFF"})`,
    );
  });
}

async function runStdio(config: Config, ynab: YnabService) {
  const server = buildServer(ynab, config);
  await server.connect(new StdioServerTransport());
  console.error("YNAB MCP server running on stdio");
}

async function main() {
  const config = loadConfig();
  const ynab = new YnabService(config.ynabToken, config.defaultPlanId, config.cacheTtlSeconds * 1000);
  if (process.argv.includes("--stdio")) await runStdio(config, ynab);
  else await runHttp(config, ynab);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
