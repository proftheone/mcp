import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createAccountServer } from "./accountServer.js";
import { cryptoReady } from "./crypto.js";
import { ACCOUNT_MCP_PATH, mountOAuth, requireAccessToken, type AccessClaims } from "./oauth.js";

if (process.argv.includes("--stdio")) {
  // Local use (Claude Desktop config) - public knowledge tools only
  await createServer().connect(new StdioServerTransport());
} else {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      name: "EPRPilot MCP",
      status: "ok",
      endpoints: { public: "/mcp", account: cryptoReady ? ACCOUNT_MCP_PATH + " (OAuth)" : "disabled (set ENCRYPTION_KEY)" },
      docs: "https://eprpilot.com",
    });
  });
  app.get("/health", (_req, res) => {
    res.send("ok");
  });

  if (cryptoReady) {
    mountOAuth(app);
  } else {
    app.use(["/oauth", "/.well-known", ACCOUNT_MCP_PATH], (_req, res) => {
      res.status(503).json({ error: "account_disabled", error_description: "Server is missing ENCRYPTION_KEY" });
    });
  }

  /** Stateless Streamable HTTP: a fresh server + transport per request. */
  const handle = (make: (req: express.Request) => McpServer) => async (req: express.Request, res: express.Response) => {
    const server = make(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const notAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };

  const json = express.json({ limit: "4mb" });
  app.post("/mcp", json, handle(() => createServer()));
  app.post(ACCOUNT_MCP_PATH, requireAccessToken, json, handle((req) => createAccountServer((req as any).claims as AccessClaims)));
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.get(ACCOUNT_MCP_PATH, requireAccessToken, notAllowed);
  app.delete(ACCOUNT_MCP_PATH, requireAccessToken, notAllowed);

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`EPRPilot MCP listening on :${port} (public /mcp, account ${ACCOUNT_MCP_PATH})`));
}
