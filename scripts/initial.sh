while true; do
  echo "Starting stream at $(date)"
  ffmpeg -rtsp_transport tcp -i "rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -c:v libx264 -preset veryfast -b:v 4500k -maxrate 5000k -bufsize 10000k \
  -vf "scale=1920:1080" \
  -c:a aac -b:a 128k -ar 44100 \
  -f flv "rtmp://a.rtmp.youtube.com/live2/pda4-j9yb-hhc9-6t6k-7phr"

  echo "FFmpeg crashed. Restarting in 5 seconds..."
  sleep 5
done
