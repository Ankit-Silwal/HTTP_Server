# HTTP Server from Scratch

A tiny HTTP server built directly on **raw TCP sockets** (`node:net`), without Node's `http` module or Express.
The goal is to learn what really happens between `curl` and a server: name resolution, TCP connections, bytes, and the HTTP text format.

| Phase | Topic | Status |
|---|---|---|
| 1 | TCP connection, sockets, Buffer | ✅ Done |
| 2 | Keep-alive, routing, validation, idle timeout | ✅ Done |
| 3 | Request bodies (`Content-Length`), `POST /echo`, `413` | ✅ Done (current `src/index.ts`) |
| 4 | Header parser into an object, query strings | ⏳ Next |

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

Send requests from another terminal:

```powershell
curl.exe -v http://localhost:3000/hello     # 200  Hello from my tcp server
curl.exe -v http://localhost:3000/health    # 200  Server is healthy
curl.exe -v http://localhost:3000/abc       # 404  Route not found
curl.exe -v -d "hello" http://localhost:3000/echo   # 200  You sent: hello
```

Stop the server with **Ctrl + C**. If port 3000 is still busy after that:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess -Force
```

---

## The full code (Phase 1)

> This is the Phase 1 version, which the sections below explain. The current `src/index.ts` is the Phase 3 version, explained in [Phase 3](#phase-3--request-bodies).

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

---

## **Phase 2 — Keep-Alive, Routing & Validation**

Phase 1 handled **one request per TCP connection** and always answered `200 OK`. Phase 2 changes that:

| | Phase 1 | Phase 2 |
|---|---|---|
| Requests per connection | 1, then close | Many (**keep-alive**) |
| Routes | Every path gives the same reply | `/hello`, `/health`, others get `404` |
| Bad requests | Not checked | `400 Bad Request` |
| Idle clients | Stay connected forever | Closed after **10 seconds** |
| Flag | `handled` (done after 1 request) | `closing` (stop only when closing) |
| Parsing | Once per `data` event | A `while` loop handles every request in the buffer |

### Full code (Phase 2 version)

> This is the Phase 2 version. The current code, which also reads request bodies, is in [Phase 3](#phase-3--request-bodies).

```ts
import net from "node:net";

const MAX_HEADER_SIZE=8192;
const IDLE_TIMEOUT=10_000;

// Example: curl.exe -v http://localhost:3000/hello
//
// What curl sends over TCP (\r\n written out, normally invisible):
//
//   GET /hello HTTP/1.1\r\n          -> bytes  0-20
//   Host: localhost:3000\r\n         -> bytes 21-42
//   User-Agent: curl/8.21.0\r\n      -> bytes 43-67
//   Accept: */*                      -> bytes 68-78
//   \r\n\r\n                         -> bytes 79-82 (end of headers)
//
// Raw bytes (hex) in the Buffer:
//   G  E  T     /  h  e  l  l  o
//   47 45 54 20 2f 68 65 6c 6c 6f ...
//
// With keep-alive, the same connection can carry more requests,
// so the buffer can hold the next one right after byte 82:
//
//   [ request 1: bytes 0-82 ][ request 2: bytes 83-... ]

const server=net.createServer((socket)=>{
  console.log("Client is connected");

  // empty bucket for this connection -> <Buffer >, length 0
  let request=Buffer.alloc(0);
  let requestsServed=0;
  let closing=false;

  // no data for 10s -> close the idle connection
  socket.setTimeout(IDLE_TIMEOUT);
  socket.on("timeout",()=>{
    console.log("Idle connection timeout");
    closing=true;
    socket.end();
  });

  socket.on("data",(chunk:Buffer)=>{
    if(closing) return;

    // TCP can split a request into pieces, so we keep adding them:
    //   data #1 chunk -> "GET /hello HTTP/1.1\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\n"
    //   data #2 chunk -> "Host: localhost:3000\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\n"
    //   data #3 chunk -> "User-Agent: curl/8.21.0\r\nAccept: */*\r\n\r\n"
    //   request       -> full headers (now contains \r\n\r\n)
    request=Buffer.concat([request,chunk]);

    // one chunk can contain several requests -> handle them one by one
    while(true){
      // where do the headers end?
      //   not arrived yet -> -1
      //   full example    -> 79
      const index=request.indexOf("\r\n\r\n");

      if(index===-1){
        // too big and still no end of headers -> reject
        //this goes to the up things and again buffer.concat occurs!
        if(request.length>MAX_HEADER_SIZE){
          closing=true;
          socket.end(
            "HTTP/1.1 431 Request Header Fields Too Large\r\n"+
            "Content-Length: 0\r\n"+
            "Connection: close\r\n"+
            "\r\n"
          );
        }
        return; // wait for more data
      }

      // headers finished but bigger than the limit -> reject
      if(index+4>MAX_HEADER_SIZE){
        closing=true;
        socket.end(
          "HTTP/1.1 431 Request Header Fields Too Large\r\n"+
          "Content-Length: 0\r\n"+
          "Connection: close\r\n"+
          "\r\n"
        );
        return;
      }

      // subarray(0,79) -> header bytes only (without \r\n\r\n)
      // toString()     -> bytes to text:
      //   "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\nUser-Agent: curl/8.21.0\r\nAccept: */*"
      const text=request.subarray(0,index).toString();

      // cut off this request (79 + 4 = 83) and keep whatever comes after it:
      //   only one request -> request = <Buffer >
      //   two requests     -> request = bytes of request 2
      request=request.subarray(index+4);

      // split("\r\n") ->
      //   firstLine = "GET /hello HTTP/1.1"
      //   headers   = ["Host: localhost:3000","User-Agent: curl/8.21.0","Accept: */*"]
      const [firstLine,...headers]=text.split("\r\n");

      // split(" ") -> ["GET","/hello","HTTP/1.1"]
      const [method,path,version]=firstLine.split(" ");
      console.log("Method:",method);
      console.log("Path:",path);

      // only plain GET with HTTP/1.1 and no body for now
      const unsupported=
        version!=="HTTP/1.1"||
        method!=="GET"||
        headers.some(h=>/^(content-length|transfer-encoding)\s*:/i.test(h));

      if(unsupported){
        closing=true;
        socket.end(
          "HTTP/1.1 400 Bad Request\r\n"+
          "Content-Length: 0\r\n"+
          "Connection: close\r\n"+
          "\r\n"
        );
        return;
      }

      // routing
      let status="200 OK";
      let body="";
      if(path==="/hello"){
        body="Hello from my tcp server";
      }else if(path==="/health"){
        body="Server is healthy";
      }else{
        status="404 Not Found";
        body="Route not found";
      }

      requestsServed++;
      console.log("Requests on connection:",requestsServed);

      // client sent "Connection: close" -> close after this response
      // otherwise HTTP/1.1 keeps the connection open (keep-alive)
      const shouldClose=headers.some(h=>/^connection\s*:\s*close\s*$/i.test(h));

      // response = status line + headers + empty line + body
      const response=
        `HTTP/1.1 ${status}\r\n`+
        "Content-Type: text/plain\r\n"+
        `Content-Length: ${Buffer.byteLength(body)}\r\n`+
        `Connection: ${shouldClose?"close":"keep-alive"}\r\n`+
        "\r\n"+
        body;

      if(shouldClose){
        closing=true;
        socket.end(response); // send and close
        return;
      }

      socket.write(response); // send and keep the connection open
    }
  });

  socket.on("close",()=>{
    console.log("Client disconnected");
  });

  socket.on("error",(err)=>{
    console.log("Socket error:",err.message);
  });
});

// 0.0.0.0 -> listen on every address this PC has (localhost, Wi-Fi IP, ...)
server.listen(3000,"0.0.0.0",()=>{
  console.log("TCP server is running on port 3000");
});
```

The sections below explain each part of this code.

---

### 2.1 Keep-alive: one connection, many requests

Opening a TCP connection costs a handshake (`SYN → SYN-ACK → ACK`). Opening one for **every** request wastes time. In HTTP/1.1, connections stay open by default, so the client can send the next request on the same socket.

```
Phase 1 (Connection: close)              Phase 2 (keep-alive)

connect ─► GET /hello ─► 200 ─► close     connect ─► GET /hello  ─► 200
connect ─► GET /health ─► 200 ─► close             ─► GET /health ─► 200
                                                    ─► ... idle 10s ─► close
```

How the server decides:

```ts
// client sent "Connection: close" -> close after this response
// otherwise HTTP/1.1 keeps the connection open (keep-alive)
const shouldClose=headers.some(h=>/^connection\s*:\s*close\s*$/i.test(h));
```

| Client sent | Server replies | Server then calls |
|---|---|---|
| no `Connection` header | `Connection: keep-alive` | `socket.write(response)`, so the socket **stays open** |
| `Connection: close` | `Connection: close` | `socket.end(response)`, so the socket **closes** |

`socket.write()` sends data and keeps the socket open. `socket.end()` sends data and then closes it.

The regex `/^connection\s*:\s*close\s*$/i` matches `Connection: close`, `connection:close`, `CONNECTION :  close`, and so on. `i` means case-insensitive, and `\s*` allows optional spaces.

**Try it.** Give curl two URLs and it reuses the same connection for both:

```powershell
curl.exe -v http://localhost:3000/hello http://localhost:3000/health
```

curl reports that it is **re-using the existing connection**, and the server logs:

```
Client is connected
Method: GET
Path: /hello
Requests on connection: 1
Method: GET
Path: /health
Requests on connection: 2      ← same connection, second request
```

Force a close:

```powershell
curl.exe -v -H "Connection: close" http://localhost:3000/hello
```

---

### 2.2 The `while(true)` loop: more than one request in the buffer

With keep-alive, one `data` chunk can contain **two requests back to back** (this is called *pipelining*), or one full request plus **half** of the next one. So after handling a request, we must not throw the buffer away. We **cut off** only the part we used and loop again.

Using the curl `/hello` request from Phase 1 (83 bytes in total), sent twice:

```
byte:   0 ............. 78  79-82   83 ............ 161  162-165
       [ request 1 headers ][\r\n\r\n][ request 2 headers ][\r\n\r\n]
```

```ts
while(true){
  const index=request.indexOf("\r\n\r\n");     // 1st loop: 79
  if(index===-1) return;                        // no complete request left -> wait

  const text=request.subarray(0,index).toString();   // bytes 0-78 -> request 1 as text
  request=request.subarray(index+4);                 // drop bytes 0-82, keep 83-165
  ...                                                // respond to request 1
}                                                    // loop again
```

| Loop | `request` holds | `indexOf` | What happens |
|---|---|---|---|
| 1 | request 1 + request 2 (166 bytes) | `79` | answer request 1, keep bytes 83–165 |
| 2 | request 2 (83 bytes) | `79` | answer request 2, keep nothing |
| 3 | `<Buffer >` (empty) | `-1` | `return`, and wait for the next `data` event |

**Why `index+4`?** `index` is where `\r\n\r\n` **starts**, and that sequence is 4 bytes long. So `index+4` is the first byte **after** the headers, which is where the next request begins.

`subarray()` doesn't copy any bytes. It just creates a smaller view onto the same memory.

---

### 2.3 Splitting first line vs headers

```ts
const [firstLine,...headers]=text.split("\r\n");
```

`...headers` (rest syntax) means "put everything after the first item into an array":

```ts
text.split("\r\n") ===
  ["GET /hello HTTP/1.1", "Host: localhost:3000", "User-Agent: curl/8.21.0", "Accept: */*"]

firstLine === "GET /hello HTTP/1.1"
headers   === ["Host: localhost:3000", "User-Agent: curl/8.21.0", "Accept: */*"]
```

```ts
const [method,path,version]=firstLine.split(" ");
// method = "GET", path = "/hello", version = "HTTP/1.1"
```

---

### 2.4 Validation: `400 Bad Request`

```ts
const unsupported=
  version!=="HTTP/1.1"||
  method!=="GET"||
  headers.some(h=>/^(content-length|transfer-encoding)\s*:/i.test(h));
```

The server rejects the request and closes the connection if:

| Check | Example that fails | Why |
|---|---|---|
| `version!=="HTTP/1.1"` | `GET / HTTP/1.0` | We only implement HTTP/1.1 rules, such as keep-alive by default |
| `method!=="GET"` | `POST /hello` | Other methods aren't supported yet |
| has `Content-Length` or `Transfer-Encoding` | `curl.exe -d "x" ...` | The request has a **body**, which we don't read yet |

**Why rejecting bodies matters:** our loop treats the bytes after `\r\n\r\n` as the **next request**. If a client sent a body such as `hello`, those 5 bytes would stay in the buffer and be parsed as the start of a fake second request. Rejecting bodies until Phase 3 reads them properly avoids that bug. This class of bug is the basis of real attacks called *request smuggling*.

`headers.some(...)` returns `true` if **at least one** header matches.

Try it:

```powershell
curl.exe -v -X POST http://localhost:3000/hello          # 400 (method)
curl.exe -v --http1.0 http://localhost:3000/hello        # 400 (version)
```

---

### 2.5 Routing: `200` vs `404`

```ts
let status="200 OK";
let body="";
if(path==="/hello"){
  body="Hello from my tcp server";
}else if(path==="/health"){
  body="Server is healthy";
}else{
  status="404 Not Found";
  body="Route not found";
}
```

| Path | Status | Body | `Content-Length` |
|---|---|---|---|
| `/hello` | `200 OK` | `Hello from my tcp server` | 24 |
| `/health` | `200 OK` | `Server is healthy` | 17 |
| anything else | `404 Not Found` | `Route not found` | 15 |

The path is compared exactly, so `/hello?name=x` and `/hello/` also get `404`. Query strings come later.

A `404` keeps the connection open, because the request itself was valid. Only the route didn't exist. A `400` closes it, because we can no longer trust what is in the buffer.

**`Content-Length` matters even more now.** With keep-alive the connection stays open, so the client can't wait for the connection to close to know the body has ended. It reads exactly `Content-Length` bytes, and anything after that belongs to the next response.

---

### 2.6 Idle timeout

```ts
socket.setTimeout(IDLE_TIMEOUT);   // 10_000 ms = 10 seconds
socket.on("timeout",()=>{
  console.log("Idle connection timeout");
  closing=true;
  socket.end();
});
```

Every open connection uses memory and a file handle. With keep-alive, a client could connect and then sit there forever. `setTimeout` fires the `"timeout"` event after **10 seconds with no activity**. The timer **restarts** every time data is sent or received, so busy connections are never cut off.

`10_000` is just `10000`. The `_` is a digit separator for readability.

---

### 2.7 Header size limit: `431`

There are two checks, because there are two ways headers can be too big:

```ts
// 1. still no \r\n\r\n and the buffer is already over 8192 bytes
if(index===-1){
  if(request.length>MAX_HEADER_SIZE){ ...431... }
  return;
}

// 2. \r\n\r\n was found, but the headers themselves are over 8192 bytes
if(index+4>MAX_HEADER_SIZE){ ...431... }
```

Without the first check, a client could send endless bytes with no `\r\n\r\n`, and the buffer would keep growing until memory runs out.

---

### 2.8 The `closing` flag

```ts
if(closing) return;   // at the top of the "data" handler
```

`closing` is set to `true` whenever we call `socket.end()`: on a `400`, a `431`, `Connection: close`, or a timeout. After that, any bytes still arriving are ignored, so we never write to a socket that is shutting down.

---

### 2.9 Events on one connection

```
"connection"  → Client is connected
"data"        → bytes arrive → while loop → 0, 1 or many responses
"data"        → more bytes ...
"timeout"     → 10 s idle → socket.end()
"close"       → Client disconnected
"error"       → e.g. client vanished (ECONNRESET), logged instead of crashing the server
```

---

## Phase 2 summary

| Feature | Code | Purpose |
|---|---|---|
| Keep-alive | `socket.write()` vs `socket.end()` | Reuse one TCP connection for many requests |
| Request loop | `while(true)` + `subarray(index+4)` | Handle several requests in one buffer |
| Rest split | `[firstLine,...headers]` | Separate the request line from the headers |
| Validation | `unsupported` → `400` | Reject what we can't parse safely |
| Routing | `if / else if / else` → `404` | Different reply per path |
| Idle timeout | `socket.setTimeout(10_000)` | Free connections nobody uses |
| Size limit | `MAX_HEADER_SIZE` → `431` | Stop endless headers from eating memory |
| Request count | `requestsServed` | Shows keep-alive working |

**Next: Phase 3** reads request bodies using `Content-Length` and supports `POST`.

---

## **Phase 3 — Request Bodies**

Up to Phase 2, a request was **only headers**, and anything with a body got a `400`. Phase 3 reads the **body** that comes after the headers, so clients can send data with `POST`.

| | Phase 2 | Phase 3 |
|---|---|---|
| Methods | `GET` only | `GET` and `POST` |
| `Content-Length` header | Rejected with `400` | Read and used to find the body |
| Request ends at | `index+4` (end of headers) | `index+4+contentLength` (end of body) |
| New routes | | `POST /echo` replies with what you sent |
| New errors | | `400` for a bad `Content-Length`, `413` for a body over 1 MB |
| Error responses | Written out 4 times | One `sendError()` helper |
| Routing | By path only | By **method and path** |

### Full code (Phase 3, current `src/index.ts`)

```ts
import net from "node:net";

const MAX_HEADER_SIZE=8192;
const MAX_BODY_SIZE=1024*1024; // 1 MB
const IDLE_TIMEOUT=10_000;

// Example: curl.exe -v http://localhost:3000/hello
//
// What curl sends over TCP (\r\n written out, normally invisible):
//
//   GET /hello HTTP/1.1\r\n          -> bytes  0-20
//   Host: localhost:3000\r\n         -> bytes 21-42
//   User-Agent: curl/8.21.0\r\n      -> bytes 43-67
//   Accept: */*                      -> bytes 68-78
//   \r\n\r\n                         -> bytes 79-82 (end of headers)
//
// Raw bytes (hex) in the Buffer:
//   G  E  T     /  h  e  l  l  o
//   47 45 54 20 2f 68 65 6c 6c 6f ...
//
// With keep-alive, the same connection can carry more requests,
// so the buffer can hold the next one right after byte 82:
//
//   [ request 1: bytes 0-82 ][ request 2: bytes 83-... ]
//
// Example with a body: curl.exe -v -d "hello" http://localhost:3000/echo
//
//   POST /echo HTTP/1.1\r\n                                -> bytes   0-20
//   Host: localhost:3000\r\n                               -> bytes  21-42
//   User-Agent: curl/8.21.0\r\n                            -> bytes  43-67
//   Accept: */*\r\n                                        -> bytes  68-80
//   Content-Length: 5\r\n                                  -> bytes  81-99
//   Content-Type: application/x-www-form-urlencoded        -> bytes 100-146
//   \r\n\r\n                                               -> bytes 147-150 (index=147)
//   hello                                                  -> bytes 151-155 (the body)
//
//   [ headers: 0-146 ][\r\n\r\n: 147-150][ body: 151-155 ][ next request: 156-... ]

// small helper so every error response looks the same
function sendError(socket:net.Socket,status:string){
  socket.end(
    `HTTP/1.1 ${status}\r\n`+
    "Content-Length: 0\r\n"+
    "Connection: close\r\n"+
    "\r\n"
  );
}

const server=net.createServer((socket)=>{
  console.log("Client is connected");

  // empty bucket for this connection -> <Buffer >, length 0
  let request=Buffer.alloc(0);
  let requestsServed=0;
  let closing=false;

  // no data for 10s -> close the idle connection
  socket.setTimeout(IDLE_TIMEOUT);
  socket.on("timeout",()=>{
    console.log("Idle connection timeout");
    closing=true;
    socket.end();
  });

  socket.on("data",(chunk:Buffer)=>{
    if(closing) return;

    // TCP can split a request into pieces, so we keep adding them:
    //   data #1 chunk -> "GET /hello HTTP/1.1\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\n"
    //   data #2 chunk -> "Host: localhost:3000\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\n"
    //   data #3 chunk -> "User-Agent: curl/8.21.0\r\nAccept: */*\r\n\r\n"
    //   request       -> full headers (now contains \r\n\r\n)
    request=Buffer.concat([request,chunk]);

    // one chunk can contain several requests -> handle them one by one
    while(true){
      // where do the headers end?
      //   not arrived yet -> -1
      //   GET example     -> 79
      //   POST example    -> 147
      const index=request.indexOf("\r\n\r\n");

      if(index===-1){
        // too big and still no end of headers -> reject
        // otherwise return, the next "data" event runs Buffer.concat again
        if(request.length>MAX_HEADER_SIZE){
          closing=true;
          sendError(socket,"431 Request Header Fields Too Large");
        }
        return; // wait for more data
      }

      // headers finished but bigger than the limit -> reject
      if(index+4>MAX_HEADER_SIZE){
        closing=true;
        sendError(socket,"431 Request Header Fields Too Large");
        return;
      }

      // subarray(0,79) -> header bytes only (without \r\n\r\n)
      // toString()     -> bytes to text:
      //   "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\nUser-Agent: curl/8.21.0\r\nAccept: */*"
      const text=request.subarray(0,index).toString();

      // split("\r\n") ->
      //   firstLine = "GET /hello HTTP/1.1"
      //   headers   = ["Host: localhost:3000","User-Agent: curl/8.21.0","Accept: */*"]
      const [firstLine,...headers]=text.split("\r\n");

      // split(" ") -> ["GET","/hello","HTTP/1.1"]
      const [method,path,version]=firstLine.split(" ");

      // find the Content-Length header (if any):
      //   GET example  -> undefined       -> contentLength=0
      //   POST example -> "Content-Length: 5" -> split(":")[1] = " 5" -> trim -> "5" -> 5
      const lengthHeader=headers.find(h=>
        h.toLowerCase().startsWith("content-length:")
      );
      let contentLength=0;
      if(lengthHeader){
        contentLength=Number(lengthHeader.split(":")[1].trim());
      }

      // validate BEFORE waiting for the body
      // (a bad Content-Length like "abc" -> NaN would break the math below)
      const unsupported=
        version!=="HTTP/1.1"||
        (method!=="GET"&&method!=="POST")||
        headers.some(h=>/^transfer-encoding\s*:/i.test(h))|| // chunked bodies not supported yet
        !Number.isInteger(contentLength)||
        contentLength<0;

      if(unsupported){
        closing=true;
        sendError(socket,"400 Bad Request");
        return;
      }

      if(contentLength>MAX_BODY_SIZE){
        closing=true;
        sendError(socket,"413 Content Too Large");
        return;
      }

      // where the body is in the buffer (POST example):
      //   bodyStart   = 147 + 4 = 151
      //   totalLength = 151 + 5 = 156  -> this request ends at byte 155
      const bodyStart=index+4;
      const totalLength=bodyStart+contentLength;

      // body not fully arrived yet -> wait for more data
      // (we keep the headers in the buffer and parse them again next time)
      if(request.length<totalLength){
        return;
      }

      // subarray(151,156) -> "hello"
      const requestBody=request.subarray(bodyStart,totalLength).toString();

      // cut off this whole request (headers + body) and keep whatever comes after it:
      //   only one request -> request = <Buffer >
      //   two requests     -> request = bytes of request 2
      request=request.subarray(totalLength);

      console.log("Method:",method);
      console.log("Path:",path);
      console.log("Body:",requestBody);

      // routing
      let status="200 OK";
      let body="";
      if(method==="GET"&&path==="/hello"){
        body="Hello from my tcp server";
      }else if(method==="GET"&&path==="/health"){
        body="Server is healthy";
      }else if(method==="POST"&&path==="/echo"){
        body=`You sent: ${requestBody}`;
      }else{
        status="404 Not Found";
        body="Route not found";
      }

      requestsServed++;
      console.log("Requests on connection:",requestsServed);

      // client sent "Connection: close" -> close after this response
      // otherwise HTTP/1.1 keeps the connection open (keep-alive)
      const shouldClose=headers.some(h=>/^connection\s*:\s*close\s*$/i.test(h));

      // response = status line + headers + empty line + body
      const response=
        `HTTP/1.1 ${status}\r\n`+
        "Content-Type: text/plain\r\n"+
        `Content-Length: ${Buffer.byteLength(body)}\r\n`+
        `Connection: ${shouldClose?"close":"keep-alive"}\r\n`+
        "\r\n"+
        body;

      if(shouldClose){
        closing=true;
        socket.end(response); // send and close
        return;
      }

      socket.write(response); // send and keep the connection open
    }
  });

  socket.on("close",()=>{
    console.log("Client disconnected");
  });

  socket.on("error",(err)=>{
    console.log("Socket error:",err.message);
  });
});

// 0.0.0.0 -> listen on every address this PC has (localhost, Wi-Fi IP, ...)
server.listen(3000,"0.0.0.0",()=>{
  console.log("TCP server is running on port 3000");
});
```

---

### 3.1 What a request with a body looks like

```powershell
curl.exe -v -d "hello" http://localhost:3000/echo
```

`-d` means "send this data as the body". curl then switches to `POST` automatically and adds two headers:

```
> POST /echo HTTP/1.1
> Host: localhost:3000
> User-Agent: curl/8.21.0
> Accept: */*
> Content-Length: 5                                    ← the body is 5 bytes
> Content-Type: application/x-www-form-urlencoded      ← the kind of data
>
hello                                                  ← the body (5 bytes)
```

Byte by byte in the buffer:

```
POST /echo HTTP/1.1\r\n                              -> bytes   0-20
Host: localhost:3000\r\n                             -> bytes  21-42
User-Agent: curl/8.21.0\r\n                          -> bytes  43-67
Accept: */*\r\n                                      -> bytes  68-80
Content-Length: 5\r\n                                -> bytes  81-99
Content-Type: application/x-www-form-urlencoded      -> bytes 100-146
\r\n\r\n                                             -> bytes 147-150   ← index = 147
hello                                                -> bytes 151-155   ← the body
```

```
[ headers: 0-146 ][ \r\n\r\n: 147-150 ][ body: 151-155 ][ next request: 156-... ]
```

**The key problem:** after `\r\n\r\n`, how does the server know where the body ends and the next request begins? There is no special marker at the end of a body. **`Content-Length` is the only way to know.** It says "the next 5 bytes are the body".

---

### 3.2 Reading `Content-Length`

```ts
const lengthHeader=headers.find(h=>
  h.toLowerCase().startsWith("content-length:")
);
let contentLength=0;
if(lengthHeader){
  contentLength=Number(lengthHeader.split(":")[1].trim());
}
```

Step by step for the POST example:

| Step | Value |
|---|---|
| `headers.find(...)` | `"Content-Length: 5"`. `find` returns the **first matching item**, or `undefined` |
| `.split(":")` | `["Content-Length", " 5"]` |
| `[1]` | `" 5"` |
| `.trim()` | `"5"`, with the spaces removed |
| `Number(...)` | `5` |

For a `GET` with no `Content-Length`, `find` returns `undefined`, so `contentLength` stays `0`. A request without a body simply has a 0-byte body.

`toLowerCase()` is needed because header names are **case-insensitive**. `Content-Length`, `content-length` and `CONTENT-LENGTH` all mean the same thing.

---

### 3.3 Validate before waiting

```ts
const unsupported=
  version!=="HTTP/1.1"||
  (method!=="GET"&&method!=="POST")||
  headers.some(h=>/^transfer-encoding\s*:/i.test(h))||
  !Number.isInteger(contentLength)||
  contentLength<0;
```

| Check | Bad example | Why reject |
|---|---|---|
| `version!=="HTTP/1.1"` | `HTTP/1.0` | Only HTTP/1.1 rules are implemented |
| not `GET` or `POST` | `DELETE` | Other methods aren't supported yet |
| `Transfer-Encoding` present | `Transfer-Encoding: chunked` | A *chunked* body has no `Content-Length`. It comes in pieces, each with its own size, and needs a different parser |
| `!Number.isInteger(...)` | `Content-Length: abc` → `NaN`, or `2.5` | Not a valid byte count |
| `contentLength<0` | `Content-Length: -5` | A negative length makes no sense |

**Why the order matters:** this check runs **before** the body math. If `contentLength` were `NaN`, then `totalLength` would be `NaN`, `request.length<NaN` would always be `false`, and `subarray(NaN)` would quietly return the wrong bytes. So bad input is rejected first, before it can break anything.

**Size limit, `413`:**

```ts
if(contentLength>MAX_BODY_SIZE){   // 1024*1024 = 1 MB
  sendError(socket,"413 Content Too Large");
}
```

Without it, a client could send `Content-Length: 99999999999`, and the server would keep growing the buffer while it waits for bytes that never stop.

---

### 3.4 Finding and cutting out the body

```ts
const bodyStart=index+4;                    // 147 + 4 = 151
const totalLength=bodyStart+contentLength;  // 151 + 5 = 156

if(request.length<totalLength){
  return;                                   // body not fully here yet -> wait
}

const requestBody=request.subarray(bodyStart,totalLength).toString();  // bytes 151-155 -> "hello"
request=request.subarray(totalLength);                                // keep bytes from 156 on
```

| Name | Meaning | POST example |
|---|---|---|
| `index` | where `\r\n\r\n` starts | `147` |
| `bodyStart` | first byte of the body | `151` |
| `totalLength` | first byte **after** this request | `156` |
| `request.length` | how many bytes have arrived so far | `156` if everything is here |

**What if the body is split across chunks?** For a big body, TCP might deliver the headers first and the body later:

| Event | `request.length` | `totalLength` | What happens |
|---|---|---|---|
| data #1: headers + `"hel"` | 154 | 156 | `154 < 156`, so `return` and wait. The headers **stay in the buffer** |
| data #2: `"lo"` | 156 | 156 | full request: read the body, cut it out, respond |

On the second `data` event, the `while` loop starts from the top again. It finds `\r\n\r\n` and re-reads the headers before checking the length. Parsing the headers twice is a little wasteful, but it keeps the code simple.

**Phase 2 vs Phase 3 cutting:**

```ts
request=request.subarray(index+4);          // Phase 2: cut headers only
request=request.subarray(totalLength);      // Phase 3: cut headers + body
```

This is exactly the bug Phase 2 avoided by rejecting bodies. If we cut only the headers, `hello` would stay in the buffer and be parsed as the start of the next request.

---

### 3.5 Routing by method and path

```ts
if(method==="GET"&&path==="/hello"){
  body="Hello from my tcp server";
}else if(method==="GET"&&path==="/health"){
  body="Server is healthy";
}else if(method==="POST"&&path==="/echo"){
  body=`You sent: ${requestBody}`;
}else{
  status="404 Not Found";
  body="Route not found";
}
```

| Request | Status | Response body |
|---|---|---|
| `GET /hello` | `200 OK` | `Hello from my tcp server` |
| `GET /health` | `200 OK` | `Server is healthy` |
| `POST /echo` with body `hello` | `200 OK` | `You sent: hello` |
| `POST /hello` | `404 Not Found` | `Route not found` |
| `GET /echo` | `404 Not Found` | `Route not found` |

Two different variables are involved:
- `requestBody` is what the **client sent** us.
- `body` is what **we send back**.

They need different names. When both were called `body`, TypeScript refused to compile ("Cannot redeclare block-scoped variable").

---

### 3.6 The `sendError()` helper

```ts
function sendError(socket:net.Socket,status:string){
  socket.end(
    `HTTP/1.1 ${status}\r\n`+
    "Content-Length: 0\r\n"+
    "Connection: close\r\n"+
    "\r\n"
  );
}
```

The `400`, `413` and both `431` responses were the same text with only the status changed, so one function builds all of them. It always closes the connection, because after a bad request we can't trust what's left in the buffer.

---

### 3.7 Try it

```powershell
curl.exe -v -d "hello" http://localhost:3000/echo                    # 200  You sent: hello
curl.exe -v -d "hello world" http://localhost:3000/echo              # 200  You sent: hello world
curl.exe -v http://localhost:3000/hello                              # 200  GET still works
curl.exe -v -X POST http://localhost:3000/hello                      # 404  wrong method for /hello
curl.exe -v -X DELETE http://localhost:3000/hello                    # 400  method not supported
curl.exe -v -H "Content-Length: abc" http://localhost:3000/hello     # 400  bad Content-Length
curl.exe -v -H "Transfer-Encoding: chunked" -d "hi" http://localhost:3000/echo   # 400  chunked not supported
```

Server log for the first command:

```
Client is connected
Method: POST
Path: /echo
Body: hello
Requests on connection: 1
Client disconnected
```

---

## Phase 3 summary

| Feature | Code | Purpose |
|---|---|---|
| Read body length | `headers.find(...)` → `Number(...)` | Know how many bytes the body has |
| Validate first | `Number.isInteger`, `contentLength<0` → `400` | Stop bad input before it breaks the math |
| Body size limit | `MAX_BODY_SIZE` → `413` | Stop huge bodies from eating memory |
| Wait for full body | `request.length<totalLength` → `return` | Bodies can arrive in several chunks |
| Cut headers + body | `request.subarray(totalLength)` | The next request starts in the right place |
| Echo route | `POST /echo` | Proves the body was read correctly |
| Error helper | `sendError(socket,status)` | One place builds every error response |

**Next: Phase 4** will turn the headers into an object (`{ host: "localhost:3000", ... }`), handle query strings (`/hello?name=x`), and move the parsing into its own `parser.ts`.
