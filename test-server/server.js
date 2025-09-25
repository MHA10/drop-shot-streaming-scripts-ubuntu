const express = require("express");
const path = require("path");

const app = express();
const PORT = 3001;

// Store connected SSE clients
let clients = [];

// Middleware
app.use(express.json());
app.use(express.static("public"));

// Go Live API endpoint
app.get(
  "/api/v1/padel-grounds/:groundId/courts/:courtId/go-live/:streamKey",
  (req, res) => {
    const { groundId, courtId, streamKey } = req.params;

    console.log(
      `Go Live API called - Ground ID: ${groundId}, Court ID: ${courtId}, Stream Key: ${streamKey}`
    );

    res.status(200).json({
      success: true,
      message: "Go live request received",
      data: {
        groundId,
        courtId,
        streamKey,
        timestamp: new Date().toISOString(),
      },
    });
  }
);

// SSE endpoint
app.get("/api/v1/padel-grounds/:groundId/events", (req, res) => {
  // Set SSE headers
  console.log("request received");
  const { groundId } = req.params;
  console.log("groundId: ", groundId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  // Add client to the list
  const clientId = Date.now();
  const newClient = {
    id: clientId,
    response: res,
  };
  clients.push(newClient);

  console.log(`Client ${clientId} connected. Total clients: ${clients.length}`);

  // Send initial connection message
  res.write(
    `data: ${JSON.stringify({
      type: "connection",
      message: "Connected to SSE",
    })}\n\n`
  );

  // Handle client disconnect
  req.on("close", () => {
    console.log(`Client ${clientId} disconnected`);
    clients = clients.filter((client) => client.id !== clientId);
  });
});

// Endpoint to send SSE events
app.post("/api/v1/logs/logs", (req, res) => {
  console.log("Received log:", JSON.stringify(req.body, null, 2));
  res.json({ success: true, message: "Log received" });
});

app.post("/send-event", (req, res) => {
  const { eventType, cameraUrl, streamKey, courtId } = req.body;

  const eventData = {
    eventType,
    cameraUrl,
    streamKey,
    courtId,
  };

  console.log("Broadcasting event:", eventData);

  // Send to all connected clients
  clients.forEach((client) => {
    try {
      client.response.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch (error) {
      console.error("Error sending to client:", error);
    }
  });

  res.json({ success: true, message: "Event sent", clients: clients.length });
});

// Serve the HTML page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`SSE Testing Server running on http://localhost:${PORT}`);
  console.log(
    "Open your browser and navigate to the URL above to test SSE events"
  );
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down server...");
  clients.forEach((client) => {
    client.response.end();
  });
  process.exit(0);
});
