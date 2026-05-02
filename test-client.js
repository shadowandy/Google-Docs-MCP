import { EventSource } from "eventsource";

async function runTest() {
  const token = "faketoken";
  const sseUrl = `http://localhost:8787/mcp/sse?token=${token}`;
  console.log(`Connecting to SSE at ${sseUrl}`);
  
  const es = new EventSource(sseUrl);
  let endpoint = null;
  
  es.addEventListener("endpoint", async (event) => {
    endpoint = new URL(event.data, "http://localhost:8787").toString();
    console.log(`Received endpoint: ${endpoint}`);
    
    // 1. Initialize
    console.log("Sending initialize request...");
    let res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0" }
        }
      })
    });
    console.log(`Initialize POST status: ${res.status}`);
    
    // Wait for the initialize response from SSE
    // In a real client we'd wait for the SSE message, but we can just sleep briefly
    await new Promise(r => setTimeout(r, 500));
    
    // 2. notifications/initialized
    console.log("Sending initialized notification...");
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      })
    });
    console.log(`Initialized POST status: ${res.status}`);
    
    await new Promise(r => setTimeout(r, 500));
    
    // 3. tools/list
    console.log("Sending tools/list request...");
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      })
    });
    console.log(`Tools/list POST status: ${res.status}`);
  });
  
  es.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log("Received SSE Message:", JSON.stringify(msg, null, 2));
    
    if (msg.id === 2) {
      console.log("Received tools/list response! Test successful.");
      process.exit(0);
    }
  };
  
  es.onerror = (err) => {
    console.error("EventSource Error:", err);
  };
  
  // Wait up to 5 seconds
  await new Promise(r => setTimeout(r, 5000));
  console.log("Test timed out.");
  process.exit(1);
}

runTest().catch(console.error);