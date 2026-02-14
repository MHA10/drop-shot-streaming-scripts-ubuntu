import { SupabaseService } from "../services/SupabaseService";
import * as fs from "fs/promises";
import * as path from "path";
import { PNG } from "pngjs";

/**
 * Supabase Real-time Listener
 * Listens to changes on a configurable table in Supabase
 * Uses a single channel with event routing to separate handlers
 */
export class SupabaseListener {
  // Minimal bitmap font for score rendering in the overlay PNG
  private static readonly FONT: Record<string, string[]> = {
    "0": ["01110", "11011", "10101", "10101", "10101", "11011", "01110"],
    "1": ["00100", "01100", "10100", "00100", "00100", "00100", "11111"],
    "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
    "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    " ": ["000", "000", "000", "000", "000", "000", "000"],
  };
  // Cached glyph points to avoid re-scanning glyph matrices on every update
  private static readonly GLYPH_CACHE = new Map<
    string,
    { points: Array<[number, number]>; width: number; height: number }
  >();
  private supabaseService: SupabaseService;
  private channelName: string;
  private tableName: string;
  private enabled: boolean;
  private readonly scoreImageDir: string;
  private lastRenderedTextByCourt: Map<string, string> = new Map();

  constructor(channelName: string, tableName: string) {
    this.supabaseService = SupabaseService.getInstance();
    this.channelName = channelName;
    this.tableName = tableName;
    this.enabled = this.supabaseService.isEnabled();
    this.scoreImageDir = path.resolve("./public/overlays");
  }

  /**
   * Start listening to table changes
   */
  public start(): void {
    if (!this.enabled) {
      console.log(
        "⚠️  Supabase listener is disabled. Skipping initialization.",
      );
      return;
    }

    console.log("🎯 Starting Supabase real-time listener...\n");
    console.log(`   Table: ${this.tableName}`);
    console.log(`   Channel: ${this.channelName}`);
    console.log(`   Event: UPDATE only\n`);

    // Single channel listening to UPDATE events only
    this.supabaseService.subscribeToTable(
      this.channelName,
      this.tableName,
      this.handleAllEvents.bind(this),
      "UPDATE", // Listen to UPDATE events only
      "public",
    );

    console.log("✨ Real-time channel configured\n");
  }

  /**
   * Handle all events and route them accordingly
   */
  private handleAllEvents(payload: any): void {
    console.log("📡 Event received:", payload.eventType);

    switch (payload.eventType) {
      case "INSERT":
        this.handleInsertEvent(payload);
        break;
      case "UPDATE":
        this.handleUpdateEvent(payload);
        break;
      case "DELETE":
        this.handleDeleteEvent(payload);
        break;
      default:
        console.log("❓ Unknown event type:", payload.eventType);
    }
  }

  /**
   * Handle INSERT events
   */
  private handleInsertEvent(payload: any): void {
    console.log("➕ INSERT event");
    console.log("   New record:", payload.new);
    this.handleInsert(payload.new);
  }

  /**
   * Handle UPDATE events
   */
  private handleUpdateEvent(payload: any): void {
    console.log("✏️  UPDATE event");
    console.log("   Old:", payload.old);
    console.log("   New:", payload.new);
    this.handleUpdate(payload.old, payload.new);
  }

  /**
   * Handle DELETE events
   */
  private handleDeleteEvent(payload: any): void {
    console.log("🗑️  DELETE event");
    console.log("   Deleted:", payload.old);
    this.handleDelete(payload.old);
  }

  /**
   * Business logic for INSERT events
   */
  private handleInsert(record: any): void {
    // Add your custom logic here
    // For example: send notification, update local cache, trigger webhook, etc.
    console.log("Processing new record...");
    // TODO: Implement your business logic
  }

  /**
   * Business logic for UPDATE events
   */
  private handleUpdate(oldRecord: any, newRecord: any): void {
    console.log("Processing record update...");
    const score = this.extractScore(newRecord);
    if (!score) {
      return;
    }
    // Render the updated score overlay asynchronously
    void this.writeScoreImage(
      score.courtId,
      score.left,
      score.right,
      score.leftGames,
      score.rightGames,
    );
  }

  private extractScore(record: Record<string, unknown>): {
    courtId: string;
    left: string;
    right: string;
    leftGames: string;
    rightGames: string;
  } | null {
    const courtId = record["court_id"];
    const leftValue = record["blue_score"];
    const rightValue = record["red_score"];
    const leftGamesValue = record["blue_games"];
    const rightGamesValue = record["red_games"];

    if (
      typeof courtId !== "string" ||
      leftValue === undefined ||
      rightValue === undefined ||
      leftGamesValue === undefined ||
      rightGamesValue === undefined
    ) {
      return null;
    }

    return {
      courtId,
      left: String(leftValue),
      right: String(rightValue),
      leftGames: String(leftGamesValue),
      rightGames: String(rightGamesValue),
    };
  }

  private async writeScoreImage(
    courtId: string,
    leftScore: string,
    rightScore: string,
    leftGames: string,
    rightGames: string,
  ): Promise<void> {
    const width = 280;
    const height = 80;

    // More visible colors - matching NodeFFmpegService
    const background = { r: 18, g: 18, b: 24, a: 240 }; // Dark blue-gray, more opaque
    const accentColor = { r: 0, g: 200, b: 83, a: 255 }; // Bright green
    const borderColor = { r: 45, g: 45, b: 55, a: 255 }; // Lighter gray border
    const foreground = { r: 255, g: 255, b: 255, a: 255 }; // White text
    const shadow = { r: 0, g: 0, b: 0, a: 200 }; // Shadow

    const scale = 5;
    const spacing = 5;
    const text = `${leftScore}-${rightScore} ${leftGames}-${rightGames}`;

    if (text === this.lastRenderedTextByCourt.get(courtId)) {
      return;
    }

    const image = new PNG({ width, height });
    image.data.fill(0);

    const setPixel = (x: number, y: number, color: typeof background) => {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
      }
      const idx = (width * y + x) << 2;
      image.data[idx] = color.r;
      image.data[idx + 1] = color.g;
      image.data[idx + 2] = color.b;
      image.data[idx + 3] = color.a;
    };

    const fillRect = (
      x: number,
      y: number,
      rectWidth: number,
      rectHeight: number,
      color: typeof background,
    ) => {
      const maxX = x + rectWidth;
      const maxY = y + rectHeight;
      for (let py = y; py < maxY; py++) {
        for (let px = x; px < maxX; px++) {
          setPixel(px, py, color);
        }
      }
    };

    // Draw main background
    fillRect(0, 0, width, height, background);

    // Draw bright green accent bar at top (very visible)
    const accentHeight = 5;
    fillRect(0, 0, width, accentHeight, accentColor);

    // Draw subtle border around the entire overlay
    const borderWidth = 1;
    // Top border (after accent bar)
    fillRect(0, accentHeight, width, borderWidth, borderColor);
    // Bottom border
    fillRect(0, height - borderWidth, width, borderWidth, borderColor);
    // Left border
    fillRect(0, accentHeight, borderWidth, height - accentHeight, borderColor);
    // Right border
    fillRect(
      width - borderWidth,
      accentHeight,
      borderWidth,
      height - accentHeight,
      borderColor,
    );

    const glyphs = Array.from(text).map((char) => {
      return (
        SupabaseListener.GLYPH_CACHE.get(char) ??
        SupabaseListener.buildGlyphCache(char)
      );
    });
    const totalTextWidth =
      glyphs.reduce((sum, glyph) => sum + glyph.width * scale, 0) +
      Math.max(0, glyphs.length - 1) * spacing;

    const cursorX = Math.floor((width - totalTextWidth) / 2);
    const cursorY = Math.floor((height - 7 * scale) / 2) + 3; // Adjusted for accent bar

    const drawGlyphs = (
      offsetX: number,
      offsetY: number,
      color: typeof background,
    ) => {
      let x = offsetX;
      for (const glyph of glyphs) {
        for (const [col, rowIndex] of glyph.points) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPixel(
                x + col * scale + dx,
                offsetY + rowIndex * scale + dy,
                color,
              );
            }
          }
        }
        x += glyph.width * scale + spacing;
      }
    };

    drawGlyphs(cursorX + 2, cursorY + 2, shadow);
    drawGlyphs(cursorX, cursorY, foreground);

    const scoreImagePath = this.getScoreImagePath(courtId);
    await fs.mkdir(path.dirname(scoreImagePath), { recursive: true });
    const buffer = PNG.sync.write(image);
    await fs.writeFile(scoreImagePath, buffer);
    this.lastRenderedTextByCourt.set(courtId, text);
  }

  private getScoreImagePath(courtId: string): string {
    return path.join(this.scoreImageDir, `${courtId}.png`);
  }

  // Convert a glyph's bitmap matrix into a list of pixels to draw
  private static buildGlyphCache(char: string): {
    points: Array<[number, number]>;
    width: number;
    height: number;
  } {
    const glyph = SupabaseListener.FONT[char] ?? SupabaseListener.FONT[" "];
    const points: Array<[number, number]> = [];
    for (let row = 0; row < glyph.length; row++) {
      const line = glyph[row];
      for (let col = 0; col < line.length; col++) {
        if (line[col] === "1") {
          points.push([col, row]);
        }
      }
    }
    const record = {
      points,
      width: glyph[0]?.length ?? 0,
      height: glyph.length,
    };
    SupabaseListener.GLYPH_CACHE.set(char, record);
    return record;
  }

  /**
   * Business logic for DELETE events
   */
  private handleDelete(record: any): void {
    // Add your custom logic here
    // For example: cleanup related data, send notifications, etc.
    console.log("Processing record deletion...");
    // TODO: Implement your business logic
  }

  /**
   * Stop listening to table changes
   */
  public async stop(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    console.log("🛑 Stopping Supabase listener...");
    await this.supabaseService.unsubscribe(this.channelName);
    console.log("✅ Channel unsubscribed");
  }
}
