import type { EventBus } from "@/application/ports/outbound.ts";
import type { AppSettings } from "shared/types";

const SETTINGS_KEY = "app";

export class SettingsUseCase {
  private settings: AppSettings;

  constructor(private readonly bus: EventBus) {
    this.settings = {
      gpuDevice: null,
      exportDir: "~/Videos/SemaClip",
      defaultAspectRatio: "16:9",
      defaultCaptions: {
        enabled: false,
        preset: "bold-white",
        position: "bottom",
        fontSize: 48,
        backgroundOpacity: 0.8,
      },
      engineBinaryPath: null,
    };
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  update(partial: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...partial };
    return this.get();
  }
}
