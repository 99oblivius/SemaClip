import type { StreamStorage } from "@/application/ports/outbound.ts";

/**
 * Per-stream directory structure for file artifacts.
 *
 * Layout:
 *   {dataDir}/
 *   └── streams/
 *       └── {streamId}/
 *           ├── vod/          ← original video file
 *           ├── chat/         ← chat JSON
 *           ├── waveform.json ← cached waveform peaks
 *           ├── density.json  ← cached chat density
 *           ├── thumbnails/   ← frame thumbnails
 *           └── exports/      ← exported clips
 *
 * Derived artifacts (waveform.json, density.json) live at the stream root
 * because there's exactly one per stream. Thumbnails and exports get
 * subdirectories because there can be many.
 */
export class DenoStreamStorage implements StreamStorage {
  constructor(private readonly dataDir: string) {}

  streamDir(streamId: string): string {
    return `${this.dataDir}/streams/${streamId}`;
  }

  vodPath(streamId: string, filename: string): string {
    return `${this.streamDir(streamId)}/vod/${filename}`;
  }

  chatPath(streamId: string, filename: string): string {
    return `${this.streamDir(streamId)}/chat/${filename}`;
  }

  artifactPath(streamId: string, name: string): string {
    return `${this.streamDir(streamId)}/${name}`;
  }

  thumbnailPath(streamId: string, name: string): string {
    return `${this.streamDir(streamId)}/thumbnails/${name}`;
  }

  exportPath(streamId: string, filename: string): string {
    return `${this.streamDir(streamId)}/exports/${filename}`;
  }

  async ensureStreamDirs(streamId: string): Promise<void> {
    const dir = this.streamDir(streamId);
    await Deno.mkdir(`${dir}/vod`, { recursive: true });
    await Deno.mkdir(`${dir}/chat`, { recursive: true });
    await Deno.mkdir(`${dir}/thumbnails`, { recursive: true });
    await Deno.mkdir(`${dir}/exports`, { recursive: true });
  }

  async deleteStream(streamId: string): Promise<void> {
    try {
      await Deno.remove(this.streamDir(streamId), { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}
