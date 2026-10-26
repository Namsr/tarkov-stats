import { createInterface } from "node:readline";

function receive({ id, args: [action] }) {
  const send = (reply) => process.send ? process.send(reply) : process.stdout.write(`${JSON.stringify(reply)}\n`);
  if (action === "crash") process.exit(17);
  if (action === "stall") return;
  if (action === "invalid") return process.stdout.write("invalid json\n");
  if (action === "wrong_id") return send({ id: id + 1, result: true });
  if (action === "oversize") return process.stdout.write("x".repeat(140 * 1024));
  if (action === "error") return send({ id, error: "fixture calculation failure" });
  const reply = { id, result: { pid: process.pid, action, text: "\u0427\u0412\u041a" } };
  if (process.send) return send(reply);
  const frame = `${JSON.stringify(reply)}\n`;
  // Split inside UTF-8 and inside the JSON frame, as a real pipe may do.
  const bytes = Buffer.from(frame);
  const boundary = bytes.indexOf(Buffer.from("\u0427")) + 1;
  process.stdout.write(bytes.subarray(0, boundary));
  setImmediate(() => process.stdout.write(bytes.subarray(boundary)));
}
if (process.send) {
  process.on("message", receive);
  process.on("disconnect", () => process.exit(0));
} else {
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => receive(JSON.parse(line)));
  input.on("close", () => process.exit(0));
}
