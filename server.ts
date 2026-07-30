/**
 * Deno Voice Agent Starter - Backend Server
 *
 * This is a Deno HTTP/WebSocket server that provides a voice agent interface
 * by proxying messages between the client and Deepgram's Voice Agent API.
 *
 * Key Features:
 * - WebSocket endpoint: /api/voice-agent
 * - Bidirectional audio/control streaming
 * - JWT session auth for API protection
 * - Metadata endpoint: /api/metadata
 * - Native TypeScript support
 * - No external web framework needed
 */

import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";
import * as jose from "jose";
import { DeepgramClient } from "@deepgram/sdk";

// Load environment variables
await load({ export: true });

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens for API protection
// ============================================================================

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

const JWT_EXPIRY = "1h";

let indexHtmlTemplate: string | null = null;
try {
  indexHtmlTemplate = await Deno.readTextFile(
    new URL("./frontend/dist/index.html", import.meta.url).pathname
  );
} catch {
  // No built frontend (dev mode)
}

/**
 * Creates a signed JWT session token
 */
async function createSessionToken(): Promise<string> {
  return await new jose.SignJWT({ iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(JWT_EXPIRY)
    .sign(SESSION_SECRET_KEY);
}

/**
 * Verifies a JWT session token
 */
async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jose.jwtVerify(token, SESSION_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables
 */
function loadApiKey(): string {
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");

  if (!apiKey) {
    console.error("\n❌ ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    Deno.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// DEEPGRAM SDK CLIENT
// ============================================================================

// A single SDK client is reused across connections; auth is resolved from the
// API key here, so the browser never sees it. The default Production
// environment already points the agent websocket at wss://agent.deepgram.com.
//
// DEEPGRAM_BASE_URL (e.g. a staging host like wss://agent.staging.deepgram.com)
// overrides the default agent endpoint.
const baseUrl = Deno.env.get("DEEPGRAM_BASE_URL");
const httpBase = baseUrl
  ?.replace(/^wss:\/\//, "https://")
  .replace(/^ws:\/\//, "http://");
const deepgram = new DeepgramClient({
  apiKey,
  ...(baseUrl && httpBase
    ? {
        environment: {
          base: httpBase,
          production: baseUrl,
          agent: baseUrl,
          agentRest: httpBase,
        },
      }
    : {}),
});
if (baseUrl) {
  console.log(`Using custom Deepgram base URL: ${baseUrl}`);
}

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ============================================================================
// TYPES - TypeScript interfaces for WebSocket communication
// ============================================================================

interface ErrorMessage {
  type: "Error";
  description: string;
  code: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Collect the client's query params so they can be forwarded to Deepgram via
 * the SDK's `queryParams` connect option (preserving the previous behavior of
 * passing every query parameter straight through to the agent endpoint).
 */
function collectQueryParams(queryParams: URLSearchParams): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [key, value] of queryParams.entries()) {
    forwarded[key] = value;
  }
  return forwarded;
}

/**
 * Send error message to client WebSocket
 */
function sendError(socket: WebSocket, error: Error, code: string = "UNKNOWN_ERROR") {
  if (socket.readyState === WebSocket.OPEN) {
    const errorMsg: ErrorMessage = {
      type: "Error",
      description: error.message,
      code: code,
    };
    socket.send(JSON.stringify(errorMsg));
  }
}

// ============================================================================
// WEBSOCKET HANDLERS
// ============================================================================

/**
 * Handle voice agent WebSocket connection
 * Establishes bidirectional proxy between client and Deepgram
 */
type AgentConnection = Awaited<
  ReturnType<typeof deepgram.agent.v1.createConnection>
>;

type PendingMessage =
  | { binary: true; data: ArrayBuffer }
  | { binary: false; msg: Record<string, unknown> };

async function handleVoiceAgent(
  clientSocket: WebSocket,
  queryParams: URLSearchParams
) {
  console.log("Client connected to /api/voice-agent");

  // Ensure binary mic audio arrives as ArrayBuffer so we can forward it
  // straight to the SDK's sendMedia().
  clientSocket.binaryType = "arraybuffer";

  const forwarded = collectQueryParams(queryParams);
  const connectArgs =
    Object.keys(forwarded).length > 0 ? { queryParams: forwarded } : undefined;

  // Buffer any browser messages that arrive before the Deepgram socket is open.
  let dgReady = false;
  const pending: PendingMessage[] = [];

  // Create the Deepgram Voice Agent connection object (not yet connected). The
  // SDK manages the websocket, auth, reconnection and (de)serialization; its
  // WrappedAgentV1Socket delivers binary audio frames as-is.
  let dgConn: AgentConnection;
  try {
    dgConn = await deepgram.agent.v1.createConnection(connectArgs);
  } catch (err) {
    console.error("Failed to create Deepgram connection:", err);
    sendError(clientSocket, err as Error, "CONNECTION_FAILED");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(3000, "Failed to reach Deepgram");
    }
    return;
  }

  // Route a browser control message to the matching SDK method. The browser
  // speaks the standard Deepgram Agent protocol; the parsed JSON is passed to
  // the corresponding typed send* method (payloads are cast to the method's
  // parameter type since they originate from the trusted frontend).
  const dispatchControl = (msg: Record<string, unknown>) => {
    try {
      switch (msg.type) {
        case "Settings":
          dgConn.sendSettings(msg as unknown as Parameters<typeof dgConn.sendSettings>[0]);
          break;
        case "UpdateListen":
          dgConn.sendUpdateListen(msg as unknown as Parameters<typeof dgConn.sendUpdateListen>[0]);
          break;
        case "UpdateThink":
          dgConn.sendUpdateThink(msg as unknown as Parameters<typeof dgConn.sendUpdateThink>[0]);
          break;
        case "UpdateSpeak":
          dgConn.sendUpdateSpeak(msg as unknown as Parameters<typeof dgConn.sendUpdateSpeak>[0]);
          break;
        case "UpdatePrompt":
          dgConn.sendUpdatePrompt(msg as unknown as Parameters<typeof dgConn.sendUpdatePrompt>[0]);
          break;
        case "InjectUserMessage":
          dgConn.sendInjectUserMessage(msg as unknown as Parameters<typeof dgConn.sendInjectUserMessage>[0]);
          break;
        case "InjectAgentMessage":
          dgConn.sendInjectAgentMessage(msg as unknown as Parameters<typeof dgConn.sendInjectAgentMessage>[0]);
          break;
        case "FunctionCallResponse":
          dgConn.sendFunctionCallResponse(msg as unknown as Parameters<typeof dgConn.sendFunctionCallResponse>[0]);
          break;
        case "KeepAlive":
          dgConn.sendKeepAlive({ type: "KeepAlive" });
          break;
        default:
          console.warn("Ignoring unknown client control message type:", msg.type);
      }
    } catch (err) {
      console.error("Failed to forward control message to Deepgram:", err);
    }
  };

  // Deepgram -> browser. Binary audio frames (agent speech) are forwarded as-is;
  // JSON events (Welcome / ConversationText / AgentAudioDone / ...) are
  // re-serialized so the frontend sees the same JSON it received before.
  dgConn.on("message", (data: unknown) => {
    if (clientSocket.readyState !== WebSocket.OPEN) return;
    if (
      data instanceof ArrayBuffer ||
      data instanceof Blob ||
      ArrayBuffer.isView(data)
    ) {
      clientSocket.send(data as ArrayBuffer | Blob | ArrayBufferView);
    } else if (typeof data === "string") {
      clientSocket.send(data);
    } else {
      clientSocket.send(JSON.stringify(data));
    }
  });

  dgConn.on("open", () => {
    console.log("✓ Connected to Deepgram Voice Agent");
  });

  dgConn.on("error", (err) => {
    console.error("Deepgram socket error:", err);
    sendError(clientSocket, new Error("Deepgram connection error"), "DEEPGRAM_ERROR");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
  });

  dgConn.on("close", () => {
    console.log("Deepgram connection closed");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
  });

  // browser -> Deepgram. Binary frames are mic audio; text frames are JSON
  // control messages (Settings / Update* / Inject* / FunctionCallResponse /
  // KeepAlive).
  clientSocket.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
      if (!dgReady) {
        pending.push({ binary: true, data });
        return;
      }
      try {
        dgConn.sendMedia(data);
      } catch (err) {
        console.error("Failed to send audio to Deepgram:", err);
      }
      return;
    }

    // Text frame — a JSON control message.
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      console.warn("Ignoring non-JSON text message from client");
      return;
    }
    if (!dgReady) {
      pending.push({ binary: false, msg });
      return;
    }
    dispatchControl(msg);
  };

  // Handle client disconnect
  clientSocket.onclose = () => {
    console.log("Client disconnected");
    try {
      dgConn.close();
    } catch {
      // already closed
    }
  };

  // Handle client errors
  clientSocket.onerror = (err) => {
    console.error("Client WebSocket error:", err);
    try {
      dgConn.close();
    } catch {
      // already closed
    }
  };

  // Open the Deepgram connection and flush anything the browser sent early.
  try {
    dgConn.connect();
    await dgConn.waitForOpen();
    dgReady = true;
    for (const item of pending) {
      if (item.binary) {
        try {
          dgConn.sendMedia(item.data);
        } catch (err) {
          console.error("Failed to send buffered audio to Deepgram:", err);
        }
      } else {
        dispatchControl(item.msg);
      }
    }
    pending.length = 0;
  } catch (err) {
    console.error("Deepgram connection did not open:", err);
    sendError(clientSocket, err as Error, "CONNECTION_FAILED");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(3000, "Setup failed");
    }
  }
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * Serve index.html (production only)
 */
function handleServeIndex(): Response {
  if (!indexHtmlTemplate) {
    return new Response("Frontend not built. Run make build first.", { status: 404 });
  }
  return new Response(indexHtmlTemplate, {
    headers: { "Content-Type": "text/html", ...getCorsHeaders() },
  });
}

/**
 * GET /api/session
 * Issues a signed JWT session token.
 */
async function handleGetSession(): Promise<Response> {
  const token = await createSessionToken();
  return Response.json({ token }, { headers: getCorsHeaders() });
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/metadata
 * Returns metadata about this starter application
 */
async function handleMetadata(): Promise<Response> {
  try {
    const tomlContent = await Deno.readTextFile("./deepgram.toml");
    const config = TOML.parse(tomlContent);

    if (!config.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(config.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session routes (unprotected)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return handleServeIndex();
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    return await handleGetSession();
  }

  // WebSocket endpoint: /api/voice-agent (auth via subprotocol)
  if (url.pathname === "/api/voice-agent") {
    const upgrade = req.headers.get("upgrade") || "";

    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426, headers: getCorsHeaders() });
    }

    // Validate JWT from subprotocol
    const protocols = req.headers.get("sec-websocket-protocol") || "";
    const protocolList = protocols.split(",").map((p) => p.trim());
    const tokenProto = protocolList.find((p) => p.startsWith("access_token."));

    if (!tokenProto) {
      return new Response("Unauthorized", { status: 401, headers: getCorsHeaders() });
    }

    const jwtToken = tokenProto.slice("access_token.".length);
    if (!(await verifySessionToken(jwtToken))) {
      return new Response("Unauthorized", { status: 401, headers: getCorsHeaders() });
    }

    // Upgrade with accepted subprotocol
    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: tokenProto,
    });

    // Handle the WebSocket connection
    handleVoiceAgent(socket, url.searchParams);

    return response;
  }

  // Metadata (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: getCorsHeaders() }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`🚀 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`📡 GET  /api/session`);
console.log(`📡 WS   /api/voice-agent (auth required)`);
console.log(`📡 GET  /api/metadata`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);
