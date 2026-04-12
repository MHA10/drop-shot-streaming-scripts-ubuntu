import {
  createClient,
  SupabaseClient,
  RealtimeChannel,
} from "@supabase/supabase-js";

/**
 * Supabase Client Singleton
 * Manages the connection to Supabase and provides real-time subscription capabilities
 */
export class SupabaseService {
  private static instance: SupabaseService;
  private client: SupabaseClient | null = null;
  private channels: Map<string, RealtimeChannel> = new Map();
  private enabled: boolean;

  private constructor(url: string, anonKey: string, enabled: boolean) {
    this.enabled = enabled;

    if (!this.enabled) {
      console.log("⚠️  Supabase is disabled via configuration");
      return;
    }

    if (!url || !anonKey) {
      console.warn(
        "⚠️  Supabase URL and ANON_KEY are required. Supabase features will be disabled."
      );
      this.enabled = false;
      return;
    }

    // Initialize Supabase client
    this.client = createClient(url, anonKey, {
      realtime: {
        params: {
          eventsPerSecond: 10, // Rate limiting for real-time events
        },
      },
    });

    console.log("✅ Supabase client initialized");
  }

  /**
   * Initialize singleton instance
   */
  public static initialize(
    url: string,
    anonKey: string,
    enabled: boolean
  ): void {
    if (!SupabaseService.instance) {
      SupabaseService.instance = new SupabaseService(url, anonKey, enabled);
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): SupabaseService {
    if (!SupabaseService.instance) {
      throw new Error(
        "SupabaseService must be initialized before use. Call initialize() first."
      );
    }
    return SupabaseService.instance;
  }

  /**
   * Check if Supabase is enabled and ready
   */
  public isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * Get the Supabase client
   */
  public getClient(): SupabaseClient {
    if (!this.client) {
      throw new Error("Supabase client is not initialized");
    }
    return this.client;
  }

  /**
   * Subscribe to real-time changes on a table
   * @param channelName - Unique name for this channel
   * @param tableName - Name of the table to listen to
   * @param callback - Function to call when changes occur
   * @param event - Type of event to listen for ('INSERT', 'UPDATE', 'DELETE', or '*' for all)
   * @param schema - Database schema (default: 'public')
   * @param retryCount - Current retry attempt (internal use)
   */
  /**
   * Subscribe to real-time changes on a table
   * @param channelName - Unique name for this channel
   * @param tableName - Name of the table to listen to
   * @param callback - Function to call when changes occur
   * @param event - Type of event to listen for ('INSERT', 'UPDATE', 'DELETE', or '*' for all)
   * @param schema - Database schema (default: 'public')
   * @param filter - Optional filter string (e.g., 'some_column=eq.some_value')
   * @param retryCount - Current retry attempt (internal use)
   */
  public subscribeToTable(
    channelName: string,
    tableName: string,
    callback: (payload: any) => void,
    event: "INSERT" | "UPDATE" | "DELETE" | "*" = "*",
    schema: string = "public",
    filter?: string,
    retryCount: number = 0
  ): RealtimeChannel | null {
    if (!this.isEnabled()) {
      console.warn("⚠️  Supabase is not enabled. Cannot subscribe to table.");
      return null;
    }

    const MAX_RETRIES = 10;
    const BASE_RETRY_DELAY = 1000; // 1 second

    // Check if channel already exists
    if (this.channels.has(channelName)) {
      if (retryCount === 0) {
        console.warn(
          `⚠️  Channel '${channelName}' already exists. Unsubscribing old channel first.`
        );
      }
      // cleanup previous channel instance before retrying/subscribing
      const oldChannel = this.channels.get(channelName);
      if (oldChannel) {
        this.client!.removeChannel(oldChannel).catch((err) =>
          console.error("Error removing old channel:", err)
        );
        this.channels.delete(channelName);
      }
    }

    if (retryCount === 0) {
      console.log(`🔧 Setting up channel: ${channelName}`);
      console.log(`   Table: ${schema}.${tableName}`);
      console.log(`   Event: ${event}`);
      if (filter) {
        console.log(`   Filter: ${filter}`);
      }
    } else {
      console.log(
        `🔄 Retrying subscription for channel: ${channelName} (Attempt ${retryCount}/${MAX_RETRIES})`
      );
    }

    const scheduleRetry = () => {
      if (retryCount >= MAX_RETRIES) {
        console.error(
          `❌ Max retries reached for channel: ${channelName}. Giving up.`
        );
        return;
      }

      const delay = Math.min(
        BASE_RETRY_DELAY * Math.pow(2, retryCount),
        30000 // Max 30 seconds delay
      );

      console.log(`⏳ Scheduling retry in ${delay}ms...`);
      setTimeout(() => {
        this.subscribeToTable(
          channelName,
          tableName,
          callback,
          event,
          schema,
          filter,
          retryCount + 1
        );
      }, delay);
    };

    // Create new channel
    const channel = this.client!.channel(channelName)
      .on(
        "postgres_changes" as any,
        { event, schema, table: tableName, filter },
        (payload: any) => {
          console.log(`\n📡 [${channelName}] ===== CHANGE RECEIVED =====`);
          console.log(`   Timestamp: ${new Date().toISOString()}`);
          console.log(`   Event Type: ${payload.eventType}`);
          console.log(`   Table: ${payload.table}`);
          console.log(`   Schema: ${payload.schema}`);
          // console.log(`   Full Payload:`, JSON.stringify(payload, null, 2)); // Reduced noise
          console.log(`========================================\n`);
          callback(payload);
        }
      )
      .subscribe((status, err) => {
        console.log(
          `\n📊 [${channelName}] Subscription status changed: ${status}`
        );

        if (status === "SUBSCRIBED") {
          console.log(`✅ Successfully subscribed to channel: ${channelName}`);
          console.log(
            `   Listening for: ${event} events on ${schema}.${tableName}`
          );
          if (filter) {
            console.log(`   Applied Filter: ${filter}`);
          }
        } else if (status === "CHANNEL_ERROR") {
          console.error(`❌ Error subscribing to channel: ${channelName}`);
          if (err) {
            console.error(`   Error details:`, err);
          }
          scheduleRetry();
        } else if (status === "TIMED_OUT") {
          console.error(
            `⏱️  Subscription timed out for channel: ${channelName}`
          );
          scheduleRetry();
        } else if (status === "CLOSED") {
          console.log(`🔌 Channel closed: ${channelName}`);
        } else {
          console.log(`📊 Channel status: ${status}`);
        }
      });

    // Store channel reference
    this.channels.set(channelName, channel);

    return channel;
  }

  /**
   * Unsubscribe from a channel
   * @param channelName - Name of the channel to unsubscribe from
   */
  public async unsubscribe(channelName: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const channel = this.channels.get(channelName);
    if (channel) {
      await this.client!.removeChannel(channel);
      this.channels.delete(channelName);
      console.log(`🔌 Unsubscribed from channel: ${channelName}`);
    } else {
      console.warn(`⚠️  Channel '${channelName}' not found`);
    }
  }

  /**
   * Unsubscribe from all channels
   */
  public async unsubscribeAll(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    console.log(`🔌 Unsubscribing from ${this.channels.size} channels...`);
    await this.client!.removeAllChannels();
    this.channels.clear();
    console.log("✅ All channels unsubscribed");
  }

  /**
   * Get all active channel names
   */
  public getActiveChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Check if a channel is active
   */
  public isChannelActive(channelName: string): boolean {
    return this.channels.has(channelName);
  }
}
