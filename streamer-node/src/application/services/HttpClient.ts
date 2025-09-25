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
}
