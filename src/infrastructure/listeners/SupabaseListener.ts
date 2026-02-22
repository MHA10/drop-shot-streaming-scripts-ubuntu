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
  /**
   * Start listening to table changes
   * @deprecated Global subscription is no longer used. Use subscribeToCourt instead.
   */
  public start(): void {
    if (!this.enabled) {
      console.log(
        "⚠️  Supabase listener is disabled. Skipping initialization.",
      );
      return;
    }
    console.log("ℹ️  SupabaseListener initialized (waiting for stream start events)");
  }

  /**
   * Subscribe to score updates for a specific court
   */
  public subscribeToCourt(courtId: string): void {
    if (!this.enabled) return;

    const channelName = `${this.channelName}-${courtId}`;
    const filter = `court_id=eq.${courtId}`;

    console.log(`🎯 Subscribing to Supabase updates for court: ${courtId}`);

    this.supabaseService.subscribeToTable(
      channelName,
      this.tableName,
      this.handleAllEvents.bind(this),
      "UPDATE",
      "public",
      filter
    );
  }

  /**
   * Unsubscribe from score updates for a specific court
   */
  public async unsubscribeFromCourt(courtId: string): Promise<void> {
    if (!this.enabled) return;

    const channelName = `${this.channelName}-${courtId}`;
    console.log(`🛑 Unsubscribing from Supabase updates for court: ${courtId}`);
    await this.supabaseService.unsubscribe(channelName);
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
    const height = 160;

    const FONT: Record<string, string[]> = {
        "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
        "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
        "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
        "3": ["01110", "10001", "00001", "00110", "00001", "10001", "01110"],
        "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
        "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
        "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
        "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
        "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
        "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
        "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
        "D": ["11110", "10011", "10001", "10001", "10001", "10011", "11110"],
        "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
        "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
        ":": ["00000", "00100", "00000", "00000", "00100", "00000", "00000"],
        " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    };

    const B_FONT: Record<string, string[]> = {
        "B": ["11110", "10001", "11110", "10001", "11110"],
        "L": ["10000", "10000", "10000", "10000", "11111"],
        "U": ["10001", "10001", "10001", "10001", "01110"],
        "E": ["11111", "10000", "11110", "10000", "11111"],
        "R": ["11110", "10001", "11110", "10100", "10011"],
        "D": ["11110", "10011", "10001", "10011", "11110"],
        "H": ["10001", "10001", "11111", "10001", "10001"],
        "O": ["01110", "10001", "10001", "10001", "01110"],
        "M": ["10001", "11011", "10101", "10001", "10001"],
        "G": ["01110", "10000", "10111", "10001", "01110"],
        "S": ["01111", "10000", "01110", "00001", "11110"],
        "T": ["11111", "00100", "00100", "00100", "00100"],
        " ": ["00000", "00000", "00000", "00000", "00000"],
        "A": ["01110", "10001", "11111", "10001", "10001"],
        "C": ["01111", "10000", "10000", "10000", "01111"],
    };

    const text = `${leftScore}-${rightScore} ${leftGames}-${rightGames}`;
    if (text === this.lastRenderedTextByCourt.get(courtId)) {
      return;
    }

    const image = new PNG({ width, height });
    image.data.fill(0);

    const setPixel = (x: number, y: number, color: any) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const idx = (width * y + x) << 2;
        image.data[idx] = color.r;
        image.data[idx + 1] = color.g;
        image.data[idx + 2] = color.b;
        image.data[idx + 3] = color.a;
    };

    const fillRect = (x: number, y: number, w: number, h: number, color: any) => {
        for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) {
                setPixel(px, py, color);
            }
        }
    };

    // Colors matching the original display
    const bg = { r: 18, g: 18, b: 24, a: 240 };
    const border = { r: 240, g: 240, b: 240, a: 255 };
    const headerBg = { r: 25, g: 25, b: 35, a: 240 };
    const ledBg = { r: 15, g: 15, b: 20, a: 240 };

    const ledOn = { r: 255, g: 10, b: 10, a: 255 };
    const ledOff = { r: 60, g: 20, b: 20, a: 200 };
    const textWhite = { r: 255, g: 255, b: 255, a: 255 };

    const drawLedDigit = (char: string, ox: number, oy: number, size: number) => {
        const glyph = FONT[char] || FONT[" "];
        const dotSize = size;
        const gap = 1;
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                const isOn = glyph[row] && glyph[row][col] === "1";
                fillRect(ox + col * (dotSize + gap), oy + row * (dotSize + gap), dotSize, dotSize, isOn ? ledOn : ledOff);
            }
        }
        return 5 * (size + gap);
    };

    const drawLedText = (textStr: string, x: number, y: number, size: number, spacing: number) => {
        let currX = x;
        for (const char of textStr) {
            drawLedDigit(char, currX, y, size);
            currX += 5 * (size + 1) + spacing;
        }
        return currX - x;
    };

    const measureLedText = (textStr: string, size: number, spacing: number) => {
        return textStr.length * 5 * (size + 1) + Math.max(0, textStr.length - 1) * spacing;
    };

    const drawTitleText = (textStr: string, x: number, y: number, size: number, spacing: number) => {
        let currX = x;
        for (const char of textStr) {
            const glyph = B_FONT[char] || B_FONT[" "];
            const dotSize = size;
            for (let row = 0; row < 5; row++) {
                for (let col = 0; col < 5; col++) {
                    const isOn = glyph[row] && glyph[row][col] === "1";
                    if(isOn) fillRect(currX + col * dotSize, y + row * dotSize, dotSize, dotSize, textWhite);
                }
            }
            currX += 5 * dotSize + spacing;
        }
        return currX - x;
    };

    const measureTitleText = (textStr: string, size: number, spacing: number) => {
        return textStr.length * 5 * size + Math.max(0, textStr.length - 1) * spacing;
    };

    // Draw base board
    fillRect(0, 0, width, height, bg);
    
    // Outer Border
    fillRect(2, 2, width - 4, height - 4, border);
    
    // Inner margins
    const pad = 5;
    fillRect(pad, pad, width - pad * 2, height - pad * 2, headerBg);

    // Separators
    fillRect(pad, 42, width - pad * 2, 2, border); // Headers vs Scores
    fillRect(pad, 115, width - pad * 2, 2, border); // Scores vs Bottom Timer
    fillRect(width / 2 - 1, pad, 2, 42 - pad, border); // Home vs Guest Header Divider

    // LED Background Areas
    fillRect(pad, 44, width - pad * 2, 115 - 44, ledBg);
    fillRect(pad, 117, width - pad * 2, height - pad - 117, ledBg);

    // Draw Titles (BLUE / RED)
    const titleY = 14;
    const titleS = 4;
    const hw = measureTitleText("BLUE", titleS, 3);
    const gw = measureTitleText("RED", titleS, 3);
    
    drawTitleText("BLUE", Math.floor(width / 4 - hw / 2), titleY, titleS, 3);
    drawTitleText("RED", Math.floor(3 * width / 4 - gw / 2), titleY, titleS, 3);

    // Scores (pad to 2 digits to look better, but fallback if letters)
    const bScoreStr = leftScore.length === 1 ? `0${leftScore}` : leftScore;
    const rScoreStr = rightScore.length === 1 ? `0${rightScore}` : rightScore;
    const sSize = 6;
    const lw = measureLedText(bScoreStr, sSize, 6);
    const rw = measureLedText(rScoreStr, sSize, 6);
    const cw = measureLedText(":", sSize, 6);

    const scoreY = 56;
    drawLedText(bScoreStr, Math.floor(width / 4 - lw / 2) + 5, scoreY, sSize, 6);
    drawLedText(":", Math.floor(width / 2 - cw / 2), scoreY, sSize, 6);
    drawLedText(rScoreStr, Math.floor(3 * width / 4 - rw / 2) - 5, scoreY, sSize, 6);

    // Games (Bottom row)
    const lGamesStr = leftGames.length === 1 ? `0${leftGames}` : leftGames;
    const rGamesStr = rightGames.length === 1 ? `0${rightGames}` : rightGames;
    const gamesStr = `${lGamesStr}:${rGamesStr}`;
    const gSize = 3;
    const gbW = measureLedText(gamesStr, gSize, 4);
    drawLedText(gamesStr, Math.floor(width / 2 - gbW / 2), 125, gSize, 4);

    const scoreImagePath = this.getScoreImagePath(courtId);
    await fs.mkdir(path.dirname(scoreImagePath), { recursive: true });
    const buffer = PNG.sync.write(image);
    
    const tempPath = `${scoreImagePath}.tmp`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, scoreImagePath);
    
    this.lastRenderedTextByCourt.set(courtId, text);
  }

  private getScoreImagePath(courtId: string): string {
    return path.join(this.scoreImageDir, `${courtId}.png`);
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
    await this.supabaseService.unsubscribeAll();
    console.log("✅ All channels unsubscribed");
  }
}
