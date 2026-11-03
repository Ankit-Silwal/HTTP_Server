import net from "node:net";

const MAX_HEADER_SIZE = 8192;

const server = net.createServer((socket) => {
  console.log("Client is connected");
  let request = Buffer.alloc(0);
  let handled = false;

  socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    request = Buffer.concat([request, chunk]);

    const headerEnd = request.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (request.length > MAX_HEADER_SIZE) {
        handled = true;
        socket.end(
          "HTTP/1.1 431 Request Header Fields Too Large\r\n" +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n\r\n"
        );
      }
      return;
    }

    handled = true;
    const text = request.subarray(0, headerEnd).toString();
    const firstLine = text.split("\r\n")[0];
    console.log("Request:", firstLine);

    const body = "Hello from my TCP server!";
    const response =
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      body;
    socket.end(response);
  });

  socket.on("close", () => {
    console.log("Client disconnected");
  });

  socket.on("error", (err) => {
    console.log("Socket error:", err.message);
  });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("TCP server is running on port 3000");
});
