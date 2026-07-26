import type { VodDownloadPort, VodMetadata } from "@/application/ports/outbound.ts";

const TWITCH_VOD_REGEX = /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)/;

/** Wraps the `twitch-dl` CLI for Twitch VOD download + chat fetch. */
export class TwitchDlAdapter implements VodDownloadPort {
  constructor(private readonly binaryPath = "twitch-dl") {}

  isSupported(url: string): boolean {
    return TWITCH_VOD_REGEX.test(url);
  }

  async fetchMetadata(url: string): Promise<VodMetadata> {
    const vodId = this.extractVodId(url);
    const result = await this.run([vodId, "--json"], { capture: true });
    const data = JSON.parse(result) as {
      title: string;
      channel: string;
      game: string | null;
      duration_seconds: number;
    };
    return {
      title: data.title,
      streamer: data.channel,
      game: data.game,
      duration: data.duration_seconds,
    };
  }

  async download(
    url: string,
    destDir: string,
    onProgress: (p: { percent: number; bytesDownloaded: number; totalBytes: number }) => void,
  ): Promise<{ vodPath: string; chatPath: string | null }> {
    const vodId = this.extractVodId(url);
    await Deno.mkdir(destDir, { recursive: true });

    const vodPath = `${destDir}/${vodId}.mp4`;
    const chatPath = `${destDir}/${vodId}.json`;

    // Download video — parse stderr for progress.
    await this.run(["download", vodId, "--format", "mp4", "--output", vodPath], {
      capture: false,
      onStderr: (line) => this.parseProgress(line, onProgress),
    });

    // Download chat.
    let chatFetched = false;
    try {
      await this.run(["chat", vodId, "--json", "--output", chatPath], { capture: true });
      chatFetched = true;
    } catch (err) {
      console.warn("Chat download failed:", err);
    }

    return { vodPath, chatPath: chatFetched ? chatPath : null };
  }

  // ── Internals ──

  private extractVodId(url: string): string {
    const match = url.match(TWITCH_VOD_REGEX);
    if (!match?.[1]) throw new Error(`Invalid Twitch VOD URL: ${url}`);
    return match[1];
  }

  private parseProgress(
    line: string,
    onProgress: (p: { percent: number; bytesDownloaded: number; totalBytes: number }) => void,
  ): void {
    // twitch-dl emits lines like: "Downloading 45% (1.2 GB / 2.8 GB)"
    const m = line.match(/(\d+)%.*?\(([\d.]+)\s*(GB|MB)\s*\/\s*([\d.]+)\s*(GB|MB)\)/);
    if (!m) return;
    const percent = parseInt(m[1]!, 10);
    const bytesDownloaded = this.toBytes(parseFloat(m[2]!), m[3]!);
    const totalBytes = this.toBytes(parseFloat(m[4]!), m[5]!);
    onProgress({ percent, bytesDownloaded, totalBytes });
  }

  private toBytes(value: number, unit: string): number {
    return unit === "GB" ? value * 1e9 : value * 1e6;
  }

  private async run(
    args: string[],
    opts: {
      capture: boolean;
      onStderr?: (line: string) => void;
    },
  ): Promise<string> {
    const cmd = new Deno.Command(this.binaryPath, {
      args,
      stdout: opts.capture ? "piped" : "inherit",
      stderr: "piped",
    });
    const child = cmd.spawn();

    if (opts.onStderr) {
      this.readLines(child.stderr, opts.onStderr).catch(() => {});
    }

    const { stdout, success, code } = await child.output();
    if (!success) throw new Error(`twitch-dl exited ${code}`);
    return opts.capture ? new TextDecoder().decode(stdout) : "";
  }

  private async readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    }
  }
}
