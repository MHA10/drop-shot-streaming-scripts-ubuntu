import { Config } from "../../infrastructure/config/Config";

export class HttpClient {
  private readonly config = Config.getInstance().get();
  
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
          headers: {
            "Content-Type": "application/json",
          },
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

  async sendHeartbeat(groundId: string): Promise<Response> {
    // POST request to send heartbeat
    const url = `${this.config.server.baseUrl}/api/v1/padel-grounds/heartbeat`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "Content-Type": "application/json",
        },
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
