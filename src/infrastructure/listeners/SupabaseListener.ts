import { SupabaseService } from "../services/SupabaseService";
import * as fs from "fs/promises";
import * as path from "path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";

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
    const width = 420;
    const height = 120;
    
    const text = `${leftScore}-${rightScore} ${leftGames}-${rightGames}`;
    if (text === this.lastRenderedTextByCourt.get(courtId)) {
      return;
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Make transparent background
    ctx.clearRect(0, 0, width, height);

    // Color definitions
    const bgMain = "rgba(42, 40, 85, 0.95)";
    const redAccent = "#E62E2D";
    const whiteBorder = "#FFFFFF";

    // Parallelogram properties
    const slantX = 12; // Amount of horizontal shift
    const redWidth = 8;
    
    // Draw red accent left border
    ctx.beginPath();
    ctx.moveTo(slantX, 0);
    ctx.lineTo(slantX + redWidth, 0);
    ctx.lineTo(redWidth, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = redAccent;
    ctx.fill();

    // Draw main background
    const bgStartX = slantX + redWidth;
    const bgEndX = width;
    const bgBotStartX = redWidth;
    const bgBotEndX = width - slantX;
    
    ctx.beginPath();
    ctx.moveTo(bgStartX, 0);
    ctx.lineTo(bgEndX, 0);
    ctx.lineTo(bgBotEndX, height);
    ctx.lineTo(bgBotStartX, height);
    ctx.closePath();
    ctx.fillStyle = bgMain;
    ctx.fill();

    // The line widths
    const lineWidth = 2;
    ctx.strokeStyle = whiteBorder;
    ctx.lineWidth = lineWidth;

    // Draw horizontal separator
    ctx.beginPath();
    ctx.moveTo(slantX / 2 + redWidth, height / 2); // Middle roughly aligned to slant
    ctx.lineTo(width - slantX / 2, height / 2);
    ctx.stroke();

    // Measurements for columns
    const namesWidth = 240;
    const pointsWidth = 90;
    const gamesWidth = width - namesWidth - pointsWidth;

    // Draw vertical separators matching the slant
    const drawSlantedLine = (xOffset: number) => {
        ctx.beginPath();
        ctx.moveTo(slantX + xOffset, 0);
        ctx.lineTo(xOffset, height);
        ctx.stroke();
    };

    drawSlantedLine(namesWidth);
    drawSlantedLine(namesWidth + pointsWidth);

    // Typography
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // Team Names
    ctx.font = "300 28px sans-serif";
    const namePad = 40;
    ctx.fillText("TEAM A", namePad, height / 4 + 2);
    ctx.fillText("TEAM B", namePad - (slantX / 2), 3 * height / 4 + 2);

    // Points
    ctx.textAlign = "center";
    ctx.font = "500 42px sans-serif";
    const p1CenterX = namesWidth + pointsWidth / 2 + slantX / 2;
    const p2CenterX = namesWidth + pointsWidth / 2;
    ctx.fillText(leftScore, p1CenterX, height / 4 + 4);
    ctx.fillText(rightScore, p2CenterX, 3 * height / 4 + 4);

    // Games
    ctx.font = "400 36px sans-serif";
    const g1CenterX = namesWidth + pointsWidth + gamesWidth / 2 + slantX / 2;
    const g2CenterX = namesWidth + pointsWidth + gamesWidth / 2;
    ctx.fillText(leftGames, g1CenterX, height / 4 + 2);
    ctx.fillText(rightGames, g2CenterX, 3 * height / 4 + 2);

    const scoreImagePath = this.getScoreImagePath(courtId);
    await fs.mkdir(path.dirname(scoreImagePath), { recursive: true });
    const buffer = canvas.encodeSync('png');
    
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
