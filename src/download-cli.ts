import { materializeBinaryReference } from "./binary-materialize.js";

// Receive private reference JSON over stdin, never as a shell argument or log.
try {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 32768) throw new Error("Reference too large");
    chunks.push(Buffer.from(chunk));
  }
  const ref = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await materializeBinaryReference(ref, {
    origin: process.env.KDRIVE_CONNECTOR_BASE_URL ?? "https://kdrive-connector-mcp.maxpfennighaus.workers.dev",
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("Binary reference download failed. Refresh an expired reference with kdrive_export_file; verify the version before retrying. No signed URL or credentials are logged.\n");
  process.exitCode = 1;
}
