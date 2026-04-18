import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { Logger } from "../../application/interfaces/Logger";

export type AdSlot = "left" | "right";

export class AdDownloaderService {
  private readonly adDir: string;
  private readonly downloadTimeoutMs = 10000;

  constructor(private readonly logger: Logger) {
    this.adDir = path.resolve("./ad");
    if (!fs.existsSync(this.adDir)) {
      fs.mkdirSync(this.adDir, { recursive: true });
    }
  }

  public async download(
    url: string | null | undefined,
    courtId: string,
    slot: AdSlot
  ): Promise<string | null> {
    if (!url) return null;

    const ext = this.extractExtension(url);
    const localPath = path.join(this.adDir, `${courtId}-${slot}.${ext}`);
    const sidecarPath = `${localPath}.url`;

    if (fs.existsSync(localPath) && fs.existsSync(sidecarPath)) {
      try {
        const cachedUrl = fs.readFileSync(sidecarPath, "utf8").trim();
        if (cachedUrl === url) {
          this.logger.info("Using cached ad", { slot, courtId, localPath });
          return localPath;
        }
      } catch {
        // fall through and re-download
      }
    }

    this.clearStaleFilesForSlot(courtId, slot, ext);

    try {
      await this.httpDownload(url, localPath);
      fs.writeFileSync(sidecarPath, url);
      this.logger.info("Downloaded ad", { slot, courtId, url, localPath });
      return localPath;
    } catch (error) {
      this.logger.warn("Failed to download ad, skipping", {
        slot,
        courtId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private extractExtension(url: string): string {
    const cleaned = url.split("?")[0];
    const match = cleaned.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match ? match[1].toLowerCase() : "png";
  }

  // Remove files for this court+slot that have a different extension than the new one,
  // so old cached formats don't linger when the ad format changes.
  private clearStaleFilesForSlot(
    courtId: string,
    slot: AdSlot,
    currentExt: string
  ): void {
    const prefix = `${courtId}-${slot}.`;
    const keep = new Set([`${prefix}${currentExt}`, `${prefix}${currentExt}.url`]);
    try {
      for (const file of fs.readdirSync(this.adDir)) {
        if (file.startsWith(prefix) && !keep.has(file)) {
          fs.unlinkSync(path.join(this.adDir, file));
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private httpDownload(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const file = fs.createWriteStream(destPath);

      const cleanup = () => {
        file.close();
        fs.unlink(destPath, () => {});
      };

      const request = client.get(url, (res) => {
        if (res.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      request.on("error", (err) => {
        cleanup();
        reject(err);
      });
      request.setTimeout(this.downloadTimeoutMs, () => {
        request.destroy();
        cleanup();
        reject(new Error("Download timeout"));
      });
    });
  }
}
