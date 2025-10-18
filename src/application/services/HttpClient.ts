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

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      throw error;
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
