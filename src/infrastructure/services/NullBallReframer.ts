import { BallReframer } from "../../domain/services/BallReframer";

/**
 * Default BallReframer: does nothing, always returns null so the caller uses
 * the full-frame clip. Active whenever ball-tracking is disabled (the default),
 * so the highlight pipeline produces a full-frame, logo-branded reel with no
 * dependency on Python/OpenCV.
 */
export class NullBallReframer implements BallReframer {
  public async reframe(): Promise<string | null> {
    return null;
  }
}
