# HTTP Server from Scratch

A tiny HTTP server built directly on **raw TCP sockets** (`node:net`), without Node's `http` module or Express.
The goal is to learn what really happens between `curl` and a server: name resolution, TCP connections, bytes, and the HTTP text format.

---

## **Phase 1 — TCP Connection**

In this phase the server can:

- accept TCP connections
- receive the raw bytes of an HTTP request
- collect those bytes until the full header section has arrived
- read the first line (`GET /hello HTTP/1.1`)
- send back a valid HTTP response and close the connection

---

## Running it

```powershell
npm install
npm start
```

Output:

```
TCP server is running on port 3000
```

Send a request from another terminal:

```powershell
curl.exe -v http://localhost:3000/hello
```

Stop the server with **Ctrl + C**. If port 3000 is still busy after that:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess -Force
```

---

## The full code (Phase 1)

```ts
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

  socket.on("close", () => console.log("Client disconnected"));
  socket.on("error", (err) => console.log("Socket error:", err.message));
});

server.listen(3000, "0.0.0.0", () => {
  console.log("TCP server is running on port 3000");
});
```

---

## 1. The big picture

One `curl` command goes through all of these steps:

```
curl.exe http://localhost:3000/hello
   │
   ├─ 1. Name resolution    "localhost"  →  ::1 (IPv6) and 127.0.0.1 (IPv4)
   ├─ 2. TCP connect        127.0.0.1:57009  ──►  127.0.0.1:3000   (SYN, SYN-ACK, ACK)
   ├─ 3. Send HTTP request  "GET /hello HTTP/1.1\r\nHost: ...\r\n\r\n"   (just bytes)
   ├─ 4. Node "data" event  our code collects the bytes in a Buffer
   ├─ 5. Parse              find "\r\n\r\n", take the first line
   ├─ 6. Send HTTP response "HTTP/1.1 200 OK\r\n...\r\n\r\nHello from my TCP server!"
   └─ 7. Close              socket.end()  →  this connection closes, the server keeps running
```

**TCP only moves bytes.** It has no idea what `GET`, `/hello`, or `\r\n\r\n` mean. HTTP is just text that both sides agree on, and our code is what gives those bytes meaning.

---

## 2. Which address does the server listen on?

```ts
server.listen(3000, "0.0.0.0", ...)
```

The IP in `listen()` must be **one of this computer's own addresses**. It means "accept connections that arrive at this address of mine".

| Value in `listen()` | Who can connect |
|---|---|
| `"127.0.0.1"` | Only this computer (IPv4 loopback) |
| `"10.180.22.73"` (your Wi-Fi IP) | Devices on the same Wi-Fi, but only while your PC has that IP |
| `"0.0.0.0"` | **Every IPv4 address this PC has**: localhost, Wi-Fi, and so on |
| An IP of another device (for example `192.168.1.10`) | ❌ Crashes with `EADDRNOTAVAIL`, because that address isn't yours |

`0.0.0.0` is only for **listening**. You can't connect *to* it:

```
curl.exe http://0.0.0.0:3000/   →  "Address not available"
```

Connect to a real address instead:

| From | URL |
|---|---|
| This PC | `http://localhost:3000` or `http://127.0.0.1:3000` |
| A phone on the same Wi-Fi | `http://<your Wi-Fi IP>:3000`. Find the IP with `ipconfig` → "IPv4 Address" under the Wi-Fi adapter |

If the phone can't connect, allow port 3000 in Windows Firewall (run PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Node 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

---

## 3. `localhost` vs `127.0.0.1`

| `localhost` | `127.0.0.1` |
|---|---|
| A **hostname** | An **IPv4 address** |
| Must be resolved to an IP first | Already an IP, so no lookup is needed |
| Can resolve to `127.0.0.1` (IPv4) **or** `::1` (IPv6) | Always IPv4 |
| Means this computer | Means this computer |

```
localhost
    │  name resolution (OS / hosts file: C:\Windows\System32\drivers\etc\hosts)
    ▼
::1 (IPv6)   and   127.0.0.1 (IPv4)
```

Try it:

```powershell
curl.exe -4 -v http://localhost:3000/hello   # forces IPv4 → works
curl.exe -6 -v http://localhost:3000/hello   # forces IPv6 → fails, because our server only listens on IPv4
```

> Inside Docker, `localhost` means *the container itself*, not your Windows machine.

---

## 4. Reading `curl -v` line by line

```powershell
curl.exe -v http://localhost:3000/hello
```

```
* Host localhost:3000 was resolved.
* IPv6: ::1
* IPv4: 127.0.0.1
*   Trying [::1]:3000...
*   Trying 127.0.0.1:3000...
* Established connection to localhost (127.0.0.1 port 3000) from 127.0.0.1 port 57009
* using HTTP/1.x
> GET /hello HTTP/1.1
> Host: localhost:3000
> User-Agent: curl/8.21.0
> Accept: */*
>
* Request completely sent off
< HTTP/1.1 200 OK
< Content-Type: text/plain
< Content-Length: 25
< Connection: close
<
Hello from my TCP server!* shutting down connection #0
```

How to read the prefixes:

- `*` is curl's own info
- `>` is what curl **sent**
- `<` is what curl **received**

### 4.1 Name resolution

```
* IPv6: ::1
* IPv4: 127.0.0.1
```

`localhost` resolved to two addresses. Both mean this computer.

### 4.2 Two connection attempts

```
*   Trying [::1]:3000...        ← IPv6: our server isn't listening there, so it fails
*   Trying 127.0.0.1:3000...    ← IPv4: our server is listening, so it succeeds
```

Under the hood, the OS performs the TCP **three-way handshake**: `SYN → SYN-ACK → ACK`.

### 4.3 Two ports: 3000 and 57009

```
Established connection to localhost (127.0.0.1 port 3000) from 127.0.0.1 port 57009
```

| Program | Role | Port |
|---|---|---|
| Node.js | Server | `3000`, the fixed listening port |
| curl | Client | `57009`, a temporary (**ephemeral**) port picked by the OS |

The OS identifies each TCP connection by its **four-tuple**:

```
Source IP:   127.0.0.1    Source Port:   57009
Dest IP:     127.0.0.1    Dest Port:     3000
```

That's why many clients can connect to the same port 3000 at once. Each one has a different source port:

```
curl A :57009 ──┐
curl B :57010 ──┼──► Server :3000
curl C :57011 ──┘
```

You can see the same information from the server side:

```ts
console.log("Client:", socket.remoteAddress, socket.remotePort); // 127.0.0.1 57009
console.log("Server:", socket.localAddress, socket.localPort);   // 127.0.0.1 3000
```

### 4.4 The HTTP request (`>` lines)

```
GET /hello HTTP/1.1          ← request line: method, path, version
Host: localhost:3000         ← which host and port the client wanted (one IP can host many sites)
User-Agent: curl/8.21.0      ← client software; easy to fake, so never trust it
Accept: */*                  ← "I accept any content type"
                             ← empty line = end of headers
```

What actually travels over TCP, with the invisible characters shown:

```
GET /hello HTTP/1.1\r\n
Host: localhost:3000\r\n
User-Agent: curl/8.21.0\r\n
Accept: */*\r\n
\r\n
```

`Request completely sent off` only means curl finished sending. It doesn't mean the server has processed the request yet.

### 4.5 The HTTP response (`<` lines)

| Line | Meaning |
|---|---|
| `HTTP/1.1 200 OK` | Status line. `200` means success (others: `400` bad request, `404` not found, `500` server error) |
| `Content-Type: text/plain` | The body is plain text |
| `Content-Length: 25` | The body is exactly 25 bytes, computed with `Buffer.byteLength(body)` |
| `Connection: close` | The server will close this TCP connection after the response |
| *(empty line)* | End of headers |
| `Hello from my TCP server!` | The body (25 bytes) |

### 4.6 Closing

```
* shutting down connection #0
```

`#0` is curl's internal connection number, **not** port 0. Only this connection closes. The **server keeps running** and accepts the next one.

> Any path (`/hello`, `/health`, `/anything`) returns the same `200 OK` because Phase 1 has no routing yet.

---

## 5. How the code turns bytes into a request

### 5.1 `Buffer.alloc(0)`: an empty bucket

```ts
let request = Buffer.alloc(0);   // <Buffer >, length 0
```

A **Buffer** is a block of raw bytes. We start with an empty one because the request may arrive in several pieces, and we need somewhere to collect them.

It is declared **inside** `createServer` but **outside** the `"data"` callback:

- Each connection gets its **own** `request` buffer.
- The buffer **keeps its contents** between `"data"` events on that connection.

### 5.2 `chunk`: what Node gives us

```ts
socket.on("data", (chunk: Buffer) => { ... })
```

We don't create `chunk`. Node creates it whenever the OS has received bytes on this socket. It is a Buffer, so it holds numbers, not text:

```
Text:  G  E  T     /  h  e  l  l  o
Hex:  47 45 54 20 2f 68 65 6c 6c 6f
```

```ts
console.log(chunk);             // <Buffer 47 45 54 20 2f 68 65 6c 6c 6f ...>
console.log(chunk.toString());  // GET /hello HTTP/1.1 ...
```

### 5.3 `Buffer.concat()`: collecting the pieces

```ts
request = Buffer.concat([request, chunk]);
```

TCP is a **stream**. It doesn't promise that one request arrives in one `"data"` event. It might arrive like this:

| Event | `chunk` | `request` after concat |
|---|---|---|
| start | | `""` |
| data #1 | `"GET /hello HTTP/1.1\r\n"` | `"GET /hello HTTP/1.1\r\n"` |
| data #2 | `"Host: localhost:3000\r\n"` | `"GET /hello HTTP/1.1\r\nHost: localhost:3000\r\n"` |
| data #3 | `"User-Agent: curl/8.21.0\r\nAccept: */*\r\n\r\n"` | the full header section ✅ |

`Buffer.concat` builds a **new** Buffer that holds the old bytes followed by the new ones.

For a small curl request on localhost, everything usually arrives in a single chunk. The code still has to handle the split case.

### 5.4 `indexOf("\r\n\r\n")`: are the headers complete?

```ts
const headerEnd = request.indexOf("\r\n\r\n");
if (headerEnd === -1) { ... return; }   // not there yet → wait for more data
```

- `\r` is a carriage return (byte `13`), and `\n` is a line feed (byte `10`).
- `\r\n` ends every line in HTTP/1.1.
- `\r\n\r\n` (an empty line) means **the headers are finished**. This is part of the HTTP standard, not something we made up.

`indexOf` returns the position where the sequence starts, or `-1` if it isn't there:

```ts
Buffer.from("Hello World").indexOf("World"); // 6
Buffer.from("Hello World").indexOf("Java");  // -1
```

For our full request:

```
GET /hello HTTP/1.1\r\n        → bytes  0–20
Host: localhost:3000\r\n       → bytes 21–42
User-Agent: curl/8.21.0\r\n    → bytes 43–67
Accept: */*                    → bytes 68–78
\r\n\r\n                       → starts at byte 79   ← headerEnd = 79
```

**Safety check:** if more than 8192 bytes arrive and there's still no `\r\n\r\n`, the server replies `431 Request Header Fields Too Large` and closes the connection, so a client can't fill up memory forever.

### 5.5 `subarray(0, headerEnd).toString()`: bytes to text

```ts
const text = request.subarray(0, headerEnd).toString();
```

- `subarray(0, 79)` takes bytes 0 to 78, which is only the headers without the final `\r\n\r\n`.
- `toString()` decodes the bytes as UTF-8 text:

```ts
text ===
  "GET /hello HTTP/1.1\r\n" +
  "Host: localhost:3000\r\n" +
  "User-Agent: curl/8.21.0\r\n" +
  "Accept: */*"
```

### 5.6 `split("\r\n")[0]`: the first line

```ts
const firstLine = text.split("\r\n")[0];
```

`split` cuts the string at every line ending:

```ts
[
  "GET /hello HTTP/1.1",      // index 0  ← we take this
  "Host: localhost:3000",     // index 1
  "User-Agent: curl/8.21.0",  // index 2
  "Accept: */*"               // index 3
]
```

So `firstLine` is `"GET /hello HTTP/1.1"`.

Splitting it again on spaces gives the three parts:

```ts
const [method, path, version] = firstLine.split(" ");
// method = "GET", path = "/hello", version = "HTTP/1.1"
```

### 5.7 Building the response

```ts
const body = "Hello from my TCP server!";
const response =
  "HTTP/1.1 200 OK\r\n" +                              // status line
  "Content-Type: text/plain\r\n" +                     // header
  `Content-Length: ${Buffer.byteLength(body)}\r\n` +   // header: 25
  "Connection: close\r\n" +                            // header
  "\r\n" +                                             // end of headers
  body;                                                // body
socket.end(response);  // write it, then close our side of the connection
```

The response follows the same format as the request: start line, headers, empty line, body.

### 5.8 The `handled` flag

```ts
if (handled) return;
...
handled = true;
```

After we've responded, any extra `"data"` events on this socket are ignored, so we never send a second response on a closed connection.

---

## 6. Watch every step yourself

Add these logs inside the `"data"` callback, then run `curl.exe -v http://127.0.0.1:3000/hello`:

```ts
console.log("1. Incoming chunk:", chunk);
console.log("2. Decoded chunk:", chunk.toString());
request = Buffer.concat([request, chunk]);
console.log("3. Accumulated buffer:", request);
const headerEnd = request.indexOf("\r\n\r\n");
console.log("4. Header end index:", headerEnd);
// ...
console.log("5. Header text:", JSON.stringify(text)); // JSON.stringify shows \r\n
console.log("6. First line:", firstLine);
console.log("7. Parts:", firstLine.split(" "));
```

---

## Phase 1 summary

| Layer | What happened |
|---|---|
| Name resolution | `localhost` → `::1` and `127.0.0.1` |
| IP | curl fell back to IPv4 `127.0.0.1` |
| TCP | A connection formed between client port `57009` and server port `3000` |
| HTTP request | curl sent `GET /hello HTTP/1.1` plus headers as raw bytes |
| Node socket | The `"data"` event delivered the bytes as a `Buffer` |
| Our parser | `concat` → `indexOf("\r\n\r\n")` → `toString()` → `split` → first line |
| HTTP response | The server sent `200 OK` with a 25-byte body |
| TCP close | `socket.end()` closed this connection; the server kept running |

**Next: Phase 2** will parse every header into an object and add routes (`/health`, `/tasks`, `404`).
