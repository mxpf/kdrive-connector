// Opt-in, read-only live probe. Uses an existing Inspector grant; never refreshes it.
// Only initialize, discovery, and protocol notifications are sent. No tools/call.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [oauthFile, verificationMode] = process.argv.slice(2);
if (!oauthFile) throw new Error("Pass the Inspector OAuth storage path (not a token).");
const endpoint = "https://kdrive-connector-mcp.maxpfennighaus.workers.dev/mcp";
const entry = JSON.parse(readFileSync(oauthFile, "utf8")).servers?.[endpoint];
const token = entry?.byIssuer?.[entry.activeIssuer]?.tokens?.access_token;
if (!token) throw new Error("No existing grant for the configured kDrive endpoint.");
const methods = ["listTools", "listResources", "listResourceTemplates"];
let failed = false;
const modes = verificationMode === "--verify" ? ["normal", "normal", "normal", "normal"]
  : ["no-get", "delayed", "no-get", "delayed"];
for (const mode of modes) {
  const client = new Client({ name: "kdrive-discovery-probe", version: "1.0.0" });
  const options = { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
  // Diagnostic control only: emulate an unsupported optional GET stream locally.
  // The deployed server, POST responses, and OAuth configuration are unchanged.
  options.fetch = (url, init) => mode === "no-get" && init?.method === "GET"
    ? Promise.resolve(new Response(null, { status: 405 })) : fetch(url, init);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), options);
  try {
    await client.connect(transport, { timeout: 8000 });
    if (mode === "delayed") await new Promise(resolve => setTimeout(resolve, 1000));
    const started = Date.now();
    const results = await Promise.allSettled(methods.map(method => client[method](undefined, { timeout: 8000 })));
    const summary = results.map((result, index) => {
      if (result.status === "rejected") {
        failed = true;
        return { method: methods[index], ok: false, errorCode: result.reason?.code };
      }
      const value = result.value;
      const items = value.tools ?? value.resources ?? value.resourceTemplates;
      const valid = index === 0 ? value.tools?.length === 17 &&
        ["kdrive_export_file", "kdrive_upload_file_ref", "kdrive_upload_from_url"].every(name => value.tools.some(tool => tool.name === name))
        : index === 1 ? value.resources?.length === 2 : value.resourceTemplates?.length === 0;
      if (!valid) failed = true;
      return { method: methods[index], ok: !!valid, count: items.length,
        ...(value.tools ? { names: value.tools.map(tool => tool.name) } : {}) };
    });
    console.log(JSON.stringify({ mode, durationMs: Date.now() - started, results: summary }));
  } catch (error) {
    failed = true;
    // Never print error messages, headers, URLs, tokens, or raw server responses.
    console.log(JSON.stringify({ mode, connected: false, errorCode: error?.code }));
  } finally {
    await client.close();
  }
}
process.exitCode = failed ? 1 : 0;
