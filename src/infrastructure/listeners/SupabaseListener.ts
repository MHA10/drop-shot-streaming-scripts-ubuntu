import { SupabaseService } from "../services/SupabaseService";

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

  constructor(channelName: string, tableName: string) {
    this.supabaseService = SupabaseService.getInstance();
    this.channelName = channelName;
    this.tableName = tableName;
    this.enabled = this.supabaseService.isEnabled();
  }

  /**
   * Start listening to table changes
   */
  public start(): void {
    if (!this.enabled) {
      console.log(
        "⚠️  Supabase listener is disabled. Skipping initialization."
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
      "public"
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
    // Add your custom logic here
    // For example: compare changes, send alerts, sync with other systems, etc.
    console.log("Processing record update...");
    // TODO: Implement your business logic
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
