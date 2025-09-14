// server.js — MCP (Streamable HTTP) with search + fetch + answer
import express from "express";
import cors from "cors";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT || 3000;
const PPLX_API_KEY = process.env.PERPLEXITY_API_KEY;
const PPLX_MODEL  = process.env.PERPLEXITY_MODEL || "sonar-pro";
const PPLX_URL    = "https://api.perplexity.ai/chat/completions";

const log = (...args) => console.log("[MCP]", ...args);

// --- Perplexity 呼叫（可選 style / minWords，但預設尊重原生長度）---
async function askPerplexity(query, opts = {}) {
  if (!PPLX_API_KEY) throw new Error("Missing PERPLEXITY_API_KEY");
  const { style, minWords } = opts;

  let system = "Answer helpfully and accurately.";
  if (style || minWords) {
    const target =
      style === "short" ? Math.max(60,  minWords ?? 0) :
      style === "medium"? Math.max(160, minWords ?? 0) :
      style === "long"  ? Math.max(300, minWords ?? 0) :
      undefined;
    if (target) {
      system =
        `You are a meticulous research assistant. ` +
        `Write around ${target} words if appropriate, ` +
        `but do NOT pad or fabricate when the question is simple. ` +
        `Prefer precision over verbosity.`;
    }
  }

  const res = await fetch(PPLX_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PPLX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: PPLX_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: query }
      ],
      temperature: 0.3
      // 想更長可自訂：max_tokens: 2000
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Perplexity ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const full = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
  return { full, meta: { model: json?.model, usage: json?.usage } };
}

// --- Base64url helpers（stateless id）---
const b64enc = (s) => Buffer.from(s, "utf8").toString("base64url");
const b64dec = (s) => Buffer.from(s, "base64url").toString("utf8");

// --- MCP server（加上 search + fetch，並保留 answer）---
function buildServer() {
  const server = new McpServer({ name: "perplexcity-mcp", version: "1.3.0" });

  // 1) 備用：直接取未壓縮原文（開發者模式可直接叫用）
  server.registerTool(
    "answer",
    {
      title: "Perplexity Answer (raw)",
      description: "Return the full, uncompressed answer from Perplexity, wrapped with raw markers.",
      inputSchema: {
        query: z.string(),
        style: z.enum(["short", "medium", "long"]).optional(),
        min_words: z.number().int().positive().optional()
      }
    },
    async ({ query, style, min_words }) => {
      log("answer called:", { query, style, min_words });
      const { full, meta } = await askPerplexity(query, { style, minWords: min_words });
      const payload =
`<<<PPLX_RAW>>>
${full}
<<<END_PPLX_RAW>>>

[meta] ${JSON.stringify(meta)}`;
      return { content: [{ type: "text", text: payload }] };
    }
  );

  // 2) 正規要求：search（回傳結果清單）
  server.registerTool(
    "search",
    {
      title: "Search (Perplexity)",
      description: "Return a list of search results for the given query (ids, titles, urls).",
      inputSchema: { query: z.string() }
    },
    async ({ query }) => {
      log("search called:", { query });
      const id = b64enc(query);
      const results = [
        {
          id,
          title: `Perplexity: ${query}`,
          url: `https://www.perplexity.ai/search?q=${encodeURIComponent(query)}`
        }
      ];
      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    }
  );

  // 3) 正規要求：fetch（用 id 還原查詢並取「未壓縮全文」）
  server.registerTool(
    "fetch",
    {
      title: "Fetch full text for a search result",
      description: "Given a search result id, return the full document text and metadata.",
      inputSchema: { id: z.string() }
    },
    async ({ id }) => {
      const query = b64dec(id);
      log("fetch called:", { id, query });
      const { full } = await askPerplexity(query);
      const doc = {
        id,
        title: `Perplexity: ${query}`,
        text: full,
        url: `https://www.perplexity.ai/search?q=${encodeURIComponent(query)}`,
        metadata: { source: "perplexity", model: PPLX_MODEL }
      };
      return { content: [{ type: "text", text: JSON.stringify(doc) }] };
    }
  );

  return server;
}

// --- Express + Transport ---
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "mcp-session-id"],
  exposedHeaders: ["Mcp-Session-Id"]
}));
app.options("/mcp", cors());
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    hint: "MCP endpoint: POST /mcp ; health: /health"
  });
});

app.listen(PORT, () => log(`MCP server listening on ${PORT}`));
