import { Config } from "../../infrastructure/config/Config";

export class HttpClient {
  private readonly config = Config.getInstance().get();

  // Base headers for DropShot backend calls, including the server-to-server
  // auth key when configured. Sent only when STREAMING_API_KEY is set, so this
  // stays backward-compatible with a backend that doesn't yet require it.
  private backendHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const key = this.config.server.streamingApiKey;
    if (key) headers["x-streaming-api-key"] = key;
    return headers;
  }

  async goLiveYouTube(
    groundId: string,
    courtId: string,
    streamKey: string
  ): Promise<Response> {
    // GET request to notify YouTube to go live
    const url = `${this.config.server.baseUrl}/api/v1/padel-grounds/${groundId}/courts/${courtId}/go-live/${streamKey}`;
    
    // Retry configuration
    const maxRetries = 5;
    const initialBackoff = 1000; // 1 second
    let retryCount = 0;
    
    while (true) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: this.backendHeaders({ "Content-Type": "application/json" }),
        });

        // If we get a non-5xx response, return it (success or non-retryable error)
        if (response.status < 500) {
          if (!response.ok) {
            console.warn(`YouTube go-live notification failed with status ${response.status}: ${response.statusText}`);
          }
          return response;
        }
        
        // If we get here, it's a 5xx error
        if (retryCount >= maxRetries) {
          console.error(`YouTube go-live notification failed after ${maxRetries} retries with status ${response.status}`);
          throw new Error(`HTTP ${response.status}: ${response.statusText} (after ${maxRetries} retries)`);
        }
        
        // Calculate backoff with exponential increase and jitter
        const backoff = initialBackoff * Math.pow(2, retryCount) * (0.5 + Math.random() * 0.5);
        console.warn(`YouTube go-live notification failed with status ${response.status}, retrying in ${Math.round(backoff)}ms (attempt ${retryCount + 1}/${maxRetries})`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, backoff));
        retryCount++;
        
      } catch (error) {
        // Network errors or other exceptions
        if (retryCount >= maxRetries) {
          console.error(`YouTube go-live notification failed after ${maxRetries} retries due to exception:`, error);
          throw error;
        }
        
        // Calculate backoff with exponential increase and jitter
        const backoff = initialBackoff * Math.pow(2, retryCount) * (0.5 + Math.random() * 0.5);
        console.warn(`YouTube go-live notification failed with exception, retrying in ${Math.round(backoff)}ms (attempt ${retryCount + 1}/${maxRetries})`, error);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, backoff));
        retryCount++;
      }
    }
  }

  /**
   * Forward a court's current scoreboard state to the backend, which writes it
   * to Supabase (the single source of truth the overlay already reads).
   *
   * ── WHY VIA THE BACKEND AND NOT SUPABASE DIRECTLY ──
   * Writing Supabase from the box would need write credentials on every court
   * machine. This reuses the x-streaming-api-key every box already has, and the
   * backend validates the court actually belongs to this ground — a check the
   * shared device key cannot make on its own.
   *
   * The state is ABSOLUTE, never a delta: mesh delivery is best-effort with no
   * retry, so a dropped packet must be self-healing on the next update.
   */
  async postScoreboard(
    groundId: string,
    courtId: string,
    body: {
      mode?: string;
      redScore: string;
      blueScore: string;
      redGames?: number;
      blueGames?: number;
    }
  ): Promise<Response> {
    const url = `${this.config.server.baseUrl}/api/v1/padel-grounds/${groundId}/courts/${courtId}/scoreboard`;
    return fetch(url, {
      method: "POST",
      headers: this.backendHeaders({
        accept: "application/json",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(body),
    });
  }

  async sendHeartbeat(groundId: string): Promise<Response> {
    // POST request to send heartbeat
    const url = `${this.config.server.baseUrl}/api/v1/padel-grounds/heartbeat`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.backendHeaders({
          "accept": "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          groundId: groundId
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      throw error;
    }
  }
}
