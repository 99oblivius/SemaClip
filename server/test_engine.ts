import type { EngineEvent } from "shared/types";

const cmd = new Deno.Command("python3", {
  args: ["/home/livia/SemaClip/engine/engine.py", "--ipc"],
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
});
const proc = cmd.spawn();
const writer = proc.stdin.getWriter();
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();

// Send start command
const startCmd = JSON.stringify({
  type: "start",
  jobId: "test-1",
  vodPath: "/tmp/test.mp4",
  chatPath: null,
  config: {},
}) + "\n";
await writer.write(new TextEncoder().encode(startCmd));
console.log("Sent start command");

// Read events until complete or timeout
let buffer = "";
let eventCount = 0;
let clipCount = 0;

const timeout = setTimeout(() => {
  console.log(`Timeout: got ${eventCount} events, ${clipCount} clips`);
  proc.kill("SIGTERM");
  Deno.exit(1);
}, 8000);

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    eventCount++;
    try {
      const event = JSON.parse(trimmed) as EngineEvent;
      if (event.type === "clip") {
        clipCount++;
        console.log(`Clip ${clipCount}: ${event.axis} ${event.score}`);
      } else if (event.type === "complete") {
        console.log(`Complete: ${event.clipsFound} clips found`);
        clearTimeout(timeout);
        proc.kill("SIGTERM");
        Deno.exit(0);
      } else if (event.type === "progress" && eventCount <= 3) {
        console.log(`Progress: ${event.phase} ${Math.round(event.percent * 100)}%`);
      }
    } catch {
      console.error("Malformed:", trimmed.substring(0, 60));
    }
  }
}
